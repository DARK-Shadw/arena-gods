/**
 * ARENA ASSETS: loads the baked arena art (public/arena, built by tools/arena/build_assets.mjs) for a theme
 * and a quality tier, caches it, prefetches it and disposes what a new theme no longer uses
 * (arena art plan 4.1 / 5.8 / 6.7, milestone A1).
 *
 *   manifest.json   asset id -> files[tier][format]   (tier full = LOD0, medium / high; low = LOD1, low)
 *   format          'ktx2' (KHR_texture_basisu, transcoded in the KTX2Loader's workers from /basis/) by default;
 *                   'webp' (EXT_texture_webp) when the transcoder fails or with ?arenatex=webp
 *   geometry        EXT_meshopt_compression (MeshoptDecoder)
 *
 * Each asset GLB is one KIT_<id> root (extras: role, kind, footprint, height, debris, dustTint) with LOD0 or
 * LOD1, a hidden COL proxy and SOCK_* sockets (plan 4.2). `KitAsset.instantiate()` clones it (geometry and
 * materials shared with the cache, so Arena.dispose() skips objects flagged userData.kit) and hands back the
 * sockets in the asset's frame. `ArenaAssets.release(keep)` disposes every cached asset the kept pack does not
 * use (fixes the "textures leak when switching themes" issue for the new art; the legacy CPU textures are still
 * disposed by Arena.dispose()).
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { ArenaLayout, ThemeId } from '../../sim/arenaGen';
import { artFor, assetsOf, tierOf, type AssetId, type AssetTier, type KitSocket, type ThemeArt } from './art';
import { backdropTier, type BackdropData, type BackdropJson, type TexFiles } from './backdrop';
import type { SkyLook } from './sky';

export type TexFormat = 'ktx2' | 'webp';

export interface ManifestEntry {
  role: string;
  kind?: string;
  contract?: { radius?: number; height?: number };
  sources?: string[];
  files: Record<AssetTier, Partial<Record<TexFormat, string>>>;
}
export interface ArenaManifest {
  version: number;
  assets: Record<AssetId, ManifestEntry>;
}

export interface KitInstance {
  obj: THREE.Object3D;
  sockets: KitSocket[];
  asset: KitAsset;
}

/** one loaded asset GLB (one tier, one texture format) */
export class KitAsset {
  readonly root: THREE.Object3D;
  readonly sockets: KitSocket[] = [];
  readonly extras: Record<string, unknown>;
  readonly lod: string;
  readonly bytes: number;
  /** A3: 9-slice band [y0, y1] (asset frame, m) of a stretchable obstacle (the SHAFT node), else null */
  shaft: [number, number] | null = null;
  constructor(
    readonly id: AssetId,
    readonly tier: AssetTier,
    readonly format: TexFormat,
    readonly url: string,
    scene: THREE.Object3D,
    bytes = 0,
  ) {
    this.bytes = bytes;
    const root = scene.getObjectByName(`KIT_${id.split('/').pop()}`) ?? scene.children.find((c) => c.name.startsWith('KIT_')) ?? scene;
    this.root = root;
    this.extras = { ...(root.userData ?? {}) };
    root.position.set(0, 0, 0);
    root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const p = new THREE.Vector3();
    let lod = '';
    root.traverse((o) => {
      o.userData.kit = true;
      if (/^LOD\d$/.test(o.name)) lod = o.name;
      if (o.name === 'COL' || o.userData.col) {
        o.visible = false;
        o.userData.col = true;
      } else if (o.name.startsWith('FRAC_') || o.userData.frac) {
        // A3: pre-fractured pieces travel with the asset hidden (A5 spawns them along the fall line)
        o.visible = false;
        o.userData.frac = true;
      } else if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
      if (o.name === 'SHAFT' && typeof o.userData.y0 === 'number') this.shaft = [o.userData.y0, o.userData.y1];
      if (o.name.startsWith('SOCK_')) {
        o.getWorldPosition(p).applyMatrix4(inv);
        const { kit: _k, ...extras } = o.userData;
        this.sockets.push({ name: o.name, pos: [p.x, p.y, p.z], extras });
      }
    });
    this.lod = lod;
  }

  /** a placeable copy (shares geometry / materials / textures with the cache) */
  instantiate(): KitInstance {
    const obj = this.root.clone(true);
    obj.userData = { ...this.root.userData, kit: true, asset: this.id };
    return { obj, sockets: this.sockets, asset: this };
  }

