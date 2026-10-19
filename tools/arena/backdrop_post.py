"""A6 backdrop post-process (arena art plan 5.6, milestone A6): Blender panorama outputs -> per-tier game files.

  python tools/arena/backdrop_post.py --src tools/arena/_bake/backdrop_moongate --inset tools/arena/_bake/backdrop_moongate_inset
        --cards tools/arena/_bake/backdrop_cards --out tools/arena/_work/backdrop/moongate [--preview <dir>]
  (numpy + Pillow from the user site-packages: run WITHOUT -I; called by tools/arena/build_backdrop.mjs)

Input (backdrop_pano.py): <layer>_color.png (RGBA, straight alpha), <layer>_aov.png (R emission, G water, B unused),
<layer>_depth.npy (radial metres from the pano origin, row 0 = latMax, >= 1e8 = no surface), backdrop_src.json.
Per tier (plan 6.6; GPU memory is the limit: the medium tier has about 11 MB left after the kit):
  q2 (high)    near 8192x1368, mid 8192x1368, far 4096x684 + AOV at half size + hero inset 4096x2048
  q1 (medium)  near 4096x684, 'farc' = mid over far 3072x512 + AOV near 2048x344 / farc 1024x172 (A8: no inset)
  q0 (low)     one composite of all layers 2048x344 + AOV 1024x172, no inset
Colour: alpha-0 texels are filled from their neighbours (push-pull) so filtering and mipmaps have no dark fringes.
AOV B (cloud) is derived here: far-layer coverage where the volume has no surface depth.
Depth: a coarse grid per layer (vertices of the game's displaced cylinder): per cell a low percentile of the covered
texels' depth (silhouettes keep their foreground depth), empty cells filled from neighbours, then smoothed; nodes on
cell corners, u wraps; stored as uint16 decimetres, (gh + 1) rows x (gw + 1) columns, row 0 = latMax.
Writes <out>/<tier>/*.png + *.bin and <out>/layout.json (sizes, grids, latitude band, inset camera) for build_backdrop.mjs.
--preview <dir>: a composite over a night-sky stand-in (sky.ts colours + moon) with distance fog, full strip + the
ref-3 direction, for judging the render by eye before the game sees it.
"""
import argparse
import json
import math
import os

import numpy as np
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument('--src', required=True)
ap.add_argument('--inset', default='')
ap.add_argument('--cards', default='')
ap.add_argument('--out', required=True)
ap.add_argument('--preview', default='')
ap.add_argument('--fog-color', default='3b3462')
ap.add_argument('--fog-density', type=float, default=0.0065)
ap.add_argument('--fog-height', type=float, default=0.07)
ap.add_argument('--fog-range', type=float, default=140.0)
A = ap.parse_args()

SRC = json.load(open(os.path.join(A.src, 'backdrop_src.json'), encoding='utf-8'))
LAT0, LAT1 = SRC['latMin'], SRC['latMax']
ORIGIN_Y = SRC['origin'][1]
GRIDS = {'near': (512, 96), 'mid': (256, 48), 'far': (128, 24), 'farc': (256, 48), 'all': (256, 48)}
DEFAULT_DEPTH = {'near': 90.0, 'mid': 300.0, 'far': 1100.0, 'farc': 600.0, 'all': 300.0}
TIERS = {
    'q2': {'layers': {'near': (8192, 1368), 'mid': (8192, 1368), 'far': (4096, 684)}, 'aov': 0.5, 'inset': (4096, 2048)},
    # A8: no hero inset on medium (its GPU texture budget has no headroom: about 126.6 of 128 MB before A8)
    'q1': {'layers': {'near': (4096, 684), 'farc': (3072, 512)}, 'aovSize': {'near': (2048, 344), 'farc': (1024, 172)}},
    'q0': {'layers': {'all': (2048, 344)}, 'aovSize': {'all': (1024, 172)}},
}


def gblur(x, sigma):
    """separable gaussian blur of a float 2D array (u wraps, v clamps)"""
    r = int(sigma * 3) + 1
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    out = sum(np.roll(x, i, 1) * k[i + r] for i in range(-r, r + 1))
    p = np.pad(out, ((r, r), (0, 0)), mode='edge')
    return sum(p[r + i: r + i + x.shape[0]] * k[i + r] for i in range(-r, r + 1)).astype(np.float32)


