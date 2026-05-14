/**
 * Post-FX pipeline:
 *   1) `bloomComposer` renders the scene with camera layer mask = BLOOM_LAYER only,
 *      then UnrealBloomPass. Output is a bloom-only texture.
 *   2) `composer` renders the scene normally, then a composite ShaderPass adds the
 *      bloom texture over the base, then chromatic/vignette/dither, then OutputPass.
 *
 * Net effect: only objects on layer 1 contribute glow. Hero/enemies/ground stay
 * un-bloomed regardless of brightness. The "deliberate glow not accidental" pattern.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// Public — set `mesh.layers.enable(BLOOM_LAYER)` on anything that should bloom.
export const BLOOM_LAYER = 1;

const PostFXShader = {
  uniforms: {
    tDiffuse:  { value: null },
    chromatic: { value: 0.0008 },
    vignette:  { value: 0.45 },
    grain:     { value: 0.0 },
    time:      { value: 0 },
    fogTint:   { value: new THREE.Color(0x3a4a44) },
    fogAmount: { value: 0.18 },
    // LGG color grade (Lift/Gamma/Gain). Defaults nudge shadows cool, highlights warm.
    lift:      { value: new THREE.Vector3(0.00, 0.00, 0.02) },
    gamma:     { value: new THREE.Vector3(1.00, 1.00, 1.05) },
    gain:      { value: new THREE.Vector3(1.02, 1.00, 0.98) },
    // ── Iter 10a accessibility uniforms ──
    // uReduceMotion: 0 = motion ON (default), 1 = strip chromatic warp.
    //   We multiply the per-pixel chromatic offset by (1 - uReduceMotion).
    //   The chromaticPulse field still gets written by callers we don't
    //   own (hero/spawnDirector/pickups) — gating in the fragment shader
    //   is the cheapest way to honor reduce-motion without touching them.
    // uColorblind: 0=off, 1=deuteranopia, 2=protanopia, 3=tritanopia. Each
    //   non-zero value triggers a Brettel-style channel mix that nudges
    //   reds/greens/blues into safe-confusion-line bands. Subtle (≈30%)
    //   so the player keeps the aesthetic but reds/greens become readable.
    // uHighContrast: 0..1, lerps the final color toward a stretched range
    //   (lift→0, gain→1.15) to boost HUD/text legibility.
    uReduceMotion: { value: 0.0 },
    uColorblind:   { value: 0.0 },
    uHighContrast: { value: 0.0 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float chromatic, vignette, grain, time, fogAmount;
    uniform float uReduceMotion, uColorblind, uHighContrast;
    uniform vec3 fogTint, lift, gamma, gain;
    varying vec2 vUv;

    vec3 applyColorblind(vec3 c, float mode) {
      // mode rounded to nearest int: 1=deut, 2=prot, 3=trit.
      // Linear daltonization-style channel rebalance — keeps the picture
      // looking like itself while pushing confusion-line colors apart.
      if (mode < 0.5) return c;
      if (mode < 1.5) {
        // Deuteranopia (green-weak) — shift red+green toward separable bands.
        return vec3(c.r * 0.85 + c.g * 0.15, c.r * 0.20 + c.g * 0.80, c.b);
      }
      if (mode < 2.5) {
        // Protanopia (red-weak) — boost green into red channel for visibility.
        return vec3(c.r * 0.70 + c.g * 0.30, c.g * 0.95 + c.r * 0.05, c.b);
      }
      // Tritanopia (blue-weak) — pull blue toward yellow-friendly bands.
      return vec3(c.r, c.g * 0.85 + c.b * 0.15, c.b * 0.65 + c.g * 0.35);
    }

    void main(){
      vec2 d = vUv - 0.5;
      float dist = length(d);
      // Reduce-motion gate: zero out the chromatic warp when toggled on.
      vec2 off = d * chromatic * dist * 2.0 * (1.0 - uReduceMotion);
      float r = texture2D(tDiffuse, vUv + off).r;
      float g = texture2D(tDiffuse, vUv).g;
      float b = texture2D(tDiffuse, vUv - off).b;
      vec3 col = vec3(r, g, b);
      // Height fog: blend toward fogTint based on screen Y (top of screen heavier).
      float hFog = smoothstep(0.0, 0.7, 1.0 - vUv.y) * fogAmount;
      col = mix(col, fogTint, hFog);
      // LGG color grade
      col = pow(max(col + lift, vec3(0.0)), vec3(1.0) / max(gamma, vec3(0.001))) * gain;
      // Colorblind remap (no-op when uColorblind == 0).
      col = applyColorblind(col, uColorblind);
      // High-contrast lerp: push to a stretched range so HUD reads brighter.
      vec3 hc = clamp((col - 0.04) * 1.18, vec3(0.0), vec3(1.0));
      col = mix(col, hc, clamp(uHighContrast, 0.0, 1.0));
      float vig = 1.0 - smoothstep(0.35, 0.95, dist * 1.4) * vignette;
      float n = (fract(sin(dot(vUv*time, vec2(12.9898,78.233)))*43758.5453)-0.5) * grain;
      gl_FragColor = vec4((col + n) * vig, 1.0);
    }
  `,
};

const BloomCompositeShader = {
  uniforms: {
    tDiffuse: { value: null },
    bloomTex: { value: null },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform sampler2D bloomTex;
    varying vec2 vUv;
    void main(){
      vec4 base = texture2D(tDiffuse, vUv);
      vec4 bloom = texture2D(bloomTex, vUv);
      gl_FragColor = vec4(base.rgb + bloom.rgb, base.a);
    }
  `,
};

export function createComposer(renderer, scene, camera, W, H) {
  // ── Bloom-only composer (renders just layer 1, then bloom) ──
  const bloomComposer = new EffectComposer(renderer);
  bloomComposer.renderToScreen = false;
  bloomComposer.addPass(new RenderPass(scene, camera));
  // threshold 0 — everything on the bloom layer blooms. Strength + radius shape the glow.
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(W * 0.5, H * 0.5), 0.70, 0.50, 0.0);
  bloomComposer.addPass(bloomPass);

  // ── Main composer ──
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const compositePass = new ShaderPass(BloomCompositeShader);
  compositePass.uniforms.bloomTex.value = bloomComposer.renderTarget2.texture;
  composer.addPass(compositePass);
  const postFXPass = new ShaderPass(PostFXShader);
  composer.addPass(postFXPass);
  composer.addPass(new OutputPass());

  return { composer, bloomComposer, bloomPass, postFXPass };
}

export function resizeComposer(composer, bloomPass, postFXPass, W, H, bloomComposer) {
  composer.setSize(W, H);
  if (bloomComposer) {
    bloomComposer.setSize(W, H);
  }
  bloomPass.setSize(W * 0.5, H * 0.5);
}

/**
 * Iter 10a: apply accessibility-related meta options to the post-FX uniforms.
 * Cheap to call repeatedly (just uniform writes), so the options menu calls
 * it after every toggle/slider change. Boot also calls it once after loadMeta.
 *
 * Inputs:
 *   - postFXPass: the ShaderPass returned by createComposer.
 *   - opts: { reduceMotion, colorblind, highContrast } from meta.
 *     colorblind values: 'off' | 'deuteranopia' | 'protanopia' | 'tritanopia'.
 */
export function applyAccessibilityOptions(postFXPass, opts) {
  if (!postFXPass || !postFXPass.uniforms) return;
  const u = postFXPass.uniforms;
  if (u.uReduceMotion) u.uReduceMotion.value = opts && opts.reduceMotion ? 1.0 : 0.0;
  if (u.uHighContrast) u.uHighContrast.value = opts && opts.highContrast ? 1.0 : 0.0;
  if (u.uColorblind) {
    const map = { off: 0, deuteranopia: 1, protanopia: 2, tritanopia: 3 };
    const key = (opts && opts.colorblind) || 'off';
    u.uColorblind.value = map[key] != null ? map[key] : 0;
  }
}
