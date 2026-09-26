// Entry point: renderer, input, player movement/collision, the run state
// machine, and the core loop --
//   move out -> the demon hunts you through the hubs and corridors ->
//   duck into a safe room (it can't follow; it drops back to patrolling) ->
//   entering re-samples the corridors (local graph sampler) and refills
//   your stamina -> pick your moment and cross to the next room.
// Everything here is local: no Moth / Atlas calls of any kind.

import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import {
  EDGES,
  START_NODE,
  EXIT_NODE,
  ROOMS,
  WALL_THICKNESS,
  TRANSITION_MS,
  roomAt,
  regionAt,
  regionNodes,
  navPointOf,
  enforceSolvable,
  buildPortalGraph,
  sampleLabyrinth,
  localApiJson,
  segmentHitsBox,
} from "./maze.js";
import { buildWorld } from "./world.js";
import { Gates } from "./doors.js";
import { Demon } from "./demon.js";
import { Decoherence, FOG_DENSITY } from "./decoherence.js";
import { AudioEngine } from "./audio.js";
import { Hud } from "./hud.js";
import "./style.css";

// ---- tuning ----------------------------------------------------------------
const EYE_HEIGHT = 1.6;
const PLAYER_RADIUS = 0.35;
const WALK_SPEED = 4.2;
const SPRINT_SPEED = 7.0;
const MOVE_RESPONSE = 14; // 1/s: how quickly velocity catches up with input
const STAMINA_DRAIN = 0.24; // per second sprinting (~4 s from full)
const STAMINA_REGEN = 0.2;
const STAMINA_REGEN_SAFE = 0.75; // in a safe room: full again in ~1.5 s
const CATCH_RADIUS = 1.5;
const PROX_NEAR = 1.5; // proximity reads 1 at this distance...
const PROX_FAR = 16; // ...and 0 beyond this one
const PROX_EASE = 4;
const PROX_SAFE_EASE = 2.5; // how fast dread drains once you're in a safe room
const ENTER_INSET = 0.6; // must be this far inside a safe room to count as entering it
const RESHUFFLE_COOLDOWN = 0.8;
const BASE_FOV = 72;

// ---- state -----------------------------------------------------------------
const game = {
  phase: "menu", // menu | playing | paused | caught | escaped
  generation: 0, // bumps every run; async results from an old run are dropped
  elapsed: 0,
  proximity: 0,
  stamina: 1,
  exhausted: false,
  velocity: new THREE.Vector2(),
  currentRoom: START_NODE, // safe room the reshuffle trigger considers you inside, or -1
  region: null, // { kind: "room" | "hub" | "corridor", ... } under the player
  signs: EDGES.map(() => -1),
  graph: null,
  graphVersion: 0,
  spins: null,
  transition: null,
  cooldownUntil: 0,
  doorsOpenAt: null,
  hasMoved: false, // first WASD input wakes the demon
  demonAnnounced: false,
  reshuffles: 0,
  serverCount: 0,
  clientCount: 0,
  guardTotal: 0,
  flicker: 0,
  bob: 0,
};
const keys = { forward: false, back: false, left: false, right: false, sprint: false };
const eventCounts = {}; // demon event tally, for the dev hook

let renderer, scene, camera, controls, lantern, world, gates, demon, fx, audio, hud;
let colliders = [];
const clock = new THREE.Clock();
const _euler = new THREE.Euler(0, 0, 0, "YXZ");
const _shakeEuler = new THREE.Euler(0, 0, 0, "YXZ");
const _shakeQ = new THREE.Quaternion();
const _savedQ = new THREE.Quaternion();
const _savedP = new THREE.Vector3();

init();

