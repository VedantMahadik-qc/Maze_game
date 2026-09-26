// The "demon" for this prototype: not a modeled entity at all, per the
// working answer to the brief's open question. Proximity is rendered
// directly as accumulating decoherence -- screen static, light flicker,
// fog creep, and a Geiger-counter-style audio ping that speeds up. Each of
// these is a deliberate stand-in for a later real Atlas engine:
//   - screen static / wall tint  -> Telablur (step 4: real wall morph)
//   - the audio ping             -> Retrocausal Echo (step 4: real tap map)
// so the *shape* of "one proximity value drives multiple presentation
// layers" gets play-tested now, before any live call depends on it.

import * as THREE from "three";

export class Decoherence {
  constructor({ scene, roomLights, corridorLight }) {
    this.scene = scene;
    this.roomLights = roomLights;
    this.corridorLight = corridorLight;
    this.overlay = document.getElementById("static-overlay");
    // `dim` below is a multiplier, not an absolute candela value -- capture
    // whatever main.js set as the light's real base intensity so flicker
    // scales it instead of crushing it down to a near-zero absolute number.
    this.corridorBaseIntensity = corridorLight ? corridorLight.intensity : 0;
    this.baseFogColor = new THREE.Color(0x05050a);
    this.hotFogColor = new THREE.Color(0x3a0a12);
    this.baseFogDensity = 0.018; // must match main.js's initial scene.fog density (menu-state value)

    this._audioCtx = null;
    this._nextPingAt = 0;
    this._flickerPhase = 0;
  }

  // Audio needs a user gesture first (pointer lock click already provides
  // one) -- created lazily so the page never throws on load.
  _ensureAudio() {
    if (this._audioCtx) return this._audioCtx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this._audioCtx = new Ctx();
    return this._audioCtx;
  }

  _ping(proximity) {
    const ctx = this._ensureAudio();
    if (ctx.state === "suspended") ctx.resume();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    // Pitch and loudness both climb with proximity -- the "early warning"
    // cue Retrocausal Echo will eventually generate for real.
    osc.frequency.value = 220 + proximity * 660;
    osc.type = "sine";
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.05 + proximity * 0.15, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.2);
  }

  update(proximity, dt, elapsed) {
    // Screen static: opacity ramps with proximity, flicker driven by a
    // cheap sine so it doesn't need a per-frame noise texture regen.
    this._flickerPhase += dt * (4 + proximity * 20);
    const flicker = 0.5 + 0.5 * Math.sin(this._flickerPhase);
    const staticOpacity = proximity * proximity * (0.15 + 0.35 * flicker);
    this.overlay.style.opacity = staticOpacity.toFixed(3);

    // Fog creeps from cold/dark toward a hot decoherence red as proximity
    // rises, and closes in (higher density = shorter visible range).
    if (this.scene.fog) {
      this.scene.fog.color.copy(this.baseFogColor).lerp(this.hotFogColor, proximity);
      this.scene.fog.density = this.baseFogDensity + proximity * 0.03;
    }

    // Corridor lights flicker harder and redder as the thing gets close;
    // room lights stay steady -- rooms are supposed to read as safe.
    if (this.corridorLight) {
      const flickerRate = 6 + proximity * 40;
      const n = Math.sin(elapsed * flickerRate) * Math.sin(elapsed * flickerRate * 2.7);
      const dim = 1 - proximity * 0.5 * (0.5 + 0.5 * n);
      this.corridorLight.intensity = this.corridorBaseIntensity * Math.max(0.15, dim);
      this.corridorLight.color.setHSL(0.02, 0.8, 0.5 - proximity * 0.15);
    }

    // Geiger-counter ping: interval shrinks toward a floor as proximity -> 1.
    if (proximity > 0.02 && elapsed >= this._nextPingAt) {
      this._ping(proximity);
      const interval = 1.4 - proximity * 1.15; // 1.4s at low proximity -> ~0.25s near caught
      this._nextPingAt = elapsed + Math.max(0.2, interval);
    }
  }

  reset() {
    this._nextPingAt = 0;
    this.overlay.style.opacity = "0";
  }
}
