"""
Atlas engine contract probe -- Labyrinth, Retrocausal Echo, Telablur
=====================================================================

Standalone verification script for CLAUDE_CODE_PROMPT.md step 1. Its only
job is to find out, against the REAL Atlas API, what these three engines
actually are before any game code assumes a shape for them:

  - real engine IDs (the brief's `labyrinth` / `retrocausal-echo(-v1)` /
    `telablur(-v1)` are, at best, confirmed-to-exist or guessed slugs --
    see GAME_DESIGN_BRIEF.md's "confirmed vs. still guessed" table)
  - real parameter names
  - real request shape, in particular Telablur's two-image `input_files`

Strategy, cheapest-and-most-honest-first:

  1. Try a catalog/discovery endpoint (`GET /engines`, `GET /engines/{id}`)
     if the API exposes one. If it does, this answers everything at once
     with zero guessing and zero wasted job submissions.
  2. If there's no discovery endpoint, fall back to submitting a *minimal*
     probe job (empty or near-empty body) per engine-ID candidate and
     reading the validation error. Most JSON-schema-validated APIs name
     their required/unknown fields in a 4xx body, which is enough to
     learn the real parameter names without spending real compute on a
     wrong guess. Only once a probe body validates do we let it actually
     run to completion and inspect the real output shape.

This mirrors the AtlasClient lifecycle already proven working end-to-end
for `blur-v1` in ~/Downloads/decay_strip_output/decay.py (register asset,
presigned upload, complete, submit job, poll, fetch result) -- ported
here rather than reinvented, per the prompt's ground rules.

Requires MOTH_API_KEY in the environment. Makes real network calls and
may consume real Atlas quota/credits -- do not run this unattended.
"""

from __future__ import annotations

import argparse
import io
import json
import logging
import mimetypes
import os
import struct
import sys
import time
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

import requests

LOG: Final = logging.getLogger("probe")

DEFAULT_BASE_URL: Final[str] = "https://api.mothquantum.com/api/v1"
TERMINAL_FAILURE_STATES: Final[frozenset[str]] = frozenset({"failed", "cancelled", "error"})
RETRYABLE_STATUS: Final[frozenset[int]] = frozenset({408, 429, 500, 502, 503, 504})

# Guessed slugs from GAME_DESIGN_BRIEF.md -- explicitly marked as guesses
# there (extrapolated from the blur-v1 / tessa-image-v1 naming pattern).
# Never treated as correct until a probe below confirms one of them.
ENGINE_CANDIDATES: Final[dict[str, list[str]]] = {
    "labyrinth": ["labyrinth", "labyrinth-v1"],
    "retrocausal_echo": ["retrocausal-echo", "retrocausal-echo-v1"],
    "telablur": ["telablur", "telablur-v1"],
}


class AtlasError(RuntimeError):
    """Any non-recoverable failure talking to the Atlas API."""


