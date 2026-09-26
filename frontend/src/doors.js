// Door dressing. Playtest note: an open gap in a wall didn't read as "a
// room with a door" and the exit's flat floor marker didn't read as "the
// way out" -- both needed actual door geometry. None of this is collision:
// room doorways stay fully walkable (the leaf is swung open, out of the
// path), and the exit door sits flush against the corridor collision wall
// that's already there, purely as a visual target for the win trigger.

import * as THREE from "three";
import { getRoomDoorways, getExitDoor, CELL_SIZE, WALL_HEIGHT, WALL_THICKNESS } from "./maze.js";

const DOOR_WIDTH = 1.7;
const DOOR_HEIGHT = 2.5;
const DOOR_THICKNESS = 0.1;
const FRAME_THICKNESS = 0.16;
const FRAME_DEPTH = WALL_THICKNESS + 0.05;

const frameMat = new THREE.MeshStandardMaterial({ color: 0x18181d, roughness: 0.7 });
const roomLeafMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1c, roughness: 0.6 });
const exitLeafMat = new THREE.MeshStandardMaterial({
  color: 0x0f3322,
  roughness: 0.4,
  emissive: 0x22ff88,
  emissiveIntensity: 0.6,
});

// Builds one door group in "N/S-side wall" local space (frame spans local
// X, normal along local Z) and yaws it 90 degrees for an E/W-side wall,
// per `doorway.facingNS` from maze.js.
function buildDoorGroup(doorway, { leafMat, leafOpenDeg, frameGlow = false }) {
  const group = new THREE.Group();
  group.position.set(doorway.x, 0, doorway.z);
  group.rotation.y = doorway.facingNS ? 0 : Math.PI / 2;

  const postGeo = new THREE.BoxGeometry(FRAME_THICKNESS, DOOR_HEIGHT + FRAME_THICKNESS, FRAME_DEPTH);
  const postMat = frameGlow
    ? new THREE.MeshStandardMaterial({ color: 0x18181d, roughness: 0.7, emissive: 0x114422, emissiveIntensity: 0.4 })
    : frameMat;
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(postGeo, postMat);
    post.position.set(side * (DOOR_WIDTH / 2 + FRAME_THICKNESS / 2), DOOR_HEIGHT / 2, 0);
    group.add(post);
  }
  const lintel = new THREE.Mesh(
    new THREE.BoxGeometry(DOOR_WIDTH + FRAME_THICKNESS * 2, FRAME_THICKNESS, FRAME_DEPTH),
    postMat
  );
  lintel.position.set(0, DOOR_HEIGHT + FRAME_THICKNESS / 2, 0);
  group.add(lintel);

  // Hinge pivot at the left post so rotating the pivot swings the leaf
  // like a real door instead of spinning it around its own center.
  const hinge = new THREE.Group();
  hinge.position.set(-DOOR_WIDTH / 2, DOOR_HEIGHT / 2, 0);
  hinge.rotation.y = THREE.MathUtils.degToRad(leafOpenDeg);
  const leaf = new THREE.Mesh(new THREE.BoxGeometry(DOOR_WIDTH * 0.96, DOOR_HEIGHT * 0.97, DOOR_THICKNESS), leafMat);
  leaf.position.set(DOOR_WIDTH / 2, 0, 0);
  hinge.add(leaf);
  group.add(hinge);

  return group;
}

// One open-leaf door per real room<->corridor doorway, purely decorative.
export function buildRoomDoorways(scene, house) {
  for (const doorway of getRoomDoorways(house)) {
    const group = buildDoorGroup(doorway, { leafMat: roomLeafMat, leafOpenDeg: -78 });
    scene.add(group);
  }
}

// The actual exit: a closed, glowing door on the house's outer wall. Returns
// its world position (offset slightly into the room off the wall plane) for
// use as the win-trigger anchor, so reaching it means walking up to the
// visible door rather than an arbitrary point in the room.
export function buildExitDoor(scene, house) {
  const doorway = getExitDoor(house);
  if (!doorway) return null;

  const group = buildDoorGroup(doorway, { leafMat: exitLeafMat, leafOpenDeg: 0, frameGlow: true });
  scene.add(group);

  const light = new THREE.PointLight(0x33ff99, 10, 8, 1.8);
  light.position.set(
    doorway.x - doorway.normalX * 0.6,
    WALL_HEIGHT * 0.6,
    doorway.z - doorway.normalZ * 0.6
  );
  scene.add(light);

  return {
    x: doorway.x - doorway.normalX * 1.0,
    z: doorway.z - doorway.normalZ * 1.0,
  };
}