def stitch(name, kind, mode):
    """<layer>_<kind>.png, or the strips <layer>_s<k>_<kind>.png side by side (backdrop_pano.py --strips)"""
    p = os.path.join(A.src, f'{name}_{kind}.png')
    if os.path.exists(p):
        return Image.open(p).convert(mode)
    parts = []
    k = 0
    while os.path.exists(os.path.join(A.src, f'{name}_s{k}_{kind}.png')):
        parts.append(Image.open(os.path.join(A.src, f'{name}_s{k}_{kind}.png')).convert(mode))
        k += 1
    if not parts:
        raise FileNotFoundError(p)
    out = Image.new(mode, (sum(x.size[0] for x in parts), parts[0].size[1]))
    x = 0
    for im in parts:
        out.paste(im, (x, 0))
        x += im.size[0]
    return out


def has_layer(name):
    return os.path.exists(os.path.join(A.src, f'{name}_color.png')) or os.path.exists(os.path.join(A.src, f'{name}_s0_color.png'))


def load_layer(name):
    col = np.asarray(stitch(name, 'color', 'RGBA'), np.float32) / 255.0
    aov = np.asarray(stitch(name, 'aov', 'RGB'), np.float32) / 255.0
    dep = np.load(os.path.join(A.src, f'{name}_depth.npy')).astype(np.float32)
    h, w = col.shape[:2]
    if dep.shape != (h, w):
        raise SystemExit(f'{name}: depth {dep.shape} != colour {(h, w)}')
    if aov.shape[:2] != (h, w):
        aov = np.asarray(Image.fromarray((aov * 255).astype(np.uint8)).resize((w, h), Image.BILINEAR), np.float32) / 255
    if name == 'far':
        # Cycles denoises colour, not alpha: the cloud volumes' alpha is speckled. Blur alpha where there is no surface.
        from PIL import ImageFilter
        a8 = Image.fromarray((col[..., 3] * 255).astype(np.uint8))
        ab = np.asarray(a8.filter(ImageFilter.GaussianBlur(max(1.0, w / 2048.0))), np.float32) / 255.0
        col = col.copy()
        col[..., 3] = np.where(dep >= 1e8, ab, col[..., 3])
        # cloud colour: a soft blur of the premultiplied colour too (volumes; matters for low-sample renders)
        rad = 1.6 * max(1.0, w / 2048.0)
        pm = [gblur(col[..., c] * col[..., 3], rad) for c in range(3)]
        ab2 = gblur(col[..., 3], rad)
        for c in range(3):
            col[..., c] = np.where(dep >= 1e8, np.where(ab2 > 1e-3, pm[c] / np.maximum(ab2, 1e-3), col[..., c]), col[..., c])
        cloud = col[..., 3] * (dep >= 1e8)
        aov = aov.copy()
        aov[..., 2] = np.maximum(aov[..., 2], cloud)
    return {'name': name, 'col': col, 'aov': aov, 'dep': dep}


def resize(arr, size, resample=Image.LANCZOS):
    """float HxWxC array -> resized (w, h); alpha-premultiplied for RGBA so edges do not darken"""
    w, h = size
    if arr.shape[1] == w and arr.shape[0] == h:
        return arr
    if arr.shape[-1] == 4:
        pm = arr.copy()
        pm[..., :3] *= pm[..., 3:4]
        chans = [np.asarray(Image.fromarray(pm[..., c]).resize((w, h), resample), np.float32) for c in range(4)]
        out = np.stack(chans, -1)
        a = np.clip(out[..., 3:4], 1e-6, None)
        out[..., :3] = np.where(out[..., 3:4] > 1e-4, out[..., :3] / a, 0)
        return np.clip(out, 0, 1)
    chans = [np.asarray(Image.fromarray(arr[..., c]).resize((w, h), resample), np.float32) for c in range(arr.shape[-1])]
    return np.clip(np.stack(chans, -1), 0, 1)


def over(top, bot):
    """straight-alpha 'over' of two RGBA float images (same size)"""
    ta, ba = top[..., 3:4], bot[..., 3:4]
    oa = ta + ba * (1 - ta)
    oc = np.where(oa > 1e-5, (top[..., :3] * ta + bot[..., :3] * ba * (1 - ta)) / np.clip(oa, 1e-5, None), 0)
    return np.concatenate([oc, oa], -1)


