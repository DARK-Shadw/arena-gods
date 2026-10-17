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
      } else if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
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
}

export class ArenaAssets {
  /** texture format used for new loads ('webp' after a KTX2 transcoder failure) */
  format: TexFormat;
  private manifestP: Promise<ArenaManifest> | null = null;
  private cache = new Map<string, Promise<KitAsset>>();
  private done = new Map<string, KitAsset>();
  private loader = new GLTFLoader();
  private ktx2Ready: Promise<boolean> | null = null;

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
    return { theme, tier, art, assets, missing, ms: performance.now() - t0 };
  }

  /** start downloading a theme's assets early (select screen, A21); errors are left to the real load */
  prefetch(theme: ThemeId, quality: number, layout?: ArenaLayout) {
    void this.load(theme, quality, layout).catch(() => {});
  }

  /** dispose every loaded asset the kept pack does not use (call after the new arena is built) */
  release(keep: ArenaPack | null) {
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