  socket(name: string): KitSocket | undefined {
    return this.sockets.find((s) => s.name === name);
  }

  dispose() {
    const done = new Set<unknown>();
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry && !done.has(m.geometry)) done.add(m.geometry), m.geometry.dispose();
      for (const mat of m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : []) {
        if (done.has(mat)) continue;
        done.add(mat);
        for (const v of Object.values(mat)) if (v instanceof THREE.Texture && !done.has(v)) done.add(v), v.dispose();
        mat.dispose();
      }
    });
  }
}

/** everything one arena build needs, resolved for its theme / tier */
export interface ArenaPack {
  theme: ThemeId;
  tier: AssetTier;
  art: ThemeArt;
  assets: Map<AssetId, KitAsset>;
  /** ids that failed to load (the dressing falls back to the legacy builder for those slots) */
  missing: AssetId[];
  ms: number;
  /** A6: the baked landmark panorama for this quality (null: none in the art, or it failed: the legacy skyline stays) */
  backdrop: BackdropData | null;
  /** A7c: the authored sky for this quality (null: none in the art, or it failed: the A7b storm deck stays) */
  sky?: SkyData | null;
}

/** A7c: public/arena/sky/<id>/sky.json (tools/arena/build_sky.mjs) */
export interface SkyJson {
  id: string;
  source: string;
  moon: { az: number; elev: number; diameter: number };
  palette: number[][];
  look: SkyLook;
  tiers: Record<string, { size: [number, number]; tex: TexFiles; gpuMB: number }>;
}
export interface SkyData {
  id: string;
  tier: string;
  json: SkyJson;
  tex: THREE.Texture;
  ms: number;
}

export class ArenaAssets {
  /** texture format used for new loads ('webp' after a KTX2 transcoder failure) */
  format: TexFormat;
  private manifestP: Promise<ArenaManifest> | null = null;
  private cache = new Map<string, Promise<KitAsset>>();
  private done = new Map<string, KitAsset>();
  private loader = new GLTFLoader();
  private ktx2Ready: Promise<boolean> | null = null;
  /** A6: KTX2 loader for standalone textures (backdrop layers), shared with the GLTF loader */
  private ktx2: import('three/examples/jsm/loaders/KTX2Loader.js').KTX2Loader | null = null;
  /** A6: loaded backdrops per id + tier + format (textures owned here, disposed by release) */
  private backdrops = new Map<string, Promise<BackdropData>>();
  private backdropDone = new Map<string, BackdropData>();
  /** A7c: loaded skies per id + tier */
  private skies = new Map<string, Promise<SkyData>>();
  private skyDone = new Map<string, SkyData>();

  constructor(
    private renderer: THREE.WebGLRenderer | null,
    readonly base = '/arena/',
    readonly basisPath = '/basis/',
    format?: TexFormat,
  ) {
    this.loader.setMeshoptDecoder(MeshoptDecoder);
    this.format = format ?? (renderer ? 'ktx2' : 'webp');
  }

  manifest(): Promise<ArenaManifest> {
    return (this.manifestP ??= fetch(this.base + 'manifest.json').then((r) => {
      if (!r.ok) throw new Error(`arena manifest: HTTP ${r.status}`);
      return r.json() as Promise<ArenaManifest>;
    }));
  }

  private initKtx2(): Promise<boolean> {
    return (this.ktx2Ready ??= (async () => {
      if (!this.renderer) return false;
      try {
        const { KTX2Loader } = await import('three/examples/jsm/loaders/KTX2Loader.js');
        const k = new KTX2Loader().setTranscoderPath(this.basisPath).detectSupport(this.renderer);
        this.loader.setKTX2Loader(k);
        this.ktx2 = k;
        return true;
      } catch (e) {
        console.warn('[arena assets] KTX2 unavailable, using WebP', e);
        return false;
      }
    })());
  }

  /** load one asset (cached per id + tier + format); KTX2 failures retry once as WebP and switch the default */
  asset(id: AssetId, tier: AssetTier): Promise<KitAsset> {
    const key = `${id}|${tier}|${this.format}`;
    let p = this.cache.get(key);
    if (!p) {
      p = this.fetchAsset(id, tier, this.format).catch(async (e) => {
        if (this.format !== 'ktx2') throw e;
        console.warn(`[arena assets] ${id} (${tier}) failed as KTX2, retrying as WebP`, e);
        this.format = 'webp';
        this.cache.delete(key);
        return this.asset(id, tier);
      });
      this.cache.set(key, p);
    }
    return p;
  }