function init() {
  renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  document.body.prepend(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x030306);
  scene.fog = new THREE.FogExp2(0x040409, FOG_DENSITY);

  camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.05, 150);
  camera.rotation.order = "YXZ";
  controls = new PointerLockControls(camera, renderer.domElement);
  controls.minPolarAngle = 0.12 * Math.PI;
  controls.maxPolarAngle = 0.88 * Math.PI;

  scene.add(new THREE.HemisphereLight(0x9fb0d8, 0x2a2016, 0.32));
  lantern = new THREE.PointLight(0xffd8a8, 6, 8.5, 1.7);
  scene.add(lantern);

  world = buildWorld(scene, renderer);
  gates = new Gates(scene);
  demon = new Demon(scene);
  fx = new Decoherence({ renderer, scene, camera });
  fx.setSize(window.innerWidth, window.innerHeight);
  audio = new AudioEngine();
  hud = new Hud();

  resetRun();
  wireInput();
  window.addEventListener("resize", onResize);

  pollLocalSampler();
  setInterval(pollLocalSampler, 5000);

  if (import.meta.env.DEV) {
    // Pointer lock can't be scripted, so automated checks drive the game here.
    window.__debug = {
      game,
      keys,
      camera,
      demon,
      renderer,
      eventCounts,
      // Push a hand-made edge state through the real apply path (guards included).
      applySigns: (signs) =>
        applySample({ source: "client", signs, zz: null, spins: null, params: {}, fallbackReason: "debug" }),
      start: startRun,
      teleport: (x, z) => camera.position.set(x, EYE_HEIGHT, z),
      look: (yaw) => camera.rotation.set(0, yaw, 0),
      // Advance the simulation by `seconds` at 60 Hz, then draw one frame --
      // hidden/background tabs get no requestAnimationFrame at all.
      tick: (seconds) => {
        for (let t = 0; t < seconds; t += 1 / 60) {
          simTime += 1 / 60;
          step(1 / 60, simTime);
        }
        renderFrame(simTime);
      },
    };
  }

  renderer.setAnimationLoop(loop);
}

// ---- runs --------------------------------------------------------------------

function resetRun() {
  game.generation++;
  game.elapsed = 0;
  game.proximity = 0;
  game.stamina = 1;
  game.exhausted = false;
  game.velocity.set(0, 0);
  game.currentRoom = START_NODE;
  game.signs = EDGES.map(() => -1); // un-sampled house: every corridor sealed
  game.graph = buildPortalGraph(game.signs);
  game.graphVersion++;
  game.spins = null;
  game.transition = null;
  game.cooldownUntil = 0;
  game.doorsOpenAt = null;
  game.hasMoved = false;
  game.demonAnnounced = false;
  game.reshuffles = 0;
  game.serverCount = 0;
  game.clientCount = 0;
  game.guardTotal = 0;
  game.flicker = 0;
  game.bob = 0;

  gates.reset();
  rebuildColliders();
  demon.reset();

  const start = ROOMS[START_NODE].center;
  camera.position.set(start.x, EYE_HEIGHT, start.z);
  camera.rotation.set(0, -Math.PI / 2, 0); // facing the room's doorway (east)
  camera.fov = BASE_FOV;
  camera.updateProjectionMatrix();

  game.region = regionAt(start.x, start.z);
  hud.setPlace(game.region);
  hud.setMeters(0, 1, false);
  hud.setEdges({ signs: game.signs, rawSigns: game.signs, zz: null, guardFlips: [], occupancyFlips: [], spins: null });
}

function startRun() {
  audio.start();
  resetRun();
  game.phase = "playing";
  controls.enabled = true;
  hud.hideOverlays();
  beginReshuffle();
}

function endRun(kind) {
  if (game.phase !== "playing") return;
  game.phase = kind;
  controls.enabled = false;
  clearKeys();
  hud.showTransition(false);
  if (kind === "caught") {
    game.proximity = 1;
    fx.pulse(1.5);
    audio.caught();
  } else {
    game.proximity = 0;
    fx.pulse(0.4);
    audio.escaped();
  }
  hud.setMeters(game.proximity, game.stamina, false);
  hud.showEnd(kind, [
    ["time", formatTime(game.elapsed)],
    ["reshuffles", String(game.reshuffles)],
    ["samples", `${game.serverCount} server · ${game.clientCount} in-browser`],
    ["guard flips", String(game.guardTotal)],
    ["demon speed", `${demon.speed.toFixed(1)} m/s`],
  ]);
}

// ---- the reshuffle -----------------------------------------------------------

