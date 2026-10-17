"""Floor decal atlas (plan §4.1 static `decals`): procedural, seeded, CC0 (own work), with the
crack cells taken from the Screaming Brain "Cracks" noises (CC0) and, when the owner has
downloaded them, ambientCG decals (CC0) replacing the procedural crack / footprint cells.

  python -P tools/fx/make_decals.py

Writes
  decals.webp      768^2 colour, 4x4 cells of 192 px (authored at 256), PREMULTIPLIED sRGB colour + coverage alpha
  decals.low.webp  384^2
  decals_nrm.webp  512^2 data (linear, lossless): R,G = tangent normal xy (0.5 = flat),
                   B = roughness, A = wetness (1 = glossy wet: blood, mud)
"""
import glob
import io
import math
import os
import re
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fxlib as L  # noqa: E402
import cv2  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

PX = 256
CELLS = ['blood_splat_0', 'blood_splat_1', 'blood_splat_2', 'blood_splat_3',
         'blood_pool', 'blood_drips', 'scorch_0', 'scorch_1',
         'scorch_2', 'crack_0', 'crack_1', 'crack_2',
         'crack_3', 'frost', 'mud', 'footprint']
TINTABLE = {'footprint'}            # grey: tinted at runtime (blood, mud, wet)


def fbm(seed, px=PX, octaves=5, base=4):
    rng = np.random.default_rng(seed)
    out = np.zeros((px, px), np.float32)
    amp, tot = 1.0, 0.0
    for o in range(octaves):
        n = base * 2 ** o
        g = rng.random((n + 1, n + 1)).astype(np.float32)
        out += amp * cv2.resize(g, (px, px), interpolation=cv2.INTER_CUBIC)
        tot += amp
        amp *= 0.5
    return out / tot


def grid():
    y, x = np.mgrid[0:PX, 0:PX].astype(np.float32)
    return (x + 0.5) / PX * 2 - 1, (y + 0.5) / PX * 2 - 1


def smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def blood_splat(seed, pool=False, drips=False):
    rng = np.random.default_rng(seed)
    x, y = grid()
    n = fbm(seed, octaves=6)
    if pool:
        d = np.sqrt(x ** 2 + (y * 1.15) ** 2) + (n - 0.5) * 0.35
        cov = smooth(0.80, 0.785, d)
    else:
        cov = np.zeros_like(x)
        ang = rng.uniform(0, 2 * math.pi)
        dx, dy = math.cos(ang), math.sin(ang)
        if not drips:      # main body
            d = np.sqrt((x + dx * 0.15) ** 2 + (y + dy * 0.15) ** 2) + (n - 0.5) * 0.55
            cov = np.maximum(cov, smooth(0.40, 0.385, d))
        for i in range(rng.integers(14, 26) if not drips else 40):     # satellites along the throw
            t = rng.uniform(0.1, 0.9) if not drips else rng.uniform(-0.8, 0.8)
            sp = rng.normal(0, 0.18 if not drips else 0.45)
            cx, cy = dx * t - dy * sp, dy * t + dx * sp
            r = rng.uniform(0.012, 0.06) * (1.2 - t if not drips else 0.8)
            el = 1 + rng.uniform(0, 1.5)        # elongated along the throw
            u = (x - cx) * dx + (y - cy) * dy
            v = -(x - cx) * dy + (y - cy) * dx
            cov = np.maximum(cov, smooth(r, r * 0.85, np.sqrt((u / el) ** 2 + v ** 2)))
        if not drips:      # streak tendrils
            for i in range(rng.integers(3, 7)):
                a2 = ang + rng.normal(0, 0.35)
                L_ = rng.uniform(0.35, 0.85)
                u = x * math.cos(a2) + y * math.sin(a2)
                v = -x * math.sin(a2) + y * math.cos(a2)
                w = 0.035 * (1 - np.clip(u / L_, 0, 1)) + 0.004
                cov = np.maximum(cov, smooth(w, w * 0.5, np.abs(v)) * (u > 0) * (u < L_))
    cov = np.clip(cov, 0, 1) * smooth(1.0, 0.92, np.maximum(np.abs(x), np.abs(y)))
    thick = cv2.GaussianBlur(cov, (0, 0), 3) * (0.8 + 0.4 * n)
    col = np.stack([0.09 + 0.07 * (1 - thick), 0.004 + 0.003 * n, 0.007 + 0.003 * n], -1)
    return col, cov * 0.96, thick * 0.6, np.full_like(cov, 0.12), cov


