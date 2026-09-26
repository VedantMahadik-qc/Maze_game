"""PARKED -- NOT USED BY THE GAME. Nothing imports this file; server.py is the
local-only sampler. Kept so the real Moth Atlas bridge isn't lost. Importing or
running it does nothing unless ATLAS_BRIDGE_ENABLE=spend-credits is set, because
it submits labyrinth-v1 jobs (5 credits each) and polls Moth in the background.

Atlas bridge for Quantum Chase: a small FastAPI app in front of moth_client.

The game calls GET /api/labyrinth at every room entry and must never wait on
Atlas. labyrinth-v1 EMU jobs take seconds when Moth's queue is healthy, but
we've watched jobs sit in `build` for many minutes. So this server:

  * answers /api/labyrinth immediately, from real results already in memory,
  * runs Atlas jobs in the background on moth_client's MothWorker thread,
  * answers 503 (-> the game's labelled mock fallback) until a real result exists.

Every completed job's raw result is saved to atlas_samples/ and reloaded on
start, so a result that landed once keeps serving across restarts and offline.

One labyrinth-v1 job returns many measured shots (top_n bitstrings, one bit per
room/qubit). Each reshuffle serves one shot: edge sign = Z_a * Z_b for that
shot, i.e. +1 when both rooms measured the same (open corridor), -1 otherwise
(wall). Proximity biases which shot is drawn: calm -> the most probable
states, hunted -> the long tail.

Run:   .venv\\Scripts\\python server.py      ->  http://127.0.0.1:8000
Costs: labyrinth-v1 is 5 credits per job. Jobs are only submitted when there is
       no real sample for the requested mode yet (or on the in-game [J] key),
       capped by LABYRINTH_MAX_JOBS per server run.

Environment:
  MOTH_API_KEY            required for live calls (also read from the Windows
                          user environment, so `setx` works without a new shell)
  MOTH_API_BASE           default https://api.mothquantum.com/api/v1
  LABYRINTH_LIVE=0        never call Atlas; serve saved samples only
  LABYRINTH_MAX_JOBS      default 4 submissions per run (LABYRINTH_MAX_QPU_JOBS: 1)
  LABYRINTH_JOB_TIMEOUT   seconds before giving up on a job, default 1800
  LABYRINTH_FRACTION      optional ZZ prep strength (engine default 1/3)
  IBM_QUANTUM_TOKEN / IBM_QUANTUM_INSTANCE   optional, forwarded for mode=qpu
"""

from __future__ import annotations

import os as _os

if _os.environ.get("ATLAS_BRIDGE_ENABLE") != "spend-credits":
    raise SystemExit(
        "atlas_bridge_parked.py is disabled: the game runs 100% locally (server.py). "
        "Set ATLAS_BRIDGE_ENABLE=spend-credits only if you deliberately want live Moth calls."
    )

import json
import logging
import os
import random
import sys
import threading
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

log = logging.getLogger("atlas-bridge")

ROOT = Path(__file__).resolve().parent
SAMPLES_DIR = ROOT / "atlas_samples"
DIST_DIR = ROOT / "frontend" / "dist"

ENGINE_ID = "labyrinth-v1"
MODES = ("emu", "qpu")

# Level: 3x3 rooms, one qubit per room, row-major -- labyrinth-v1's own
# convention (GET /engines/labyrinth-v1). All 12 grid-adjacent pairs are
# coupled; the measurement decides which ones end up open.
ROWS, COLS = 3, 3
NUM_QUBITS = ROWS * COLS
COUPLING_MAP: list[list[int]] = []
for _n in range(NUM_QUBITS):
    if _n % COLS < COLS - 1:
        COUPLING_MAP.append([_n, _n + 1])
    if _n + COLS < NUM_QUBITS:
        COUPLING_MAP.append([_n, _n + COLS])
EDGE_KEYS = [tuple(e) for e in COUPLING_MAP]
LEVEL_DATA = {
    "name": "quantum-chase-3x3",
    "grid_size": {"rows": ROWS, "cols": COLS},
    "num_qubits": NUM_QUBITS,
    "coupling_map": COUPLING_MAP,
}


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


def load_api_key() -> Optional[str]:
    key = os.environ.get("MOTH_API_KEY")
    if key:
        return key.strip()
    if sys.platform == "win32":
        # `setx` only reaches *new* shells; read the user environment directly.
        try:
            import winreg

            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as k:
                value, _ = winreg.QueryValueEx(k, "MOTH_API_KEY")
                return str(value).strip() or None
        except OSError:
            return None
    return None


