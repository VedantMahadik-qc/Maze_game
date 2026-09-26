// Proximity rendered as decoherence of the image itself: a full-screen
// shader pass whose grain, chromatic split, scan tearing and TV snow all
// scale with the proximity scalar (0 = calm, 1 = it's on you), plus fog that
// thickens and warms. `pulse()` adds a short burst on top for events -- a
// maze reshuffle, the demon materializing, getting caught.
//
// This is the stand-in for Telablur (brief step 4); the shader is the
// runtime "blend" side of that plan, so a precomputed Telablur sweep can
// later replace what it samples without changing who drives it.

import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

// Dense on purpose: with the short-range lights, visibility is roughly the
// hallway directly ahead of you. main.js builds the scene fog with this too.
export const FOG_DENSITY = 0.075;

const DecoherenceShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uAmount: { value: 0 },
    uGlitch: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uAmount;
    uniform float uGlitch;
    uniform vec2 uResolution;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
    void main() {
      float a = clamp(uAmount, 0.0, 1.0);
      float g = clamp(uGlitch, 0.0, 1.0);
      float a2 = a * a;
      float frame = floor(uTime * 30.0);
      vec2 uv = vUv;

      // Scan tearing: whole horizontal bands jump sideways.
      float band = floor(uv.y * 48.0);
      if (hash(vec2(band, frame)) < a2 * 0.3 + g * 0.55) {
        uv.x += (hash(vec2(band + 7.0, frame)) - 0.5) * (0.015 + 0.06 * g) * (a + g);
      }

      // Chromatic split, radial from the centre.
      vec2 dir = uv - 0.5;
      float ca = 0.0015 + 0.012 * a2 + 0.02 * g;
      vec3 col = vec3(
        texture2D(tDiffuse, uv + dir * ca).r,
        texture2D(tDiffuse, uv).g,
        texture2D(tDiffuse, uv - dir * ca).b
      );

      // Film grain, always a little, a lot when close.
      col += (hash(uv * uResolution + frame) - 0.5) * (0.035 + 0.2 * a2 + 0.25 * g);

      // TV snow blocks once it's very close.
      vec2 block = floor(uv * vec2(64.0, 36.0));
      float snow = step(1.0 - (a2 * a * 0.14 + g * 0.07), hash(block + frame * 3.1));
      col = mix(col, vec3(hash(uv * uResolution * 0.5 + frame)), snow * 0.8);

      // Scanlines + brightness dropouts.
      col *= 1.0 - (0.03 + 0.1 * a) * (0.5 + 0.5 * sin(uv.y * uResolution.y * 1.5708));
      col *= 1.0 - a2 * 0.35 * step(0.85, hash(vec2(frame, 3.0)));

      // Vignette closing in, shifting toward red.
      float vig = smoothstep(0.9, 0.25, length(dir) * (1.0 + a * 0.7));
      col *= mix(1.0, vig, 0.5 + 0.4 * a);
      col = mix(col, col * vec3(1.3, 0.55, 0.6), a2 * 0.55);

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

export class Decoherence {
  constructor({ renderer, scene, camera }) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.glitch = 0;
    this.proximity = 0;
    this.baseFog = new THREE.Color(0x040409);
    this.hotFog = new THREE.Color(0x2a0710);

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    // MSAA on the scene target -- the composer bypasses the canvas's own AA.
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));
    this.composer.addPass(new OutputPass());
    this.pass = new ShaderPass(DecoherenceShader);
    this.composer.addPass(this.pass);
    this._failed = false;
  }

  setSize(width, height) {
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(width, height);
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.pass.uniforms.uResolution.value.copy(size);
  }

  pulse(amount) {
    this.glitch = Math.max(this.glitch, amount);
  }

  // How hard the camera should shake right now (0..~1.5).
  get shake() {
    return this.proximity * this.proximity + this.glitch * 0.6;
  }

  update(dt, time, proximity) {
    this.proximity = proximity;
    this.glitch = Math.max(0, this.glitch - dt * 1.4);
    const u = this.pass.uniforms;
    u.uTime.value = time;
    u.uAmount.value = proximity;
    u.uGlitch.value = Math.min(1, this.glitch);
    const fog = this.scene.fog;
    if (fog) {
      fog.color.copy(this.baseFog).lerp(this.hotFog, proximity);
      fog.density = FOG_DENSITY + proximity * 0.03;
    }
  }

  render() {
    if (this._failed) {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    try {
      this.composer.render();
    } catch (err) {
      // Post-processing is decoration; never let it take the game down.
      console.warn("[decoherence] post-processing disabled:", err);
      this._failed = true;
      this.renderer.render(this.scene, this.camera);
    }
  }
}
