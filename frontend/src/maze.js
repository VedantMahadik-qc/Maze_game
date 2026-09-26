// Level graph, world layout, navigation and the local graph sampler.
//
// The house is a 4x4 grid of nodes q0..q15 (row-major), one qubit per node:
// q0 is the Foyer (start), q15 the Exit. Each node is two spaces:
//   * a HUB -- an open, exposed junction square the corridors run into, and
//   * a SAFE ROOM -- a small walled room built into the hub's north-west
//     corner, reached through a single doorway.
// The 24 grid-adjacent hub pairs are candidate corridors; every reshuffle
// gives each one a ZZ sign: +1 = open, -1 = sealed by a gate.
//
// The demon lives entirely in hubs and corridors -- safe rooms are not part
// of its navigation graph, so it can never enter one.
//
// Maze-state sources (both 100% local, no Moth calls of any kind):
//   1. GET /api/labyrinth -> server.py, an exact 16-qubit statevector circuit
//      simulation (24 ZZ edges, 1024 shots)
//   2. mockSample() -- a classical Ising Monte-Carlo stand-in with the same
//      output shape, used only when server.py isn't running. Every result
//      says which one it came from.

export const GRID_ROWS = 4;
export const GRID_COLS = 4;
export const NUM_QUBITS = GRID_ROWS * GRID_COLS;
export const START_NODE = 0;
export const EXIT_NODE = NUM_QUBITS - 1;

// World layout. Node spacing (PITCH) is 32: corridors are 18 long and 3 wide
// -- long enough to be a real dash between rooms, wide enough to read.
export const HUB_SIZE = 14;
export const HALF_HUB = HUB_SIZE / 2;
export const CORRIDOR_LEN = 18;
export const CORRIDOR_WIDTH = 3.0;
export const PITCH = HUB_SIZE + CORRIDOR_LEN;
export const WALL_HEIGHT = 3.2;
export const WALL_THICKNESS = 0.3;
export const DOOR_HEIGHT = 2.5;
export const ROOM_INNER = 4.4; // interior side length of a safe room
export const ROOM_DOOR_WIDTH = 1.9;

// Every reshuffle takes this long whether it comes from server.py or the
// in-browser fallback, so the room-entry beat feels the same either way.
export const TRANSITION_MS = 1200;
const FETCH_TIMEOUT_MS = 1000;
const OFFLINE_RETRY_MS = 15000;

export const NODE_CENTERS = Array.from({ length: NUM_QUBITS }, (_, n) => ({
  x: (n % GRID_COLS) * PITCH,
  z: Math.floor(n / GRID_COLS) * PITCH,
}));

export const EDGES = buildEdges();
export const COUPLING_MAP = EDGES.map((e) => [e.a, e.b]);
export const NODE_EDGES = Array.from({ length: NUM_QUBITS }, (_, n) =>
  EDGES.filter((e) => e.a === n || e.b === n)
);
const EDGE_BY_KEY = new Map(EDGES.map((e) => [e.key, e]));

function buildEdges() {
  const edges = [];
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const n = r * GRID_COLS + c;
      if (c + 1 < GRID_COLS) edges.push(makeEdge(edges.length, n, n + 1, true));
      if (r + 1 < GRID_ROWS) edges.push(makeEdge(edges.length, n, n + GRID_COLS, false));
    }
  }
  return edges;
}

// A corridor's two "portals" are the doorway midpoints on each hub's wall
// line; its rect is the walkable strip between them.
function makeEdge(id, a, b, horizontal) {
  const ca = NODE_CENTERS[a];
  const cb = NODE_CENTERS[b];
  const hw = CORRIDOR_WIDTH / 2;
  let portalA, portalB, rect;
  if (horizontal) {
    portalA = { x: ca.x + HALF_HUB, z: ca.z };
    portalB = { x: cb.x - HALF_HUB, z: cb.z };
    rect = { minX: portalA.x, maxX: portalB.x, minZ: ca.z - hw, maxZ: ca.z + hw };
  } else {
    portalA = { x: ca.x, z: ca.z + HALF_HUB };
    portalB = { x: cb.x, z: cb.z - HALF_HUB };
    rect = { minX: ca.x - hw, maxX: ca.x + hw, minZ: portalA.z, maxZ: portalB.z };
  }
  return { id, a, b, horizontal, portalA, portalB, rect, key: `${a}-${b}` };
}