class AtlasClient:
    """Thin client for the Atlas asynchronous asset-processing lifecycle.

    Ported from decay_strip_output/decay.py's AtlasClient (the one engine,
    blur-v1, we've actually exercised successfully end-to-end) rather than
    reinvented -- same retry/backoff, same error-body-preserving failures.
    """

    def __init__(
        self,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 30.0,
        max_retries: int = 3,
    ) -> None:
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._max_retries = max_retries
        self._session = requests.Session()
        self._session.headers.update({"Authorization": f"Bearer {api_key}"})

    def request(self, method: str, path: str, **kwargs: Any) -> requests.Response:
        """Authenticated call against the Atlas base URL, with backoff on
        transient failures. Does NOT raise on 4xx -- callers here want to
        read validation-error bodies, not just a status code."""
        url = f"{self._base_url}{path}"
        kwargs.setdefault("timeout", self._timeout)

        for attempt in range(1, self._max_retries + 1):
            try:
                resp = self._session.request(method, url, **kwargs)
            except requests.RequestException as exc:
                if attempt == self._max_retries:
                    raise AtlasError(f"{method} {url} failed after {attempt} attempts: {exc}") from exc
                delay = 2.0**attempt
                LOG.warning("%s %s raised %s -- retrying in %.1fs", method, path, exc, delay)
                time.sleep(delay)
                continue

            if resp.status_code in RETRYABLE_STATUS and attempt < self._max_retries:
                delay = float(resp.headers.get("Retry-After", 2.0**attempt))
                LOG.warning(
                    "%s %s -> %s -- retrying in %.1fs (attempt %d/%d)",
                    method, path, resp.status_code, delay, attempt, self._max_retries,
                )
                time.sleep(delay)
                continue

            return resp

        raise AtlasError(f"{method} {url} exhausted {self._max_retries} attempts")

    def upload_asset(self, name: str, payload: bytes, content_type: str) -> str:
        """Register, upload, and complete one asset. Returns its asset_id.
        Raises AtlasError -- unlike the probe helpers below, there's no
        useful "partial" outcome from a failed upload."""
        LOG.info("Registering asset %s (%s, %d bytes)", name, content_type, len(payload))
        resp = self.request(
            "POST", "/assets",
            json={"filename": name, "content_type": content_type, "size_bytes": len(payload)},
        )
        if not resp.ok:
            raise AtlasError(f"POST /assets -> {resp.status_code}\n{resp.text[:1000]}")
        body = resp.json()

        try:
            asset_id: str = body["asset_id"]
            upload: dict[str, Any] = body["upload"]
            upload_url: str = upload["url"]
        except KeyError as exc:
            raise AtlasError(f"Unexpected /assets response shape, missing {exc}: {body}") from exc

        put_resp = requests.request(
            upload.get("method", "PUT"), upload_url,
            headers=upload.get("headers", {}), data=payload, timeout=self._timeout,
        )
        if not put_resp.ok:
            raise AtlasError(f"Presigned upload -> {put_resp.status_code}\n{put_resp.text[:1000]}")

        complete = self.request("POST", f"/assets/{asset_id}/complete", json={})
        if not complete.ok:
            raise AtlasError(f"POST /assets/{asset_id}/complete -> {complete.status_code}\n{complete.text[:1000]}")

        LOG.info("Asset ready: %s", asset_id)
        return asset_id

    def wait_for_job(self, job_id: str, interval: float, timeout: float) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        last_status: str | None = None
        while True:
            resp = self.request("GET", f"/jobs/{job_id}/status")
            if not resp.ok:
                raise AtlasError(f"GET /jobs/{job_id}/status -> {resp.status_code}\n{resp.text[:1000]}")
            body = resp.json()
            status = str(body.get("status", "unknown"))
            if status != last_status:
                LOG.info("  job %s -> %s", job_id, status)
                last_status = status
            if status == "completed":
                return body
            if status in TERMINAL_FAILURE_STATES:
                raise AtlasError(f"job {job_id} ended as '{status}': {body}")
            if time.monotonic() > deadline:
                raise AtlasError(f"job {job_id} still '{status}' after {timeout:.0f}s")
            time.sleep(interval)


def _png_chunk(tag: bytes, data: bytes) -> bytes:
    import zlib
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))


def _solid_png(width: int, height: int, rgb: tuple[int, int, int]) -> bytes:
    """A solid-color RGB PNG of the given size -- no external imaging lib needed."""
    import zlib
    r, g, b = rgb
    row = bytes([0]) + bytes((r, g, b)) * width  # filter byte + pixels
    raw = row * height
    idat = zlib.compress(raw)
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)  # color type 2 = RGB
    return b"\x89PNG\r\n\x1a\n" + _png_chunk(b"IHDR", ihdr) + _png_chunk(b"IDAT", idat) + _png_chunk(b"IEND", b"")


def _solid_mask_png(width: int, height: int, gray: int) -> bytes:
    """A solid-gray single-channel PNG of the given size, for Telablur's `mask`
    input -- gray=255 (white) means 'apply the effect everywhere'."""
    import zlib
    row = bytes([0]) + bytes([gray]) * width  # filter byte + pixels
    raw = row * height
    idat = zlib.compress(raw)
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)  # color type 0 = grayscale
    return b"\x89PNG\r\n\x1a\n" + _png_chunk(b"IHDR", ihdr) + _png_chunk(b"IDAT", idat) + _png_chunk(b"IEND", b"")


def _tiny_png() -> bytes:
    """1x1 white PNG -- just needs to be a structurally valid image, used only
    for the cheap STEP B contract probes (field names), not for a real result
    anyone would look at."""
    return _solid_png(1, 1, (255, 255, 255))


