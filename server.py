"""Local 16-qubit lattice sampler for Quantum Chase -- 100% offline, zero Moth calls.

This server never talks to Moth Atlas: no API key is read, no HTTP client is
imported, nothing is submitted or polled, and no credits can be spent. (The
old Atlas bridge is parked, disabled, in atlas_bridge_parked.py.)

At every room entry the game asks GET /api/labyrinth for a fresh maze state:
the 24 corridors of the 4x4 house, each with a ZZ-correlation sign
(+1 = open, -1 = sealed).

The sample is a real quantum circuit, simulated exactly on this CPU (a full
2^16-amplitude statevector in NumPy -- the same thing Qiskit Aer's
statevector backend does; it is an EMULATION, not a quantum computer):

    |0>^16 --H--> |+>^16, then two layers of
        RZZ(theta_e) on each of the 24 nearest-neighbour edges of the 4x4 grid
        RX(phi_q)    on each of the 16 qubits            (transverse field)
    then 1024 measurement shots in the Z basis.

<Z_a Z_b> is estimated per edge from the shots and its sign becomes the edge:
+1 correlated -> open corridor, -1 anti-correlated -> sealed. (For one pair
the circuit gives <ZZ> = sin(2 theta) sin(2 phi); the lattice adds
interference and frustration on top.) Every call re-rolls the per-edge
couplings, so successive mazes differ. Proximity (0..1) raises the coupling
strength -- the closer the demon, the stronger the entangling correlations --
and the share of anti-ferromagnetic (sealing) edges.

Run:   .venv\\Scripts\\python server.py     ->  http://127.0.0.1:8000
       (serves the built game from frontend/dist as well as /api)
"""

from __future__ import annotations

import math
import time
from pathlib import Path
from typing import Any

import numpy as np
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent
DIST_DIR = ROOT / "frontend" / "dist"

ENGINE = "local-16q-lattice-emulated"
ROWS, COLS = 4, 4
N = ROWS * COLS  # 16 qubits, one per room, row-major (q0 .. q15)

# Every grid-adjacent pair is a candidate corridor: 24 nearest-neighbour edges.
EDGES: list[tuple[int, int]] = []
for _n in range(N):
    if _n % COLS < COLS - 1:
        EDGES.append((_n, _n + 1))
    if _n + COLS < N:
        EDGES.append((_n, _n + COLS))
M = len(EDGES)
assert M == 24

SHOTS = 1024
LAYERS = 2
BUDGET_MS = 30.0

EDGE_A = np.array([a for a, _ in EDGES])
EDGE_B = np.array([b for _, b in EDGES])

