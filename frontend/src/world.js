// Static house geometry for the 4x4 level: hubs, corridors, the safe rooms
// built into each hub's north-west corner, lights and the exit door. Every
// wall box doubles as a collision AABB. Textures are drawn procedurally on
// canvases, so the game ships with no binary assets, and all static geometry
// is merged per material (a handful of draw calls for the whole house).

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  NUM_QUBITS,
  NODE_CENTERS,
  EDGES,
  ROOMS,
  GRID_COLS,
  GRID_ROWS,
  HALF_HUB,
  HUB_SIZE,
  ROOM_INNER,
  ROOM_DOOR_WIDTH,
  CORRIDOR_WIDTH,
  WALL_HEIGHT,
  WALL_THICKNESS,
  DOOR_HEIGHT,
  EXIT_NODE,
  START_NODE,
  nodeLabel,
} from "./maze.js";

const T = WALL_THICKNESS;
const CASING = 0.12; // doorway trim width
const UV_SCALE = { wall: 2.4, floor: 3, roomFloor: 2.2, carpet: 2, ceiling: 3, trim: 1, strip: 1, lamp: 1, safe: 1 };

// Point-light reach is kept short on purpose: with the dense fog, only the
// hallway immediately around you is ever readable. With 16 hubs, a small
// pool of lights follows whichever hubs are nearest the player instead of
// one light per hub -- every extra live light costs every pixel.
const HUB_LIGHT = { intensity: 17, distance: 12, decay: 1.6 };
const HUB_LIGHT_POOL = 5;

