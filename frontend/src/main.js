import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { generateHouse, buildWallSegments, CELL_SIZE, WALL_HEIGHT } from "./maze.js";
import { buildRoomDoorways, buildExitDoor } from "./doors.js";
import { Decoherence } from "./decoherence.js";
import { Demon } from "./demon.js";
import "./style.css";

// ---- constants -------------------------------------------------------
const PLAYER_RADIUS = 0.35;
const WALK_SPEED = 4.2;
const SPRINT_SPEED = 7.0;
const EXIT_RADIUS = 1.2;

// Proximity is now a read of the demon's actual distance, not an abstract
// timer -- see playtest note: an invisible threat didn't feel like a threat,
// and a positioned entity gives the meter something spatial to correlate
// with. Rooms still fully protect (the demon structurally cannot enter one).
const CATCH_RADIUS = 1.1; // world units -- contact in a corridor ends the run
const PROXIMITY_MIN_DIST = 1.6; // at or closer than this (pre-catch), proximity reads 1
const PROXIMITY_MAX_DIST = 9; // at or beyond this, proximity reads 0
const PROXIMITY_EASE = 3; // per second, how fast the meter chases its target (avoids a twitchy bar)
const PROXIMITY_SAFE_DECAY = 0.9; // per second, how fast proximity drains once hidden in a room

// ---- state -------------------------------------------------------
let house, wallSegments, decoherence, demon;
let scene, camera, renderer, controls;
let corridorLight;
let proximity = 0;
let gameState = "menu"; // menu | playing | caught | escaped
let elapsed = 0;

const keys = { forward: false, back: false, left: false, right: false, sprint: false };
const clock = new THREE.Clock();

const blocker = document.getElementById("blocker");
const endScreen = document.getElementById("end-screen");
const endTitle = document.getElementById("end-title");
const proximityFill = document.getElementById("proximity-fill");

init();

function init() {
  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x05050a, 0.018);

  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  // three's lights are physical units (candela) as of this version -- the
  // old "intensity 1 looks like a lamp" defaults no longer apply. ACES +
  // an explicit exposure gets back a readable, still-moody image instead of
  // either crushed blacks or blown-out highlights.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;
  document.body.appendChild(renderer.domElement);

  controls = new PointerLockControls(camera, renderer.domElement);

  // Hemisphere light = the scene's baseline fill (no distance falloff), so
  // corridors read as dim rather than pitch black even away from any point
  // light. Point lights on top of that create the room/corridor contrast.
  const hemi = new THREE.HemisphereLight(0x8fa8ff, 0x1a140c, 1.4);
  scene.add(hemi);

  corridorLight = new THREE.PointLight(0xffe0b0, 18, 14, 1.8);
  corridorLight.position.set(0, WALL_HEIGHT - 0.3, 0);
  scene.add(corridorLight);

  buildHouse();
  decoherence = new Decoherence({ scene, roomLights: [], corridorLight });
  demon = new Demon(house, scene);

  const spawn = house.toWorld(house.startRoom.cx + 0.5, house.startRoom.cy + 0.5);
  camera.position.set(spawn.x, 1.6, spawn.z);
  // Modern PointerLockControls drives `controls.object` (the camera) directly
  // -- there's no separate rig object to parent into the scene anymore.

  wireInput();
  window.addEventListener("resize", onResize);

  if (import.meta.env.DEV) {
    // Dev-only inspection hook -- pointer lock can't be scripted, so this is
    // how a headless/automated check can move the camera and read state.
    window.__debug = { scene, camera, controls, demon, house, gameState: () => gameState };
  }

  requestAnimationFrame(loop);
}

function buildHouse() {
  house = generateHouse({ width: 10, height: 10 });
  wallSegments = buildWallSegments(house);

  const floorMat = new THREE.MeshStandardMaterial({ color: 0x24242c, roughness: 0.95 });
  const roomFloorMat = new THREE.MeshStandardMaterial({ color: 0x2a3a26, roughness: 0.9 });
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x36363f, roughness: 0.8 });

  const floorSize = Math.max(house.width, house.height) * CELL_SIZE;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(floorSize, floorSize), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set((house.width * CELL_SIZE) / 2, 0, (house.height * CELL_SIZE) / 2);
  floor.receiveShadow = true;
  scene.add(floor);

  // Tint room floors so a player can tell "safe" from "exposed" at a glance.
  for (const room of house.rooms) {
    const geo = new THREE.PlaneGeometry(CELL_SIZE * 2, CELL_SIZE * 2);
    const mesh = new THREE.Mesh(geo, roomFloorMat);
    mesh.rotation.x = -Math.PI / 2;
    // toWorld(cx, cy) already centers within cell cx,cy -- a 2x2 room
    // block's true center is a half-cell in from its corner, not a full
    // cell (that landed a half-cell off, visibly misaligning the floor
    // tint/lights from the actual open clearing).
    const center = house.toWorld(room.cx + 0.5, room.cy + 0.5);
    mesh.position.set(center.x, 0.01, center.z);
    scene.add(mesh);

    const light = new THREE.PointLight(0xcfe8ff, 26, 11, 1.6);
    light.position.set(center.x, WALL_HEIGHT - 0.4, center.z);
    scene.add(light);
  }

  // Every room<->corridor gap gets an actual open-door frame instead of
  // just reading as a hole in the wall; the exit gets a real closed,
  // glowing door on the house's outer wall instead of a flat floor marker.
  buildRoomDoorways(scene, house);
  house.exitWorld = buildExitDoor(scene, house);

  const wallGeo = new THREE.BoxGeometry(1, WALL_HEIGHT, 1);
  for (const seg of wallSegments) {
    const w = seg.maxX - seg.minX;
    const d = seg.maxZ - seg.minZ;
    const mesh = new THREE.Mesh(wallGeo, wallMat);
    mesh.scale.set(w, 1, d);
    mesh.position.set((seg.minX + seg.maxX) / 2, WALL_HEIGHT / 2, (seg.minZ + seg.maxZ) / 2);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
}