function beginReshuffle() {
  if (game.transition) return;
  const gen = game.generation;
  game.transition = {};
  hud.showTransition(true);
  audio.sweep(TRANSITION_MS / 1000);
  fx.pulse(0.45);
  sampleLabyrinth({ proximity: game.proximity })
    .then((sample) => {
      if (gen === game.generation && (game.phase === "playing" || game.phase === "paused")) applySample(sample);
    })
    .catch((err) => console.warn("[maze] reshuffle failed, keeping current layout:", err))
    .finally(() => {
      if (gen !== game.generation) return;
      game.transition = null;
      game.cooldownUntil = game.elapsed + RESHUFFLE_COOLDOWN;
      hud.showTransition(false);
    });
}

function applySample(sample) {
  const p = camera.position;
  const signs = sample.signs.slice();

  // Occupancy guard: never seal a corridor (or doorway) the player is in.
  const occupancyFlips = [];
  for (const e of EDGES) {
    if (signs[e.id] < 0 && playerTouchesCorridor(e)) {
      signs[e.id] = 1;
      occupancyFlips.push(e.id);
    }
  }
  // Solvability guard: if q15 is unreachable, open a randomly chosen route.
  const { signs: solved, flipped } = enforceSolvable(signs, regionNodes(regionAt(p.x, p.z)), EXIT_NODE);

  const changes = gates.apply(solved);
  game.signs = solved;
  game.graph = buildPortalGraph(solved);
  game.graphVersion++;
  if (sample.spins) game.spins = sample.spins;
  game.reshuffles++;
  if (sample.source === "server") game.serverCount++;
  else game.clientCount++;
  game.guardTotal += flipped.length;
  rebuildColliders();
  if (game.doorsOpenAt == null) game.doorsOpenAt = game.elapsed;

  hud.setSample(sample);
  hud.setGuards(flipped, occupancyFlips, game.guardTotal);
  hud.setEdges({
    signs: solved,
    rawSigns: sample.signs,
    zz: sample.zz,
    guardFlips: flipped,
    occupancyFlips,
    spins: sample.spins,
  });

  // Make the shift unmistakable: banner, heavy clunk, gate slams, glitch.
  hud.flashCollapse();
  audio.clunk();
  for (const pt of nearestGatePoints(changes.closed, 3)) audio.slam(pt);
  fx.pulse(1.0);
}

function playerTouchesCorridor(e) {
  const r = e.rect;
  const pad = WALL_THICKNESS / 2 + 0.3;
  const box = e.horizontal
    ? { minX: r.minX - pad, maxX: r.maxX + pad, minZ: r.minZ, maxZ: r.maxZ }
    : { minX: r.minX, maxX: r.maxX, minZ: r.minZ - pad, maxZ: r.maxZ + pad };
  return circleHitsBox(camera.position.x, camera.position.z, PLAYER_RADIUS + 0.1, box);
}

function nearestGatePoints(edgeIds, max) {
  const p = camera.position;
  return edgeIds
    .map((id) => {
      const e = EDGES[id];
      const da = Math.hypot(e.portalA.x - p.x, e.portalA.z - p.z);
      const db = Math.hypot(e.portalB.x - p.x, e.portalB.z - p.z);
      return da < db ? { pt: e.portalA, d: da } : { pt: e.portalB, d: db };
    })
    .sort((a, b) => a.d - b.d)
    .slice(0, max)
    .map((x) => x.pt);
}

function rebuildColliders() {
  colliders = world.colliders.concat(gates.colliders());
}

// ---- per-frame ---------------------------------------------------------------

let simTime = 0;

function loop() {
  const dt = Math.min(clock.getDelta(), 0.05);
  simTime += dt;
  step(dt, simTime);
  renderFrame(simTime);
}

function step(dt, time) {
  if (game.phase === "playing") {
    game.elapsed += dt;
    updatePlayer(dt);
    updateLocation();
    if (game.phase === "playing") {
      updateDemon(dt, time);
      updateProximity(dt);
      audio.heartbeat(game.proximity, dt);
    }
  }

  game.flicker = game.transition ? Math.min(1, game.flicker + dt * 4) : Math.max(0, game.flicker - dt * 2.5);
  gates.update(dt, time);
  world.update(time, game.flicker, camera.position);
  fx.update(dt, time, game.proximity);
  const lanternFlicker = 1 - game.proximity * 0.45 * (0.5 + 0.5 * Math.sin(time * 31) * Math.sin(time * 13));
  lantern.intensity = 6 * lanternFlicker;
  lantern.position.set(camera.position.x, camera.position.y + 0.3, camera.position.z);

  camera.updateMatrixWorld();
  audio.updateListener(camera);
  hudTick(dt);
}