  private async fetchAsset(id: AssetId, tier: AssetTier, fmt: TexFormat): Promise<KitAsset> {
    const m = await this.manifest();
    const e = m.assets[id];
    if (!e) throw new Error(`arena asset ${id} is not in the manifest`);
    const file = e.files[tier]?.[fmt] ?? e.files.full?.[fmt];
    if (!file) throw new Error(`arena asset ${id}: no ${tier}/${fmt} file`);
    if (fmt === 'ktx2' && !(await this.initKtx2())) throw new Error('KTX2 transcoder unavailable');
    const url = this.base + file;
    const gltf = await this.loader.loadAsync(url);
    const a = new KitAsset(id, tier, fmt, url, gltf.scene);
    this.done.set(`${id}|${tier}|${fmt}`, a);
    return a;
  }

  /** load what a theme's art needs for this layout and quality (assets that fail are listed in `missing`) */
  async load(theme: ThemeId, quality: number, layout?: ArenaLayout): Promise<ArenaPack> {
    const t0 = performance.now();
    const art = artFor(theme);
    const tier = tierOf(quality);
    const ids = assetsOf(art, layout);
    const assets = new Map<AssetId, KitAsset>();
    const missing: AssetId[] = [];
    await Promise.all(
      ids.map((id) =>
        this.asset(id, tier).then(
          (a) => void assets.set(id, a),
          (e) => {
            console.warn(`[arena assets] ${id} unavailable, legacy visual used`, e);
            missing.push(id);
          },
        ),
      ),
    );
    let backdrop: BackdropData | null = null;
    if (art.backdrop) {
      try {
        backdrop = await this.loadBackdrop(art.backdrop.id, quality);
      } catch (e) {
        console.warn(`[arena assets] backdrop ${art.backdrop.id} unavailable`, e);
        missing.push(`backdrop/${art.backdrop.id}`);
      }
    }
    let sky: SkyData | null = null;
    if (art.sky) {
      try {
        sky = await this.loadSky(art.sky.id, quality);
      } catch (e) {
        console.warn(`[arena assets] sky ${art.sky.id} unavailable`, e);
        missing.push(`sky/${art.sky.id}`);
      }
    }
    return { theme, tier, art, assets, missing, ms: performance.now() - t0, backdrop, sky };
  }

  /** A7c: an authored sky (sky.json + the quality tier's data texture: linear, repeat in u, clamped in v), cached */
  loadSky(id: string, quality: number): Promise<SkyData> {
    const tier = backdropTier(quality);
    const key = `${id}|${tier}`;
    let p = this.skies.get(key);
    if (!p) {
      p = (async () => {
        const t0 = performance.now();
        const r = await fetch(`${this.base}sky/${id}/sky.json`);
        if (!r.ok) throw new Error(`sky ${id}: HTTP ${r.status}`);
        const json = (await r.json()) as SkyJson;
        const T = json.tiers[tier];
        if (!T) throw new Error(`sky ${id}: no tier ${tier}`);
        const tex = await this.texture(T.tex, false);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.anisotropy = 1;
        tex.name = `sky.${id}.${tier}`;
        const d: SkyData = { id, tier, json, tex, ms: performance.now() - t0 };
        this.skyDone.set(key, d);
        return d;
      })();
      p.catch(() => this.skies.delete(key));
      this.skies.set(key, p);
    }
    return p;
  }

  /** one texture file (KTX2 or WebP by the session format; KTX2 failures fall back to WebP like the GLBs) */
  private async texture(f: TexFiles, srgb: boolean): Promise<THREE.Texture> {
    if (this.format === 'ktx2' && f.ktx2 && (await this.initKtx2()) && this.ktx2) {
      try {
        const t = await this.ktx2.loadAsync(this.base + f.ktx2);
        t.wrapS = THREE.RepeatWrapping;
        return t;
      } catch (e) {
        console.warn('[arena assets] KTX2 texture failed, using WebP', f.ktx2, e);
        this.format = 'webp';
      }
    }
    if (!f.webp) throw new Error('no WebP fallback');
    const t = await new THREE.TextureLoader().loadAsync(this.base + f.webp);
    t.flipY = false;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.needsUpdate = true;
    return t;
  }

