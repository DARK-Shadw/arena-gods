/**
 * Shared scene depth for FX (plan §2.2 "soft particles", §3.10 item 1).
 *
 * Post renders the WORLD layer into a target with a DepthTexture, then copies it into a
 * half-res RGBA16F texture whose A channel is LINEAR view depth in metres (`uSceneDepth`). FX materials sample
 * that copy (never the depth attachment itself, which is bound while they draw: a WebGL2
 * feedback loop) and fade where they meet geometry:
 *
 *   fade = clamp((sceneDepth - fragDepth) / softness, 0, 1)
 *
 * The uniforms below are ONE shared object: every FX material puts these same uniform objects
 * in its `uniforms`, so Post updates them once per frame for all of them. Without a Post (Node
 * tests, a plain renderer.render) `uSoftOn` stays 0 and the fade is 1.
 *
 * Arena session: a soft card is any ShaderMaterial that spreads `softDepthUniforms` into its
 * uniforms, includes SOFT_DEPTH_PARS in the fragment shader, passes the view depth (-mvPosition.z)
 * in a varying and multiplies its alpha by fxSoftFade(viewDepth, softness). Put the mesh on
 * LAYER.FX_ALPHA (fxLayers.ts) so it draws after the depth copy.
 */
import * as THREE from 'three';

const blank = new THREE.DataTexture(new Float32Array([0, 0, 0, 1e4]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
blank.needsUpdate = true;

export const softDepthUniforms = {
  /** linear view depth (m) of the opaque scene in the A channel, half res (RGB: packed normals when AO runs) */
  uSceneDepth: { value: blank as THREE.Texture },
  /** 1 / (render target size in pixels): gl_FragCoord.xy * uDepthInvRes = screen uv */
  uDepthInvRes: { value: new THREE.Vector2(1, 1) },
  /** 0 = no depth this frame (low tier, or no Post): fades are 1 */
  uSoftOn: { value: 0 },
};

export const SOFT_DEPTH_PARS = /* glsl */ `
  uniform sampler2D uSceneDepth;
  uniform vec2 uDepthInvRes;
  uniform float uSoftOn;
  /** 0 where the fragment is behind / at the scene surface, 1 once it is \`softness\` metres in front */
  float fxSoftFade(float fragDepth, float softness) {
    if (uSoftOn < 0.5 || softness <= 0.0) return 1.0;
    float sceneDepth = texture2D(uSceneDepth, gl_FragCoord.xy * uDepthInvRes).a;
    return clamp((sceneDepth - fragDepth) / softness, 0.0, 1.0);
  }`;

/** Default softness per primitive (m), plan §2.2: sparks 0.05, smoke 0.6, fog cards 1.5. */
export const SOFTNESS = {
  sparks: 0.05,
  embers: 0.05,
  flash: 0.3,
  fire: 0.25,
  dust: 0.4,
  smoke: 0.5,
  ring: 0.15,
  heat: 0.4,
  ripple: 0.3,
  fog: 1.5,
} as const;