export function edgeBetween(a, b) {
  return EDGE_BY_KEY.get(a < b ? `${a}-${b}` : `${b}-${a}`) ?? null;
}

export function otherEnd(edge, node) {
  return edge.a === node ? edge.b : edge.a;
}

export function nodeLabel(n) {
  return `q${n}`;
}

// ---- safe rooms ------------------------------------------------------------

// Each room sits in its hub's north-west corner, doorway on its east wall.
// `block` is the room plus its walls (what navigation must walk around) and
// `shoulder` is a waypoint just past its south-east corner.
export const ROOMS = NODE_CENTERS.map(makeRoom);

function makeRoom(c) {
  const t = WALL_THICKNESS / 2;
  const minX = c.x - HALF_HUB + t;
  const minZ = c.z - HALF_HUB + t;
  const maxX = minX + ROOM_INNER;
  const maxZ = minZ + ROOM_INNER;
  const eastWallX = maxX + t;
  const southWallZ = maxZ + t;
  const doorZ = (minZ + maxZ) / 2;
  return {
    inner: { minX, maxX, minZ, maxZ },
    center: { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 },
    eastWallX,
    southWallZ,
    doorZ,
    doorOut: { x: eastWallX + t + 0.8, z: doorZ },
    block: { minX: c.x - HALF_HUB, maxX: eastWallX + t, minZ: c.z - HALF_HUB, maxZ: southWallZ + t },
    shoulder: { x: eastWallX + t + 0.9, z: southWallZ + t + 0.9 },
  };
}

// ---- regions -------------------------------------------------------------------

// Safe room containing (x, z), or -1. `inset` shrinks the room, used as
// hysteresis so lingering in the doorway doesn't count as entering.
export function roomAt(x, z, inset = 0) {
  for (let n = 0; n < NUM_QUBITS; n++) {
    const r = ROOMS[n].inner;
    if (x >= r.minX + inset && x <= r.maxX - inset && z >= r.minZ + inset && z <= r.maxZ - inset) return n;
  }
  return -1;
}

export function hubAt(x, z) {
  for (let n = 0; n < NUM_QUBITS; n++) {
    const c = NODE_CENTERS[n];
    if (Math.abs(x - c.x) <= HALF_HUB && Math.abs(z - c.z) <= HALF_HUB) return n;
  }
  return -1;
}

export function corridorAt(x, z) {
  for (const e of EDGES) {
    const r = e.rect;
    if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ) return e;
  }
  return null;
}

// Always returns a region -- falls back to the nearest one for positions
// that drifted into a wall, so callers never have to handle "nowhere".
//   { kind: "room", node }  inside a safe room (safe)
//   { kind: "hub", node }   in a hub (exposed)
//   { kind: "corridor", edge }  in a corridor (exposed)
export function regionAt(x, z) {
  const rn = roomAt(x, z);
  if (rn >= 0) return { kind: "room", node: rn };
  const hn = hubAt(x, z);
  if (hn >= 0) return { kind: "hub", node: hn };
  const e = corridorAt(x, z);
  if (e) return { kind: "corridor", edge: e };

  let best = null;
  let bestD = Infinity;
  for (let i = 0; i < NUM_QUBITS; i++) {
    const c = NODE_CENTERS[i];
    const d = rectDistance(x, z, c.x - HALF_HUB, c.x + HALF_HUB, c.z - HALF_HUB, c.z + HALF_HUB);
    if (d < bestD) {
      bestD = d;
      best = { kind: "hub", node: i };
    }
  }
  for (const edge of EDGES) {
    const r = edge.rect;
    const d = rectDistance(x, z, r.minX, r.maxX, r.minZ, r.maxZ);
    if (d < bestD) {
      bestD = d;
      best = { kind: "corridor", edge };
    }
  }
  return best;
}