def _tiny_wav() -> bytes:
    """~0.1s of silence -- just needs to be a structurally valid WAV."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(8000)
        w.writeframes(b"\x00\x00" * 800)
    return buf.getvalue()


def probe_discovery(client: AtlasClient, all_candidates: list[str]) -> bool:
    """Try a catalog endpoint first. Returns True if it told us anything."""
    found_anything = False

    resp = client.request("GET", "/engines")
    print(f"\nGET /engines -> {resp.status_code}")
    if resp.ok:
        print(json.dumps(resp.json(), indent=2)[:4000])
        found_anything = True
    else:
        print(resp.text[:1000])

    for engine_id in all_candidates:
        resp = client.request("GET", f"/engines/{engine_id}")
        print(f"\nGET /engines/{engine_id} -> {resp.status_code}")
        if resp.ok:
            print(json.dumps(resp.json(), indent=2)[:4000])
            found_anything = True
        else:
            print(resp.text[:500])

    return found_anything


def probe_process_call(
    client: AtlasClient,
    engine_id: str,
    params: dict[str, Any],
    input_files: dict[str, str],
    label: str,
) -> dict[str, Any] | None:
    """POST /engines/{id}/process and print the full response body.

    Returns the parsed job-submission body on a 2xx (caller decides
    whether to poll it to completion), otherwise None.
    """
    body = {"params": params, "input_files": input_files}
    print(f"\n[{label}] POST /engines/{engine_id}/process")
    print(f"[{label}] request body: {json.dumps(body)}")
    resp = client.request("POST", f"/engines/{engine_id}/process", json=body)
    print(f"[{label}] -> {resp.status_code}")
    try:
        parsed = resp.json()
        print(f"[{label}] response body: {json.dumps(parsed, indent=2)[:4000]}")
    except ValueError:
        parsed = None
        print(f"[{label}] response body (non-JSON): {resp.text[:1000]}")

    if resp.status_code == 404:
        print(f"[{label}] 404 -> '{engine_id}' is not a real engine ID, or process route differs.")
        return None
    if not resp.ok:
        print(f"[{label}] non-2xx -- read the body above for required/unknown field names.")
        return None
    return parsed


def run_to_completion(client: AtlasClient, job_body: dict[str, Any], label: str, timeout: float) -> None:
    job_id = job_body.get("job_id") or job_body.get("id")
    if not job_id:
        print(f"[{label}] accepted but no job_id/id in body -- can't poll: {job_body}")
        return
    print(f"[{label}] polling job {job_id} ...")
    try:
        result = client.wait_for_job(str(job_id), interval=1.5, timeout=timeout)
        print(f"[{label}] job status body: {json.dumps(result, indent=2)[:4000]}")
    except AtlasError as exc:
        print(f"[{label}] job did not complete: {exc}")
        return

    resp = client.request("GET", f"/jobs/{job_id}/result")
    print(f"[{label}] GET /jobs/{job_id}/result -> {resp.status_code}")
    try:
        print(json.dumps(resp.json(), indent=2)[:4000])
    except ValueError:
        print(resp.text[:1000])


def poll_existing_job(client: AtlasClient, job_id: str, timeout: float) -> None:
    """Poll a job ID that was already submitted (e.g. by an earlier probe
    run) and print its full status body, then its full result body if it
    completed. Does not guess or assume which engine it belongs to."""
    label = f"poll:{job_id}"
    print(f"\n[{label}] GET /jobs/{job_id}/status (initial)")
    resp = client.request("GET", f"/jobs/{job_id}/status")
    print(f"[{label}] -> {resp.status_code}")
    try:
        body = resp.json()
        print(json.dumps(body, indent=2)[:4000])
    except ValueError:
        print(resp.text[:1000])
        return

    status = str(body.get("status", "unknown"))
    if status not in ("completed",) and status not in TERMINAL_FAILURE_STATES:
        try:
            body = client.wait_for_job(job_id, interval=2.0, timeout=timeout)
            print(f"[{label}] final status body: {json.dumps(body, indent=2)[:4000]}")
        except AtlasError as exc:
            print(f"[{label}] {exc}")
            return
        status = str(body.get("status", "unknown"))

    if status != "completed":
        print(f"[{label}] ended as '{status}' -- not fetching /result.")
        return

    resp = client.request("GET", f"/jobs/{job_id}/result")
    print(f"[{label}] GET /jobs/{job_id}/result -> {resp.status_code}")
    try:
        print(json.dumps(resp.json(), indent=2)[:4000])
    except ValueError:
        print(resp.text[:1000])


def submit_and_run(
    client: AtlasClient, engine_id: str, params: dict[str, Any],
    input_files: dict[str, str], label: str, timeout: float,
) -> None:
    """Submit a real job with caller-supplied (not guessed-here) params/
    input_files, and run it to completion. Used for --labyrinth-params-json
    and --telablur-submit once a probe has actually confirmed the shape."""
    result = probe_process_call(client, engine_id, params=params, input_files=input_files, label=label)
    if result:
        run_to_completion(client, result, label, timeout)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--job-timeout", type=float, default=120.0)
    parser.add_argument("--run-completed", action="store_true",
                         help="if a probe call validates (2xx), poll it to completion too")
    parser.add_argument("--poll", action="append", default=[], metavar="JOB_ID",
                         help="poll an already-submitted job ID and print its status/result "
                              "bodies, instead of (or in addition to) probing. Repeatable.")
    parser.add_argument("--skip-probes", action="store_true",
                         help="with --poll, skip steps A/B and only do the polling")
    parser.add_argument("--labyrinth-engine", default="labyrinth-v1",
                         help="engine ID to use with --labyrinth-params-json")
    parser.add_argument("--labyrinth-params-json", default=None,
                         help="JSON object of params to submit to labyrinth as a real job -- "
                              "only pass field names you actually saw required in a probe's "
                              "error body, not a guess. Prefer --labyrinth-params-file on "
                              "Windows/PowerShell, which mangles embedded double quotes when "
                              "forwarding args to a native exe.")
    parser.add_argument("--labyrinth-params-file", type=Path, default=None,
                         help="path to a JSON file containing the params object, as an "
                              "alternative to --labyrinth-params-json that avoids shell "
                              "quoting issues entirely")
    parser.add_argument("--telablur-engine", default="telablur-v1",
                         help="engine ID to use with --telablur-submit")
    parser.add_argument("--telablur-submit", action="store_true",
                         help="upload two real images and submit telablur under image1/image2 "
                              "keys (only meaningful once a probe confirmed those key names)")
    parser.add_argument("--telablur-image1", type=Path, default=None,
                         help="source image; if omitted along with --telablur-image2, a "
                              "48x48 solid-color pair is auto-generated so the morph is "
                              "actually visible in the result")
    parser.add_argument("--telablur-image2", type=Path, default=None)
    parser.add_argument("--telablur-mask", type=Path, default=None,
                         help="mask image (must match image1's dimensions per the engine's "
                              "own docs). Required if you supply your own images -- with no "
                              "images given at all, a matching solid-white mask is generated")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                         format="%(asctime)s %(levelname)-7s %(message)s", datefmt="%H:%M:%S")

    api_key = os.environ.get("MOTH_API_KEY")
    if not api_key:
        LOG.error("MOTH_API_KEY is not set -- refusing to guess at credentials.")
        return 2

    client = AtlasClient(api_key, base_url=args.base_url)
    all_candidates = [c for cands in ENGINE_CANDIDATES.values() for c in cands]

    for job_id in args.poll:
        poll_existing_job(client, job_id, args.job_timeout)

    if args.labyrinth_params_json is not None or args.labyrinth_params_file is not None:
        if args.labyrinth_params_file is not None:
            raw = args.labyrinth_params_file.read_text(encoding="utf-8")
        else:
            raw = args.labyrinth_params_json
        try:
            params = json.loads(raw)
        except json.JSONDecodeError as exc:
            LOG.error("Labyrinth params are not valid JSON: %s\nRaw: %r", exc, raw)
            return 2
        submit_and_run(client, args.labyrinth_engine, params, {},
                        f"labyrinth-submit:{args.labyrinth_engine}", args.job_timeout)

    if args.telablur_submit:
        have_custom_images = args.telablur_image1 and args.telablur_image2
        if bool(args.telablur_image1) != bool(args.telablur_image2):
            LOG.error("--telablur-image1 and --telablur-image2 must be given together")
            return 2

        if have_custom_images:
            img1_bytes = args.telablur_image1.read_bytes()
            img2_bytes = args.telablur_image2.read_bytes()
            ct1 = mimetypes.guess_type(args.telablur_image1.name)[0] or "application/octet-stream"
            ct2 = mimetypes.guess_type(args.telablur_image2.name)[0] or "application/octet-stream"
            name1, name2 = args.telablur_image1.name, args.telablur_image2.name
            if not args.telablur_mask:
                LOG.error(
                    "The job that failed did so on `no_mask_region` -- an all-transparent/"
                    "empty fallback mask, not a real one. With custom images we don't know "
                    "their pixel dimensions without an imaging library, so pass "
                    "--telablur-mask explicitly (must match image1's size, per the engine's "
                    "own docs above)."
                )
                return 2
            mask_bytes = args.telablur_mask.read_bytes()
            mask_ct = mimetypes.guess_type(args.telablur_mask.name)[0] or "application/octet-stream"
            mask_name = args.telablur_mask.name
        else:
            # Two visually distinct solid colors so the morph is actually
            # inspectable in the output, plus a matching solid-white mask
            # (per the engine docs: white = fully apply the effect).
            size = 48
            img1_bytes = _solid_png(size, size, (20, 30, 90))     # dark navy
            img2_bytes = _solid_png(size, size, (255, 140, 0))    # bright orange
            mask_bytes = _solid_mask_png(size, size, 255)         # solid white
            ct1 = ct2 = mask_ct = "image/png"
            name1, name2, mask_name = "probe_navy.png", "probe_orange.png", "probe_mask.png"

        try:
            image1_id = client.upload_asset(name1, img1_bytes, ct1)
            image2_id = client.upload_asset(name2, img2_bytes, ct2)
            mask_id = client.upload_asset(mask_name, mask_bytes, mask_ct)
        except AtlasError as exc:
            LOG.error("telablur asset upload failed: %s", exc)
            return 1
        submit_and_run(
            client, args.telablur_engine, {},
            {"image1": image1_id, "image2": image2_id, "mask": mask_id},
            f"telablur-submit:{args.telablur_engine}", args.job_timeout,
        )

    if args.skip_probes:
        return 0

    print("=" * 70)
    print("STEP A: discovery endpoints (zero-guess path)")
    print("=" * 70)
    have_discovery = probe_discovery(client, all_candidates)
    if have_discovery:
        print("\nDiscovery endpoint(s) returned real data above -- read that before "
              "trusting anything below; it supersedes guessed IDs/params.")

    print("\n" + "=" * 70)
    print("STEP B: minimal process-call probes (learn shape from validation errors)")
    print("=" * 70)

    # -- Labyrinth: brief gives no evidence it needs a file input at all
    # (ZZ-correlation-driven maze structure, not asset transformation).
    # Start with params-only; empty params first to surface required-field
    # errors, since we don't know the real field names.
    for engine_id in ENGINE_CANDIDATES["labyrinth"]:
        label = f"labyrinth:{engine_id}"
        result = probe_process_call(client, engine_id, params={}, input_files={}, label=label)
        if result and args.run_completed:
            run_to_completion(client, result, label, args.job_timeout)

    # -- Retrocausal Echo: audio-domain (multi-tap delay), so give it a
    # structurally valid tiny WAV under the most plausible input key.
    wav_bytes = _tiny_wav()
    try:
        audio_asset_id = client.upload_asset("probe.wav", wav_bytes, "audio/wav")
    except AtlasError as exc:
        print(f"\n[retrocausal_echo] could not upload probe audio asset: {exc}")
        audio_asset_id = None
    if audio_asset_id:
        for engine_id in ENGINE_CANDIDATES["retrocausal_echo"]:
            label = f"retrocausal_echo:{engine_id}"
            result = probe_process_call(
                client, engine_id, params={},
                input_files={"audio": audio_asset_id}, label=label,
            )
            if result and args.run_completed:
                run_to_completion(client, result, label, args.job_timeout)

    # -- Telablur: brief is explicit that this needs TWO images under
    # `input_files`, key names unknown. Try the two most obvious guesses
    # as separate attempts so the error for each is legible on its own.
    png_bytes = _tiny_png()
    try:
        image_a = client.upload_asset("probe_a.png", png_bytes, "image/png")
        image_b = client.upload_asset("probe_b.png", png_bytes, "image/png")
    except AtlasError as exc:
        print(f"\n[telablur] could not upload probe image assets: {exc}")
        image_a = image_b = None
    if image_a and image_b:
        key_guesses = [
            {"image_a": image_a, "image_b": image_b},
            {"from_image": image_a, "to_image": image_b},
            {"safe": image_a, "wrong": image_b},
            {"image1": image_a, "image2": image_b},
        ]
        for engine_id in ENGINE_CANDIDATES["telablur"]:
            for keys in key_guesses:
                label = f"telablur:{engine_id}:{'+'.join(keys)}"
                result = probe_process_call(client, engine_id, params={}, input_files=keys, label=label)
                if result and args.run_completed:
                    run_to_completion(client, result, label, args.job_timeout)

    print("\n" + "=" * 70)
    print("Done. Read every response body above -- 404s rule out an engine ID,")
    print("422/400 bodies should name the real required params/input_files keys.")
    print("Nothing here should be treated as confirmed until a call actually")
    print("returns 2xx end-to-end with output you can inspect.")
    print("=" * 70)
    return 0


if __name__ == "__main__":
    sys.exit(main())