function isSafe() {
  return game.region.kind === "room";
}

function updatePlayer(dt) {
  const fwd = forwardXZ();
  const f = (keys.forward ? 1 : 0) - (keys.back ? 1 : 0);
  const s = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  let wx = fwd.x * f - fwd.z * s;
  let wz = fwd.z * f + fwd.x * s;
  const len = Math.hypot(wx, wz);
  const moving = len > 0;
  if (moving) {
    wx /= len;
    wz /= len;
    game.hasMoved = true; // first movement input wakes the demon
  }

  const sprinting = keys.sprint && moving && !game.exhausted && game.stamina > 0;
  if (sprinting) game.stamina = Math.max(0, game.stamina - STAMINA_DRAIN * dt);
  else game.stamina = Math.min(1, game.stamina + (isSafe() ? STAMINA_REGEN_SAFE : STAMINA_REGEN) * dt);
  if (game.stamina === 0) game.exhausted = true;
  else if (game.exhausted && game.stamina > 0.35) game.exhausted = false;

  const speed = sprinting ? SPRINT_SPEED : WALK_SPEED;
  const k = 1 - Math.exp(-MOVE_RESPONSE * dt);
  game.velocity.x += (wx * speed - game.velocity.x) * k;
  game.velocity.y += (wz * speed - game.velocity.y) * k;
  moveWithCollision(game.velocity.x * dt, game.velocity.y * dt);

  const hSpeed = game.velocity.length();
  game.bob += dt * hSpeed * 1.9;
  camera.position.y = EYE_HEIGHT + Math.sin(game.bob) * 0.045 * Math.min(1, hSpeed / WALK_SPEED);

  const targetFov = BASE_FOV + (sprinting ? 6 : 0);
  if (Math.abs(camera.fov - targetFov) > 0.05) {
    camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 8);
    camera.updateProjectionMatrix();
  }
}

function forwardXZ() {
  _euler.setFromQuaternion(camera.quaternion, "YXZ");
  return { x: -Math.sin(_euler.y), z: -Math.cos(_euler.y) };
}

// Sub-stepped circle-vs-AABB with push-out along the contact normal: slides
// along walls and can never get wedged inside a freshly closed gate.
function moveWithCollision(dx, dz) {
  const p = camera.position;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.12));
  for (let i = 0; i < steps; i++) {
    p.x += dx / steps;
    p.z += dz / steps;
    pushOut(p);
  }
}

function pushOut(p) {
  const r = PLAYER_RADIUS;
  for (let iter = 0; iter < 3; iter++) {
    let hit = false;
    for (const b of colliders) {
      const cx = Math.max(b.minX, Math.min(p.x, b.maxX));
      const cz = Math.max(b.minZ, Math.min(p.z, b.maxZ));
      const dx = p.x - cx;
      const dz = p.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      hit = true;
      if (d2 > 1e-12) {
        const d = Math.sqrt(d2);
        p.x += (dx / d) * (r - d);
        p.z += (dz / d) * (r - d);
      } else {
        const l = p.x - b.minX;
        const rt = b.maxX - p.x;
        const u = p.z - b.minZ;
        const dn = b.maxZ - p.z;
        const m = Math.min(l, rt, u, dn);
        if (m === l) p.x = b.minX - r;
        else if (m === rt) p.x = b.maxX + r;
        else if (m === u) p.z = b.minZ - r;
        else p.z = b.maxZ + r;
      }
    }
    if (!hit) break;
  }
}