API_KEY = load_api_key()
LIVE = os.environ.get("LABYRINTH_LIVE", "1") != "0" and bool(API_KEY)
MAX_JOBS = _env_int("LABYRINTH_MAX_JOBS", 4)
MAX_QPU_JOBS = _env_int("LABYRINTH_MAX_QPU_JOBS", 1)
# Generous on purpose: giving up early on a slow queue and resubmitting would
# spend credits on a job that may still complete.
JOB_TIMEOUT = float(_env_int("LABYRINTH_JOB_TIMEOUT", 1800))
SHOTS = _env_int("LABYRINTH_SHOTS", 4096)
TOP_N = _env_int("LABYRINTH_TOP_N", 64)
FRACTION = os.environ.get("LABYRINTH_FRACTION")


def job_params(mode: str) -> dict[str, Any]:
    params: dict[str, Any] = {"level_data": LEVEL_DATA, "mode": mode, "shots": SHOTS, "top_n": TOP_N}
    if FRACTION:
        params["fraction"] = float(FRACTION)
    if mode == "qpu":
        for env, key in (("IBM_QUANTUM_TOKEN", "qpu_token"), ("IBM_QUANTUM_INSTANCE", "qpu_instance")):
            if os.environ.get(env):
                params[key] = os.environ[env]
    return params


# ---------------------------------------------------------------------------
# Parsing labyrinth-v1 results
#
# Confirmed: /jobs/{id}/result -> {"result": {"output": {...}}}; the output has
# `results.measurements[].bitstring` (engine code samples; qubit 0 LEFTMOST per
# the engine docs) and `target.edge_signs` (+1 corridor / -1 wall, per an
# earlier real run). NOT yet confirmed: the exact per-item shape of
# edge_signs and the weight field name on measurements -- so both parsers
# below accept the plausible variants and ignore anything they can't read.
# The raw JSON is always saved, so a wrong guess costs nothing but a re-parse.
# ---------------------------------------------------------------------------

_PAIR_KEYS = ("edge", "pair", "qubits", "nodes", "rooms", "between", "coupling")
_PAIR_KEY_PAIRS = (("a", "b"), ("u", "v"), ("i", "j"), ("q0", "q1"), ("source", "target"), ("from", "to"))
_VALUE_KEYS = ("zz", "expectation", "correlation", "value", "mean", "strength")
_WEIGHT_KEYS = ("probability", "prob", "p", "count", "counts", "frequency", "shots")


def _as_pair(value: Any) -> Optional[tuple[int, int]]:
    if isinstance(value, (list, tuple)) and len(value) == 2:
        try:
            a, b = int(value[0]), int(value[1])
        except (TypeError, ValueError):
            return None
    elif isinstance(value, str):
        digits = [int(t) for t in "".join(c if c.isdigit() else " " for c in value).split()]
        if len(digits) != 2:
            return None
        a, b = digits
    else:
        return None
    pair = (min(a, b), max(a, b))
    return pair if pair in EDGE_KEYS else None


def _as_sign(value: Any) -> Optional[int]:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return 1 if v > 0 else -1 if v < 0 else None


def _as_float(value: Any) -> Optional[float]:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return v if v == v else None  # drop NaN


def parse_edge_signs(raw: Any) -> dict[tuple[int, int], dict[str, Any]]:
    out: dict[tuple[int, int], dict[str, Any]] = {}

    def put(pair, sign, zz=None):
        if pair and sign:
            out[pair] = {"sign": sign, "zz": zz}

    if isinstance(raw, dict):
        for k, v in raw.items():
            pair = _as_pair(k)
            if isinstance(v, dict):
                put(pair, _as_sign(v.get("sign", v.get("value"))), next((_as_float(v[x]) for x in _VALUE_KEYS if x in v), None))
            else:
                put(pair, _as_sign(v))
    elif isinstance(raw, list):
        for idx, item in enumerate(raw):
            if isinstance(item, dict):
                pair = next((_as_pair(item[k]) for k in _PAIR_KEYS if k in item), None)
                if pair is None:
                    pair = next((_as_pair((item[x], item[y])) for x, y in _PAIR_KEY_PAIRS if x in item and y in item), None)
                sign = _as_sign(item.get("sign", item.get("value")))
                zz = next((_as_float(item[x]) for x in _VALUE_KEYS if x in item and x != "value"), None)
                put(pair, sign, zz)
            elif isinstance(item, (list, tuple)) and len(item) == 3:
                put(_as_pair(item[:2]), _as_sign(item[2]))
            elif idx < len(EDGE_KEYS):
                # UNVERIFIED: a bare list of signs, assumed in submitted coupling_map order.
                put(EDGE_KEYS[idx], _as_sign(item))
    return out


