/**
 * Material factory: PBR materials from procedural texture sets, with
 * world-space macro variation (breaks tiling), optional triplanar mapping for
 * displaced rock/cliff meshes, vertex AO, and animated special materials
 * (lava, water, glowing runes).
 */
import * as THREE from 'three';
import type { TexSet } from './textures';

export const shaderTime = { value: 0 };

/** GLSL value noise used by the patches below */
export const GLSL_NOISE = /* glsl */ `
float an_hash(vec3 p){ p = fract(p*0.3183099+0.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float an_noise(vec3 x){ vec3 i=floor(x); vec3 f=fract(x); f=f*f*(3.0-2.0*f);
  return mix(mix(mix(an_hash(i+vec3(0,0,0)),an_hash(i+vec3(1,0,0)),f.x),mix(an_hash(i+vec3(0,1,0)),an_hash(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(an_hash(i+vec3(0,0,1)),an_hash(i+vec3(1,0,1)),f.x),mix(an_hash(i+vec3(0,1,1)),an_hash(i+vec3(1,1,1)),f.x),f.y),f.z); }
float an_fbm(vec3 p){ float s=0.0, a=0.5; for(int i=0;i<4;i++){ s+=a*an_noise(p); p*=2.03; a*=0.5; } return s; }
`;

export interface MatOpts {
  color?: THREE.ColorRepresentation;
  repeat?: [number, number];
  rough?: number;
  metal?: number;
  normalScale?: number;
  emissive?: THREE.ColorRepresentation;
  emissiveIntensity?: number;
  /** world-space albedo variation: [scale (1/m), strength] */
  macro?: [number, number];
  /** sample albedo/roughness in world space (scale = repeats per metre) */
  triplanar?: number;
  vertexColors?: boolean;
  side?: THREE.Side;
  envIntensity?: number;
  /** darken towards the ground (contact AO) up to this height (m), world space */
  groundAO?: number;
  /** progressive damage overlay (0..1), world-space crack pattern */
  crack?: { value: number };
}

let _crackTex: THREE.Texture | null = null;
export function crackTexture(): THREE.Texture {
  if (_crackTex) return _crackTex;
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, 512, 512);
  let s = 77;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  g.strokeStyle = '#fff';
  g.lineCap = 'round';
  for (let b = 0; b < 14; b++) {
    let x = rnd() * 512,
      y = rnd() * 512,
      a = rnd() * Math.PI * 2,
      w = 5;
    // severity encoded in brightness: early cracks bright (appear first)
    const lvl = 0.35 + (b / 14) * 0.65;
    g.strokeStyle = `rgb(${255 * (1.05 - lvl)},0,0)`;
    for (let i = 0; i < 16; i++) {
      a += (rnd() - 0.5) * 1.1;
      const nx = x + Math.cos(a) * 26,
        ny = y + Math.sin(a) * 26;
      g.lineWidth = w;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(nx, ny);
      g.stroke();
      x = nx;
      y = ny;
      w = Math.max(1, w * 0.88);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  _crackTex = t;
  return t;
}

function rep(t: THREE.Texture | undefined, r?: [number, number]) {
  if (!t) return undefined;
  if (!r) return t;
  const c = t.clone();
  c.repeat.set(r[0], r[1]);
  c.needsUpdate = true;
  return c;
}

export function pbr(set: TexSet | null, o: MatOpts = {}): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: o.color ?? '#ffffff',
    map: set ? rep(set.map, o.repeat) : null,
    normalMap: set && !o.triplanar ? rep(set.normalMap, o.repeat) : null,
    roughnessMap: set ? rep(set.ormMap, o.repeat) : null,
    metalnessMap: set && (o.metal ?? 0) > 0 ? rep(set.ormMap, o.repeat) : null,
    roughness: o.rough ?? 1,
    metalness: o.metal ?? 0,
    emissive: o.emissive ?? '#000000',
    emissiveMap: set?.emissiveMap ? rep(set.emissiveMap, o.repeat) : null,
    emissiveIntensity: o.emissiveIntensity ?? 1,
    vertexColors: !!o.vertexColors,
    side: o.side ?? THREE.FrontSide,
    envMapIntensity: o.envIntensity ?? 1,
  });
  if (m.normalMap) m.normalScale.setScalar(o.normalScale ?? 1);
  if (o.macro || o.triplanar || o.groundAO || o.crack) patchWorld(m, o);
  return m;
}

/** clone a material for one destructible object, with its own crack uniform */
export function withCrack(base: THREE.MeshStandardMaterial, opts: MatOpts, crack: { value: number }): THREE.MeshStandardMaterial {
  const m = base.clone();
  patchWorld(m, { ...opts, crack });
  return m;
}