// Tracks where the player is; stepping into a safe room (with hysteresis)
// is the trigger for every reshuffle, and the exit room ends the run.
function updateLocation() {
  const p = camera.position;
  const region = regionAt(p.x, p.z);
  game.region = region;
  hud.setPlace(region);

  if (game.currentRoom >= 0) {
    if (!(region.kind === "room" && region.node === game.currentRoom)) game.currentRoom = -1;
    return;
  }
  const n = roomAt(p.x, p.z, ENTER_INSET);
  if (n < 0) return;
  game.currentRoom = n;
  if (n === EXIT_NODE) {
    endRun("escaped");
    return;
  }
  if (!game.transition && game.elapsed >= game.cooldownUntil) beginReshuffle();
}

function updateDemon(dt, time) {
  const p = camera.position;
  const region = game.region;
  const ctx = {
    time,
    graph: game.graph,
    signs: game.signs,
    graphVersion: game.graphVersion,
    playerPos: p,
    playerNav: navPointOf(p.x, p.z),
    playerForward: forwardXZ(),
    playerSafe: region.kind === "room",
    playerHub: region.kind === "corridor" ? -1 : region.node,
    proximity: game.proximity,
  };
  // Wakes on the player's first movement input -- as soon as the first
  // sample has opened the house so there is somewhere for it to be.
  if (demon.state === "dormant" && game.hasMoved && game.doorsOpenAt != null) {
    const ev = demon.summon(ctx, 12);
    if (ev) {
      handleDemonEvents(ev);
      if (!game.demonAnnounced) {
        game.demonAnnounced = true;
        hud.toast("Something stirs in the corridors…", 3000);
      }
    }
  }
  handleDemonEvents(demon.update(dt, ctx));
}

function handleDemonEvents(events) {
  for (const ev of events) {
    eventCounts[ev.type] = (eventCounts[ev.type] || 0) + 1;
    switch (ev.type) {
      case "preEcho":
        audio.preEcho(ev.pos, ev.lead);
        hud.flashRetro("pre-echo");
        break;
      case "footstep":
        audio.footstep(ev.pos, (0.45 + 0.55 * game.proximity) * (ev.strength ?? 1));
        break;
      case "threshold":
        audio.threshold(ev.pos);
        hud.flashRetro("doorway");
        break;
      case "materialize":
        audio.materialize(ev.pos);
        fx.pulse(0.5);
        break;
      case "decohere":
        fx.pulse(0.35);
        break;
    }
  }
}

function updateProximity(dt) {
  const p = camera.position;
  // Safe rooms: the demon can't follow, so dread drains and no catch is possible.
  if (isSafe()) {
    game.proximity += (0 - game.proximity) * (1 - Math.exp(-PROX_SAFE_EASE * dt));
    return;
  }
  let target = 0;
  if (demon.present) {
    const d = demon.distanceTo(p);
    target = THREE.MathUtils.clamp(1 - (d - PROX_NEAR) / (PROX_FAR - PROX_NEAR), 0, 1);
    if (demon.canCatch && d < CATCH_RADIUS && lineOfSight(demon.pos, p)) {
      endRun("caught");
      return;
    }
  }
  game.proximity += (target - game.proximity) * (1 - Math.exp(-PROX_EASE * dt));
}

function lineOfSight(a, b) {
  for (const box of colliders) if (segmentHitsBox(a.x, a.z, b.x, b.z, box)) return false;
  return true;
}

function circleHitsBox(x, z, r, b) {
  const cx = Math.max(b.minX, Math.min(x, b.maxX));
  const cz = Math.max(b.minZ, Math.min(z, b.maxZ));
  return (x - cx) ** 2 + (z - cz) ** 2 < r * r;
}

let hudAcc = 0;
function hudTick(dt) {
  hudAcc += dt;
  if (hudAcc < 0.1) return;
  hudAcc = 0;
  hud.setMeters(game.proximity, game.stamina, game.exhausted);
  if (game.phase === "playing") audio.setIntensity(game.proximity);
  if (hud.telemetryOpen) {
    hud.setMarkers(
      hud.mapPoint(game.region),
      demon.present ? hud.mapPoint(regionAt(demon.pos.x, demon.pos.z)) : null
    );
  }
}