def scorch(seed):
    x, y = grid()
    n = fbm(seed, octaves=6)
    n2 = fbm(seed + 1, octaves=4, base=8)
    d = np.sqrt(x ** 2 + y ** 2) + (n - 0.5) * 0.5
    cov = smooth(0.95, 0.15, d) * (0.65 + 0.35 * n2)
    soot = np.stack([0.025 + 0.02 * n2, 0.018 + 0.012 * n2, 0.014 + 0.008 * n2], -1)
    ember = smooth(0.25, 0.0, d) * smooth(0.55, 0.75, n2)          # faint orange-brown burnt core
    col = soot + ember[..., None] * np.array([0.05, 0.015, 0.0])
    return col, np.clip(cov, 0, 0.92), -0.05 * cov, 0.92 - 0.0 * cov, np.zeros_like(cov)


def crack_from(gray, seed):
    """gray: (PX,PX) float 0..1 crack texture (dark lines on light, SBS style)."""
    x, y = grid()
    n = fbm(seed, octaves=4)
    g = gray if gray.mean() > 0.5 else 1 - gray
    lo, hi = np.percentile(g, 2), np.percentile(g, 22)
    lines = smooth(hi, lo, g) ** 1.5
    radial = smooth(0.95, 0.35, np.sqrt(x ** 2 + y ** 2) + (n - 0.5) * 0.4)
    cov = np.clip(lines * radial, 0, 1)
    chips = smooth(0.62, 0.75, n) * radial * 0.35                 # dusty broken rim around the lines
    col = np.stack([0.012, 0.011, 0.010], -1) * np.ones_like(cov)[..., None]
    col = col * cov[..., None] + np.array([0.09, 0.085, 0.08]) * chips[..., None] * (1 - cov[..., None])
    a = np.clip(cov + chips, 0, 1)
    col = col / np.maximum(a, 1e-4)[..., None]
    return col, a, -0.9 * cov, np.full_like(cov, 0.85), np.zeros_like(cov)


def frost(seed):
    x, y = grid()
    n = fbm(seed, octaves=6, base=6)
    d = np.sqrt(x ** 2 + y ** 2) + (n - 0.5) * 0.45
    cov = smooth(0.92, 0.3, d)
    rng = np.random.default_rng(seed)
    feathers = np.zeros_like(x)
    for i in range(70):                      # crystalline feather strokes
        a2 = rng.uniform(0, 2 * math.pi)
        cx, cy = rng.normal(0, 0.35, 2)
        u = (x - cx) * math.cos(a2) + (y - cy) * math.sin(a2)
        v = -(x - cx) * math.sin(a2) + (y - cy) * math.cos(a2)
        L_ = rng.uniform(0.08, 0.3)
        feathers = np.maximum(feathers, smooth(0.006, 0.0, np.abs(v)) * (np.abs(u) < L_))
    cov = np.clip(cov * (0.35 + 0.65 * n) + feathers * cov * 0.6, 0, 0.85)
    col = np.stack([0.62 + 0.2 * feathers, 0.74 + 0.2 * feathers, 0.86 + 0.1 * feathers], -1)
    return col, cov, 0.3 * feathers, 0.35 - 0.2 * feathers, 0.3 * cov


def mud(seed):
    x, y = grid()
    n = fbm(seed, octaves=6)
    d = np.sqrt((x * 1.1) ** 2 + y ** 2) + (n - 0.5) * 0.6
    cov = smooth(0.8, 0.45, d)
    col = np.stack([0.10 + 0.05 * n, 0.07 + 0.03 * n, 0.045 + 0.02 * n], -1)
    return col, cov * 0.9, 0.4 * cv2.GaussianBlur(cov, (0, 0), 6) * n, 0.45 - 0.25 * cov, cov * 0.7


