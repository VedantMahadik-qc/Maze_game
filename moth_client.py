"""Asynchronous Moth API wrapper.

Two layers:

* ``MothClient`` -- pure ``asyncio`` + ``httpx`` coroutines with a ``diskcache``
  layer and graceful fallbacks: nothing here raises on a network or API
  failure (blur/compress return the original bytes, job calls return None).
* ``MothWorker`` -- runs a private event loop in a daemon thread so the FastAPI
  handlers can fire requests and poll ``is_busy`` without ever blocking.

Atlas job lifecycle (``submit_job`` / ``job_status`` / ``job_result`` /
``run_job``) is CONFIRMED against the live API on 2026-09-26:

    base  https://api.mothquantum.com/api/v1   (Bearer MOTH_API_KEY)
    POST  /engines/{engine_id}/process   {"params": {...}, "input_files": {...}}
          -> 202 {"job_id": "...", "status": "queued"}
    GET   /jobs/{job_id}/status   -> {"status": "queued|processing|completed|failed",
                                      "progress": {"step": ..., "detail": ...}, "steps": [...]}
    GET   /jobs/{job_id}/result   -> {"result": {"output": {...}}}

NOTE: ``ATLAS_BLUR_PATH`` / ``TESSA_COMPRESS_PATH`` below are still unverified
placeholders carried over from an earlier project; nothing in this game uses them.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import threading
from concurrent.futures import Future
from pathlib import Path
from typing import Any, Callable, Coroutine, Optional

import httpx
from diskcache import Cache

log = logging.getLogger("moth_client")

BASE_URL = os.environ.get("MOTH_API_BASE", "https://api.mothquantum.com/api/v1")
ATLAS_BLUR_PATH = "/v1/atlas/blur-v1"  # UNVERIFIED placeholder
TESSA_COMPRESS_PATH = "/v1/tessa/compress"  # UNVERIFIED placeholder

MOCK_DELAY_SECONDS = 0.5
DEFAULT_TIMEOUT_SECONDS = 10.0
DEFAULT_CACHE_DIR = Path(os.environ.get("MOTH_CACHE_DIR", Path(__file__).parent / ".moth_cache"))

RETRYABLE_STATUS = frozenset({408, 429, 500, 502, 503, 504})
TERMINAL_FAILURE_STATES = frozenset({"failed", "cancelled", "canceled", "error"})

# Called with a small dict every time a tracked job changes state.
JobUpdate = Callable[[dict[str, Any]], None]


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

    async def submit_job(
        self, engine_id: str, params: dict[str, Any], input_files: Optional[dict[str, str]] = None
    ) -> Optional[str]:
        """Queue an Atlas job. Returns its job_id, or None on any failure."""
        body = await self._json(
            "POST",
            f"/engines/{engine_id}/process",
            json={"params": params, "input_files": input_files or {}},
        )
        job_id = body.get("job_id") if isinstance(body, dict) else None
        return str(job_id) if job_id else None

    async def job_status(self, job_id: str) -> Optional[dict[str, Any]]:
        return await self._json("GET", f"/jobs/{job_id}/status")

    async def job_result(self, job_id: str) -> Optional[dict[str, Any]]:
        return await self._json("GET", f"/jobs/{job_id}/result")

    async def run_job(
        self,
        engine_id: str,
        params: dict[str, Any],
        *,
        input_files: Optional[dict[str, str]] = None,
        poll_interval: float = 3.0,
        timeout: float = 600.0,
        on_update: Optional[JobUpdate] = None,
        job_id: Optional[str] = None,
    ) -> Optional[dict[str, Any]]:
        """Submit, poll until done, and return the /result body. Pass `job_id`
        to resume tracking an already-submitted job instead (no new charge).

        Returns None -- never raises -- on submission failure, a failed job, or
        timeout; `on_update` is told which ("failed" / "timeout") and why.
        """

        def emit(**update: Any) -> None:
            if on_update is None:
                return
            try:
                on_update(update)
            except Exception:  # a broken observer must not kill the job
                log.exception("job update callback failed")

        if self.mock_mode:
            emit(state="failed", error="client is in mock mode (no API key)")
            return None

        if job_id is None:
            job_id = await self.submit_job(engine_id, params, input_files)
            if not job_id:
                emit(state="failed", error="submission rejected or API unreachable")
                return None
            emit(state="queued", job_id=job_id)

        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        last = None
        while True:
            status = await self.job_status(job_id)
            state = str(status.get("status", "unknown")) if isinstance(status, dict) else "unreachable"
            progress = status.get("progress") if isinstance(status, dict) else None
            step = progress.get("step") if isinstance(progress, dict) else None
            if (state, step) != last:
                last = (state, step)
                log.info("%s job %s -> %s%s", engine_id, job_id, state, f" ({step})" if step else "")
                emit(state=state, job_id=job_id, step=step)

            if state == "completed":
                result = await self.job_result(job_id)
                if result is None:
                    emit(state="failed", job_id=job_id, error="completed but /result unreadable")
                return result
            if state in TERMINAL_FAILURE_STATES:
                error = None
                if isinstance(status, dict):
                    error = status.get("error") or status.get("message") or status.get("detail")
                emit(state="failed", job_id=job_id, error=str(error)[:200] if error else state)
                return None
            if loop.time() > deadline:
                emit(state="timeout", job_id=job_id, error=f"still '{state}' after {timeout:.0f}s")
                return None
            await asyncio.sleep(poll_interval)

    async def aclose(self) -> None:
        if self._http is not None:
            await self._http.aclose()
            self._http = None
        self.cache.close()

    # ---------------------------------------------------------------- internals

    def _client(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(base_url=self.base_url, timeout=self.timeout)
        return self._http

    def _auth_headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}

    async def _json(self, method: str, path: str, **kwargs: Any) -> Optional[dict[str, Any]]:
        """Authenticated JSON call with backoff on transient failures.

        Returns the decoded JSON object, or None on any failure (logged).
        """
        headers = {**self._auth_headers(), **kwargs.pop("headers", {})}
        for attempt in range(1, 4):
            try:
                resp = await self._client().request(method, path, headers=headers, **kwargs)
            except httpx.HTTPError as exc:
                log.warning("Moth %s %s failed (%r), attempt %d/3", method, path, exc, attempt)
                if attempt < 3:
                    await asyncio.sleep(2.0**attempt)
                    continue
                return None
            if resp.status_code in RETRYABLE_STATUS and attempt < 3:
                delay = _retry_after(resp, 2.0**attempt)
                log.warning("Moth %s %s -> %s, retrying in %.1fs", method, path, resp.status_code, delay)
                await asyncio.sleep(delay)
                continue
            if resp.is_error:
                log.warning("Moth %s %s -> %s: %s", method, path, resp.status_code, resp.text[:300])
                return None
            try:
                body = resp.json()
            except ValueError:
                log.warning("Moth %s %s returned non-JSON", method, path)
                return None
            return body if isinstance(body, dict) else None
        return None

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
        headers = {"Content-Type": "application/octet-stream", **self._auth_headers()}
        try:
            resp = await self._client().post(
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


def _retry_after(resp: httpx.Response, default: float) -> float:
    try:
        return min(30.0, float(resp.headers.get("Retry-After", default)))
    except ValueError:
        return default


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

    def submit(self, coro: Coroutine[Any, Any, Any]) -> Future:
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
