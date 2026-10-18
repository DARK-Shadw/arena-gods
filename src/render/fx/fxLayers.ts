/**
 * Render layers (plan §2.2). Post (src/render/post.ts) renders them in separate passes:
 *  - WORLD (0): the opaque scene and the arena's own transparent geometry -> scene target with a
 *    DepthTexture (the shared depth);
 *  - FX_ADD / FX_ALPHA / FX_GHOST: rendered into the same colour target AFTER AO and the
 *    linear-depth copy, with the hardware depth test against the shared depth and a soft fade
 *    sampled from the linear-depth copy (softDepth.ts);
 *  - FX_DIST: screen distortion sprites, rendered into a half-res RG offset target.
 * Objects on FX layers are invisible to GTAO and to shadow maps for free.
 */
import type * as THREE from 'three';

export const LAYER = { WORLD: 0, FX_ADD: 20, FX_ALPHA: 21, FX_DIST: 22, FX_GHOST: 23 } as const;

export const MASK_WORLD = 1 << LAYER.WORLD;
export const MASK_FX = (1 << LAYER.FX_ADD) | (1 << LAYER.FX_ALPHA) | (1 << LAYER.FX_GHOST);
export const MASK_DIST = 1 << LAYER.FX_DIST;

/** Put an object (only this object, not its children) on one layer. */
export function setLayer(o: THREE.Object3D, layer: number) {
  o.layers.set(layer);
}
