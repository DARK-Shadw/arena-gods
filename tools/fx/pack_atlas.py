"""Pack baked flipbook frames (tools/fx/_bake/<id>/) into atlases in public/fx/ + manifest.

  python -P tools/fx/pack_atlas.py                 # every bake that has a bake.json
  python -P tools/fx/pack_atlas.py fire_loop smoke_wisp
  python -P tools/fx/pack_atlas.py --hires         # 256 px frames (only with KTX2: VRAM budget)

Per atlas it writes
  <id>.webp       full tier   (8x8 x 128 px = 1024^2 by default)
  <id>.low.webp   low tier    (half the frame size)
  <id>.mv.webp    motion vectors (half frame size, lossless, RG = flow, B = 0) when bake.json has mv
and PNG intermediates in tools/fx/_work/ for encode_ktx2.mjs.

Frame data (see docs/fx-pipeline.md):
  emissive / emissive+smoke / lit-fixed : RGB = premultiplied colour (sRGB), A = coverage
  lit3   : R/G/B = luminance lit from screen right / top / left (sRGB-encoded), A = coverage
Values are normalised so the 99.9th percentile of the whole sequence is 1.0; the factor is
stored as `hdrScale` (multiply the decoded linear value to get bake radiance).
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fxlib as L  # noqa: E402
import cv2  # noqa: E402
import numpy as np  # noqa: E402


# 'core' = loaded at session start (GPU budget); 'alt' = shipped, loaded on demand. The Unity Labs
# packs (ingest_packs.py) took the core slot where they are better: Flame02 > fire_loop,
# Explosion00 > explosion, FireBall01 > fire_burst, WispySmoke01 > smoke_wisp (owner to confirm
# in the FX Lab). energy_swirl is for the F8 magic work.
# per-atlas full-tier frame size where 128 px is more than the effect needs (GPU budget)
FRAME_PX = {'embers': 96, 'splash': 96}
SETS = {'fire_loop': 'alt', 'fire_burst': 'alt', 'explosion': 'alt', 'smoke_wisp': 'alt', 'energy_swirl': 'alt'}


def load_frames(bdir, meta):
    n = meta['frames']
    fdir = os.path.join(bdir, 'frames')
    if meta['kind'] == 'lit3':
        frames = []
        for i in range(n):
            ps = [L.read_exr(os.path.join(fdir, p, f'f_{i:04d}.exr')) for p in ('L0', 'L1', 'L2')]
            lum = [0.2126 * p[..., 0] + 0.7152 * p[..., 1] + 0.0722 * p[..., 2] for p in ps]
            frames.append(np.stack(lum + [ps[1][..., 3]], -1))
        return frames
    return [L.read_exr(os.path.join(fdir, f'f_{i:04d}.exr')) for i in range(n)]


def motion_vectors(frames_u8, loop, px_out):
    """Farneback optical flow frame n -> n+1 on (alpha + luma). Returns list of (px_out,px_out,2)
    flows in UV units per frame and the encode scale."""
    n = len(frames_u8)
    g = [cv2.cvtColor(f[..., :3], cv2.COLOR_RGB2GRAY) // 2 + f[..., 3] // 2 for f in frames_u8]
    px = g[0].shape[0]
    flows = []
    for i in range(n):
        j = (i + 1) % n if loop else min(i + 1, n - 1)
        a, b = (g[i], g[j]) if j != i else (g[i - 1], g[i])
        fl = cv2.calcOpticalFlowFarneback(a, b, None, 0.5, 3, 9, 3, 5, 1.1, 0)
        fl = cv2.resize(fl, (px_out, px_out), interpolation=cv2.INTER_AREA) / px     # -> UV units
        flows.append(fl)
    scale = float(max(1e-4, np.percentile(np.abs(np.stack(flows)), 99.8)))
    return flows, scale


def pack_one(aid, hires=False):
    bdir = os.path.join(L.BAKE, aid)
    with open(os.path.join(bdir, 'bake.json')) as f:
        meta = json.load(f)
    if meta.get('preview'):
        L.log(f'skip {aid}: preview bake (only {meta["preview"]} frames)')
        return None
    cols, rows = meta['grid']
    n = cols * rows
    if meta['frames'] != n:
        raise SystemExit(f'{aid}: {meta["frames"]} frames do not fill a {cols}x{rows} grid')
    full_px = min(meta['px'], (256 if hires else 128) if aid not in FRAME_PX else FRAME_PX[aid] * (2 if hires else 1))
    low_px = full_px // 2
    L.log(f'{aid}: {n} frames {meta["px"]}px -> {cols}x{rows} x {full_px}px ({meta["kind"]})')
    frames = load_frames(bdir, meta)
    hi = np.percentile(np.stack([f[..., :3].max(-1) for f in frames]), 99.9)
    k = 1.0 / max(hi, 1e-6)
    fade = None
    out = {}
    for tier, px in (('full', full_px), ('low', low_px)):
        fade = L.edge_fade(px)
        cells = []
        for fr in frames:
            x = L.resize(fr, px).copy()
            x[..., :3] *= k
            x *= fade[..., None]
            # premultiplied: colour can never exceed alpha for occluding kinds; emissive may (additive)
            enc = np.concatenate([L.srgb_encode(x[..., :3]), np.clip(x[..., 3:], 0, 1)], -1)
            cells.append(L.to_u8(enc))
        atlas = L.grid_pack(cells, cols, rows)
        suffix = '' if tier == 'full' else '.low'
        fn = f'{aid}{suffix}.webp'
        size = L.save_webp(atlas, os.path.join(L.PUB, fn))
        L.save_png(atlas, os.path.join(L.WORK, f'{aid}{suffix}.png'))
        out[tier] = {'file': fn, 'w': atlas.shape[1], 'h': atlas.shape[0], 'frame': px, 'frameW': px, 'frameH': px, 'bytes': size}
        if tier == 'full':
            full_cells = cells
    entry = {
        'type': 'flipbook', 'kind': meta['kind'], 'grid': [cols, rows], 'frames': n,
        'fps': round(meta['fps'], 3), 'loop': meta['loop'], 'blend': meta['blend'],
        'tint': meta.get('tint', False), 'colorSpace': 'srgb', 'premultiplied': True, 'set': SETS.get(aid, 'core'),
        'hdrScale': round(float(1.0 / k), 5), 'pivot': meta.get('pivot', [0.5, 0.5]),
        'worldSize': meta.get('worldSize'), 'order': 'row-major, frame 0 top-left',
        'full': out['full'], 'low': out['low'], 'notes': meta.get('notes', ''),
        'source': {'type': 'blender-bake', 'method': meta.get('method'), 'blender': meta.get('blender'),
                   'engine': meta.get('engine'), 'bakePx': meta['px'], 'peakRamMB': meta.get('peakRamMB'),
                   'bakeSeconds': meta.get('bakeSeconds'), 'command': meta.get('command')},
    }
    if meta.get('cameraElevationDeg'):
        entry['cameraElevationDeg'] = meta['cameraElevationDeg']
    if meta['kind'] == 'lit3':
        entry['lightDirs'] = {'R': 'screen right, 35deg toward camera', 'G': 'screen top, 35deg toward camera',
                              'B': 'screen left, 35deg toward camera'}
    files = [out['full']['file'], out['low']['file']]
    if meta.get('mv'):
        mvpx = full_px // 2
        flows, sc = motion_vectors(full_cells, meta['loop'], mvpx)
        cells = []
        for fl in flows:
            rg = np.clip(fl / sc * 0.5 + 0.5, 0, 1)
            cells.append(L.to_u8(np.concatenate([rg, np.zeros_like(rg[..., :1])], -1)))
        atlas = L.grid_pack(cells, cols, rows)
        fn = f'{aid}.mv.webp'
        size = L.save_webp(atlas, os.path.join(L.PUB, fn), lossless=True)
        L.save_png(atlas, os.path.join(L.WORK, f'{aid}.mv.png'))
        entry['mv'] = {'file': fn, 'w': atlas.shape[1], 'h': atlas.shape[0], 'frame': mvpx, 'bytes': size,
                       'scale': round(sc, 6), 'colorSpace': 'linear',
                       'decode': 'mv = (tex.rg * 2 - 1) * scale  // UV units of ONE frame cell, frame n -> n+1',
                       'use': 'c0 = tex(uv0 - mv0 * k); c1 = tex(uv1 + mv1 * (1 - k)); mix(c0, c1, k)'}
        files.append(fn)
    L.ledger_set(files, f'Blender bake: tools/fx/blender ({meta.get("method")})', 'CC0 1.0 (own work, Arena Gods)',
                 'tools/fx/blender', notes=f'baked {meta.get("blender")} {meta.get("engine")}')
    return entry


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('ids', nargs='*')
    ap.add_argument('--hires', action='store_true')
    a = ap.parse_args()
    L.ensure_dirs()
    ids = a.ids or sorted(d for d in os.listdir(L.BAKE) if os.path.exists(os.path.join(L.BAKE, d, 'bake.json')))
    m = L.load_manifest()
    for aid in ids:
        e = pack_one(aid, a.hires)
        if e:
            m['atlases'][aid] = e
            L.log(f'  -> {e["full"]["file"]} {e["full"]["bytes"] / 1024:.0f} KB, low {e["low"]["bytes"] / 1024:.0f} KB'
                  + (f', mv {e["mv"]["bytes"] / 1024:.0f} KB' if 'mv' in e else ''))
    L.save_manifest(m)


if __name__ == '__main__':
    main()