// Nodes a region touches, for the solvability guard.
export function regionNodes(region) {
  return region.kind === "corridor" ? [region.edge.a, region.edge.b] : [region.node];
}

function sameRegion(r1, r2) {
  if (r1.kind !== r2.kind) return false;
  return r1.kind === "corridor" ? r1.edge.id === r2.edge.id : r1.node === r2.node;
}

function rectDistance(x, z, minX, maxX, minZ, maxZ) {
  const dx = Math.max(minX - x, 0, x - maxX);
  const dz = Math.max(minZ - z, 0, z - maxZ);
  return Math.hypot(dx, dz);
}

// Liang-Barsky segment vs axis-aligned box in the xz-plane; `margin` inflates
// the box first.
export function segmentHitsBox(ax, az, bx, bz, box, margin = 0) {
  const minX = box.minX - margin;
  const maxX = box.maxX + margin;
  const minZ = box.minZ - margin;
  const maxZ = box.maxZ + margin;
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dz = bz - az;
  const clip = (pp, q) => {
    if (pp === 0) return q >= 0;
    const t = q / pp;
    if (pp < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return clip(-dx, ax - minX) && clip(dx, maxX - ax) && clip(-dz, az - minZ) && clip(dz, maxZ - az);
}

// ---- solvability guard ---------------------------------------------------------

const PATH_CACHE = new Map();

// Every simple path (as edge ids) from `start` to `exit` on the 4x4 grid
// (184 from corner to corner). Computed once per start node, then cached.
function pathsToExit(start, exit) {
  const key = `${start}>${exit}`;
  if (PATH_CACHE.has(key)) return PATH_CACHE.get(key);
  const out = [];
  const visited = new Set([start]);
  const stack = [];
  const dfs = (u) => {
    if (u === exit) {
      out.push(stack.slice());
      return;
    }
    for (const e of NODE_EDGES[u]) {
      const v = otherEnd(e, u);
      if (visited.has(v)) continue;
      visited.add(v);
      stack.push(e.id);
      dfs(v);
      stack.pop();
      visited.delete(v);
    }
  };
  dfs(start);
  PATH_CACHE.set(key, out);
  return out;
}

function reachableViaOpen(signs, fromNodes, exitNode) {
  const seen = new Set(fromNodes);
  const queue = [...fromNodes];
  while (queue.length) {
    const u = queue.shift();
    if (u === exitNode) return true;
    for (const e of NODE_EDGES[u]) {
      const v = otherEnd(e, u);
      if (signs[e.id] > 0 && !seen.has(v)) {
        seen.add(v);
        queue.push(v);
      }
    }
  }
  return false;
}

// If the exit can't be reached from the player's node(s) over open edges,
// open one route's worth of walls. The route is chosen AT RANDOM from all
// simple routes, weighted toward the ones needing the fewest flips (cheapest
// routes are ~3x likelier than routes one flip dearer), so the path that gets
// unsealed keeps changing instead of always being the same one.
export function enforceSolvable(signs, fromNodes, exitNode = EXIT_NODE, rand = Math.random) {
  const out = signs.slice();
  if (reachableViaOpen(out, fromNodes, exitNode)) return { signs: out, flipped: [] };

  const routes = [];
  for (const start of new Set(fromNodes)) {
    for (const path of pathsToExit(start, exitNode)) {
      routes.push({ path, cost: path.reduce((n, id) => n + (out[id] < 0 ? 1 : 0), 0) });
    }
  }
  if (!routes.length) return { signs: out, flipped: [] };

  const minCost = Math.min(...routes.map((r) => r.cost));
  const pool = routes.filter((r) => r.cost <= minCost + 2);
  const weights = pool.map((r) => Math.pow(0.35, r.cost - minCost));
  let roll = rand() * weights.reduce((a, b) => a + b, 0);
  let chosen = pool[pool.length - 1];
  for (let i = 0; i < pool.length; i++) {
    roll -= weights[i];
    if (roll <= 0) {
      chosen = pool[i];
      break;
    }
  }

  const flipped = [];
  for (const id of chosen.path) {
    if (out[id] < 0) {
      out[id] = 1;
      flipped.push(id);
    }
  }
  return { signs: out, flipped };
}

// ---- navigation ------------------------------------------------------------------
// Portal graph over the OPEN corridors: one point per corridor mouth. Safe
// rooms are deliberately absent, so nothing routed over this graph can enter
// one. A hub is convex except for its room block, so two points in a hub are
// joined directly unless that would cut through the block -- then the walk
// bends around its `shoulder` waypoint.

const DETOUR_MARGIN = 0.4;

function hubDetour(node, a, b) {
  const room = ROOMS[node];
  return segmentHitsBox(a.x, a.z, b.x, b.z, room.block, DETOUR_MARGIN) ? [room.shoulder] : [];
}

function legLength(a, via, b) {
  let len = 0;
  let px = a.x;
  let pz = a.z;
  for (const p of via) {
    len += Math.hypot(p.x - px, p.z - pz);
    px = p.x;
    pz = p.z;
  }
  return len + Math.hypot(b.x - px, b.z - pz);
}

// A point in a safe room navigates as the spot just outside its door.
function navPoint(x, z) {
  const region = regionAt(x, z);
  if (region.kind === "room") {
    const d = ROOMS[region.node].doorOut;
    return { region: { kind: "hub", node: region.node }, x: d.x, z: d.z };
  }
  return { region, x, z };
}

export function navPointOf(x, z) {
  const p = navPoint(x, z);
  return { x: p.x, z: p.z };
}

export function buildPortalGraph(signs) {
  const points = [];
  const byNode = Array.from({ length: NUM_QUBITS }, () => []);
  const byEdge = new Map();
  for (const e of EDGES) {
    if (signs[e.id] <= 0) continue;
    const iA = points.push({ x: e.portalA.x, z: e.portalA.z, node: e.a, edge: e.id }) - 1;
    const iB = points.push({ x: e.portalB.x, z: e.portalB.z, node: e.b, edge: e.id }) - 1;
    byNode[e.a].push(iA);
    byNode[e.b].push(iB);
    byEdge.set(e.id, [iA, iB]);
  }
  const adj = points.map(() => []);
  const link = (i, j, via) => {
    const w = legLength(points[i], via, points[j]);
    adj[i].push({ j, w, via });
    adj[j].push({ j: i, w, via: via.slice().reverse() });
  };
  for (const [iA, iB] of byEdge.values()) link(iA, iB, []);
  byNode.forEach((list, node) => {
    for (let i = 0; i < list.length; i++) {
      for (let k = i + 1; k < list.length; k++) {
        link(list[i], list[k], hubDetour(node, points[list[i]], points[list[k]]));
      }
    }
  });
  return { points, adj, byNode, byEdge };
}

// Portals reachable in one straight (or shoulder-bent) leg from a position.
// A sealed corridor has none -- anything inside it is stranded.
function anchors(graph, region, x, z) {
  if (region.kind === "corridor") {
    const ids = graph.byEdge.get(region.edge.id) ?? [];
    return ids.map((i) => ({ i, w: Math.hypot(graph.points[i].x - x, graph.points[i].z - z), via: [] }));
  }
  const pos = { x, z };
  return graph.byNode[region.node].map((i) => {
    const via = hubDetour(region.node, pos, graph.points[i]);
    return { i, w: legLength(pos, via, graph.points[i]), via };
  });
}

function dijkstra(graph, sources) {
  const n = graph.points.length;
  const dist = new Array(n).fill(Infinity);
  const prev = new Array(n).fill(-1);
  const prevVia = new Array(n).fill(null);
  const srcVia = new Array(n).fill(null);
  const done = new Array(n).fill(false);
  for (const { i, w, via } of sources) {
    if (w < dist[i]) {
      dist[i] = w;
      srcVia[i] = via;
    }
  }
  for (;;) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      if (!done[i] && dist[i] < best) {
        best = dist[i];
        u = i;
      }
    }
    if (u < 0) break;
    done[u] = true;
    for (const { j, w, via } of graph.adj[u]) {
      if (dist[u] + w < dist[j]) {
        dist[j] = dist[u] + w;
        prev[j] = u;
        prevVia[j] = via;
        srcVia[j] = null;
      }
    }
  }
  return { dist, prev, prevVia, srcVia };
}

