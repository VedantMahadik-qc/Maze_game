// Corridor gates: the visible, collidable form of a -1 edge. Each corridor
// has a gate at both mouths -- a slab of red static stamped "ZZ = -1" that
// drops from the lintel when its edge measures -1 and retracts when it
// measures +1. Collision follows the logical state immediately; the slab
// animation is cosmetic.

import * as THREE from "three";
import { EDGES, CORRIDOR_WIDTH, DOOR_HEIGHT, WALL_THICKNESS } from "./maze.js";

const SLAB = 0.14;
const CLOSE_TIME = 0.32;
const OPEN_TIME = 0.28;

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uTime;
  uniform sampler2D uLabel;
  varying vec2 vUv;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
  void main() {
    float frame = floor(uTime * 20.0);
    float n = hash(floor(vUv * vec2(40.0, 60.0)) + frame);
    float scan = 0.65 + 0.35 * sin(vUv.y * 90.0 - uTime * 6.0);
    vec3 col = mix(vec3(0.05, 0.0, 0.02), vec3(0.9, 0.1, 0.22), n * scan * 0.8);
    float edge = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
    col += vec3(1.0, 0.25, 0.35) * smoothstep(0.06, 0.0, edge) * 1.4;
    float label = texture2D(uLabel, vUv).a;
    col = mix(col, vec3(1.0, 0.85, 0.85), label * (0.7 + 0.3 * n));
    gl_FragColor = vec4(col, 1.0);
  }
`;

export class Gates {
  constructor(scene) {
    this.uniforms = { uTime: { value: 0 }, uLabel: { value: labelTexture() } };
    this.material = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader, fragmentShader });
    this.gates = EDGES.map((edge) => this._makeGate(scene, edge));
    this.signs = EDGES.map(() => -1);
  }

  _makeGate(scene, edge) {
    const geo = edge.horizontal
      ? new THREE.BoxGeometry(SLAB, DOOR_HEIGHT, CORRIDOR_WIDTH)
      : new THREE.BoxGeometry(CORRIDOR_WIDTH, DOOR_HEIGHT, SLAB);
    const ends = [edge.portalA, edge.portalB];
    const meshes = ends.map((p) => {
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.position.set(p.x, DOOR_HEIGHT / 2, p.z);
      scene.add(mesh);
      return mesh;
    });
    const hw = CORRIDOR_WIDTH / 2;
    const ht = WALL_THICKNESS / 2;
    const colliders = ends.map((p) =>
      edge.horizontal
        ? { minX: p.x - ht, maxX: p.x + ht, minZ: p.z - hw, maxZ: p.z + hw }
        : { minX: p.x - hw, maxX: p.x + hw, minZ: p.z - ht, maxZ: p.z + ht }
    );
    return { edge, meshes, colliders, closed: 1, target: 1 };
  }

  // Seal everything instantly (new run: the house starts un-measured).
  reset() {
    this.signs = EDGES.map(() => -1);
    for (const g of this.gates) {
      g.closed = 1;
      g.target = 1;
    }
    this._place();
  }

  // Returns which edges changed so callers can play slams at the right doors.
  apply(signs) {
    const opened = [];
    const closed = [];
    signs.forEach((s, id) => {
      if (s !== this.signs[id]) (s > 0 ? opened : closed).push(id);
      this.gates[id].target = s > 0 ? 0 : 1;
    });
    this.signs = signs.slice();
    return { opened, closed };
  }

  colliders() {
    const out = [];
    for (const g of this.gates) if (g.target === 1) out.push(...g.colliders);
    return out;
  }

  gatePositions(edgeId) {
    const e = this.gates[edgeId].edge;
    return [e.portalA, e.portalB];
  }

  update(dt, time) {
    this.uniforms.uTime.value = time;
    for (const g of this.gates) {
      if (g.closed === g.target) continue;
      const rate = dt / (g.target > g.closed ? CLOSE_TIME : OPEN_TIME);
      g.closed = g.target > g.closed ? Math.min(g.target, g.closed + rate) : Math.max(g.target, g.closed - rate);
    }
    this._place();
  }

  _place() {
    for (const g of this.gates) {
      // Closing accelerates like a dropped shutter; open slabs hide in the lintel.
      const t = g.target === 1 ? g.closed * g.closed : g.closed;
      const y = DOOR_HEIGHT / 2 + (1 - t) * DOOR_HEIGHT;
      for (const m of g.meshes) {
        m.position.y = y;
        m.visible = g.closed > 0.002;
      }
    }
  }
}

function labelTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const g = canvas.getContext("2d");
  g.fillStyle = "#fff";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = "bold 58px Consolas, 'Courier New', monospace";
  g.fillText("ZZ = −1", 128, 108);
  g.font = "bold 30px Consolas, 'Courier New', monospace";
  g.fillText("SEALED", 128, 164);
  return new THREE.CanvasTexture(canvas);
}
