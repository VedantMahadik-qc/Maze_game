// The thing chasing the player. Per playtest feedback, a fully invisible
// "decoherence timer" didn't read as a threat -- it needs an actual position
// to run from. Still deliberately unmodeled (no rig, no animation beyond a
// slow spin): a capsule whose skin uses the same trick as quantum-3d-clerk's
// customer.js `cold static hum` tell (skinMat.emissive punched randomly each
// frame) rather than a new visual effect. That flicker is also the one
// concession to "emergent decoherence" from the original design -- it reads
// as a glitching presence, not a modeled monster.
//
// Movement: BFS over the maze's own corridor graph (no navmesh needed at
// this grid size), retargeted a few times a second at the player's current
// cell -- or, if the player is in a room, at the nearest real doorway, since
// the demon is not allowed to enter rooms. Rooms stay genuinely safe.

import * as THREE from "three";

const DEMON_HEIGHT = 2.1;
const DEMON_RADIUS = 0.3;
const DEMON_SPEED = 2.5;
const RETARGET_INTERVAL = 0.4;
const WAYPOINT_EPS = 0.15;

// Always-on baseline glow so it reads as a shape at a distance, independent
// of the proximity-scaled flicker below (which used to be the *only*
// source of emissive -- nearly invisible until proximity was already high).
const BASE_EMISSIVE_G = 0.12;
const BASE_EMISSIVE_B = 0.22;
const DEMON_LIGHT_BASE = 9; // candela, always on
const DEMON_LIGHT_EXTRA = 16; // added on top as proximity -> 1

const DIRS = [
  { dx: 0, dy: -1, wall: "N" },
  { dx: 1, dy: 0, wall: "E" },
  { dx: 0, dy: 1, wall: "S" },
  { dx: -1, dy: 0, wall: "W" },
];

export class Demon {
  constructor(house, scene) {
    this.house = house;
    this.speed = DEMON_SPEED;

    this.material = new THREE.MeshStandardMaterial({
      color: 0x0a0c14,
      roughness: 0.4,
      emissive: new THREE.Color(0, BASE_EMISSIVE_G, BASE_EMISSIVE_B),
    });
    const geo = new THREE.CapsuleGeometry(DEMON_RADIUS, DEMON_HEIGHT - DEMON_RADIUS * 2, 4, 8);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.castShadow = true;
    scene.add(this.mesh);

    // Playtest note: pure material flicker wasn't enough to see it coming
    // down a corridor -- a real light source is what actually sells "a
    // glowing thing is approaching," on top of the flicker for instability.
    this.light = new THREE.PointLight(0x33ccff, DEMON_LIGHT_BASE, 11, 1.7);
    scene.add(this.light);

    this._path = [];
    this._retargetTimer = 0;
    this._flickerTimer = 0;

    this.reset();
  }

  reset() {
    const spawn = this._spawnPosition();
    this.mesh.position.copy(spawn);
    this.light.position.set(spawn.x, spawn.y + 0.3, spawn.z);
    this._path = [];
    this._retargetTimer = 0;
  }

  _spawnPosition() {
    // Deep in the house, away from the start room, so the first encounter
    // comes after some exploration rather than at the spawn door.
    const far = this.house.exitRoom ?? this.house.rooms[this.house.rooms.length - 1];
    const c = this.house.toWorld(far.cx + 0.5, far.cy + 0.5); // true center of the 2x2 room block
    return new THREE.Vector3(c.x, DEMON_HEIGHT / 2, c.z);
  }

  distanceTo(worldPos) {
    return Math.hypot(this.mesh.position.x - worldPos.x, this.mesh.position.z - worldPos.z);
  }