def parse_measurements(raw: Any) -> list[tuple[str, float]]:
    shots: list[tuple[str, float]] = []
    for m in raw if isinstance(raw, list) else []:
        bits, weight = None, 1.0
        if isinstance(m, dict):
            bits = m.get("bitstring", m.get("bits", m.get("state")))
            weight = next((_as_float(m[k]) for k in _WEIGHT_KEYS if k in m), None) or 1.0
        elif isinstance(m, (list, tuple)) and m:
            bits = m[0]
            weight = _as_float(m[1]) if len(m) > 1 else 1.0
        elif isinstance(m, str):
            bits = m
        bits = str(bits or "").replace(" ", "")
        if len(bits) == NUM_QUBITS and set(bits) <= {"0", "1"} and weight and weight > 0:
            shots.append((bits, float(weight)))
    total = sum(w for _, w in shots)
    return [(b, w / total) for b, w in shots] if total > 0 else []


def spins_of(bits: str) -> list[int]:
    return [1 if c == "0" else -1 for c in bits]  # |0> -> Z=+1, |1> -> Z=-1


def _find_url(obj: Any, depth: int = 0) -> Optional[str]:
    if depth > 4:
        return None
    if isinstance(obj, str):
        return obj if obj.startswith(("http://", "https://")) else None
    items = obj.values() if isinstance(obj, dict) else obj if isinstance(obj, list) else ()
    for v in items:
        url = _find_url(v, depth + 1)
        if url:
            return url
    return None


async def run_labyrinth_job(client, mode: str, on_update, job_id: Optional[str] = None) -> Optional[dict[str, Any]]:
    """run_job, plus: if the result points at a presigned download instead of
    inlining the JSON (as retrocausal-echo-v1's outputs do -- UNVERIFIED for
    labyrinth-v1), fetch it right away, since those links expire in minutes."""
    raw = await client.run_job(
        ENGINE_ID, job_params(mode), poll_interval=3.0, timeout=JOB_TIMEOUT, on_update=on_update, job_id=job_id
    )
    if raw is None or SampleSet.from_record({"raw": raw, "mode": mode}, fresh=True) is not None:
        return raw
    url = _find_url(raw.get("result", raw))
    if not url:
        return raw
    import httpx

    try:
        async with httpx.AsyncClient(timeout=30) as http:  # presigned: no Moth auth header
            resp = await http.get(url)
            resp.raise_for_status()
            return {"result": {"output": resp.json()}, "envelope": raw}
    except Exception as exc:
        log.warning("could not fetch linked labyrinth output: %r", exc)
        return raw