# Basis-state tables, built once. Qubit q is bit q of the basis index
# (little-endian), so an RX on qubit q acts on axis 1 of reshape(-1, 2, 2**q).
_INDEX = np.arange(1 << N, dtype=np.uint32)
_Z = (1 - 2 * ((_INDEX[None, :] >> np.arange(N, dtype=np.uint32)[:, None]) & 1)).astype(np.int8)  # (16, 65536)
_ZZ = (_Z[EDGE_A] * _Z[EDGE_B]).astype(np.float32)  # (24, 65536): z_a * z_b of every basis state
_QUBIT_SHIFTS = np.arange(N, dtype=np.int64)


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def sample_circuit(proximity: float, rng: np.random.Generator | None = None) -> dict[str, Any]:
    """Run one 16-qubit circuit and read the 24 edge signs off 1024 shots."""
    t_start = time.perf_counter()
    rng = rng or np.random.default_rng()
    p = _clamp(proximity, 0.0, 1.0)

    # --- circuit parameters, re-rolled per call ---
    # rad; kept below the 2-layer over-rotation point so correlation strength
    # rises monotonically with proximity (single-pair |<ZZ>| = sin(2*theta)).
    theta_mag = 0.08 + 0.24 * p
    p_anti = 0.22 + 0.22 * p  # share of edges coupled anti-ferromagnetically (they seal)
    sign = np.where(rng.random(M) < p_anti, -1.0, 1.0)
    jitter = np.clip(1.0 + 0.25 * rng.standard_normal(M), 0.5, 1.5)
    theta = sign * theta_mag * jitter  # RZZ angle per edge
    phi = (math.pi / 4) * np.clip(1.0 + 0.2 * rng.standard_normal(N), 0.5, 1.5)  # RX angle per qubit

    # --- statevector simulation ---
    # exp(-i * sum_e theta_e Z_a Z_b) is diagonal: one phase per basis state.
    phase = np.exp(-1j * (theta.astype(np.float32) @ _ZZ)).astype(np.complex64)
    psi = np.full(1 << N, 1.0 / (1 << (N // 2)), dtype=np.complex64)  # H on every qubit
    for _ in range(LAYERS):
        psi *= phase
        for q in range(N):
            c = math.cos(phi[q] / 2.0)
            s = -1j * math.sin(phi[q] / 2.0)
            v = psi.reshape(1 << (N - 1 - q), 2, 1 << q)
            a = v[:, 0, :].copy()
            b = v[:, 1, :].copy()
            v[:, 0, :] = c * a + s * b
            v[:, 1, :] = s * a + c * b

    # --- measurement: 1024 Z-basis shots from the Born probabilities ---
    prob = psi.real.astype(np.float64) ** 2 + psi.imag.astype(np.float64) ** 2
    cdf = np.cumsum(prob)
    cdf /= cdf[-1]
    shots = np.minimum(np.searchsorted(cdf, rng.random(SHOTS)), (1 << N) - 1)
    z = (1 - 2 * ((shots[:, None] >> _QUBIT_SHIFTS) & 1)).astype(np.int8)  # (1024, 16), +1 for |0>
    zz = (z[:, EDGE_A] * z[:, EDGE_B]).mean(axis=0)  # <Z_a Z_b> per edge, from the shots

    edges = []
    walls = 0
    for i, (a_node, b_node) in enumerate(EDGES):
        value = float(zz[i])
        edge_sign = 1 if value > 0 else -1 if value < 0 else (1 if theta[i] >= 0 else -1)
        walls += edge_sign < 0
        edges.append({"a": a_node, "b": b_node, "sign": edge_sign, "zz": round(value, 4)})

    exec_ms = (time.perf_counter() - t_start) * 1000.0
    return {
        "source": "server",
        "engine": ENGINE,
        "edges": edges,
        "spins": z[0].astype(int).tolist(),  # one measured shot, for the map's up/down arrows
        "params": {
            "model": "16-qubit statevector circuit",
            "theta": round(float(theta_mag), 3),
            "layers": LAYERS,
            "shots": SHOTS,
            "anti_share": round(p_anti, 3),
            "walls": int(walls),
        },
        "timing": {
            "exec_ms": round(exec_ms, 1),
            "budget_ms": BUDGET_MS,
            "within_budget": exec_ms < BUDGET_MS,
        },
    }


# Warm up NumPy/BLAS so the first real request is as fast as the rest.
sample_circuit(0.3)

app = FastAPI(title="Quantum Chase local 16-qubit lattice sampler")


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"ok": True, "engine": ENGINE, "qubits": N, "edges": M, "remote_calls": False}


@app.get("/api/labyrinth")
def labyrinth(proximity: float = 0.0) -> dict[str, Any]:
    return sample_circuit(proximity)


# Serve the built game too, so `python server.py` alone is a complete demo.
if DIST_DIR.is_dir():
    app.mount("/", StaticFiles(directory=DIST_DIR, html=True), name="game")


if __name__ == "__main__":
    import uvicorn

    print("\n  Quantum Chase local 16-qubit sampler -> http://127.0.0.1:8000  (game + /api, no network calls)\n")
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="warning")