export function buildWorld(scene, renderer) {
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const mats = {
    wall: new THREE.MeshStandardMaterial({ map: canvasTexture(256, drawWallpaper, 11, aniso), roughness: 0.93 }),
    floor: new THREE.MeshStandardMaterial({ map: canvasTexture(256, drawWoodFloor, 23, aniso), roughness: 0.78 }),
    roomFloor: new THREE.MeshStandardMaterial({ map: canvasTexture(256, drawSafeTiles, 53, aniso), roughness: 0.55 }),
    carpet: new THREE.MeshStandardMaterial({ map: canvasTexture(256, drawCarpet, 37, aniso), roughness: 1 }),
    ceiling: new THREE.MeshStandardMaterial({ map: canvasTexture(256, drawPlaster, 41, aniso), roughness: 1 }),
    trim: new THREE.MeshStandardMaterial({ color: 0x20160f, roughness: 0.55 }),
    strip: new THREE.MeshStandardMaterial({ color: 0x151310, emissive: 0xffd9a0, emissiveIntensity: 0.35 }),
    lamp: new THREE.MeshStandardMaterial({ color: 0x202020, emissive: 0xfff0d0, emissiveIntensity: 1.4 }),
    safe: new THREE.MeshStandardMaterial({ color: 0x0a140e, emissive: 0x4dffa0, emissiveIntensity: 1.6 }),
  };
  const buckets = Object.fromEntries(Object.keys(mats).map((k) => [k, []]));
  const colliders = [];

  const addBox = (mat, cx, cy, cz, w, h, d, collide) => {
    const geo = new THREE.BoxGeometry(w, h, d);
    geo.translate(cx, cy, cz);
    worldUV(geo, UV_SCALE[mat]);
    buckets[mat].push(geo);
    if (collide) colliders.push({ minX: cx - w / 2, maxX: cx + w / 2, minZ: cz - d / 2, maxZ: cz + d / 2 });
  };
  const addPlane = (mat, cx, y, cz, w, d, facingUp) => {
    const geo = new THREE.PlaneGeometry(w, d);
    geo.rotateX(facingUp ? -Math.PI / 2 : Math.PI / 2);
    geo.translate(cx, y, cz);
    worldUV(geo, UV_SCALE[mat]);
    buckets[mat].push(geo);
  };

  // A wall centred on `line`, running along `axis` ('x': along x at z=line,
  // 'z': along z at x=line) over [a, b], with an optional doorway
  // { c: centre, w: width } cut into it and trimmed with a casing.
  const wallRun = (axis, line, a, b, gap) => {
    const seg = (p, q, y0, y1, mat, collide, depth = T) => {
      const mid = (p + q) / 2;
      const len = q - p;
      const h = y1 - y0;
      if (axis === "x") addBox(mat, mid, (y0 + y1) / 2, line, len, h, depth, collide);
      else addBox(mat, line, (y0 + y1) / 2, mid, depth, h, len, collide);
    };
    if (!gap) {
      seg(a, b, 0, WALL_HEIGHT, "wall", true);
      return;
    }
    const g0 = gap.c - gap.w / 2;
    const g1 = gap.c + gap.w / 2;
    seg(a, g0, 0, WALL_HEIGHT, "wall", true);
    seg(g1, b, 0, WALL_HEIGHT, "wall", true);
    seg(g0, g1, DOOR_HEIGHT, WALL_HEIGHT, "wall", false); // lintel
    // Casing sits inside the wall ends and protrudes from both faces.
    seg(g0 - CASING, g0, 0, DOOR_HEIGHT + CASING, "trim", false, T + 0.08);
    seg(g1, g1 + CASING, 0, DOOR_HEIGHT + CASING, "trim", false, T + 0.08);
    seg(g0, g1, DOOR_HEIGHT, DOOR_HEIGHT + CASING, "trim", false, T + 0.08);
  };

  for (let n = 0; n < NUM_QUBITS; n++) {
    const c = NODE_CENTERS[n];
    const room = ROOMS[n];
    const row = Math.floor(n / GRID_COLS);
    const col = n % GRID_COLS;
    const lo = -HALF_HUB - T / 2;
    const hi = HALF_HUB + T / 2;
    const doorZ = (has) => (has ? { c: c.z, w: CORRIDOR_WIDTH } : null);
    const doorX = (has) => (has ? { c: c.x, w: CORRIDOR_WIDTH } : null);

    // Hub: floor, ceiling, four walls with a corridor doorway where a neighbour exists.
    addPlane("floor", c.x, 0, c.z, HUB_SIZE, HUB_SIZE, true);
    addPlane("ceiling", c.x, WALL_HEIGHT, c.z, HUB_SIZE, HUB_SIZE, false);
    wallRun("x", c.z - HALF_HUB, c.x + lo, c.x + hi, doorX(row > 0));
    wallRun("x", c.z + HALF_HUB, c.x + lo, c.x + hi, doorX(row < GRID_ROWS - 1));
    wallRun("z", c.x - HALF_HUB, c.z + lo, c.z + hi, doorZ(col > 0));
    wallRun("z", c.x + HALF_HUB, c.z + lo, c.z + hi, doorZ(col < GRID_COLS - 1));
    addBox("lamp", c.x, WALL_HEIGHT - 0.03, c.z, 1.4, 0.06, 1.4, false);

    // Safe room in the north-west corner: the hub's own north and west
    // walls are its back walls; it adds an east wall (with the doorway)
    // and a south wall.
    addPlane("roomFloor", room.center.x, 0.012, room.center.z, ROOM_INNER, ROOM_INNER, true);
    wallRun("z", room.eastWallX, c.z + lo, room.southWallZ + T / 2, { c: room.doorZ, w: ROOM_DOOR_WIDTH });
    wallRun("x", room.southWallZ, c.x + lo, room.eastWallX + T / 2, null);
    addBox("lamp", room.center.x, WALL_HEIGHT - 0.03, room.center.z, 0.9, 0.06, 0.9, false);
    // Glowing threshold bar across the doorway: "this way is safe".
    addBox("safe", room.eastWallX, 0.02, room.doorZ, 0.3, 0.03, ROOM_DOOR_WIDTH, false);
  }

  for (const e of EDGES) {
    const hw = CORRIDOR_WIDTH / 2;
    if (e.horizontal) {
      const x0 = e.portalA.x;
      const x1 = e.portalB.x;
      const z = e.portalA.z;
      const mid = (x0 + x1) / 2;
      const len = x1 - x0;
      addPlane("carpet", mid, 0, z, len, CORRIDOR_WIDTH, true);
      addPlane("ceiling", mid, WALL_HEIGHT, z, len, CORRIDOR_WIDTH, false);
      addBox("wall", mid, WALL_HEIGHT / 2, z - hw - T / 2, len + T, WALL_HEIGHT, T, true);
      addBox("wall", mid, WALL_HEIGHT / 2, z + hw + T / 2, len + T, WALL_HEIGHT, T, true);
      addBox("strip", mid, WALL_HEIGHT - 0.02, z, len * 0.55, 0.04, 0.22, false);
    } else {
      const z0 = e.portalA.z;
      const z1 = e.portalB.z;
      const x = e.portalA.x;
      const mid = (z0 + z1) / 2;
      const len = z1 - z0;
      addPlane("carpet", x, 0, mid, CORRIDOR_WIDTH, len, true);
      addPlane("ceiling", x, WALL_HEIGHT, mid, CORRIDOR_WIDTH, len, false);
      addBox("wall", x - hw - T / 2, WALL_HEIGHT / 2, mid, T, WALL_HEIGHT, len + T, true);
      addBox("wall", x + hw + T / 2, WALL_HEIGHT / 2, mid, T, WALL_HEIGHT, len + T, true);
      addBox("strip", x, WALL_HEIGHT - 0.02, mid, 0.22, 0.04, len * 0.55, false);
    }
  }

  for (const [key, geos] of Object.entries(buckets)) {
    if (!geos.length) continue;
    const mesh = new THREE.Mesh(mergeGeometries(geos, false), mats[key]);
    geos.forEach((g) => g.dispose());
    scene.add(mesh);
  }

  // Warm hub lighting from a pool of lights that sit in the hubs nearest the
  // player (hubs 2 and 6 have a buzzing tube). Safe rooms borrow the hub's
  // light and the player's lantern; only the exit room gets a fixed light of
  // its own, green, so it reads from its doorway.
  const pool = Array.from({ length: HUB_LIGHT_POOL }, () => {
    const light = new THREE.PointLight(0xffe0b5, 0, HUB_LIGHT.distance, HUB_LIGHT.decay);
    scene.add(light);
    return { light, node: -1 };
  });
  const exitRoom = ROOMS[EXIT_NODE];
  const exitGlow = new THREE.PointLight(0x6dffae, 16, 10, 1.6);
  exitGlow.position.set(exitRoom.center.x, 2.4, exitRoom.center.z);
  scene.add(exitGlow);

  for (let n = 0; n < NUM_QUBITS; n++) addDecals(scene, n);
  addExitDoor(scene);

  // `focus` is the player's position: the pool is re-assigned to the hubs
  // nearest to it (a light only moves when its hub falls out of the nearest set).
  function update(time, flicker, focus) {
    const wanted = NODE_CENTERS.map((c, n) => ({ n, d: Math.hypot(c.x - focus.x, c.z - focus.z) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, HUB_LIGHT_POOL)
      .map((o) => o.n);
    for (const L of pool) if (L.node >= 0 && !wanted.includes(L.node)) L.node = -1;
    for (const n of wanted) {
      if (pool.some((L) => L.node === n)) continue;
      const free = pool.find((L) => L.node < 0);
      free.node = n;
      free.light.position.set(NODE_CENTERS[n].x, WALL_HEIGHT - 0.4, NODE_CENTERS[n].z);
    }
    for (const L of pool) {
      if (L.node < 0) {
        L.light.intensity = 0;
        continue;
      }
      const n = L.node;
      let k = 1;
      if ((n === 2 || n === 6) && Math.sin(time * 61.3 + n) * Math.sin(time * 17.9 + n * 2.1) > 0.8) k *= 0.3;
      if (flicker > 0) {
        const w = Math.sin(time * 87.1 + n * 4.7) * Math.sin(time * 23.3 + n * 1.3);
        k *= 1 - flicker * (0.55 + 0.45 * w);
      }
      L.light.intensity = HUB_LIGHT.intensity * Math.max(0.05, k);
    }
    const f = flicker > 0 ? 1 - flicker * 0.7 * (0.5 + 0.5 * Math.sin(time * 71)) : 1;
    mats.lamp.emissiveIntensity = 1.4 * f;
    mats.strip.emissiveIntensity = 0.35 * f;
  }

  return { colliders, update };
}

// Floor stencils: the node's name on the hub floor (faint) and on the safe
// room floor with what the room is, so what you see on the telemetry map
// ("q4") is also written where you're standing.
function addDecals(scene, n) {
  const c = NODE_CENTERS[n];
  const room = ROOMS[n];
  const decal = (tex, x, z, size, opacity) => {
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      transparent: true,
      opacity,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      roughness: 0.9,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 0.02, z);
    scene.add(mesh);
  };
  const tag = n === START_NODE ? "FOYER" : n === EXIT_NODE ? "EXIT" : "SAFE";
  const tagColor = n === EXIT_NODE ? "#8dffc0" : "#a9ffd0";
  decal(labelTexture(nodeLabel(n), tag, tagColor, 101 + n), room.center.x, room.center.z, 3.0, 0.6);
  decal(labelTexture(nodeLabel(n), "", "#e8dcc0", 201 + n), c.x + 1.5, c.z + 1.5, 2.6, 0.22);
}

// The way out: a glowing door on the exit room's back (north) wall. Purely a
// visual target -- entering the exit room is what wins.
function addExitDoor(scene) {
  const room = ROOMS[EXIT_NODE];
  const group = new THREE.Group();
  group.position.set(room.center.x, 0, room.inner.minZ + 0.04);

  const leaf = new THREE.Mesh(
    new THREE.BoxGeometry(1.4, 2.35, 0.06),
    new THREE.MeshStandardMaterial({ color: 0x0c2a1a, emissive: 0x1fff86, emissiveIntensity: 0.45, roughness: 0.4 })
  );
  leaf.position.y = 2.35 / 2;
  group.add(leaf);

  const glow = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, emissive: 0x6dffae, emissiveIntensity: 2.2 });
  for (const dx of [-0.76, 0.76]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.5, 0.1), glow);
    post.position.set(dx, 1.25, 0);
    group.add(post);
  }
  const head = new THREE.Mesh(new THREE.BoxGeometry(1.62, 0.1, 0.1), glow);
  head.position.set(0, 2.5, 0);
  group.add(head);

  const signTex = exitSignTexture();
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(1.1, 0.4),
    new THREE.MeshStandardMaterial({ map: signTex, emissiveMap: signTex, emissive: 0xffffff, emissiveIntensity: 1.6 })
  );
  sign.position.set(0, 2.85, 0.05); // plane faces +z, into the room
  group.add(sign);

  scene.add(group);
}