/** inject world position + macro variation / triplanar / ground AO */
export function patchWorld(m: THREE.MeshStandardMaterial, o: MatOpts) {
  const macro = o.macro ?? [0, 0];
  const tri = o.triplanar ?? 0;
  const gao = o.groundAO ?? 0;
  const crack = o.crack;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uMacro = { value: new THREE.Vector2(macro[0], macro[1]) };
    sh.uniforms.uTri = { value: tri };
    sh.uniforms.uGao = { value: gao };
    sh.uniforms.uCrack = crack ?? { value: 0 };
    sh.uniforms.uCrackMap = { value: crackTexture() };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNor;')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        { vec4 wp = vec4(transformed,1.0);
          #ifdef USE_INSTANCING
            wp = instanceMatrix * wp;
          #endif
          wp = modelMatrix * wp; vWPos = wp.xyz;
          vec3 wn = objectNormal;
          #ifdef USE_INSTANCING
            wn = mat3(instanceMatrix) * wn;
          #endif
          vWNor = normalize(mat3(modelMatrix) * wn); }`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNor;\nuniform vec2 uMacro;\nuniform float uTri;\nuniform float uGao;\nuniform float uCrack;\nuniform sampler2D uCrackMap;\n${GLSL_NOISE}`)
      .replace(
        '#include <map_fragment>',
        tri > 0
          ? `
        #ifdef USE_MAP
        { vec3 bw = pow(abs(vWNor), vec3(4.0)); bw /= (bw.x+bw.y+bw.z);
          vec4 cx = texture2D(map, vWPos.zy*uTri); vec4 cy = texture2D(map, vWPos.xz*uTri); vec4 cz = texture2D(map, vWPos.xy*uTri);
          diffuseColor *= cx*bw.x + cy*bw.y + cz*bw.z; }
        #endif`
          : '#include <map_fragment>',
      )
      .replace(
        '#include <roughnessmap_fragment>',
        tri > 0
          ? `float roughnessFactor = roughness;
        #ifdef USE_ROUGHNESSMAP
        { vec3 bw = pow(abs(vWNor), vec3(4.0)); bw /= (bw.x+bw.y+bw.z);
          float rx = texture2D(roughnessMap, vWPos.zy*uTri).g; float ry = texture2D(roughnessMap, vWPos.xz*uTri).g; float rz = texture2D(roughnessMap, vWPos.xy*uTri).g;
          roughnessFactor *= rx*bw.x + ry*bw.y + rz*bw.z; }
        #endif`
          : '#include <roughnessmap_fragment>',
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        if (uMacro.y > 0.0) { float mv = an_fbm(vWPos*uMacro.x); diffuseColor.rgb *= 1.0 + (mv-0.5)*2.0*uMacro.y; }
        if (uGao > 0.0) { diffuseColor.rgb *= mix(0.45, 1.0, smoothstep(0.0, uGao, vWPos.y)); }
        if (uCrack > 0.01) {
          vec3 bw = pow(abs(vWNor), vec3(4.0)); bw /= (bw.x+bw.y+bw.z);
          float cr = texture2D(uCrackMap, vWPos.zy*0.45).r*bw.x + texture2D(uCrackMap, vWPos.xz*0.45).r*bw.y + texture2D(uCrackMap, vWPos.xy*0.45).r*bw.z;
          float show = smoothstep(1.0 - uCrack, 1.0 - uCrack + 0.08, cr);
          diffuseColor.rgb *= 1.0 - show * 0.82;
        }`,
      );
  };
  m.customProgramCacheKey = () => `w${macro[0]}_${macro[1]}_${tri}_${gao}_${crack ? 'c' : ''}`;
}

/** Bake simple vertex AO / tint as vertex colours: fn(x,y,z,nx,ny,nz) -> brightness */
export function bakeVertexShade(geo: THREE.BufferGeometry, fn: (x: number, y: number, z: number, nx: number, ny: number, nz: number) => number, tint?: THREE.Color) {
  const pos = geo.attributes.position,
    nor = geo.attributes.normal;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const k = fn(pos.getX(i), pos.getY(i), pos.getZ(i), nor ? nor.getX(i) : 0, nor ? nor.getY(i) : 1, nor ? nor.getZ(i) : 0);
    col[i * 3] = k * (tint?.r ?? 1);
    col[i * 3 + 1] = k * (tint?.g ?? 1);
    col[i * 3 + 2] = k * (tint?.b ?? 1);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

// ------------------------------------------------------------------ animated specials
/** flowing lava: crust + glowing flow, lit by scene lights, strongly emissive */
export function lavaMaterial(hot = '#ff6a1a', crust = '#2a1410'): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: crust, roughness: 0.85, metalness: 0, emissive: hot, emissiveIntensity: 1 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = shaderTime;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWPos;').replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed,1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWPos;\nuniform float uTime;\n${GLSL_NOISE}`)
      .replace(
        '#include <emissivemap_fragment>',
        `{ vec3 p = vec3(vWPos.x*0.45, vWPos.z*0.45, uTime*0.05);
           float w = an_fbm(p + vec3(uTime*0.03, 0.0, 0.0));
           float n = an_fbm(p*1.7 + vec3(w*2.2, -uTime*0.06, 0.0));
           float cells = smoothstep(0.42, 0.62, n);
           float pulse = 0.85 + 0.15*sin(uTime*1.7 + w*9.0);
           float heat = (1.0 - cells);
           totalEmissiveRadiance *= mix(vec3(0.05,0.01,0.0), vec3(1.6,0.6,0.12), pow(heat, 1.5)) * 2.4 * pulse + vec3(2.5,1.4,0.4)*pow(heat,6.0)*1.3;
           diffuseColor.rgb *= mix(1.0, 0.25, heat); }`,
      );
  };
  m.customProgramCacheKey = () => 'lava';
  return m;
}