def footprint(seed):
    """Boot print: sole with a narrow waist, a separate heel, block lugs, worn by noise."""
    x, y = grid()
    xs = x * 1.0
    fore = np.sqrt((xs / 0.27) ** 2 + ((y + 0.30) / 0.40) ** 2)
    waist = (np.abs(xs + 0.03) < 0.15 - 0.05 * np.clip((y - 0.05) / 0.25, 0, 1)) & (y > 0.0) & (y < 0.30)
    heel = np.sqrt(((xs + 0.02) / 0.20) ** 2 + ((y - 0.52) / 0.20) ** 2)
    sole = np.maximum(np.maximum(smooth(1.0, 0.93, fore), waist.astype(np.float32) * 0.0), smooth(1.0, 0.9, heel))
    lug = ((np.mod((y + 1) * 9.0, 1.0) < 0.62) & (np.mod((x + 1) * 7.0 + (np.floor((y + 1) * 9.0) % 2) * 0.5, 1.0) < 0.7))
    n = fbm(seed, octaves=5, base=8)
    cov = sole * (0.35 + 0.65 * lug) * smooth(0.25, 0.5, n + 0.2) * 0.85
    col = np.ones(x.shape + (3,), np.float32) * 0.85
    return col, cov, 0.2 * cov, np.full_like(cov, 0.5), cov * 0.5


def sbs_cracks():
    """4 crack sources from the SBS zip (CC0), or None."""
    root = None
    for name in os.listdir(L.ASSETS) if os.path.isdir(L.ASSETS) else []:
        if name.lower() == 'vfx':
            root = os.path.join(L.ASSETS, name)
    if not root:
        return None
    zips = sorted(glob.glob(os.path.join(root, 'sbs*noise*512*.zip')) + glob.glob(os.path.join(root, 'sbs*noise*256*.zip')))
    if not zips:
        return None
    z = zipfile.ZipFile(zips[0])
    out = []
    for num in (1, 2, 7, 11):
        hit = next(n for n in z.namelist() if re.search(rf'Cracks/Cracks {num} - ', n))
        g = Image.open(io.BytesIO(z.read(hit))).convert('L').resize((PX, PX), Image.LANCZOS)
        out.append(np.asarray(g).astype(np.float32) / 255)
    return out, os.path.basename(zips[0])


def ambientcg_cells():
    """Use ambientCG decal zips if the owner downloaded them (Assets/VFX/ambientcg/*_1K-PNG.zip):
    assets with 'Crack' / 'AsphaltDamage' replace crack cells; 'Footstep' replaces the footprint."""
    root = os.path.join(L.ASSETS, 'VFX', 'ambientcg')
    found = {}
    for p in sorted(glob.glob(os.path.join(root, '*_*K-*.zip'))):
        z = zipfile.ZipFile(p)
        names = z.namelist()
        colr = next((n for n in names if re.search(r'_Color\.(png|jpg)$', n, re.I)), None)
        opac = next((n for n in names if re.search(r'_Opacity\.(png|jpg)$', n, re.I)), None)
        if not (colr and opac):
            continue
        c = np.asarray(Image.open(io.BytesIO(z.read(colr))).convert('RGB').resize((PX, PX), Image.LANCZOS)).astype(np.float32) / 255
        o = np.asarray(Image.open(io.BytesIO(z.read(opac))).convert('L').resize((PX, PX), Image.LANCZOS)).astype(np.float32) / 255
        key = 'footprint' if re.search('footstep', p, re.I) else 'crack' if re.search('crack|damage', p, re.I) else None
        if key:
            found.setdefault(key, []).append((L.srgb_decode(c), o, os.path.basename(p)))
    return found