// ---- procedural textures -------------------------------------------------

// World-aligned UVs: the texture continues seamlessly across separate wall
// segments instead of restarting at each box's corner.
function worldUV(geo, scale) {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const ax = Math.abs(nor.getX(i));
    const ay = Math.abs(nor.getY(i));
    const az = Math.abs(nor.getZ(i));
    if (ay >= ax && ay >= az) uv.setXY(i, x / scale, z / scale);
    else if (ax >= az) uv.setXY(i, z / scale, y / scale);
    else uv.setXY(i, x / scale, y / scale);
  }
  uv.needsUpdate = true;
}

function canvasTexture(size, draw, seed, anisotropy) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  draw(canvas.getContext("2d"), size, mulberry32(seed));
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = anisotropy;
  return tex;
}

// Draw `fn` at (x, y) and at its wrapped copies so the tile stays seamless.
function wrapped(s, x, y, fn) {
  for (const dx of [-s, 0, s]) for (const dy of [-s, 0, s]) fn(x + dx, y + dy);
}

function grain(g, s, amount, rand) {
  const img = g.getImageData(0, 0, s, s);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = (rand() - 0.5) * amount;
    d[i] += v;
    d[i + 1] += v;
    d[i + 2] += v;
  }
  g.putImageData(img, 0, 0);
}