// Camera shake is applied only for the draw and undone right after, so it
// never leaks into movement or the controls' own orientation state.
function renderFrame(time) {
  const amp = game.phase === "playing" || game.phase === "caught" ? Math.min(1.5, fx.shake) : 0;
  if (amp < 0.002) {
    fx.render();
    return;
  }
  _savedQ.copy(camera.quaternion);
  _savedP.copy(camera.position);
  const n1 = Math.sin(time * 37.3) + Math.sin(time * 23.1 + 1.3);
  const n2 = Math.sin(time * 41.7 + 2.1) + Math.sin(time * 29.3 + 0.4);
  const n3 = Math.sin(time * 33.9 + 4.2) + Math.sin(time * 19.7 + 3.3);
  _shakeEuler.set(n1 * 0.006 * amp, n2 * 0.006 * amp, n3 * 0.004 * amp, "YXZ");
  _shakeQ.setFromEuler(_shakeEuler);
  camera.quaternion.multiply(_shakeQ);
  camera.position.x += n2 * 0.012 * amp;
  camera.position.y += n1 * 0.01 * amp;
  fx.render();
  camera.quaternion.copy(_savedQ);
  camera.position.copy(_savedP);
}

// ---- input -------------------------------------------------------------------

function wireInput() {
  hud.el.blocker.addEventListener("click", () => {
    startRun();
    safeLock();
  });
  hud.el.pause.addEventListener("click", () => safeLock());
  hud.el.end.addEventListener("click", () => {
    startRun();
    safeLock();
  });
  renderer.domElement.addEventListener("click", () => {
    if (game.phase === "playing" && !controls.isLocked) safeLock();
  });

  controls.addEventListener("lock", () => {
    if (game.phase === "paused") {
      game.phase = "playing";
      hud.hideOverlays();
    }
  });
  controls.addEventListener("unlock", () => {
    if (game.phase === "playing") pause("");
  });
  document.addEventListener("pointerlockerror", () => onLockFailed());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && game.phase === "playing") pause("");
  });
  window.addEventListener("blur", clearKeys);

  document.addEventListener("keydown", (e) => {
    if (e.code === "Tab") {
      e.preventDefault();
      if (!e.repeat) hud.toggleTelemetry();
      return;
    }
    if (!e.repeat && e.code === "KeyR" && game.phase !== "playing") {
      startRun();
      safeLock();
      return;
    }
    if (setKey(e.code, true)) e.preventDefault();
  });
  document.addEventListener("keyup", (e) => setKey(e.code, false));
}

function setKey(code, down) {
  switch (code) {
    case "KeyW":
    case "ArrowUp":
      keys.forward = down;
      return true;
    case "KeyS":
    case "ArrowDown":
      keys.back = down;
      return true;
    case "KeyA":
    case "ArrowLeft":
      keys.left = down;
      return true;
    case "KeyD":
    case "ArrowRight":
      keys.right = down;
      return true;
    case "ShiftLeft":
    case "ShiftRight":
      keys.sprint = down;
      return true;
  }
  return false;
}

function clearKeys() {
  for (const k of Object.keys(keys)) keys[k] = false;
}

function pause(note) {
  game.phase = "paused";
  clearKeys();
  hud.showPause(note);
}

// requestPointerLock returns a promise in current browsers, undefined in
// older ones, and may reject (e.g. re-locking too soon after Esc).
function safeLock() {
  try {
    const p = renderer.domElement.requestPointerLock();
    if (p && typeof p.catch === "function") p.catch(onLockFailed);
  } catch {
    onLockFailed();
  }
}

function onLockFailed() {
  if (game.phase === "playing" && !controls.isLocked) {
    pause("Mouse look needs pointer lock — click again to retry.");
  }
}

// ---- local sampler status --------------------------------------------------------

// server.py is the local graph sampler; the game runs fine without it (the
// in-browser copy takes over). Either way nothing leaves this machine.
async function pollLocalSampler() {
  const health = await localApiJson("/api/health");
  const online = !!(health && health.ok);
  hud.setSamplerLink(online);
  hud.setSamplerMenuStatus(
    online
      ? "Local graph sampler online (server.py) · no remote calls of any kind."
      : "server.py not running — using the built-in in-browser sampler (still 100% local).",
    online
  );
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  fx.setSize(window.innerWidth, window.innerHeight);
}

function formatTime(seconds) {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