def main():
    L.ensure_dirs()
    cracks = sbs_cracks()
    acg = ambientcg_cells()
    cells, sources = {}, {}
    for i, name in enumerate(CELLS):
        seed = 1000 + i * 17
        if name.startswith('blood_splat'):
            cells[name] = blood_splat(seed)
        elif name == 'blood_pool':
            cells[name] = blood_splat(seed, pool=True)
        elif name == 'blood_drips':
            cells[name] = blood_splat(seed, drips=True)
        elif name.startswith('scorch'):
            cells[name] = scorch(seed)
        elif name.startswith('crack'):
            k = int(name[-1])
            if acg.get('crack') and k < len(acg['crack']):
                c, o, src = acg['crack'][k]
                cells[name] = (c, o, -0.8 * o, np.full_like(o, 0.85), np.zeros_like(o))
                sources[name] = 'ambientCG ' + src
            elif cracks:
                cells[name] = crack_from(cracks[0][k], seed)
                sources[name] = 'Screaming Brain noise pack: ' + cracks[1]
            else:
                cells[name] = crack_from(fbm(seed, base=12), seed)
        elif name == 'frost':
            cells[name] = frost(seed)
        elif name == 'mud':
            cells[name] = mud(seed)
        elif name == 'footprint':
            if acg.get('footprint'):
                c, o, src = acg['footprint'][0]
                cells[name] = (np.ones_like(c) * 0.85, o, 0.2 * o, np.full_like(o, 0.5), o * 0.5)
                sources[name] = 'ambientCG ' + src
            else:
                cells[name] = footprint(seed)
    col_cells, nrm_cells, index = [], [], {}
    for i, name in enumerate(CELLS):
        col, a, h, rough, wet = cells[name]
        a = np.clip(a, 0, 1).astype(np.float32)
        prem = np.clip(col, 0, 1) * a[..., None]
        col_cells.append(L.to_u8(np.concatenate([L.srgb_encode(prem), a[..., None]], -1)))
        hb = cv2.GaussianBlur(h.astype(np.float32), (0, 0), 1.2)
        gx = cv2.Sobel(hb, cv2.CV_32F, 1, 0, ksize=3) * 2.0
        gy = cv2.Sobel(hb, cv2.CV_32F, 0, 1, ksize=3) * 2.0
        nz = np.ones_like(gx)
        ln = np.sqrt(gx ** 2 + gy ** 2 + nz ** 2)
        nx, ny = -gx / ln, gy / ln          # +y up in tangent space (OpenGL convention)
        data = np.stack([nx * 0.5 + 0.5, ny * 0.5 + 0.5, np.clip(rough, 0, 1) * np.ones_like(a), np.clip(wet, 0, 1)], -1)
        nrm_cells.append(L.to_u8(cv2.resize(data, (PX // 2, PX // 2), interpolation=cv2.INTER_AREA)))
        r, c = divmod(i, 4)
        index[name] = {'cell': i, 'rect': [c / 4, r / 4, 0.25, 0.25], 'tint': name in TINTABLE,
                       'source': sources.get(name, 'procedural (tools/fx/make_decals.py)')}
    col = L.grid_pack(col_cells, 4, 4)
    nrm = L.grid_pack(nrm_cells, 4, 4)
    # authored at 256-px cells, shipped at 192 (768^2) / 96 (384^2): GPU budget with WebP
    low = np.asarray(Image.fromarray(col, 'RGBA').resize((384, 384), Image.LANCZOS))
    col = np.asarray(Image.fromarray(col, 'RGBA').resize((768, 768), Image.LANCZOS))
    s_full = L.save_webp(col, os.path.join(L.PUB, 'decals.webp'))
    s_low = L.save_webp(low, os.path.join(L.PUB, 'decals.low.webp'))
    s_nrm = L.save_webp(nrm, os.path.join(L.PUB, 'decals_nrm.webp'), lossless=True)
    for a_, fn in ((col, 'decals'), (low, 'decals.low'), (nrm, 'decals_nrm')):
        L.save_png(a_, os.path.join(L.WORK, fn + '.png'))
    m = L.load_manifest()
    m['atlases']['decals'] = {
        'type': 'decals', 'colorSpace': 'srgb', 'premultiplied': True, 'grid': [4, 4],
        'full': {'file': 'decals.webp', 'w': 768, 'h': 768, 'frame': 192, 'bytes': s_full},
        'low': {'file': 'decals.low.webp', 'w': 384, 'h': 384, 'frame': 96, 'bytes': s_low},
        'data': {'file': 'decals_nrm.webp', 'w': 512, 'h': 512, 'frame': 128, 'bytes': s_nrm, 'colorSpace': 'linear',
                 'channels': 'R,G = tangent normal xy (0.5 flat, +y up); B = roughness; A = wetness'},
        'cells': index, 'order': 'cell row-major from top-left; rect = [u, v_from_top, w, h]',
        'notes': 'Floor decals, premultiplied. Footprint is grey: tint it (blood / mud / wet).',
        'source': {'type': 'procedural', 'script': 'tools/fx/make_decals.py'},
    }
    L.save_manifest(m)
    srcs = sorted(set(sources.values()))
    L.ledger_set(['decals.webp', 'decals.low.webp', 'decals_nrm.webp'],
                 'procedural (tools/fx/make_decals.py)' + ('; crack cells from ' + '; '.join(srcs) if srcs else ''),
                 'CC0 1.0 (own work; SBS / ambientCG sources are CC0)',
                 'tools/fx/make_decals.py; https://opengameart.org/content/noise-texture-pack')
    L.log(f'decals.webp {s_full / 1024:.0f} KB, low {s_low / 1024:.0f} KB, nrm {s_nrm / 1024:.0f} KB; sources: {srcs or "procedural"}')


if __name__ == '__main__':
    main()