  /** A6: a backdrop (backdrop.json + the quality tier's textures and depth grids), cached per id + tier */
  loadBackdrop(id: string, quality: number): Promise<BackdropData> {
    const tier = backdropTier(quality);
    const key = `${id}|${tier}`;
    let p = this.backdrops.get(key);
    if (!p) {
      p = (async () => {
        const t0 = performance.now();
        const r = await fetch(`${this.base}backdrop/${id}/backdrop.json`);
        if (!r.ok) throw new Error(`backdrop ${id}: HTTP ${r.status}`);
        const json = (await r.json()) as BackdropJson;
        const T = json.tiers[tier];
        if (!T) throw new Error(`backdrop ${id}: no tier ${tier}`);
        const bin = async (f: string) => new Uint16Array(await (await fetch(this.base + f)).arrayBuffer());
        const layers = await Promise.all(
          T.layers.map(async (def) => {
            const [map, aov, depth, cover] = await Promise.all([
              this.texture(def.tex, true),
              this.texture(def.aov, false),
              bin(def.depth),
              def.cover ? fetch(this.base + def.cover).then(async (r) => new Uint8Array(await r.arrayBuffer())) : Promise.resolve(null),
            ]);
            if (cover && cover.length !== def.grid[0] * def.grid[1]) throw new Error(`backdrop ${id}: cover ${def.cover} has ${cover.length} cells`);
            if (depth.length !== (def.grid[0] + 1) * (def.grid[1] + 1)) throw new Error(`backdrop ${id}: depth grid ${def.depth} has ${depth.length} values`);
            return { def, map, aov, depth, cover };
          }),
        );
        const inset = T.inset ? { map: await this.texture(T.inset.tex, true), camera: T.inset.camera } : undefined;
        const cards: BackdropData['cards'] = {};
        if (tier !== 'q0') for (const [k, c] of Object.entries(json.cards ?? {})) cards[k] = { map: await this.texture(c.tex, true), grid: c.grid, frames: c.frames };
        const textures = [...layers.flatMap((l) => [l.map, l.aov]), ...(inset ? [inset.map] : []), ...Object.values(cards).map((c) => c.map)];
        const d: BackdropData = { id, tier, json, layers, inset, cards, textures, ms: performance.now() - t0 };
        this.backdropDone.set(key, d);
        return d;
      })();
      p.catch(() => this.backdrops.delete(key));
      this.backdrops.set(key, p);
    }
    return p;
  }

  /** start downloading a theme's assets early (select screen, A21); errors are left to the real load */
  prefetch(theme: ThemeId, quality: number, layout?: ArenaLayout) {
    void this.load(theme, quality, layout).catch(() => {});
  }

  /** dispose every loaded asset the kept pack does not use (call after the new arena is built) */
  release(keep: ArenaPack | null) {
    // A7c: skies the kept pack does not use
    for (const [key, d] of this.skyDone) {
      if (keep?.sky === d) continue;
      d.tex.dispose();
      this.skyDone.delete(key);
      this.skies.delete(key);
    }
    // A6: backdrops the kept pack does not use
    for (const [key, d] of this.backdropDone) {
      if (keep?.backdrop === d) continue;
      for (const t of d.textures) t.dispose();
      this.backdropDone.delete(key);
      this.backdrops.delete(key);
    }
    const used = new Set(keep ? [...keep.assets.values()] : []);
    for (const [key, a] of this.done) {
      if (used.has(a)) continue;
      a.dispose();
      this.done.delete(key);
      this.cache.delete(key);
    }
  }

  /** debug: what is resident */
  info() {
    return { format: this.format, loaded: [...this.done.keys()] };
  }
}

/** `?arena=legacy` keeps the pre-A1 procedural path exactly (no manifest fetch, no kit assets) */
export function arenaMode(search = typeof location !== 'undefined' ? location.search : ''): 'kit' | 'legacy' {
  return new URLSearchParams(search).get('arena') === 'legacy' ? 'legacy' : 'kit';
}
/** `?arenatex=webp` forces the WebP fallback files (testing the fallback path) */
export function arenaTexOverride(search = typeof location !== 'undefined' ? location.search : ''): TexFormat | undefined {
  const v = new URLSearchParams(search).get('arenatex');
  return v === 'webp' || v === 'ktx2' ? v : undefined;
}