/** animated water: scrolling normals + PBR reflections of the scene environment */
let waterNormals: THREE.Texture | null = null;
export function waterNormalTex(): THREE.Texture {
  if (waterNormals) return waterNormals;
  const S = 256;
  const H = new Float32Array(S * S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      let h = 0;
      for (let k = 0; k < 6; k++) {
        const a = k * 1.3 + 0.4,
          f = (k + 2) * 2;
        h += Math.sin(((x * Math.cos(a) + y * Math.sin(a)) / S) * Math.PI * 2 * f + k) / (k + 1);
      }
      H[y * S + x] = h;
    }
  const d = new Uint8ClampedArray(S * S * 4);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const dx = H[y * S + ((x + 1) % S)] - H[y * S + ((x - 1 + S) % S)];
      const dy = H[((y + 1) % S) * S + x] - H[((y - 1 + S) % S) * S + x];
      const l = Math.hypot(dx, dy, 3);
      const i = (y * S + x) * 4;
      d[i] = (-dx / l) * 127 + 128;
      d[i + 1] = (-dy / l) * 127 + 128;
      d[i + 2] = (3 / l) * 127 + 128;
      d[i + 3] = 255;
    }
  const t = new THREE.DataTexture(d, S, S, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  waterNormals = t;
  return t;
}

export function waterMaterial(color: string, opts: { rough?: number; scale?: number; opacity?: number; speed?: number; env?: number } = {}): THREE.MeshPhysicalMaterial {
  const n = waterNormalTex().clone();
  n.needsUpdate = true;
  const m = new THREE.MeshPhysicalMaterial({
    color,
    roughness: opts.rough ?? 0.04,
    metalness: 0,
    normalMap: n,
    normalScale: new THREE.Vector2(0.35, 0.35),
    transparent: (opts.opacity ?? 1) < 1,
    opacity: opts.opacity ?? 1,
    envMapIntensity: opts.env ?? 1.2,
    clearcoat: 0.6,
    clearcoatRoughness: 0.05,
  });
  const sc = opts.scale ?? 0.25,
    sp = opts.speed ?? 0.02;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = shaderTime;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWPos;').replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed,1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nuniform float uTime;')
      .replace(
        '#include <normal_fragment_maps>',
        `{ vec2 uvA = vWPos.xz*${sc.toFixed(3)} + vec2(uTime*${sp.toFixed(3)}, uTime*${(sp * 0.6).toFixed(3)});
           vec2 uvB = vWPos.xz*${(sc * 1.7).toFixed(3)} + vec2(-uTime*${(sp * 0.8).toFixed(3)}, uTime*${(sp * 1.1).toFixed(3)});
           vec3 nA = texture2D(normalMap, uvA).xyz*2.0-1.0; vec3 nB = texture2D(normalMap, uvB).xyz*2.0-1.0;
           vec3 mapN = normalize(vec3((nA.xy+nB.xy)*normalScale, nA.z*nB.z));
           normal = normalize(tbn * mapN); }`,
      );
  };
  m.customProgramCacheKey = () => `water${sc}${sp}`;
  return m;
}

/** additive glow material (flames, runes, light shafts) */
export function glowMat(color: THREE.ColorRepresentation, opacity = 1, map?: THREE.Texture | null): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, map: map ?? null, fog: false, side: THREE.DoubleSide, toneMapped: false });
}
