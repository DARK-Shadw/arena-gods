"""A7c sky composer: a CC0 HDRI -> the arena sky data texture + a by-eye preview.

  python tools/arena/sky_compose.py --spec tools/arena/sky/moongate.json [--out tools/arena/_work/sky/moongate]
         [--preview-only] [--compare docs/concept-art/ref-3.png]

The game sky (src/render/arena/sky.ts, `skyTex`) does the LIGHTING in the shader, so clouds can drift while the moon,
its glow, the silver rims and the dark horizon banks stay put. The texture only carries moon-independent STRUCTURE
plus one moon-fixed channel, all linear 8-bit, in the sky's own equirect band:

  u = 0.5 + az / 360   (game azimuth atan2(z, x))       v = 1 - (dir.y + 0.1) / 1.1   (row 0 = zenith)
  R  cloud structure L (log luminance of the photo, large-scale gradient removed, contrast-shaped): billow shading
  G  cloud density D (1 = cloud, 0 = clear gap; from the photo's blue-sky chroma)
  B  rim potential E (thin cloud next to a gap + bright billow tops): where the moon's silver lining goes
  A  moon shafts S (moon-fixed: light through the gaps near the moon, smeared outward along the rays)

Per tier PNGs (INTER_AREA) + layout.json (palette ramp from the concept image boxes, look, sizes) + preview.jpg (the
shader maths re-done in numpy from the concept camera; approximate: no fog / backdrop / bloom / grade).
Memory: the 8k HDR is about 0.4 GB as float32; peak about 1.5 GB. No Blender, no GPU.
"""
import argparse
import json
import math
import os
import sys
import time

import cv2
import numpy as np
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SRC_DIR = os.environ.get('ARENA_SRC') or os.path.join(ROOT, '..', 'Assets', 'arena-src')


def smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def srgb_to_lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def band_dirs(w, h):
    """unit directions of the band's texel centres (game frame: y up, az = atan2(z, x))"""
    u = (np.arange(w, dtype=np.float32) + 0.5) / w
    v = (np.arange(h, dtype=np.float32) + 0.5) / h
    az = (u - 0.5) * 2 * math.pi
    hy = np.clip(1.1 * (1 - v) - 0.1, -1, 1)
    r = np.sqrt(np.maximum(0, 1 - hy * hy))
    return az[None, :], hy[:, None], r[:, None]


def dir_to_px(d, w, h):
    """direction(s) (..., 3) -> band pixel coords (x, y) (float, texel centres at +0.5)"""
    az = np.arctan2(d[..., 2], d[..., 0])
    u = 0.5 + az / (2 * math.pi)
    v = 1 - (np.clip(d[..., 1], -0.1, 1.0) + 0.1) / 1.1
    return u * w - 0.5, v * h - 0.5