@dataclass
class SampleSet:
    """One completed labyrinth-v1 job, ready to serve."""

    mode: str
    job_id: str
    completed_at: str
    fresh: bool
    shots: list[tuple[str, float]]
    consensus: Optional[dict[tuple[int, int], int]]  # from target.edge_signs, if complete
    zz: dict[tuple[int, int], float] = field(default_factory=dict)
    last_index: int = -1

    @classmethod
    def from_record(cls, record: dict[str, Any], fresh: bool) -> Optional["SampleSet"]:
        raw = record.get("raw")
        result = raw.get("result", raw) if isinstance(raw, dict) else None
        output = result.get("output", result) if isinstance(result, dict) else None
        if not isinstance(output, dict):
            return None
        target = output.get("target") if isinstance(output.get("target"), dict) else {}
        results = output.get("results") if isinstance(output.get("results"), dict) else {}

        edges = parse_edge_signs(target.get("edge_signs", output.get("edge_signs")))
        consensus = {k: v["sign"] for k, v in edges.items()} if len(edges) == len(EDGE_KEYS) else None
        shots = parse_measurements(results.get("measurements", output.get("measurements")))
        if not shots and not consensus:
            return None

        # <ZZ> per edge over the measured (top-N) states; fall back to any
        # correlation values edge_signs itself carried.
        zz: dict[tuple[int, int], float] = {}
        if shots:
            for a, b in EDGE_KEYS:
                zz[(a, b)] = sum(p * (1 if bits[a] == bits[b] else -1) for bits, p in shots)
        else:
            zz = {k: v["zz"] for k, v in edges.items() if v.get("zz") is not None}

        return cls(
            mode=str(record.get("mode", "emu")),
            job_id=str(record.get("job_id", "?")),
            completed_at=str(record.get("completed_at", "")),
            fresh=fresh,
            shots=shots,
            consensus=consensus,
            zz=zz,
        )

    def draw(self, proximity: float) -> dict[str, Any]:
        """One maze state. Calm draws favour the most probable measured
        states; the closer the demon, the flatter the distribution."""
        if not self.shots:
            signs = self.consensus or {}
            return {
                "sample": {"kind": "edge_signs", "index": 0, "count": 1},
                "signs": signs,
                "spins": None,
            }
        beta = 1.5 - 1.3 * max(0.0, min(1.0, proximity))
        weights = [p**beta for _, p in self.shots]
        idx = random.choices(range(len(self.shots)), weights=weights)[0]
        if idx == self.last_index and len(self.shots) > 1:
            idx = random.choices(range(len(self.shots)), weights=weights)[0]
        self.last_index = idx
        bits, prob = self.shots[idx]
        s = spins_of(bits)
        return {
            "sample": {"kind": "shot", "index": idx, "count": len(self.shots), "bitstring": bits, "probability": round(prob, 5)},
            "signs": {(a, b): s[a] * s[b] for a, b in EDGE_KEYS},
            "spins": s,
        }


# ---------------------------------------------------------------------------
# State: saved samples + background jobs
# ---------------------------------------------------------------------------


@dataclass
class JobState:
    state: str = "idle"  # idle | submitting | queued | processing | completed | failed | timeout
    job_id: Optional[str] = None
    step: Optional[str] = None
    error: Optional[str] = None
    started: float = 0.0
    reason: str = ""

    def public(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "job_id": self.job_id,
            "step": self.step,
            "error": self.error,
            "age_s": round(time.time() - self.started, 1) if self.started else None,
            "reason": self.reason,
        }