function wireInput() {
  document.addEventListener("click", () => {
    if (gameState === "menu" || gameState === "caught" || gameState === "escaped") {
      if (gameState !== "playing") resetGame();
      controls.lock();
    }
  });

  controls.addEventListener("lock", () => {
    blocker.classList.add("hidden");
    endScreen.classList.add("hidden");
    gameState = "playing";
  });
  controls.addEventListener("unlock", () => {
    if (gameState === "playing") {
      blocker.classList.remove("hidden");
      gameState = "menu";
    }
  });

  document.addEventListener("keydown", (e) => setKey(e.code, true));
  document.addEventListener("keyup", (e) => setKey(e.code, false));
}

function setKey(code, down) {
  switch (code) {
    case "KeyW":
    case "ArrowUp":
      keys.forward = down;
      break;
    case "KeyS":
    case "ArrowDown":
      keys.back = down;
      break;
    case "KeyA":
    case "ArrowLeft":
      keys.left = down;
      break;
    case "KeyD":
    case "ArrowRight":
      keys.right = down;
      break;
    case "ShiftLeft":
    case "ShiftRight":
      keys.sprint = down;
      break;
  }
}

function resetGame() {
  proximity = 0;
  elapsed = 0;
  decoherence.reset();
  demon.reset();
  const spawn = house.toWorld(house.startRoom.cx + 0.5, house.startRoom.cy + 0.5);
  camera.position.set(spawn.x, 1.6, spawn.z);
}

function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (gameState === "playing") {
    elapsed += dt;
    updatePlayer(dt);
    demon.update(dt, elapsed, camera.position, proximity);
    updateProximity(dt);
    decoherence.update(proximity, dt, elapsed);
    proximityFill.style.width = `${(proximity * 100).toFixed(1)}%`;
  }
  renderer.render(scene, camera);
}

function updatePlayer(dt) {
  const speed = keys.sprint ? SPRINT_SPEED : WALK_SPEED;
  const forwardInput = Number(keys.forward) - Number(keys.back);
  const strafeInput = Number(keys.right) - Number(keys.left);

  // Normalize diagonal input so strafing+forward isn't faster than either alone.
  const inputLen = Math.hypot(forwardInput, strafeInput) || 1;
  const forwardDist = (forwardInput / inputLen) * speed * dt;
  const strafeDist = (strafeInput / inputLen) * speed * dt;

  // moveForward/moveRight use the camera's actual look direction (its matrix
  // columns), so this stays correct regardless of pitch/yaw -- no hand-rolled
  // rotation math to get wrong. Resolved as two separate axis-moves (each
  // reverted independently on collision) so sliding along a wall works.
  tryMove(() => controls.moveForward(forwardDist));
  tryMove(() => controls.moveRight(strafeDist));

  corridorLight.position.set(camera.position.x, WALL_HEIGHT - 0.3, camera.position.z);

  if (house.exitWorld) {
    const distToExit = Math.hypot(camera.position.x - house.exitWorld.x, camera.position.z - house.exitWorld.z);
    if (distToExit < EXIT_RADIUS) endGame("escaped");
  }
}

function tryMove(applyFn) {
  const prevX = camera.position.x;
  const prevZ = camera.position.z;
  applyFn();
  if (collidesWithWalls(camera.position.x, camera.position.z)) {
    camera.position.x = prevX;
    camera.position.z = prevZ;
  }
}

// Circle-vs-AABB collision against every wall segment.
function collidesWithWalls(x, z) {
  for (const seg of wallSegments) {
    const closestX = Math.max(seg.minX, Math.min(x, seg.maxX));
    const closestZ = Math.max(seg.minZ, Math.min(z, seg.maxZ));
    const distX = x - closestX;
    const distZ = z - closestZ;
    if (distX * distX + distZ * distZ < PLAYER_RADIUS * PLAYER_RADIUS) return true;
  }
  return false;
}

function updateProximity(dt) {
  const cell = house.cellAtWorld(camera.position.x, camera.position.z);
  const inRoom = !!house.roomAt(cell.x, cell.y);

  if (inRoom) {
    // The demon can't enter a room at all, so this is a hard safety, not
    // just a slower build rate -- proximity always drains here.
    proximity = Math.max(0, proximity - PROXIMITY_SAFE_DECAY * dt);
    return;
  }

  const dist = demon.distanceTo(camera.position);
  const target = THREE.MathUtils.clamp(
    1 - (dist - PROXIMITY_MIN_DIST) / (PROXIMITY_MAX_DIST - PROXIMITY_MIN_DIST),
    0,
    1
  );
  // Ease toward the real distance-derived value instead of snapping to it,
  // so the meter/audio/visuals don't jitter with every small movement.
  proximity += (target - proximity) * Math.min(1, dt * PROXIMITY_EASE);

  if (dist < CATCH_RADIUS) endGame("caught");
}

function endGame(result) {
  gameState = result;
  controls.unlock();
  endTitle.textContent = result === "escaped" ? "YOU ESCAPED" : "IT CAUGHT YOU";
  endScreen.classList.remove("hidden");
  endScreen.classList.toggle("win", result === "escaped");
  blocker.classList.add("hidden");
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