// Waypoints from the source position through to portal `endI` (inclusive).
function routeTo(graph, dj, endI) {
  const chain = [];
  for (let i = endI; i >= 0; i = dj.prev[i]) chain.push(i);
  chain.reverse();
  const pts = [...(dj.srcVia[chain[0]] ?? []), graph.points[chain[0]]];
  for (let k = 1; k < chain.length; k++) {
    pts.push(...(dj.prevVia[chain[k]] ?? []), graph.points[chain[k]]);
  }
  return pts;
}

// Shortest walkable route from `from` to `to`: waypoints ending at `to`
// (or at the door, if `to` is inside a safe room), or null if walls
// separate them.
export function planPath(graph, from, to) {
  const f = navPoint(from.x, from.z);
  const t = navPoint(to.x, to.z);
  if (sameRegion(f.region, t.region)) {
    const via = f.region.kind === "hub" ? hubDetour(f.region.node, f, t) : [];
    return { points: [...via, { x: t.x, z: t.z }], length: legLength(f, via, t) };
  }
  const dj = dijkstra(graph, anchors(graph, f.region, f.x, f.z));
  let best = -1;
  let bestLen = Infinity;
  let bestVia = [];
  for (const a of anchors(graph, t.region, t.x, t.z)) {
    const total = dj.dist[a.i] + a.w;
    if (total < bestLen) {
      bestLen = total;
      best = a.i;
      bestVia = a.via;
    }
  }
  if (best < 0) return null;
  return { points: [...routeTo(graph, dj, best), ...bestVia, { x: t.x, z: t.z }], length: bestLen };
}