class Bridge:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.sets: dict[str, list[SampleSet]] = {m: [] for m in MODES}
        self.jobs: dict[str, JobState] = {m: JobState() for m in MODES}
        self.used = 0
        self.qpu_used = 0
        self.worker = None
        self.client_error: Optional[str] = None
        self._load_saved()
        if LIVE:
            try:
                from moth_client import MothWorker

                self.worker = MothWorker(api_key=API_KEY, mock_mode=False)
            except Exception as exc:  # the bridge still serves saved samples
                self.client_error = f"moth_client unavailable: {exc!r}"
                log.error(self.client_error)

    def _load_saved(self) -> None:
        if not SAMPLES_DIR.is_dir():
            return
        for path in sorted(SAMPLES_DIR.glob("labyrinth-*.json")):
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError) as exc:
                log.warning("skipping unreadable sample file %s: %s", path.name, exc)
                continue
            ss = SampleSet.from_record(record, fresh=False)
            if ss is None:
                log.warning("%s has no usable edge signs or measurements (raw kept for inspection)", path.name)
                continue
            if ss.mode in self.sets:
                self.sets[ss.mode].append(ss)
        for m in MODES:
            if self.sets[m]:
                log.info("loaded %d saved %s sample set(s)", len(self.sets[m]), m.upper())

    # -- jobs --

    def ensure_job(self, mode: str, reason: str, force: bool = False) -> str:
        """Start a background job for `mode` if allowed. Returns a status line."""
        if not LIVE:
            return "live Atlas calls disabled (no MOTH_API_KEY or LABYRINTH_LIVE=0)"
        if self.worker is None:
            return self.client_error or "Atlas client unavailable"
        with self.lock:
            st = self.jobs[mode]
            if st.state not in ("idle", "completed", "failed", "timeout", "cancelled"):
                return f"{mode.upper()} job already {st.state}"
            if self.sets[mode] and not force:
                return f"{mode.upper()} samples already available"
            if self.used >= MAX_JOBS:
                return f"job budget for this run used ({self.used}/{MAX_JOBS})"
            if mode == "qpu" and self.qpu_used >= MAX_QPU_JOBS:
                return f"QPU job budget for this run used ({self.qpu_used}/{MAX_QPU_JOBS})"
            self.used += 1
            if mode == "qpu":
                self.qpu_used += 1
            self.jobs[mode] = JobState(state="submitting", started=time.time(), reason=reason)

        log.info("submitting %s %s job (%s)", ENGINE_ID, mode.upper(), reason)
        self._track(mode)
        return f"submitted {mode.upper()} job ({reason})"

    def resume_pending(self) -> set[str]:
        """Pick up jobs a previous run submitted but never saw finish, instead
        of paying for new ones. Returns the modes being resumed."""
        resumed: set[str] = set()
        if self.worker is None:
            return resumed
        for mode in MODES:
            path = self._pending_path(mode)
            try:
                info = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            age = time.time() - float(info.get("submitted_at", 0))
            if not info.get("job_id") or age > 3 * 3600:
                path.unlink(missing_ok=True)
                continue
            with self.lock:
                self.jobs[mode] = JobState(
                    state="resuming", job_id=str(info["job_id"]), started=float(info["submitted_at"]), reason="resumed"
                )
            log.info("resuming %s job %s from a previous run (%.0f min old)", mode.upper(), info["job_id"], age / 60)
            self._track(mode, job_id=str(info["job_id"]))
            resumed.add(mode)
        return resumed

    def _track(self, mode: str, job_id: Optional[str] = None) -> None:
        coro = run_labyrinth_job(self.worker.client, mode, lambda u, m=mode: self._on_update(m, u), job_id=job_id)
        fut = self.worker.submit(coro)
        fut.add_done_callback(lambda f, m=mode: self._on_done(m, f))

    @staticmethod
    def _pending_path(mode: str) -> Path:
        return SAMPLES_DIR / f"pending-{mode}.json"

    def _on_update(self, mode: str, update: dict[str, Any]) -> None:
        with self.lock:
            st = self.jobs[mode]
            new_id = update.get("job_id")
            if new_id and st.job_id != new_id and update.get("state") == "queued":
                try:  # remember it, so a restart resumes rather than resubmits
                    SAMPLES_DIR.mkdir(exist_ok=True)
                    self._pending_path(mode).write_text(
                        json.dumps({"job_id": new_id, "mode": mode, "submitted_at": st.started or time.time()}),
                        encoding="utf-8",
                    )
                except OSError as exc:
                    log.warning("could not record pending job: %s", exc)
            st.state = str(update.get("state", st.state))
            st.job_id = new_id or st.job_id
            st.step = update.get("step", st.step)
            if update.get("error"):
                st.error = str(update["error"])

    def _on_done(self, mode: str, fut) -> None:
        if fut.cancelled():  # server shutting down: keep the pending file so the next run resumes
            with self.lock:
                self.jobs[mode].state = "cancelled"
            return
        try:
            raw = fut.result()
        except Exception as exc:  # a bug somewhere in the job coroutine
            raw = None
            with self.lock:
                self.jobs[mode].state = "failed"
                self.jobs[mode].error = repr(exc)[:200]
        if raw is None:
            with self.lock:
                st = self.jobs[mode]
                if st.state not in ("failed", "timeout"):
                    st.state = "failed"
                # A timed-out job may still finish on Moth's side: keep it for the next run.
                if st.state == "failed":
                    self._pending_path(mode).unlink(missing_ok=True)
            log.warning("%s %s job ended without a result: %s", ENGINE_ID, mode.upper(), self.jobs[mode].error)
            return
        self._pending_path(mode).unlink(missing_ok=True)

        job_id = self.jobs[mode].job_id or "unknown"
        record = {
            "engine": ENGINE_ID,
            "mode": mode,
            "job_id": job_id,
            "completed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "params": {k: v for k, v in job_params(mode).items() if k not in ("qpu_token", "qpu_instance")},
            "raw": raw,
        }
        try:
            SAMPLES_DIR.mkdir(exist_ok=True)
            path = SAMPLES_DIR / f"labyrinth-{mode}-{job_id}.json"
            path.write_text(json.dumps(record, indent=1), encoding="utf-8")
            log.info("saved real %s result to %s", mode.upper(), path.relative_to(ROOT))
        except OSError as exc:
            log.warning("could not save result: %s", exc)

        ss = SampleSet.from_record(record, fresh=True)
        with self.lock:
            st = self.jobs[mode]
            if ss is None:
                st.state = "failed"
                st.error = "result had no readable edge_signs or measurements (raw saved)"
                return
            st.state = "completed"
            self.sets[mode].append(ss)
        log.info("%s job %s: %d measured shots, edge_signs %s", mode.upper(), job_id, len(ss.shots),
                 "complete" if ss.consensus else "missing/partial")

    # -- serving --

    def pick(self, mode: str) -> Optional[SampleSet]:
        with self.lock:
            if self.sets[mode]:
                return self.sets[mode][-1]
            if mode == "qpu" and self.sets["emu"]:
                return self.sets["emu"][-1]  # clearly labelled as EMU in the response
        return None

    def status(self) -> dict[str, Any]:
        with self.lock:
            return {
                "engine": ENGINE_ID,
                "live": LIVE and self.worker is not None,
                "has_key": bool(API_KEY),
                "jobs": {m: self.jobs[m].public() for m in MODES},
                "samples": {m: len(self.sets[m]) for m in MODES},
                "budget": {"used": self.used, "max": MAX_JOBS},
            }

    def shutdown(self) -> None:
        if self.worker is not None:
            try:
                self.worker.shutdown()
            except Exception:
                pass


