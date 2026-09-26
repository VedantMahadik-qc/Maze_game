// The thing chasing the player: an unmodeled capsule skinned in animated TV
// static (the brief's "decoherence made visible" -- no rig, no character).
//
// It lives only in hubs and corridors: safe rooms are not part of the
// navigation graph, so it cannot enter one. Two behaviours:
//   hunt    -- the player is exposed: shortest walkable route to them,
//              re-planned several times a second and immediately whenever
//              the maze is re-sampled. It speeds up the longer the run goes.
//   patrol  -- the player is in a safe room: it gives up the chase and
//              wanders the outer corridors at a slower pace, keeping its
//              distance from the room instead of camping at the door.
// If a reshuffle strands it (sealed in a corridor, or unable to reach an
// exposed player) it decoheres and re-materializes elsewhere instead of
// standing still.
//
// Retrocausal cues: the demon reports events *ahead* of itself for audio --
// footsteps are emitted from where it will be RETRO_LEAD seconds from now,
// a doorway "threshold" click fires before it comes through a mouth into the
// player's hub, and a pre-echo plays at a spawn point before it materializes.

import * as THREE from "three";
import { planPath, distanceField, spawnCandidates, canLeave } from "./maze.js";

const BASE_SPEED = 2.8;
const MAX_SPEED = 6.6;
const ACCEL = 0.05; // speed gained per second since it appeared
const PATROL_FACTOR = 0.55; // patrol pace relative to chase pace
const REPATH_INTERVAL = 0.2;
const TUNNEL_AFTER = 1.1; // seconds with no route to the player before it decoheres
const STRANDED_AFTER = 1.2; // seconds shut in while patrolling before it decoheres
const DECOHERE_TIME = 0.6;
const MATERIALIZE_TIME = 0.5;
const PATROL_MIN_LEG = 6; // patrol destinations at least this far (walking) away
const PATROL_KEEP_AWAY = 10; // ...and at least this far from the player's room
const PATROL_NEAR_RANGE = 30; // prefer destinations this close to the player: it lurks nearby
const HEIGHT = 2.1;
const RADIUS = 0.36;
export const RETRO_LEAD = 0.9;

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uTime;
  uniform float uIntensity;
  uniform float uDissolve;
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vV;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
  void main() {
    vec2 cell = floor(vUv * vec2(36.0, 90.0));
    if (hash(cell * 0.73 + 11.0) < uDissolve) discard;
    float frame = floor(uTime * 24.0);
    float n = hash(cell + frame * 1.618);
    float band = step(0.9 - uIntensity * 0.2, hash(vec2(floor(vUv.y * 30.0), frame)));
    float scan = 0.7 + 0.3 * sin(vUv.y * 420.0 - uTime * 40.0);
    float rim = pow(1.0 - max(dot(normalize(vN), normalize(vV)), 0.0), 2.2);
    vec3 col = mix(vec3(0.01, 0.02, 0.04), vec3(0.75, 0.95, 1.0), n * scan);
    col *= 0.55 + 0.9 * uIntensity;
    col += band * vec3(0.9, 0.15, 0.3) * 0.8;
    col += rim * vec3(0.25, 0.85, 1.0) * (1.2 + 1.5 * uIntensity);
    gl_FragColor = vec4(col, 1.0);
  }