function stain(g, s, rand, count, rgb, alpha, rMin, rMax) {
  for (let i = 0; i < count; i++) {
    const x = rand() * s;
    const y = rand() * s;
    const r = rMin + rand() * (rMax - rMin);
    wrapped(s, x, y, (px, py) => {
      const grd = g.createRadialGradient(px, py, 0, px, py, r);
      grd.addColorStop(0, `rgba(${rgb}, ${alpha})`);
      grd.addColorStop(1, `rgba(${rgb}, 0)`);
      g.fillStyle = grd;
      g.fillRect(px - r, py - r, r * 2, r * 2);
    });
  }
}

function drawWallpaper(g, s, rand) {
  g.fillStyle = "#6e6750";
  g.fillRect(0, 0, s, s);
  for (let x = 0; x < s; x += 32) {
    g.fillStyle = "rgba(255, 244, 205, 0.07)";
    g.fillRect(x + 2, 0, 12, s);
    g.fillStyle = "rgba(35, 28, 12, 0.13)";
    g.fillRect(x + 16, 0, 2, s);
  }
  g.fillStyle = "rgba(52, 42, 22, 0.2)";
  for (let y = 16; y < s; y += 32) {
    const offset = Math.floor(y / 32) % 2 ? 24 : 8;
    for (let x = offset; x < s; x += 32) {
      g.beginPath();
      g.ellipse(x, y, 3.5, 6, 0, 0, Math.PI * 2);
      g.fill();
    }
  }
  stain(g, s, rand, 6, "58, 42, 18", 0.24, 18, 60);
  grain(g, s, 22, rand);
}