def composite(layers):
    """layers ordered near -> far: RGBA over, AOV by visibility weight, depth of the nearest covered layer"""
    h, w = layers[0]['col'].shape[:2]
    acc = np.zeros((h, w, 4), np.float32)
    aov = np.zeros((h, w, 3), np.float32)
    dep = np.full((h, w), 1e9, np.float32)
    vis = np.ones((h, w, 1), np.float32)
    for L in layers:
        c = resize(L['col'], (w, h))
        ao = resize(L['aov'], (w, h), Image.BILINEAR)
        d = L['dep'] if L['dep'].shape == (h, w) else np.asarray(Image.fromarray(L['dep']).resize((w, h), Image.NEAREST), np.float32)
        acc = over(acc, c) if acc[..., 3].any() else c.copy()
        aov += ao * c[..., 3:4] * vis
        take = (dep >= 1e8) & (c[..., 3] > 0.5) & (d < 1e8)
        dep = np.where(take, d, dep)
        vis *= 1 - c[..., 3:4]
    return {'col': acc, 'aov': np.clip(aov, 0, 1), 'dep': dep}


def push_pull(rgba):
    """fill the colour of alpha-0 texels from their neighbours (keeps alpha): no dark fringes under filtering"""
    col, a = rgba[..., :3], rgba[..., 3]
    levels = []
    c, w = col * (a[..., None] > 0.004), (a > 0.004).astype(np.float32)
    while min(c.shape[:2]) > 2:
        levels.append((c, w))
        h2, w2 = c.shape[0] // 2 * 2, c.shape[1] // 2 * 2
        c4 = c[:h2, :w2].reshape(h2 // 2, 2, w2 // 2, 2, 3).sum((1, 3))
        w4 = w[:h2, :w2].reshape(h2 // 2, 2, w2 // 2, 2).sum((1, 3))
        c = np.where(w4[..., None] > 0, c4 / np.clip(w4[..., None], 1e-6, None), 0)
        w = (w4 > 0).astype(np.float32)
    fill = c
    for c, w in reversed(levels):
        up = np.repeat(np.repeat(fill, 2, 0), 2, 1)
        up = np.pad(up, ((0, c.shape[0] - up.shape[0]), (0, c.shape[1] - up.shape[1]), (0, 0)), mode='edge')[: c.shape[0], : c.shape[1]]
        fill = np.where(w[..., None] > 0, c, up)
    out = rgba.copy()
    out[..., :3] = np.where(a[..., None] > 0.004, col, fill)
    return out


def depth_grid(dep, alpha, gw, gh, default):
    h, w = dep.shape
    cells = np.full((gh, gw), np.nan, np.float32)
    ys = np.linspace(0, h, gh + 1).astype(int)
    xs = np.linspace(0, w, gw + 1).astype(int)
    for j in range(gh):
        for i in range(gw):
            d = dep[ys[j]:ys[j + 1], xs[i]:xs[i + 1]]
            m = (d < 1e8) & (alpha[ys[j]:ys[j + 1], xs[i]:xs[i + 1]] > 0.5)
            if m.mean() > 0.04:
                cells[j, i] = np.percentile(d[m], 30)
    # fill empty cells from neighbours (u wraps), then the layer default
    for _ in range(max(gw, gh)):
        nan = np.isnan(cells)
        if not nan.any():
            break
        pad = np.pad(cells, ((1, 1), (0, 0)), mode='edge')
        nb = np.stack([np.roll(cells, 1, 1), np.roll(cells, -1, 1), pad[:-2], pad[2:]])
        cnt = np.sum(~np.isnan(nb), 0)
        s = np.nansum(nb, 0)
        cells = np.where(nan & (cnt > 0), s / np.maximum(cnt, 1), cells)
        if np.isnan(cells).sum() == nan.sum():
            break
    cells = np.where(np.isnan(cells), default, cells)
    # smooth twice (3x3, wrap in u), in log space so near / far mixes do not pull far surfaces forward too much
    lc = np.log(cells)
    for _ in range(2):
        pad = np.pad(lc, ((1, 1), (0, 0)), mode='edge')
        acc = np.zeros_like(lc)
        for dj in (0, 1, 2):
            row = pad[dj:dj + gh]
            acc += row + np.roll(row, 1, 1) + np.roll(row, -1, 1)
        lc = lc * 0.4 + (acc / 9) * 0.6
    cells = np.exp(lc)
    # nodes at cell corners: mean of the adjacent cells (u wraps, v clamps)
    pad = np.pad(cells, ((1, 1), (0, 0)), mode='edge')
    nodes = np.zeros((gh + 1, gw + 1), np.float32)
    for j in range(gh + 1):
        a, b = pad[j], pad[j + 1]
        row = (a + np.roll(a, 1) + b + np.roll(b, 1)) / 4
        nodes[j, :gw] = row
        nodes[j, gw] = row[0]
    return nodes


def coverage(alpha, gw, gh):
    """1 per grid cell that holds any visible texel (dilated by one cell, u wraps): the game skips empty cells, so
    the transparent part of each layer's band costs no fragments"""
    h, w = alpha.shape
    ys = np.linspace(0, h, gh + 1).astype(int)
    xs = np.linspace(0, w, gw + 1).astype(int)
    c = np.zeros((gh, gw), bool)
    for j in range(gh):
        row = alpha[ys[j]:ys[j + 1]].max(0)
        for i in range(gw):
            c[j, i] = row[xs[i]:xs[i + 1]].max() > 0.004
    p = np.pad(c, ((1, 1), (0, 0)))
    d = c.copy()
    for dj in (0, 1, 2):
        r = p[dj:dj + gh]
        d |= r | np.roll(r, 1, 1) | np.roll(r, -1, 1)
    return d


def save_png(arr, path, mode):
    a8 = (np.clip(arr, 0, 1) * 255 + 0.5).astype(np.uint8)
    Image.fromarray(a8, mode).save(path, optimize=False, compress_level=6)
    return path


def srgb_to_lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    c = np.clip(c, 0, None)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def preview(layers, out_dir):
    """night-sky stand-in + layers far -> near with the game's fog formula (distance compressed by fog-range)"""
    os.makedirs(out_dir, exist_ok=True)
    w, h = 4096, 684
    lat = LAT1 - (np.arange(h) + 0.5) / h * (LAT1 - LAT0)
    az = (np.arange(w) + 0.5) / w * 360 - 180
    AZ, LAT = np.meshgrid(np.radians(az), np.radians(lat))
    dx, dy, dz = np.cos(LAT) * np.cos(AZ), np.sin(LAT), np.cos(LAT) * np.sin(AZ)
    hh = np.clip(dy, 0, 1) ** 0.42
    zen, hor = srgb_to_lin(np.array([0x0a, 0x0d, 0x26]) / 255), srgb_to_lin(np.array([0x36, 0x38, 0x66]) / 255)
    sky = hor * (1 - hh[..., None]) + zen * hh[..., None]
    me, ma = math.radians(26), math.radians(0.0)  # A8: moon centred in the ring arch (ref-3)
    md = np.array([math.cos(me) * math.cos(ma), math.sin(me), math.cos(me) * math.sin(ma)])
    cosm = dx * md[0] + dy * md[1] + dz * md[2]
    moon = np.clip((cosm - math.cos(0.105)) / (math.cos(0.102) - math.cos(0.105)), 0, 1)
    sky = sky * (1 - moon[..., None]) + np.array([0.83, 0.81, 1.0]) * 1.6 * moon[..., None]
    sky += np.array([0.83, 0.81, 1.0]) * (np.clip(cosm, 0, 1) ** 60 * 0.08)[..., None]
    fogc = srgb_to_lin(np.array([int(A.fog_color[i:i + 2], 16) for i in (0, 2, 4)]) / 255)
    img = sky
    for L in reversed(layers):
        c = resize(L['col'], (w, h))
        d = np.asarray(Image.fromarray(np.where(L['dep'] < 1e8, L['dep'], 1500).astype(np.float32)).resize((w, h), Image.NEAREST))
        deff = A.fog_range * (1 - np.exp(-d / A.fog_range))
        yw = ORIGIN_Y + dy * d
        distF = 1 - np.exp(-(A.fog_density * deff) ** 2)
        hD = A.fog_height * np.exp(-np.maximum(yw + 1, 0) / 4.5)
        heightF = 1 - np.exp(-hD * deff)
        f = np.clip(np.maximum(distF, heightF), 0, 1)[..., None]
        lc = srgb_to_lin(c[..., :3]) * 1.6
        lc = lc * (1 - f) + fogc * f
        img = img * (1 - c[..., 3:4]) + lc * c[..., 3:4]
    # simple ACES-ish filmic for the preview only (the game tone-maps + grades on top)
    x = img * 1.15
    tm = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)
    srgb = lin_to_srgb(np.clip(tm, 0, 1))
    full = Image.fromarray((np.clip(srgb, 0, 1) * 255).astype(np.uint8), 'RGB')
    full.save(os.path.join(out_dir, 'preview_strip.jpg'), quality=88)
    # the ref-3 direction: azimuth -60 .. +45 (the preset looks at yaw -17.4 with about 80 deg of width)
    x0, x1 = int((0.5 + -60 / 360) * w), int((0.5 + 45 / 360) * w)
    full.crop((x0, 0, x1, h)).save(os.path.join(out_dir, 'preview_ref3dir.jpg'), quality=90)
    return {'strip': 'preview_strip.jpg', 'ref3': 'preview_ref3dir.jpg'}


def main():
    names = [n for n in ('near', 'mid', 'far') if has_layer(n)]
    L = {n: load_layer(n) for n in names}
    layout = {'latMin': LAT0, 'latMax': LAT1, 'origin': SRC['origin'], 'mapping': SRC.get('mapping'), 'scene': SRC.get('scene'),
              'ranges': {n: SRC['layers'][n]['range'] for n in names}, 'tiers': {}}
    if A.preview:
        layout['preview'] = preview([L[n] for n in names], A.preview)
    derived = {}
    if 'mid' in L and 'far' in L:
        h, w = L['mid']['col'].shape[:2]
        far_up = {'col': resize(L['far']['col'], (w, h)), 'aov': resize(L['far']['aov'], (w, h), Image.BILINEAR),
                  'dep': np.asarray(Image.fromarray(L['far']['dep']).resize((w, h), Image.NEAREST), np.float32)}
        derived['farc'] = composite([L['mid'], far_up])
    derived['all'] = composite([L[n] for n in names])
    src = {**L, **derived}
    os.makedirs(A.out, exist_ok=True)
    for tier, spec in TIERS.items():
        td = os.path.join(A.out, tier)
        os.makedirs(td, exist_ok=True)
        tl = {'layers': []}
        for name, size in spec['layers'].items():
            S = src[name]
            sh, sw = S['col'].shape[:2]
            if sw < size[0]:  # never upscale a source rendered smaller than the tier size (memory without detail)
                size = (sw // 4 * 4, sh // 4 * 4)
            col = push_pull(resize(S['col'], size))
            asz = spec.get('aovSize', {}).get(name) or (size[0] // 2 // 4 * 4, size[1] // 2 // 4 * 4)
            aov = resize(S['aov'], asz, Image.BILINEAR)
            save_png(col, os.path.join(td, f'{name}.png'), 'RGBA')
            save_png(aov, os.path.join(td, f'{name}_aov.png'), 'RGB')
            gw, gh = GRIDS[name]
            nodes = depth_grid(S['dep'], S['col'][..., 3], gw, gh, DEFAULT_DEPTH[name])
            np.clip(np.round(nodes * 10), 0, 65535).astype('<u2').tofile(os.path.join(td, f'{name}_depth.bin'))
            cover = coverage(S['col'][..., 3], gw, gh)
            cover.astype(np.uint8).tofile(os.path.join(td, f'{name}_cover.bin'))
            rng = layout['ranges'].get(name) or [float(nodes.min()), float(nodes.max())]
            tl['layers'].append({'name': name, 'size': list(size), 'aovSize': list(asz), 'grid': [gw, gh], 'depthMin': round(float(nodes.min()), 1),
                                 'depthMax': round(float(nodes.max()), 1), 'cover': round(float(cover.mean()), 3), 'aovUsed': [bool((S['aov'][..., k] > 0.05).any()) for k in range(3)]})
        if spec.get('inset') and A.inset and os.path.exists(os.path.join(A.inset, 'inset_color.png')):
            ins = np.asarray(Image.open(os.path.join(A.inset, 'inset_color.png')).convert('RGBA'), np.float32) / 255
            save_png(push_pull(resize(ins, spec['inset'])), os.path.join(td, 'inset.png'), 'RGBA')
            isrc = json.load(open(os.path.join(A.inset, 'backdrop_src.json'), encoding='utf-8'))['inset']
            tl['inset'] = {'size': list(spec['inset']), 'camera': isrc['camera']}
        layout['tiers'][tier] = tl
    if A.cards:
        layout['cards'] = {}
        res = json.load(open(os.path.join(A.cards, 'result.json'), encoding='utf-8'))
        info = next((s['value'] for s in res['steps'] if s['step'] == 'cards'), {})
        for kind, v in info.items():
            p = os.path.join(A.cards, f'card_{kind}.png')
            if os.path.exists(p):
                im = np.asarray(Image.open(p).convert('RGBA'), np.float32) / 255
                # white-on-black emission + absorption: keep luminance as alpha-weighted mask, colour = white
                save_png(im, os.path.join(A.out, f'card_{kind}.png'), 'RGBA')
                layout['cards'][kind] = {'grid': v['grid'], 'frames': v['frames'], 'px': v['px']}
    json.dump(layout, open(os.path.join(A.out, 'layout.json'), 'w', encoding='utf-8'), indent=1)
    print(json.dumps({t: [(l['name'], l['size'], l['depthMin'], l['depthMax']) for l in v['layers']] for t, v in layout['tiers'].items()}))


main()