`;

export class Demon {
  constructor(scene) {
    this.uniforms = { uTime: { value: 0 }, uIntensity: { value: 0 }, uDissolve: { value: 1 } };
    this.mesh = new THREE.Mesh(
      new THREE.CapsuleGeometry(RADIUS, HEIGHT - RADIUS * 2, 8, 20),
      new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader, fragmentShader })
    );
    this.light = new THREE.PointLight(0x5fe3ff, 0, 10, 1.8);
    scene.add(this.mesh, this.light);
    this.pos = new THREE.Vector3();
    this.reset();
  }

  reset() {
    this.state = "dormant"; // dormant | incoming | materializing | active | decohering | retry
    this.mode = "patrol"; // patrol | hunt (while active)
    this.mesh.visible = false;
    this.light.intensity = 0;
    this.path = [];
    this.hasRoute = false;
    this.noRouteFor = 0;
    this.strandedFor = 0;
    this.patrolWait = 0;
    this.chaseTime = 0;
    this.stepTimer = 0.4;
    this.repathTimer = 0;
    this.graphVersion = -1;
    this.timer = 0;
    this.dissolve = 1;
    this.spawnAt = null;
    this.cued = null;
    this.cueHub = -1;
    this._jitterTimer = 0;
    this._jitter = new THREE.Vector3();
  }

  get present() {
    return this.state === "active" || this.state === "materializing";
  }

  get canCatch() {
    return this.state === "active";
  }

  get hunting() {
    return this.state === "active" && this.mode === "hunt";
  }

  // Chase pace; grows the longer it has been out.
  get speed() {
    return Math.min(MAX_SPEED, BASE_SPEED + ACCEL * this.chaseTime);
  }

  distanceTo(p) {
    return Math.hypot(this.pos.x - p.x, this.pos.z - p.z);
  }

  // Pick a reachable point away from the player and start the pre-echo
  // there. Returns the events to play, or null if nowhere suitable exists yet.
  summon(ctx, minDist) {
    const spot = chooseSpawn(ctx.graph, ctx.signs, ctx.playerNav, ctx.playerForward, minDist);
    if (!spot) return null;
    this.state = "incoming";
    this.timer = RETRO_LEAD;
    this.spawnAt = spot;
    return [{ type: "preEcho", pos: spot, lead: RETRO_LEAD }];
  }

  update(dt, ctx) {
    const events = [];
    this.uniforms.uTime.value = ctx.time;
    switch (this.state) {
      case "dormant":
        return events;
      case "retry": {
        this.timer -= dt;
        if (this.timer <= 0) {
          const ev = this.summon(ctx, 7);
          if (ev) events.push(...ev);
          else this.timer = 1;
        }
        return events;
      }
      case "incoming":
        this.timer -= dt;
        if (this.timer <= 0) {
          this._appear(this.spawnAt);
          events.push({ type: "materialize", pos: { x: this.pos.x, z: this.pos.z } });
        }
        return events;
      case "materializing":
        this.dissolve = Math.max(0, this.dissolve - dt / MATERIALIZE_TIME);
        if (this.dissolve === 0) this.state = "active";
        break;
      case "decohering":
        this.dissolve = Math.min(1, this.dissolve + dt / DECOHERE_TIME);
        if (this.dissolve === 1) {
          this.mesh.visible = false;
          this.light.intensity = 0;
          const ev = this.summon(ctx, 10);
          if (ev) events.push(...ev);
          else {
            this.state = "retry";
            this.timer = 1;
          }
          return events;
        }
        break;
      case "active":
        this._act(dt, ctx, events);
        break;
    }
    this._animate(dt, ctx);
    return events;
  }

  _appear(spot) {
    this.pos.set(spot.x, 0, spot.z);
    this.state = "materializing";
    this.dissolve = 1;
    this.mesh.visible = true;
    this.path = [];
    this.hasRoute = false;
    this.repathTimer = 0;
    this.noRouteFor = 0;
    this.strandedFor = 0;
    this.patrolWait = 0;
    this.graphVersion = -1;
    this.cued = null;
  }

  _decohere(events) {
    this.state = "decohering";
    this.path = [];
    events.push({ type: "decohere", pos: { x: this.pos.x, z: this.pos.z } });
  }

  _act(dt, ctx, events) {
    this.chaseTime += dt;
    const hunt = !ctx.playerSafe;
    if (hunt !== (this.mode === "hunt")) {
      // Player ducked into (or stepped out of) a safe room: drop the old
      // route and start the other behaviour from scratch.
      this.mode = hunt ? "hunt" : "patrol";
      this.path = [];
      this.repathTimer = 0;
      this.patrolWait = 0;
      this.noRouteFor = 0;
      this.strandedFor = 0;
    }

    if (hunt) this._hunt(dt, ctx);
    else this._patrol(dt, ctx);
    if (this.state !== "active") {
      if (this.state === "decohering") events.push({ type: "decohere", pos: { x: this.pos.x, z: this.pos.z } });
      return;
    }

    const speed = hunt ? this.speed : this.speed * PATROL_FACTOR;
    this._walk(dt, speed, hunt);

    if (this.path.length) {
      this.stepTimer -= dt;
      if (this.stepTimer <= 0) {
        this.stepTimer = THREE.MathUtils.clamp(1.8 / speed, 0.26, 0.9);
        events.push({
          type: "footstep",
          pos: this.predict(RETRO_LEAD, speed),
          lead: RETRO_LEAD,
          strength: hunt ? 1 : 0.5,
        });
      }
      const cue = this._thresholdCue(ctx, speed);
      if (cue) events.push(cue);
    }
  }

  _hunt(dt, ctx) {
    this.repathTimer -= dt;
    if (this.repathTimer <= 0 || ctx.graphVersion !== this.graphVersion) {
      this.repathTimer = REPATH_INTERVAL;
      this.graphVersion = ctx.graphVersion;
      const route = planPath(ctx.graph, this.pos, ctx.playerPos);
      this.hasRoute = !!route;
      this.path = route ? route.points.slice() : [];
    }
    if (!this.hasRoute) {
      this.noRouteFor += dt;
      if (this.noRouteFor > TUNNEL_AFTER) this.state = "decohering";
      return;
    }
    this.noRouteFor = 0;
    // Final leg is always straight at the player's live position.
    if (this.path.length === 1) this.path[0] = { x: ctx.playerPos.x, z: ctx.playerPos.z };
  }

  _patrol(dt, ctx) {
    if (!canLeave(ctx.graph, this.pos)) {
      this.strandedFor += dt;
      if (this.strandedFor > STRANDED_AFTER) {
        this.state = "decohering";
        return;
      }
    } else {
      this.strandedFor = 0;
    }
    if (ctx.graphVersion !== this.graphVersion) {
      this.graphVersion = ctx.graphVersion;
      this.path = [];
      this.patrolWait = 0;
    }
    if (this.patrolWait > 0) {
      this.patrolWait -= dt;
      return;
    }
    if (!this.path.length) {
      const route = this._pickPatrolRoute(ctx);
      if (route) this.path = route;
      else this.patrolWait = 1;
    }
  }

  // Somewhere reachable that is neither trivially close to it nor right at
  // the player's room, favouring spots near the player so it keeps lurking.
  _pickPatrolRoute(ctx) {
    const fromMe = distanceField(ctx.graph, this.pos);
    const options = [];
    for (const c of spawnCandidates(ctx.signs)) {
      const d = fromMe(c);
      if (!Number.isFinite(d) || d < PATROL_MIN_LEG) continue;
      const away = Math.hypot(c.x - ctx.playerPos.x, c.z - ctx.playerPos.z);
      if (away < PATROL_KEEP_AWAY) continue;
      options.push({ c, near: away <= PATROL_NEAR_RANGE });
    }
    if (!options.length) return null;
    const near = options.filter((o) => o.near);
    const pool = near.length ? near : options;
    const target = pool[(Math.random() * pool.length) | 0].c;
    const route = planPath(ctx.graph, this.pos, target);
    return route ? route.points.slice() : null;
  }

  _walk(dt, speed, hunt) {
    let budget = speed * dt;
    while (budget > 0 && this.path.length) {
      const wp = this.path[0];
      const dx = wp.x - this.pos.x;
      const dz = wp.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      if (d <= budget) {
        this.pos.x = wp.x;
        this.pos.z = wp.z;
        budget -= d;
        if (this.path.length > 1) {
          this.path.shift();
        } else if (hunt) {
          break; // hunting: the last waypoint is the player -- stay on them
        } else {
          this.path.shift();
          this.patrolWait = 0.8 + Math.random() * 2; // reached the patrol spot: linger
        }
      } else {
        this.pos.x += (dx / d) * budget;
        this.pos.z += (dz / d) * budget;
        budget = 0;
      }
    }
  }

  // Where the demon will be `lead` seconds from now if it keeps its route.
  predict(lead, speed = this.speed) {
    let remaining = speed * lead;
    let px = this.pos.x;
    let pz = this.pos.z;
    for (const wp of this.path) {
      const d = Math.hypot(wp.x - px, wp.z - pz);
      if (d >= remaining) {
        const t = d > 0 ? remaining / d : 0;
        return { x: px + (wp.x - px) * t, z: pz + (wp.z - pz) * t };
      }
      remaining -= d;
      px = wp.x;
      pz = wp.z;
    }
    return { x: px, z: pz };
  }

  // Fires once, before the demon comes through a corridor mouth into the
  // player's hub (whether they're standing in it or hiding in its room) --
  // the click comes from that doorway, ahead of the demon.
  _thresholdCue(ctx, speed) {
    const hub = ctx.playerHub;
    if (hub !== this.cueHub) {
      this.cueHub = hub;
      this.cued = null;
    }
    if (hub < 0) return null;
    let acc = 0;
    let px = this.pos.x;
    let pz = this.pos.z;
    for (const wp of this.path) {
      acc += Math.hypot(wp.x - px, wp.z - pz);
      px = wp.x;
      pz = wp.z;
      if (wp.edge === undefined || wp.node !== hub) continue;
      const key = `${hub}:${wp.edge}`;
      if (acc > 0.5 && acc <= speed * RETRO_LEAD && this.cued !== key) {
        this.cued = key;
        return { type: "threshold", pos: { x: wp.x, z: wp.z }, lead: acc / speed };
      }
      return null;
    }
    return null;
  }

  _animate(dt, ctx) {
    const p = ctx.proximity;
    this._jitterTimer -= dt;
    if (this._jitterTimer <= 0) {
      this._jitterTimer = 0.05 + Math.random() * 0.08;
      const j = 0.03 + p * 0.09;
      this._jitter.set((Math.random() - 0.5) * j, (Math.random() - 0.5) * j * 0.5, (Math.random() - 0.5) * j);
      this.mesh.scale.set(1, 1 + (Math.random() - 0.5) * (0.04 + p * 0.1), 1);
    }
    this.mesh.position.set(
      this.pos.x + this._jitter.x,
      HEIGHT / 2 + Math.sin(ctx.time * 1.7) * 0.05 + this._jitter.y,
      this.pos.z + this._jitter.z
    );
    this.mesh.rotation.y = ctx.time * 0.6;
    this.uniforms.uIntensity.value = p;
    this.uniforms.uDissolve.value = this.dissolve;
    const flicker = 0.75 + 0.25 * Math.sin(ctx.time * 43) * Math.sin(ctx.time * 17);
    this.light.intensity = (1 - this.dissolve) * (8 + 14 * p) * flicker;
    this.light.position.set(this.pos.x, HEIGHT * 0.7, this.pos.z);
  }
}

// Reachable spot at least `minDist` (walking) from the player, preferring
// behind them and a middling distance -- close enough to matter soon, far
// enough to be fair.
function chooseSpawn(graph, signs, playerNav, forward, minDist) {
  const distTo = distanceField(graph, playerNav);
  let best = null;
  let bestScore = -Infinity;
  let farthest = null;
  let farthestD = -1;
  for (const c of spawnCandidates(signs)) {
    const d = distTo(c);
    if (!Number.isFinite(d)) continue;
    if (d > farthestD) {
      farthestD = d;
      farthest = c;
    }
    if (d < minDist) continue;
    const vx = c.x - playerNav.x;
    const vz = c.z - playerNav.z;
    const len = Math.hypot(vx, vz) || 1;
    const behind = -(vx * forward.x + vz * forward.z) / len;
    const distScore = 1 - Math.min(1, Math.abs(d - 20) / 20);
    const score = behind + distScore * 0.6 + Math.random() * 0.15;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best ?? (farthestD >= 5 ? farthest : null);
}
