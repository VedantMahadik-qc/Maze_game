// Web Audio synth for everything the player hears -- no audio files.
//
// The retrocausal mechanic (stand-in for Atlas retrocausal-echo-v1) lives
// here as sound design: every cue about the demon is played at where it is
// *going to be*, and uses a reversed envelope -- noise that swells INTO the
// event instead of decaying away from it -- so it reads as an echo arriving
// before its cause:
//   footstep()  thump at the demon's predicted position ~0.9 s ahead
//   threshold() latch click from the doorway it's about to come through
//   preEcho()   static swelling at a spawn point, ending as it materializes
// Everything is spatialized (HRTF) against the camera, so cues are directional.
//
// Every public method is a no-op if audio is unavailable or throws: sound is
// never allowed to break the game loop.

const NOISE_SECONDS = 2;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this._heartTimer = 0;
  }

  // Must be called from a user gesture (click / keypress).
  start() {
    try {
      if (!this.ctx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        this.ctx = new Ctx();
        this._build();
      }
      if (this.ctx.state !== "running") this.ctx.resume().catch(() => {});
    } catch (err) {
      console.warn("[audio] unavailable, continuing silently:", err);
      this.ctx = null;
      this.ready = false;
    }
  }

  _build() {
    const ctx = this.ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = 0.85;
    this.master.connect(comp);

    const len = Math.floor(ctx.sampleRate * NOISE_SECONDS);
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    // Low detuned drone that opens up as proximity rises.
    this.droneFilter = ctx.createBiquadFilter();
    this.droneFilter.type = "lowpass";
    this.droneFilter.frequency.value = 120;
    this.droneFilter.Q.value = 3;
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0;
    for (const f of [43.65, 44.2, 87.6]) {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = f;
      o.connect(this.droneFilter);
      o.start();
    }
    this.droneFilter.connect(this.droneGain).connect(this.master);

    // Faint tinnitus whine near the end.
    this.whineGain = ctx.createGain();
    this.whineGain.gain.value = 0;
    const whine = ctx.createOscillator();
    whine.frequency.value = 3150;
    whine.connect(this.whineGain).connect(this.master);
    whine.start();

    this.ready = true;
  }

  _run(fn) {
    if (!this.ready || this.ctx.state !== "running") return;
    try {
      fn(this.ctx, this.ctx.currentTime);
    } catch (err) {
      console.warn("[audio]", err);
    }
  }

  updateListener(camera) {
    this._run((ctx) => {
      const l = ctx.listener;
      const p = camera.position;
      const e = camera.matrixWorld.elements;
      // Camera looks down its local -Z; up is local +Y.
      const fx = -e[8], fy = -e[9], fz = -e[10];
      const ux = e[4], uy = e[5], uz = e[6];
      if (l.positionX) {
        l.positionX.value = p.x;
        l.positionY.value = p.y;
        l.positionZ.value = p.z;
        l.forwardX.value = fx;
        l.forwardY.value = fy;
        l.forwardZ.value = fz;
        l.upX.value = ux;
        l.upY.value = uy;
        l.upZ.value = uz;
      } else {
        l.setPosition(p.x, p.y, p.z);
        l.setOrientation(fx, fy, fz, ux, uy, uz);
      }
    });
  }

  // Continuous layers: drone, whine.
  setIntensity(proximity) {
    this._run((ctx, t) => {
      const p = Math.min(1, Math.max(0, proximity));
      this.droneGain.gain.setTargetAtTime(0.025 + 0.075 * p, t, 0.3);
      this.droneFilter.frequency.setTargetAtTime(110 + 700 * p * p, t, 0.3);
      this.whineGain.gain.setTargetAtTime(0.01 * p * p * p, t, 0.5);
    });
  }

  silence() {
    this._run((ctx, t) => {
      this.droneGain.gain.setTargetAtTime(0, t, 0.4);
      this.whineGain.gain.setTargetAtTime(0, t, 0.2);
    });
  }

  heartbeat(proximity, dt) {
    if (proximity < 0.2) {
      this._heartTimer = 0;
      return;
    }
    this._heartTimer -= dt;
    if (this._heartTimer > 0) return;
    this._heartTimer = 60 / (58 + 100 * proximity);
    this._run((ctx, t) => {
      this._thump(this.master, t, { f0: 65, f1: 40, dur: 0.22, peak: 0.35 * proximity });
      this._thump(this.master, t + 0.16, { f0: 60, f1: 38, dur: 0.2, peak: 0.24 * proximity });
    });
  }

  footstep(pos, strength = 1) {
    this._run((ctx, t) => {
      const out = this._spatial(pos, 0.3);
      this._reverseSwell(out, t, 0.22, { freq: 420, q: 0.9, peak: 0.12 * strength });
      this._thump(out, t + 0.22, { f0: 105, f1: 42, dur: 0.3, peak: 0.75 * strength });
    });
  }

  threshold(pos) {
    this._run((ctx, t) => {
      const out = this._spatial(pos, 1.8);
      this._reverseSwell(out, t, 0.45, { freq: 2200, q: 2, peak: 0.3 });
      const o = ctx.createOscillator();
      o.type = "square";
      o.frequency.value = 1900;
      const g = ctx.createGain();
      const t1 = t + 0.45;
      g.gain.setValueAtTime(0.0001, t1);
      g.gain.exponentialRampToValueAtTime(0.25, t1 + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, t1 + 0.05);
      o.connect(g).connect(out);
      o.start(t1);
      o.stop(t1 + 0.06);
    });
  }

  preEcho(pos, lead) {
    this._run((ctx, t) => {
      const out = this._spatial(pos, 1.2);
      this._reverseSwell(out, t, lead, { freq: 1400, q: 0.6, peak: 0.5 });
      this._reverseSwell(out, t, lead, { freq: 180, q: 0.7, peak: 0.6 });
      this._thump(out, t + lead, { f0: 90, f1: 30, dur: 0.6, peak: 0.9 });
    });
  }

  slam(pos) {
    this._run((ctx, t) => {
      const out = this._spatial(pos, 2.2);
      this._thump(out, t, { f0: 80, f1: 34, dur: 0.35, peak: 0.7 });
      this._noiseBurst(out, t, 0.07, { type: "bandpass", freq: 1200, q: 6, peak: 0.35 });
    });
  }

  // The house re-forming: a heavy mechanical clunk -- deep body thud, a
  // second bolt-seating knock, and a short inharmonic metallic clank.
  clunk() {
    this._run((ctx, t) => {
      this._thump(this.master, t, { f0: 62, f1: 26, dur: 0.75, peak: 1.0 });
      this._thump(this.master, t + 0.09, { f0: 92, f1: 40, dur: 0.35, peak: 0.55 });
      this._noiseBurst(this.master, t, 0.09, { type: "bandpass", freq: 900, q: 1.4, peak: 0.5 });
      for (const [freq, peak, dur] of [[212, 0.12, 0.5], [547, 0.08, 0.35], [1310, 0.05, 0.22]]) {
        const o = ctx.createOscillator();
        o.type = "triangle";
        o.frequency.value = freq;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(peak, t + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g).connect(this.master);
        o.start(t);
        o.stop(t + dur + 0.02);
      }
    });
  }

  // Rising "sampling" sweep for the length of a maze transition.
  sweep(seconds) {
    this._run((ctx, t) => {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.setValueAtTime(180, t);
      o.frequency.exponentialRampToValueAtTime(1300, t + seconds);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.07, t + seconds * 0.85);
      g.gain.linearRampToValueAtTime(0.0001, t + seconds);
      o.connect(g).connect(this.master);
      o.start(t);
      o.stop(t + seconds + 0.05);

      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.Q.value = 5;
      bp.frequency.setValueAtTime(400, t);
      bp.frequency.exponentialRampToValueAtTime(3200, t + seconds);
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.0001, t);
      ng.gain.exponentialRampToValueAtTime(0.12, t + seconds * 0.9);
      ng.gain.linearRampToValueAtTime(0.0001, t + seconds);
      src.connect(bp).connect(ng).connect(this.master);
      src.start(t);
      src.stop(t + seconds + 0.05);
    });
  }

  // A soft chord (currently unused -- reshuffles use clunk() instead).
  collapse(real) {
    this._run((ctx, t) => {
      const freqs = real ? [220, 329.63, 493.88, 659.25] : [220, 329.63, 493.88];
      for (const f of freqs) {
        const o = ctx.createOscillator();
        o.type = "sine";
        o.frequency.value = f;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.05, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
        o.connect(g).connect(this.master);
        o.start(t);
        o.stop(t + 1.4);
      }
      this._thump(this.master, t, { f0: 70, f1: 32, dur: 0.5, peak: 0.5 });
    });
  }

  materialize(pos) {
    this._run((ctx, t) => {
      this._noiseBurst(this._spatial(pos, 1.2), t, 0.35, { type: "highpass", freq: 900, q: 0.7, peak: 0.4 });
    });
  }

  caught() {
    this._run((ctx, t) => {
      this._noiseBurst(this.master, t, 1.1, { type: "highpass", freq: 700, q: 0.5, peak: 0.55 });
      this._thump(this.master, t, { f0: 70, f1: 26, dur: 1.4, peak: 1 });
    });
    this.silence();
  }

  escaped() {
    this._run((ctx, t) => {
      for (const [i, f] of [261.63, 329.63, 392.0, 493.88].entries()) {
        const o = ctx.createOscillator();
        o.type = "sine";
        o.frequency.value = f;
        const g = ctx.createGain();
        const t0 = t + i * 0.08;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.06, t0 + 0.5);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 3);
        o.connect(g).connect(this.master);
        o.start(t0);
        o.stop(t0 + 3.1);
      }
    });
    this.silence();
  }

  // ---- building blocks ----

  _spatial(pos, y) {
    const p = this.ctx.createPanner();
    p.panningModel = "HRTF";
    p.distanceModel = "inverse";
    p.refDistance = 2.5;
    p.maxDistance = 80;
    p.rolloffFactor = 1.15;
    if (p.positionX) {
      p.positionX.value = pos.x;
      p.positionY.value = y;
      p.positionZ.value = pos.z;
    } else {
      p.setPosition(pos.x, y, pos.z);
    }
    p.connect(this.master);
    return p;
  }

  // Filtered noise that ramps UP and cuts off -- a reversed decay tail.
  _reverseSwell(dest, t0, dur, { freq, q, peak }) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = freq;
    bp.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + dur);
    g.gain.linearRampToValueAtTime(0.0001, t0 + dur + 0.012);
    src.connect(bp).connect(g).connect(dest);
    const offset = Math.random() * Math.max(0, NOISE_SECONDS - dur - 0.1);
    src.start(t0, offset);
    src.stop(t0 + dur + 0.03);
  }

  _thump(dest, t0, { f0, f1, dur, peak }) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(f1, t0 + dur * 0.6);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(dest);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
    this._noiseBurst(dest, t0, 0.03, { type: "lowpass", freq: 700, q: 0.7, peak: peak * 0.4 });
  }

  _noiseBurst(dest, t0, dur, { type, freq, q, peak }) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.max(0.0002, peak), t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t0, Math.random() * (NOISE_SECONDS - dur - 0.05));
    src.stop(t0 + dur + 0.02);
  }
}
