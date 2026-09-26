"""Asynchronous Moth API wrapper (Atlas `blur-v1` + Tessa Compressor).

Two layers:

* ``MothClient`` -- pure ``asyncio`` + ``httpx`` coroutines with a ``diskcache``
  layer and graceful fallbacks (any failure returns the original bytes).
* ``MothWorker`` -- runs a private event loop in a daemon thread so the FastAPI
  handlers can fire requests and poll ``is_busy`` without ever blocking.

NOTE: the real Moth endpoint URLs / auth scheme are not documented in this repo.
``BASE_URL`` and the two paths below are placeholders -- override them via the
``MOTH_API_BASE`` / ``MOTH_API_KEY`` environment variables or constructor args.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import threading
from concurrent.futures import Future
from pathlib import Path
from typing import Any, Coroutine, Optional

import httpx
from diskcache import Cache

log = logging.getLogger("moth_client")

BASE_URL = os.environ.get("MOTH_API_BASE", "https://api.moth.example")
ATLAS_BLUR_PATH = "/v1/atlas/blur-v1"
TESSA_COMPRESS_PATH = "/v1/tessa/compress"

MOCK_DELAY_SECONDS = 0.5
DEFAULT_TIMEOUT_SECONDS = 10.0
DEFAULT_CACHE_DIR = Path(os.environ.get("MOTH_CACHE_DIR", Path(__file__).parent / ".moth_cache"))


class MothClient:
    def __init__(
        self,
        api_key: Optional[str] = None,
        *,
        mock_mode: bool = True,
        base_url: str = BASE_URL,
        cache_dir: str | os.PathLike = DEFAULT_CACHE_DIR,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        mock_delay: float = MOCK_DELAY_SECONDS,
        cache_ttl: Optional[float] = None,
    ) -> None:
        self.api_key = api_key or os.environ.get("MOTH_API_KEY")
        self.mock_mode = mock_mode
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.mock_delay = mock_delay
        self.cache_ttl = cache_ttl
        self.cache = Cache(str(cache_dir))
        # Created lazily so the client is bound to whichever loop first uses it.
        self._http: Optional[httpx.AsyncClient] = None

    # ------------------------------------------------------------------ public

    async def blur(self, image: bytes, radius: float = 8.0) -> bytes:
        """Atlas `blur-v1`: blur an image. Returns the original bytes on failure."""
        return await self._request(
            "blur-v1", ATLAS_BLUR_PATH, image, {"radius": str(radius)}
        )

    async def compress(self, data: bytes, quality: int = 50) -> bytes:
        """Tessa Compressor: compress an asset. Returns the original bytes on failure."""
        return await self._request(
            "tessa-compress", TESSA_COMPRESS_PATH, data, {"quality": str(quality)}
        )

    async def aclose(self) -> None:
        if self._http is not None:
            await self._http.aclose()
            self._http = None
        self.cache.close()

    # ---------------------------------------------------------------- internals

    def _cache_key(self, op: str, payload: bytes, params: dict[str, str]) -> str:
        h = hashlib.sha256()
        h.update(op.encode())
        for k in sorted(params):
            h.update(f"|{k}={params[k]}".encode())
        h.update(b"|")
        h.update(payload)
        # Mock results are just the input echoed back; keep them out of the
        # namespace real responses live in so they can't poison it later.
        return f"{'mock' if self.mock_mode else 'live'}:{h.hexdigest()}"

    async def _request(
        self, op: str, path: str, payload: bytes, params: dict[str, str]
    ) -> bytes:
        key = self._cache_key(op, payload, params)

        # diskcache is synchronous file I/O -- keep it off the event loop.
        cached = await asyncio.to_thread(self.cache.get, key)
        if cached is not None:
            log.debug("cache hit %s", key)
            return cached

        if self.mock_mode:
            await asyncio.sleep(self.mock_delay)
            result = payload
        else:
            result = await self._call_api(path, payload, params)
            if result is None:
                return payload  # fallback: original asset, deliberately not cached

        await asyncio.to_thread(self.cache.set, key, result, expire=self.cache_ttl)
        return result

    async def _call_api(
        self, path: str, payload: bytes, params: dict[str, str]
    ) -> Optional[bytes]:
        if self._http is None:
            self._http = httpx.AsyncClient(base_url=self.base_url, timeout=self.timeout)
        headers = {"Content-Type": "application/octet-stream"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        try:
            resp = await self._http.post(
                path, content=payload, params=params, headers=headers
            )
            if resp.status_code == 429:
                log.warning("Moth rate limit hit on %s; using original asset", path)
                return None
            resp.raise_for_status()
            return resp.content
        except httpx.TimeoutException:
            log.warning("Moth request to %s timed out; using original asset", path)
        except httpx.HTTPError as exc:
            log.warning("Moth request to %s failed (%r); using original asset", path, exc)
        return None


class MothWorker:
    """Runs a ``MothClient`` on a background event loop in a daemon thread.

    Usage::

        fut = worker.submit(worker.client.blur(img_bytes))   # returns immediately
        ...
        if worker.is_busy:  draw "Processing Quantum State..." overlay
        if fut.done():      img_bytes = fut.result()
    """

    def __init__(self, client: Optional[MothClient] = None, **client_kwargs: Any) -> None:
        self.client = client or MothClient(**client_kwargs)
        self._pending = 0
        self._lock = threading.Lock()
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(
            target=self._run_loop, name="moth-worker", daemon=True
        )
        self._thread.start()

    def _run_loop(self) -> None:
        asyncio.set_event_loop(self._loop)
        self._loop.run_forever()

    @property
    def is_busy(self) -> bool:
        with self._lock:
            return self._pending > 0

    def submit(self, coro: Coroutine[Any, Any, bytes]) -> Future:
        """Schedule a client coroutine; returns a ``concurrent.futures.Future``."""
        with self._lock:
            self._pending += 1
        fut = asyncio.run_coroutine_threadsafe(coro, self._loop)
        fut.add_done_callback(self._on_done)
        return fut

    def _on_done(self, _fut: Future) -> None:
        with self._lock:
            self._pending -= 1

    def shutdown(self) -> None:
        asyncio.run_coroutine_threadsafe(self._drain(), self._loop).result(timeout=5)
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join(timeout=5)

    async def _drain(self) -> None:
        """Cancel anything still in flight, then close the client.

        Without this, quitting mid-request leaves tasks alive on a stopped loop
        and Python prints "Task was destroyed but it is pending!" at exit.
        """
        pending = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        await self.client.aclose()