// Walking distance from `from` to arbitrary points (Infinity if walled off).
export function distanceField(graph, from) {
  const f = navPoint(from.x, from.z);
  const dj = dijkstra(graph, anchors(graph, f.region, f.x, f.z));
  return (p) => {
    const t = navPoint(p.x, p.z);
    if (sameRegion(f.region, t.region)) {
      return legLength(f, f.region.kind === "hub" ? hubDetour(f.region.node, f, t) : [], t);
    }
    let best = Infinity;
    for (const a of anchors(graph, t.region, t.x, t.z)) best = Math.min(best, dj.dist[a.i] + a.w);
    return best;
  };
}

// False when the position is shut in: a corridor sealed at both ends, or a
// hub with every doorway sealed.
export function canLeave(graph, pos) {
  const f = navPoint(pos.x, pos.z);
  if (f.region.kind === "corridor") return graph.byEdge.has(f.region.edge.id);
  return graph.byNode[f.region.node].length > 0;
}

// Places the demon may materialize or patrol to: hub centres, three hub
// corners (the fourth is the safe room's), and points along every open
// corridor. Never inside a safe room.
export function spawnCandidates(signs) {
  const pts = [];
  const k = HALF_HUB - 1.8;
  for (const c of NODE_CENTERS) {
    pts.push({ x: c.x, z: c.z });
    for (const [sx, sz] of [[1, -1], [-1, 1], [1, 1]]) pts.push({ x: c.x + sx * k, z: c.z + sz * k });
  }
  for (const e of EDGES) {
    if (signs[e.id] <= 0) continue;
    for (const t of [0.25, 0.5, 0.75]) {
      pts.push({
        x: e.portalA.x + (e.portalB.x - e.portalA.x) * t,
        z: e.portalA.z + (e.portalB.z - e.portalA.z) * t,
      });
    }
  }
  return pts;
}