  update(dt, elapsed, playerWorldPos, proximity) {
    this._retargetTimer -= dt;
    if (this._retargetTimer <= 0) {
      this._retargetTimer = RETARGET_INTERVAL;
      this._retarget(playerWorldPos);
    }
    this._advance(dt);
    this.light.position.set(this.mesh.position.x, this.mesh.position.y + 0.3, this.mesh.position.z);
    this.light.intensity = DEMON_LIGHT_BASE + proximity * DEMON_LIGHT_EXTRA;

    // Ported from customer.js: `skinMat.emissive.setRGB(0, rand<p?g:0, rand<p?b:0)`,
    // now added on top of the always-on baseline above rather than
    // replacing it, so between flicker spikes it stays visible instead of
    // dropping back toward black. Frequency and punch both climb with
    // proximity, so it visibly destabilizes as it closes in.
    this._flickerTimer -= dt;
    if (this._flickerTimer <= 0) {
      this._flickerTimer = 0.03 + Math.random() * 0.05;
      const p = 0.2 + proximity * 0.6;
      this.material.emissive.setRGB(
        0,
        BASE_EMISSIVE_G + (Math.random() < p ? 0.3 + proximity * 0.5 : 0),
        BASE_EMISSIVE_B + (Math.random() < p ? 0.5 + proximity * 0.5 : 0)
      );
    }

    this.mesh.rotation.y = elapsed * 0.6; // a slow spin reads as "wrong", not idle
  }

  _retarget(playerWorldPos) {
    const demonCell = this.house.cellAtWorld(this.mesh.position.x, this.mesh.position.z);
    const playerCell = this.house.cellAtWorld(playerWorldPos.x, playerWorldPos.z);
    const targetCell = resolveTargetCell(this.house, playerCell, demonCell);
    const path = bfsPath(this.house, demonCell, targetCell) ?? [];

    this._path = path.map((c) => {
      const w = this.house.toWorld(c.x, c.y);
      return new THREE.Vector3(w.x, DEMON_HEIGHT / 2, w.z);
    });
    if (this._path.length && this.mesh.position.distanceTo(this._path[0]) < WAYPOINT_EPS) {
      this._path.shift();
    }
  }

  _advance(dt) {
    if (!this._path.length) return;
    const target = this._path[0];
    const dir = new THREE.Vector3().subVectors(target, this.mesh.position);
    dir.y = 0;
    const dist = dir.length();
    if (dist < WAYPOINT_EPS) {
      this._path.shift();
      return;
    }
    dir.normalize();
    this.mesh.position.addScaledVector(dir, Math.min(this.speed * dt, dist));
  }
}

// If the player is hidden in a room, the demon can't follow them in -- it
// heads for the nearest cell that's actually connected to that room by an
// open wall (a real doorway), not just the geometrically nearest corridor
// cell, so it can't "cheat" through a wall it hasn't found a way around.
function resolveTargetCell(house, playerCell, demonCell) {
  const room = house.roomAt(playerCell.x, playerCell.y);
  if (!room) return playerCell;

  let best = null;
  let bestDist = Infinity;
  for (const [rx, ry] of room.cells) {
    const cell = house.cells[ry][rx];
    for (const d of DIRS) {
      if (cell[d.wall]) continue;
      const nx = rx + d.dx;
      const ny = ry + d.dy;
      if (nx < 0 || ny < 0 || nx >= house.width || ny >= house.height) continue;
      if (house.cells[ny][nx].room) continue;
      const dist = Math.hypot(nx - demonCell.x, ny - demonCell.y);
      if (dist < bestDist) {
        bestDist = dist;
        best = { x: nx, y: ny };
      }
    }
  }
  return best ?? demonCell;
}

// BFS over non-room cells only -- the demon's whole world is the corridor
// network, which is exactly the piece step 3 swaps for real labyrinth-v1
// connectivity (target.edge_signs) instead of the recursive backtracker.
function bfsPath(house, startCell, targetCell) {
  const { cells, width, height } = house;
  if (startCell.x === targetCell.x && startCell.y === targetCell.y) return [startCell];

  const key = (x, y) => `${x},${y}`;
  const visited = new Set([key(startCell.x, startCell.y)]);
  const queue = [[startCell]];

  while (queue.length) {
    const path = queue.shift();
    const cur = path[path.length - 1];
    const cell = cells[cur.y][cur.x];

    for (const d of DIRS) {
      if (cell[d.wall]) continue;
      const nx = cur.x + d.dx;
      const ny = cur.y + d.dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (cells[ny][nx].room) continue;
      const k = key(nx, ny);
      if (visited.has(k)) continue;
      visited.add(k);

      const nextPath = [...path, { x: nx, y: ny }];
      if (nx === targetCell.x && ny === targetCell.y) return nextPath;
      queue.push(nextPath);
    }
  }
  return null;
}