function drawWoodFloor(g, s, rand) {
  const plank = 32;
  for (let y = 0; y < s; y += plank) {
    const b = 58 + rand() * 18;
    g.fillStyle = `rgb(${b + 22}, ${b - 6}, ${b - 28})`;
    g.fillRect(0, y, s, plank);
    for (let k = 0; k < 6; k++) {
      g.strokeStyle = `rgba(28, 16, 6, ${0.12 + rand() * 0.15})`;
      g.lineWidth = 1;
      g.beginPath();
      const yy = y + 3 + rand() * (plank - 6);
      const ph = rand() * Math.PI * 2;
      for (let x = 0; x <= s; x += 8) {
        const wy = yy + Math.sin((x / s) * Math.PI * 4 + ph) * 1.5;
        if (x === 0) g.moveTo(x, wy);
        else g.lineTo(x, wy);
      }
      g.stroke();
    }
    g.fillStyle = "rgba(10, 6, 3, 0.85)";
    g.fillRect(0, y, s, 2);
    g.fillRect(Math.floor(rand() * s), y, 2, plank);
  }
  stain(g, s, rand, 4, "15, 10, 5", 0.3, 20, 50);
  grain(g, s, 18, rand);
}

// Pale green-grey tile: the safe rooms read differently from every other floor.
function drawSafeTiles(g, s, rand) {
  const tile = s / 4;
  for (let ty = 0; ty < 4; ty++) {
    for (let tx = 0; tx < 4; tx++) {
      const b = 96 + rand() * 22 + ((tx + ty) % 2) * 14;
      g.fillStyle = `rgb(${b - 26}, ${b + 8}, ${b - 8})`;
      g.fillRect(tx * tile, ty * tile, tile, tile);
    }
  }
  g.fillStyle = "rgba(8, 20, 14, 0.85)";
  for (let i = 0; i < 4; i++) {
    g.fillRect(i * tile, 0, 2, s);
    g.fillRect(0, i * tile, s, 2);
  }
  stain(g, s, rand, 3, "10, 24, 16", 0.28, 14, 34);
  grain(g, s, 14, rand);
}

function drawCarpet(g, s, rand) {
  g.fillStyle = "#3b2224";
  g.fillRect(0, 0, s, s);
  g.strokeStyle = "rgba(125, 85, 52, 0.2)";
  g.lineWidth = 3;
  for (let i = -s; i <= s; i += 32) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i + s, s);
    g.stroke();
    g.beginPath();
    g.moveTo(i + s, 0);
    g.lineTo(i, s);
    g.stroke();
  }
  stain(g, s, rand, 5, "12, 6, 6", 0.35, 15, 45);
  grain(g, s, 34, rand);
}

function drawPlaster(g, s, rand) {
  g.fillStyle = "#56534c";
  g.fillRect(0, 0, s, s);
  stain(g, s, rand, 10, "30, 28, 24", 0.25, 20, 70);
  stain(g, s, rand, 6, "120, 115, 100", 0.12, 20, 60);
  grain(g, s, 16, rand);
}

function labelTexture(text, sub, color, seed) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const g = canvas.getContext("2d");
  const rand = mulberry32(seed);
  g.fillStyle = color;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = "bold 112px Consolas, 'Courier New', monospace";
  g.fillText(text, 128, sub ? 110 : 128);
  if (sub) {
    g.font = "bold 36px Consolas, 'Courier New', monospace";
    g.fillText(sub, 128, 196);
  }
  // Scuff it so it reads as old floor paint, not UI.
  g.globalCompositeOperation = "destination-out";
  for (let i = 0; i < 500; i++) g.fillRect(rand() * 256, rand() * 256, 1 + rand() * 4, 1 + rand() * 3);
  g.globalCompositeOperation = "source-over";
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function exitSignTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 96;
  const g = canvas.getContext("2d");
  g.fillStyle = "#031208";
  g.fillRect(0, 0, 256, 96);
  g.shadowColor = "#6dffae";
  g.shadowBlur = 18;
  g.fillStyle = "#b8ffd6";
  g.font = "bold 64px Consolas, 'Courier New', monospace";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("EXIT", 128, 50);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Deterministic PRNG so textures look the same every load.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