// ---- in-browser fallback sampler (used only when server.py is off) --------------------
// NOT the 16-qubit circuit -- that lives in server.py. This is a classical
// Metropolis Monte-Carlo of a 16-spin Ising model on the same coupling
// graph, one spin per node. A "shot" is a spin configuration; an edge's sign
// is s_a * s_b (that shot's ZZ outcome) and <ZZ> is averaged over shots.
// Proximity heats the model, so the house fragments harder the closer the
// demon is. Temperature, field strength and per-edge couplings are re-rolled
// on every call, so successive mazes differ a lot. Nothing quantum, nothing
// remote -- and the HUD labels it as the fallback whenever it is in use.

const MOCK_BURN_IN = 24;
export const MOCK_SHOTS = 64;

export function mockSample(proximity = 0, rand = Math.random) {
  const p = clamp01(proximity);
  const temperature = (2.0 + 2.4 * p) * Math.exp(0.22 * gauss(rand));
  const sigma = 0.6 + 0.9 * rand();
  const J = EDGES.map(() => Math.min(2, Math.max(-0.4, 1 + 0.45 * gauss(rand))));
  const field = Array.from({ length: NUM_QUBITS }, () => gauss(rand) * sigma);
  const s = Array.from({ length: NUM_QUBITS }, () => (rand() < 0.5 ? 1 : -1));

  const sweep = () => {
    for (let k = 0; k < NUM_QUBITS; k++) {
      const i = Math.floor(rand() * NUM_QUBITS);
      let h = field[i];
      for (const e of NODE_EDGES[i]) h += J[e.id] * s[otherEnd(e, i)];
      const dE = 2 * s[i] * h;
      if (dE <= 0 || rand() < Math.exp(-dE / temperature)) s[i] = -s[i];
    }
  };

  for (let i = 0; i < MOCK_BURN_IN; i++) sweep();
  const zzSum = new Array(EDGES.length).fill(0);
  for (let shot = 0; shot < MOCK_SHOTS; shot++) {
    sweep();
    for (const e of EDGES) zzSum[e.id] += s[e.a] * s[e.b];
  }
  const spins = s.slice();
  const signs = EDGES.map((e) => spins[e.a] * spins[e.b]);
  return {
    spins,
    signs,
    zz: zzSum.map((v) => v / MOCK_SHOTS),
    params: {
      model: "Ising Monte-Carlo (in-browser fallback)",
      temperature,
      sigma,
      shots: MOCK_SHOTS,
      walls: signs.filter((v) => v < 0).length,
    },
  };
}