def blur(img, sx, sy):
    """separable gaussian with sigma in px; done at reduced size when the sigma is big (speed)"""
    f = max(1, int(min(sx, sy) // 6))
    if f > 1:
        small = cv2.resize(img, (img.shape[1] // f, img.shape[0] // f), interpolation=cv2.INTER_AREA)
        small = cv2.GaussianBlur(small, (0, 0), sigmaX=sx / f, sigmaY=sy / f, borderType=cv2.BORDER_REFLECT)
        return cv2.resize(small, (img.shape[1], img.shape[0]), interpolation=cv2.INTER_LINEAR)
    # wrap horizontally (the band is periodic in u)
    pad = int(3 * sx) + 1
    ext = np.concatenate([img[:, -pad:], img, img[:, :pad]], axis=1)
    return cv2.GaussianBlur(ext, (0, 0), sigmaX=sx, sigmaY=sy, borderType=cv2.BORDER_REFLECT)[:, pad:-pad]


def moon_dir(M):
    e, a = math.radians(M['elev']), math.radians(M['az'])
    return np.array([math.cos(e) * math.cos(a), math.sin(e), math.cos(e) * math.sin(a)], np.float32)


_SRC_CACHE = {}


def load_source(S, log):
    path = os.path.join(SRC_DIR, *S['asset'].split('/'), S['file'])
    if path not in _SRC_CACHE:
        src = cv2.imread(path, cv2.IMREAD_UNCHANGED)
        if src is None:
            raise SystemExit(f'cannot read {path} (node tools/arena/fetch_cc0.mjs {S["asset"].replace("/", ":")} --res=8k)')
        _SRC_CACHE.clear()  # one 8k HDR at a time (0.4 GB as float32)
        _SRC_CACHE[path] = src[:, :, ::-1].astype(np.float32)  # BGR -> RGB, linear radiance
        log(f'source {S["asset"]} {src.shape[1]}x{src.shape[0]}')
    return _SRC_CACHE[path]


def layer(S, F, W, H, log):
    """one photo layer in the band: (structure L, cloud mask C) : L = log luminance minus its large-scale trend
    (the photo's sun side / zenith brightening), contrast-shaped; C = 1 on grey / white cloud, 0 on blue sky"""
    src = load_source(S, log)
    Hs, Ws = src.shape[:2]
    # band -> source: azimuth rotated by `rot` turns; elevation e -> elev0 + k * e above the horizon (skips the ground and
    # the tree line of the photo; k > 1 packs more, smaller billows into the band), mirrored softly below it (the dark
    # bank covers that part)
    az, hy, _ = band_dirs(W, H)
    el = np.degrees(np.arcsin(hy))
    # (soft approach to the pole: slope k at the horizon, never past 89.5 deg, so the zenith does not smear)
    span = 89.5 - S['elev0']
    sel = np.where(el >= 0, 89.5 - span * np.exp(-S['k'] * el / span), S['elev0'] + 0.5 * np.abs(el))
    us = ((az / (2 * math.pi) + 0.5) * (-1 if S.get('mirror') else 1) + S['rot']) % 1.0
    mx = np.broadcast_to(us * Ws - 0.5, (H, W)).astype(np.float32)
    my = np.broadcast_to((90 - sel) / 180 * Hs - 0.5, (H, W)).astype(np.float32)
    rgb = cv2.remap(src, mx, my, interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP)
    R, G, B = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    Y = 0.2126 * R + 0.7152 * G + 0.0722 * B
    chroma = (B - R) / (B + R + 1e-4)
    pxd_x, pxd_y = W / 360.0, H * math.cos(math.radians(25)) / (1.1 * 57.2958)
    C = 1 - smooth(S.get('chromaLo', F['chromaLo']), S.get('chromaHi', F['chromaHi']), blur(chroma, 0.15 * pxd_x, 0.15 * pxd_y))
    lY = np.log2(np.maximum(Y, 1e-4))
    trend = blur(lY, 7 * pxd_x, 7 * pxd_y)
    L = 0.5 + S.get('detail', F['detail']) * (lY - trend) + F['base'] * (trend - np.median(trend))
    L = np.clip(0.5 + (L - 0.5) * S.get('contrast', F['contrast']), 0, 1)
    L = smooth(0, 1, L) * 0.5 + L * 0.5
    return L.astype(np.float32), C.astype(np.float32)


def compose(spec, log):
    """front billows (`source`) over a high textured deck (`back`, optional): the front's blue gaps show the deck, the
    deck's own gaps are the only near-clear sky (dark, starry). Rims sit on the front billows' edges."""
    F = spec['features']
    W, H = spec['master']
    t0 = time.time()
    pxd_x, pxd_y = W / 360.0, H * math.cos(math.radians(25)) / (1.1 * 57.2958)
    Lf, Cf = layer(spec['source'], F, W, H, log)
    if spec.get('back'):
        K = spec['back']
        Lb, Cb = layer(K, F, W, H, log)
        # the deck is further away: softer and darker (a depth cue against the crisp front billows)
        if K.get('soften'):
            Lb = blur(Lb, K['soften'] * pxd_x, K['soften'] * pxd_y)
            Cb = blur(Cb, K['soften'] * pxd_x, K['soften'] * pxd_y)
        Lb = 0.5 + (Lb - 0.5) * K.get('flatten', 1.0)
        Lb = Lb * K.get('gain', 0.75)
        db = K.get('density', 0.8)
        L = Cf * Lf + (1 - Cf) * Lb
        D = np.maximum(Cf, (F['dmin'] + (db - F['dmin']) * Cb))
    else:
        L, D = Lf, F['dmin'] + (1 - F['dmin']) * Cf
    # rim potential (where the moon's silver lining goes): the crisp bright billow edges of the structure (positive
    # high-pass of L, a fraction of a degree) on the brighter half, plus a thin line where front cloud meets a gap
    # (thresholded, so photo grain and chroma noise in grey cloud do not sparkle)
    Ls = cv2.GaussianBlur(L, (0, 0), 1.2)
    hp = Ls - blur(L, F['edgeBlurDeg'] * pxd_x, F['edgeBlurDeg'] * pxd_y)
    crisp = smooth(F['rimLo'], F['rimHi'], hp) * smooth(0.4, 0.8, Ls)
    Cbl = blur(Cf, 0.25 * pxd_x, 0.25 * pxd_y)
    line = smooth(0.1, 0.3, Cf - Cbl) * smooth(F['thinLo'], 0.5, Cf)
    E = np.clip(np.maximum(crisp, line), 0, 1)
    log(f'channels: density mean {D.mean():.2f}, structure p5/p50/p95 {np.percentile(L, 5):.2f}/{np.median(L):.2f}/{np.percentile(L, 95):.2f}, rim mean {E.mean():.2f} ({time.time() - t0:.1f} s)')
    Sh = shafts(1 - D, spec, log)
    return np.stack([L, D, E, Sh], -1)


def shafts(G, spec, log):
    """moon shafts: march outward from the moon's limb in a polar grid (phi around the moon, theta away from it); the
    light that gets through a gap keeps going (exponential moving average of the gap fraction), fading with angle"""
    F = spec['features']
    H, W = G.shape
    m = moon_dir(spec['moon'])
    t = np.cross(m, [0, 1, 0]).astype(np.float32)
    t /= np.linalg.norm(t)
    b = np.cross(t, m)
    r0 = math.radians(spec['moon']['diameter'] / 2)
    rmax = math.radians(F['shaftRadiusDeg'])
    NP, NT = 2048, 640
    phi = np.linspace(0, 2 * math.pi, NP, endpoint=False, dtype=np.float32)
    th = np.linspace(r0 * 0.9, rmax, NT, dtype=np.float32)
    ct, st = np.cos(th)[None, :, None], np.sin(th)[None, :, None]
    dv = ct * m + st * (np.cos(phi)[:, None, None] * t + np.sin(phi)[:, None, None] * b)
    x, y = dir_to_px(dv, W, H)
    gap = cv2.remap(G, x.astype(np.float32), y.astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP)
    a = F['shaftEma']
    acc = np.zeros(NP, np.float32)
    S = np.zeros((NP, NT), np.float32)
    for i in range(NT):
        acc = acc * (1 - a) + gap[:, i] * a
        S[:, i] = acc
    fade = np.exp(-(th - r0) / math.radians(F['shaftDecayDeg']))
    S *= fade[None, :]
    # soften across phi (beams, not hairlines), wrap
    k = F['shaftBlurBins']
    S = cv2.GaussianBlur(np.concatenate([S[-8 * k:], S, S[: 8 * k]]), (0, 0), sigmaX=0.5, sigmaY=k)[8 * k : -8 * k]
    # stretch the contrast: beams vs dark lanes
    S = S / max(1e-4, np.percentile(S[:, : NT // 3], 99))
    S = np.clip(S, 0, 1) ** 1.3
    # back to the band (only within rmax of the moon)
    az, hy, rr = band_dirs(W, H)
    dx = rr * np.cos(az)
    dz = rr * np.sin(az)
    dy = np.broadcast_to(hy, (H, W))
    cos_th = dx * m[0] + dy * m[1] + dz * m[2]
    thp = np.arccos(np.clip(cos_th, -1, 1))
    pu = (dx - cos_th * m[0]) * t[0] + (dy - cos_th * m[1]) * t[1] + (dz - cos_th * m[2]) * t[2]
    pv = (dx - cos_th * m[0]) * b[0] + (dy - cos_th * m[1]) * b[1] + (dz - cos_th * m[2]) * b[2]
    ph = np.mod(np.arctan2(pv, pu), 2 * math.pi)
    gx = (ph / (2 * math.pi) * NP - 0.5).astype(np.float32)
    gy = ((thp - th[0]) / (th[-1] - th[0]) * (NT - 1)).astype(np.float32)
    Sb = cv2.remap(S.T.copy(), gx, gy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    Sb *= (thp >= th[0]) * (1 - smooth(rmax * 0.85, rmax, thp))
    log(f'shafts: mean {Sb.mean():.3f} within {F["shaftRadiusDeg"]} deg')
    return Sb.astype(np.float32)


def palette(spec):
    """ramp stops (linear RGB) from the concept image: mean colour of the sky boxes' pixels per luminance quantile"""
    P = spec['palette']
    if 'colors' in P:
        return [[float(c) for c in s] for s in P['colors']]
    im = np.asarray(Image.open(os.path.join(ROOT, P['ref'])).convert('RGB')).astype(np.float32) / 255
    px = np.concatenate([im[y0:y1, x0:x1].reshape(-1, 3) for x0, y0, x1, y1 in P['boxes']])
    # drop the warm banner / fire pixels inside the boxes
    px = px[px[:, 0] < px[:, 2] * 1.05]
    lin = srgb_to_lin(px)
    Y = lin @ np.array([0.2126, 0.7152, 0.0722])
    o = np.argsort(Y)
    n = len(o)
    stops = []
    for q in np.linspace(P['q'][0], P['q'][1], P['stops']):
        c = int(q * (n - 1))
        sl = o[max(0, c - n // 60) : c + n // 60 + 1]
        stops.append([round(float(v), 5) for v in lin[sl].mean(0)])
    return stops


# ---------------------------------------------------------------- preview: the shader maths (keep in step with sky.ts)
def kdeg(deg):
    """exponent k so that pow(dot, k) = 0.5 at `deg` from the moon (as sky.ts halfK)"""
    return 0.693 / max(1e-5, 1 - math.cos(math.radians(deg)))


def ramp(t, stops):
    n = len(stops) - 1
    x = np.clip(t, 0, 1) * n
    i = np.minimum(np.floor(x).astype(int), n - 1)
    f = (x - i)[..., None]
    S = np.array(stops, np.float32)
    return S[i] * (1 - f) + S[i + 1] * f


def shade(d, tex, stops, look, moon, moon_r, time_s=0.0):
    """HDR colour for directions d (..., 3); tex = the band data (H, W, 4) float 0..1"""
    H, W = tex.shape[:2]
    x, y = dir_to_px(d, W, H)
    xs = x + look['drift'] * time_s * W
    samp = cv2.remap(tex[..., :3], (xs % W).astype(np.float32), y.astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP)
    Sa = cv2.remap(tex[..., 3], x.astype(np.float32), y.astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP)
    L, D, E = samp[..., 0], samp[..., 1], samp[..., 2]
    h = d[..., 1]
    # below the band: a flat dark bank (the arena and the backdrop hide it; the floor reflection may not)
    under = smooth(-0.04, -0.09, h)
    L = L + (0.3 - L) * under
    D = D + (1 - D) * under
    E = E * (1 - under)
    Sa = Sa * (1 - under)
    md = np.maximum(d @ moon, 0)
    g_hot = md ** kdeg(look['hotDeg'])
    g_mid = md ** kdeg(look['midDeg'])
    g_wide = md ** kdeg(look['wideDeg'])
    g_rim = md ** kdeg(look['rimDeg'])
    bank = (1 - smooth(-0.02, look['bankH'], h)) * (1 - look['bankAway'] * g_mid)
    bank = np.maximum(bank, 1 - smooth(-0.1, -0.04, h))
    D = np.maximum(D, bank * look['bankDens'])
    light = (look['amb'] + look['mid'] * g_mid + look['wide'] * g_wide) * (1 - look['bankDark'] * bank)
    cc = ramp(L * light, stops)
    ylum = (cc @ np.array([0.2126, 0.7152, 0.0722], np.float32))[..., None]
    cc = (ylum + (cc - ylum) * look.get('sat', 1.0)) * look['gain'] * (1 + look['hot'] * g_hot * (0.4 + 0.6 * E))[..., None]
    gap = np.array(look['gapFar'], np.float32) * (1 - g_mid[..., None]) + np.array(look['gapNear'], np.float32) * g_mid[..., None]
    # moon halo (as sky.ts moonHalo: tight corona + wide glow), seen through the gaps
    k1 = 0.693 / max(1e-5, 1 - math.cos(moon_r * 1.6))
    k2 = 0.693 / max(1e-5, 1 - math.cos(moon_r * 6))
    mc = np.array(look.get('moonColor', [1.2, 1.22, 1.3]), np.float32)
    halo = (md ** k1 * 0.35 + md ** k2 * 0.07) * look.get('moonHalo', 0.22)
    col = gap + mc * halo[..., None]
    col = col * (1 - D[..., None]) + cc * D[..., None]
    col += np.array(look['rim'], np.float32) * (look['rimGain'] * E * g_rim * (1 - 0.5 * D))[..., None]
    col += np.array(look['shaft'], np.float32) * (look['shaftGain'] * Sa * (0.35 + 0.65 * (1 - D)))[..., None]
    m = smooth(math.cos(moon_r), math.cos(moon_r * 0.97), d @ moon)
    occ = 1 - look['moonOcclude'] * smooth(0.72, 0.97, D)
    col = col * (1 - (m * occ)[..., None]) + mc * (m * occ)[..., None]
    return col


def aces(x):
    a, b, c, d_, e = 2.51, 0.03, 2.43, 0.59, 0.14
    return np.clip((x * (a * x + b)) / (x * (c * x + d_) + e), 0, 1)


def camera_dirs(cam, scale=0.5):
    w, h = int(cam['size'][0] * scale), int(cam['size'][1] * scale)
    yaw, pitch = math.radians(cam['yaw']), math.radians(cam['pitch'])
    f = np.array([math.cos(pitch) * math.cos(yaw), math.sin(pitch), math.cos(pitch) * math.sin(yaw)])
    r = np.cross(f, [0, 1, 0])
    r /= np.linalg.norm(r)
    u = np.cross(r, f)
    th = math.tan(math.radians(cam['vfov'] / 2))
    xs = (np.arange(w) + 0.5) / w * 2 - 1
    ys = 1 - (np.arange(h) + 0.5) / h * 2
    X, Yy = np.meshgrid(xs * th * w / h, ys * th)
    d = f[None, None] + X[..., None] * r[None, None] + Yy[..., None] * u[None, None]
    d /= np.linalg.norm(d, axis=-1, keepdims=True)
    return d.astype(np.float32), (w, h)


def preview(spec, tex, stops, out_dir, compare=None, look=None, name='preview'):
    look = look or spec['look']
    P = spec['preview']
    d, (w, h) = camera_dirs(P['camera'])
    moon = moon_dir(spec['moon'])
    col = shade(d, tex, stops, look, moon, math.radians(spec['moon']['diameter'] / 2))
    img = (lin_to_srgb(aces(col * P['exposure'])) * 255).astype(np.uint8)
    tiles = [img]
    if compare:
        ref = Image.open(compare).convert('RGB').resize((w, h), Image.LANCZOS)
        tiles = [np.asarray(ref), img]
    sheet = np.concatenate(tiles, axis=1)
    # plus the whole band (tone-mapped) under it
    az, hy, rr = band_dirs(sheet.shape[1], 220)
    dd = np.stack([np.broadcast_to(rr * np.cos(az), (220, sheet.shape[1])), np.broadcast_to(hy, (220, sheet.shape[1])), np.broadcast_to(rr * np.sin(az), (220, sheet.shape[1]))], -1).astype(np.float32)
    bc = shade(dd, tex, stops, look, moon, math.radians(spec['moon']['diameter'] / 2))
    band = (lin_to_srgb(aces(bc * P['exposure'])) * 255).astype(np.uint8)
    Image.fromarray(np.concatenate([sheet, band], 0)).save(os.path.join(out_dir, f'{name}.jpg'), quality=88)
    return os.path.join(out_dir, f'{name}.jpg')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--spec', default=os.path.join(ROOT, 'tools', 'arena', 'sky', 'moongate.json'))
    ap.add_argument('--out', default=None)
    ap.add_argument('--preview-only', action='store_true')
    ap.add_argument('--compare', default=None)
    a = ap.parse_args()
    spec = json.load(open(a.spec))
    out = a.out or os.path.join(ROOT, 'tools', 'arena', '_work', 'sky', spec['id'])
    os.makedirs(out, exist_ok=True)
    log = lambda s: print(s, flush=True)
    master = os.path.join(out, 'master.png')
    if a.preview_only and os.path.exists(master):
        tex = np.asarray(Image.open(master)).astype(np.float32) / 255
    else:
        tex = compose(spec, log)
        q = np.clip(np.round(tex * 255), 0, 255).astype(np.uint8)
        Image.fromarray(q, 'RGBA').save(master)
        tex = q.astype(np.float32) / 255
        for tier, (tw, th) in spec['tiers'].items():
            os.makedirs(os.path.join(out, tier), exist_ok=True)
            r = q if (tw, th) == tuple(spec['master']) else cv2.resize(q, (tw, th), interpolation=cv2.INTER_AREA)
            Image.fromarray(r, 'RGBA').save(os.path.join(out, tier, 'sky.png'))
    stops = palette(spec)
    layout = {'id': spec['id'], 'source': spec['source']['asset'], 'moon': spec['moon'], 'tiers': spec['tiers'], 'palette': stops, 'look': spec['look']}
    json.dump(layout, open(os.path.join(out, 'layout.json'), 'w'), indent=1)
    p = preview(spec, tex, stops, out, a.compare or os.path.join(ROOT, spec['palette']['ref']))
    log(f'palette {stops}')
    log(f'preview {p}')


if __name__ == '__main__':
    main()
