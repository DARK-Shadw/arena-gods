/**
 * Distance + HEIGHT fog for every built-in material.
 *
 * three's fog chunks are replaced globally: the fog colour blends by
 *   max(exp2 distance fog, ground-hugging height fog)
 * so distant backdrops dissolve into the sky colour and low valleys / lakes
 * / cloud seas get a layer of mist. Parameters ride on THREE.Fog's near/far
 * uniforms (ArenaFog: near = distance density, far = height-fog density).
 */
import * as THREE from 'three';

let installed = false;
export function installHeightFog() {
  if (installed) return;
  installed = true;
  const C = THREE.ShaderChunk as unknown as Record<string, string>;
  C.fog_pars_vertex = `#ifdef USE_FOG\n varying float vFogDepth;\n varying float vFogWorldY;\n#endif`;
  C.fog_vertex = `#ifdef USE_FOG\n vFogDepth = - mvPosition.z;\n vFogWorldY = (transpose(mat3(viewMatrix)) * (mvPosition.xyz - viewMatrix[3].xyz)).y;\n#endif`;
  C.fog_pars_fragment = `#ifdef USE_FOG\n uniform vec3 fogColor;\n varying float vFogDepth;\n varying float vFogWorldY;\n #ifdef FOG_EXP2\n uniform float fogDensity;\n #else\n uniform float fogNear;\n uniform float fogFar;\n #endif\n#endif`;
  C.fog_fragment = `#ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    #else
      float distF = 1.0 - exp( - fogNear * fogNear * vFogDepth * vFogDepth );
      float hD = fogFar * exp( - max( vFogWorldY + 1.0, 0.0 ) / 4.5 );
      float heightF = 1.0 - exp( - hD * vFogDepth );
      float fogFactor = clamp( max( distF, heightF ), 0.0, 1.0 );
    #endif
    gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
  #endif`;
}

/** near = distance-fog density, far = height-fog density (see installHeightFog) */
export class ArenaFog extends THREE.Fog {
  constructor(color: THREE.ColorRepresentation, density: number, heightDensity: number) {
    super(color, density, heightDensity);
  }
  get density() {
    return this.near;
  }
  set density(v: number) {
    this.near = v;
  }
}