function gauss(rand) {
  const u = Math.max(rand(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

function clamp01(v) {
  return Math.min(1, Math.max(0, Number(v) || 0));
}

// ---- server.py bridge (local) --------------------------------------------------------

let serverOfflineUntil = 0;

export function serverLooksOffline() {
  return performance.now() < serverOfflineUntil;
}

// One room-entry sample. Always resolves (never rejects) after exactly
// TRANSITION_MS: server.py's sample if it answered in time, otherwise the
// in-browser emulation, with the reason recorded.
export async function sampleLabyrinth({ proximity = 0 } = {}) {
  const [remote] = await Promise.all([fetchServerSample(proximity), delay(TRANSITION_MS)]);
  if (remote.ok) return { source: "server", ...remote.sample, fallbackReason: null, latencyMs: remote.latencyMs };

  const t0 = performance.now();
  const m = mockSample(proximity);
  return {
    source: "client",
    signs: m.signs,
    zz: m.zz,
    spins: m.spins,
    params: m.params,
    timing: { execMs: performance.now() - t0, budgetMs: null, within: true },
    fallbackReason: remote.reason,
    latencyMs: remote.latencyMs ?? null,
  };
}

async function fetchServerSample(proximity) {
  if (serverLooksOffline()) return { ok: false, reason: "server.py offline (retrying shortly)" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  const t0 = performance.now();
  try {
    const url = `/api/labyrinth?proximity=${clamp01(proximity).toFixed(3)}`;
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    const body = await res.json().catch(() => null);
    const latencyMs = performance.now() - t0;
    if (!body || typeof body !== "object") {
      // A non-JSON answer is the dev proxy's own error page: server.py isn't up.
      serverOfflineUntil = performance.now() + OFFLINE_RETRY_MS;
      return { ok: false, reason: `server.py unreachable (HTTP ${res.status})`, latencyMs };
    }
    if (!res.ok || body.source !== "server") {
      return { ok: false, reason: String(body.detail || `HTTP ${res.status}`), latencyMs };
    }
    const parsed = normalizeEdgeSigns(body.edges);
    if (!parsed) return { ok: false, reason: "server.py sent an unreadable edge list", latencyMs };
    const p = body.params && typeof body.params === "object" ? body.params : {};
    const t = body.timing && typeof body.timing === "object" ? body.timing : {};
    const num = (v) => (Number.isFinite(Number(v)) && v !== null ? Number(v) : null);
    return {
      ok: true,
      latencyMs,
      sample: {
        signs: parsed.signs,
        zz: parsed.zz,
        spins: validSpins(body.spins),
        params: {
          model: typeof p.model === "string" ? p.model : null,
          theta: num(p.theta),
          layers: num(p.layers),
          temperature: num(p.temperature),
          sigma: num(p.sigma),
          shots: num(p.shots),
          walls: parsed.signs.filter((v) => v < 0).length,
        },
        timing: { execMs: num(t.exec_ms), budgetMs: num(t.budget_ms), within: t.within_budget === true },
      },
    };
  } catch (err) {
    const latencyMs = performance.now() - t0;
    if (err && err.name === "AbortError") return { ok: false, reason: `server.py slow (>${FETCH_TIMEOUT_MS} ms)`, latencyMs };
    serverOfflineUntil = performance.now() + OFFLINE_RETRY_MS;
    return { ok: false, reason: "server.py unreachable", latencyMs };
  } finally {
    clearTimeout(timer);
  }
}

// Edge list -> signs/zz arrays in EDGES order. Null unless every one of the
// 24 edges has a valid +1/-1 sign.
export function normalizeEdgeSigns(list) {
  if (!Array.isArray(list)) return null;
  const signs = new Array(EDGES.length).fill(0);
  const zz = new Array(EDGES.length).fill(null);
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const e = edgeBetween(Number(item.a), Number(item.b));
    const s = Number(item.sign);
    if (!e || (s !== 1 && s !== -1)) continue;
    signs[e.id] = s;
    const z = Number(item.zz);
    zz[e.id] = item.zz !== null && Number.isFinite(z) ? z : null;
  }
  return signs.every((s) => s !== 0) ? { signs, zz } : null;
}

function validSpins(spins) {
  if (!Array.isArray(spins) || spins.length !== NUM_QUBITS) return null;
  return spins.every((s) => s === 1 || s === -1) ? spins.slice() : null;
}

// Small JSON GET against server.py that never throws: null on any failure.
// Shares the offline backoff with the sampler.
export async function localApiJson(path, timeoutMs = 1500) {
  if (serverLooksOffline()) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(path, { signal: ctrl.signal, cache: "no-store" });
    const body = await res.json().catch(() => null);
    if (!body || typeof body !== "object") {
      serverOfflineUntil = performance.now() + OFFLINE_RETRY_MS;
      return null;
    }
    return body;
  } catch (err) {
    if (!err || err.name !== "AbortError") serverOfflineUntil = performance.now() + OFFLINE_RETRY_MS;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