bridge: Optional[Bridge] = None


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global bridge
    bridge = Bridge()
    log.info("Atlas bridge up: key=%s live=%s saved emu=%d qpu=%d",
             "yes" if API_KEY else "NO", LIVE, len(bridge.sets["emu"]), len(bridge.sets["qpu"]))
    resumed = bridge.resume_pending()
    if not bridge.sets["emu"] and "emu" not in resumed:
        log.info(bridge.ensure_job("emu", "prewarm"))
    yield
    bridge.shutdown()


app = FastAPI(title="Quantum Chase Atlas bridge", lifespan=lifespan)


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"ok": True, **bridge.status()}


@app.get("/api/labyrinth/status")
def labyrinth_status() -> dict[str, Any]:
    return bridge.status()


@app.get("/api/labyrinth")
def labyrinth(mode: str = Query("emu"), proximity: float = Query(0.0)):
    mode = mode if mode in MODES else "emu"
    ss = bridge.pick(mode)
    note = ""
    if ss is None or (mode == "qpu" and ss.mode != "qpu"):
        note = bridge.ensure_job(mode, "on-demand")
    if ss is None:
        job = bridge.status()["jobs"][mode]
        detail = f"no real {mode.upper()} sample yet"
        if job["state"] not in ("idle",):
            detail += f" · job {job['state']}" + (f" ({job['step']})" if job.get("step") else "")
            if job.get("error"):
                detail += f": {job['error']}"
        elif note:
            detail += f" · {note}"
        return JSONResponse(status_code=503, content={"source": "none", "status": "pending", "detail": detail, "job": job})

    with bridge.lock:
        drawn = ss.draw(proximity)
    edges = [
        {"a": a, "b": b, "sign": drawn["signs"][(a, b)], "zz": round(ss.zz[(a, b)], 4) if (a, b) in ss.zz else None}
        for a, b in EDGE_KEYS
        if (a, b) in drawn["signs"]
    ]
    return {
        "source": "atlas",
        "engine": ENGINE_ID,
        "mode": ss.mode,
        "requested_mode": mode,
        "job_id": ss.job_id,
        "completed_at": ss.completed_at,
        "fresh": ss.fresh,
        "sample": drawn["sample"],
        "edges": edges,
        "spins": drawn["spins"],
    }


@app.post("/api/labyrinth/refresh")
def labyrinth_refresh(mode: str = Query("emu")) -> dict[str, Any]:
    mode = mode if mode in MODES else "emu"
    detail = bridge.ensure_job(mode, "manual [J]", force=True)
    return {"detail": detail, **bridge.status()["jobs"][mode]}


# Serve the built game too, so `python server.py` alone is a complete demo.
if DIST_DIR.is_dir():
    app.mount("/", StaticFiles(directory=DIST_DIR, html=True), name="game")


if __name__ == "__main__":
    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s", datefmt="%H:%M:%S")
    port = _env_int("PORT", 8000)
    print(f"\n  Quantum Chase Atlas bridge -> http://127.0.0.1:{port}  (game + /api)\n")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
