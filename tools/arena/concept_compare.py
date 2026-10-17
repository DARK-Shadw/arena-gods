"""Concept-match comparison (arena art plan 3.2 / 3.3, milestone A0).

    python tools/arena/concept_compare.py --dir docs/milestones/A0/concept [--q 1]

Reads <dir>/info.json (written by tools/shots/concept.cjs: the projected guides of every render) and
the by-eye annotations in tools/arena/concept_targets.json, and writes per concept preset:
  <ref>_side.jpg     concept (left) | game (right), guides drawn on both (cyan = concept annotations,
                     yellow = where the game camera puts them: horizon, landmark azimuth, fighters)
  <ref>_blend.jpg    50 % overlay
  <ref>_sky.png      the C1 sky masks (concept | game), for checking the heuristic by eye
  <ref>_metrics.json C1-C5, C8, luminance histogram, warm/cool split, calibration deltas,
                     and the manual checks (C6 counts from the concept, C7, C9, C10) left for a person
and for the whole run: contact_q<q>.jpg (every preset + the game-only extra views), summary.json,
summary.md (one table row per preset). Pillow + numpy only.

Metric definitions (exact, so later milestones compare like with like):
  C1 skyline IoU   concept sky mask = the by-eye skyline profile in concept_targets.json (sky above the
                   polyline + sky holes); game sky mask = VISUAL: where the frame equals a sky-only frame of
                   the same view (App.conceptSkyOnly), so geometry dissolved into the sky by fog is sky;
                   the geometric mask (App.conceptSkyMask, *_skygeo.png) is kept for reference. IoU over the top 60 % of the frame. Also profileErr = mean
                   |skyline y game - concept| per column (frame heights): robust when there is little sky.
                   (sky_mask() = colour flood-fill fallback, unreliable on painterly images: not used
                   when a profile / exact mask exists.)
  C2 palette       mean CIELAB per cell of a 3x3 grid, Delta E 1976 per cell; median and worst.
  C3 warm share    pixels with HSV hue 345-360 or 0-50 deg (the plan's 0-50 plus crimson), saturation > 0.4, L* > 40; ratio game / concept.
                   cool share = hue 180-300 deg, saturation > 0.25 (reported, no pass rule).
  C4 wet floor     share of bottom-third pixels with L* > 55; fire streaks = 4-connected blobs of warm
                   bright pixels (C3 warm and L* > 55) in the bottom third, area >= 0.02 % of the frame.
  C5 detail        mean Sobel magnitude (L*) per 3x3 cell; ratio game / concept per cell.
  C8 atmosphere    luminance std of the far band (frame top .. horizon - 0.15) over the mid band
                   (horizon - 0.15 .. horizon + 0.03), fighter A's columns masked out.
  hist             16-bin L* histogram (0-100), intersection with the concept's (1 = identical),
                   p5 / p50 / p95 of L*.
Painted HUD rectangles (ref-4) are excluded from every metric.
"""
import argparse
import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
TARGETS = os.path.join(ROOT, 'tools', 'arena', 'concept_targets.json')

PASS = {  # plan 3.2
    'C1': 0.55, 'C1hero': 0.65, 'C2median': 12.0, 'C2worst': 20.0, 'C3tol': 0.40, 'C4tol': 0.50, 'C4streaks': 3,
    'C5lo': 0.7, 'C5hi': 1.3, 'C8': 0.6,
}
HERO = 'ref-3'


# ---------------------------------------------------------------- colour
def srgb_to_lab(rgb):
    """rgb: float array (..., 3) in 0..1 (sRGB). Returns L*a*b* (D65)."""
    c = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    M = np.array([[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]])
    xyz = c @ M.T
    xyz = xyz / np.array([0.95047, 1.0, 1.08883])
    e = 216 / 24389
    k = 24389 / 27
    f = np.where(xyz > e, np.cbrt(xyz), (k * xyz + 16) / 116)
    L = 116 * f[..., 1] - 16
    a = 500 * (f[..., 0] - f[..., 1])
    b = 200 * (f[..., 1] - f[..., 2])
    return np.stack([L, a, b], -1)


def hsv(rgb):
    mx = rgb.max(-1)
    mn = rgb.min(-1)
    d = mx - mn
    s = np.where(mx > 1e-6, d / np.maximum(mx, 1e-6), 0)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    dd = np.maximum(d, 1e-6)
    h = np.where(mx == r, ((g - b) / dd) % 6, np.where(mx == g, (b - r) / dd + 2, (r - g) / dd + 4)) * 60
    h = np.where(d < 1e-6, 0, h)
    return h, s, mx


def sobel(L):
    p = np.pad(L, 1, mode='edge')
    gx = (p[:-2, 2:] + 2 * p[1:-1, 2:] + p[2:, 2:]) - (p[:-2, :-2] + 2 * p[1:-1, :-2] + p[2:, :-2])
    gy = (p[2:, :-2] + 2 * p[2:, 1:-1] + p[2:, 2:]) - (p[:-2, :-2] + 2 * p[:-2, 1:-1] + p[:-2, 2:])
    return np.hypot(gx, gy) / 8


def cells(h, w, n=3):
    for i in range(n):
        for j in range(n):
            yield i, j, slice(h * i // n, h * (i + 1) // n), slice(w * j // n, w * (j + 1) // n)


# ---------------------------------------------------------------- sky mask (C1)
def sky_mask(img, top_frac=0.6, g_thr=3.0, c_thr=22.0):
    """Heuristic sky segmentation on a 1/4-res copy: flood fill from the top row over smooth pixels
    whose colour stays near the sky colour of their column's top. Returns a full-res bool mask
    (only the top `top_frac` of the frame can be sky)."""
    W, H = img.size
    sw, sh = max(8, W // 4), max(8, H // 4)
    small = np.asarray(img.convert('RGB').resize((sw, sh), Image.BILINEAR).filter(ImageFilter.GaussianBlur(1.2)), dtype=np.float64) / 255
    lab = srgb_to_lab(small)
    g = sobel(lab[..., 0])
    lim = int(sh * top_frac)
    # reference sky colour per column: median of the top 4 % rows, smoothed across columns
    ref = np.median(lab[: max(1, sh // 25)], axis=0)
    k = 9
    ker = np.ones(k) / k
    ref = np.stack([np.convolve(np.pad(ref[:, c], k // 2, mode='edge'), ker, 'valid') for c in range(3)], -1)
    dE = np.sqrt(((lab - ref[None]) ** 2).sum(-1))
    # smooth and near the column's sky colour, or very close to it (soft cloud edges)
    ok = ((g < g_thr) | (dE < c_thr * 0.5)) & (dE < c_thr)
    ok[lim:] = False
    m = np.zeros((sh, sw), bool)
    stack = [(0, x) for x in range(sw) if ok[0, x]]
    for y, x in stack:
        m[y, x] = True
    while stack:
        y, x = stack.pop()
        for yy, xx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
            if 0 <= yy < sh and 0 <= xx < sw and ok[yy, xx] and not m[yy, xx]:
                m[yy, xx] = True
                stack.append((yy, xx))
    return np.asarray(Image.fromarray(m.astype(np.uint8) * 255).resize((W, H), Image.NEAREST)) > 127


# ---------------------------------------------------------------- blobs (C4 streaks)
def count_blobs(mask, min_area):
    h, w = mask.shape
    seen = np.zeros_like(mask)
    n = 0
    ys, xs = np.nonzero(mask)
    for y0, x0 in zip(ys, xs):
        if seen[y0, x0]:
            continue
        area = 0
        st = [(y0, x0)]
        seen[y0, x0] = True
        while st:
            y, x = st.pop()
            area += 1
            for yy, xx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
                if 0 <= yy < h and 0 <= xx < w and mask[yy, xx] and not seen[yy, xx]:
                    seen[yy, xx] = True
                    st.append((yy, xx))
        if area >= min_area:
            n += 1
    return n


# ---------------------------------------------------------------- metrics
def analyse(img, valid, horizon, a_box):
    """img: PIL RGB; valid: bool mask of pixels to use (HUD excluded)."""
    W, H = img.size
    rgb = np.asarray(img, dtype=np.float64) / 255
    lab = srgb_to_lab(rgb)
    L = lab[..., 0]
    hue, sat, _ = hsv(rgb)
    warm = ((hue <= 50) | (hue >= 345)) & (sat > 0.4) & (L > 40) & valid
    cool = (hue >= 180) & (hue <= 300) & (sat > 0.25) & valid
    nvalid = max(1, valid.sum())
    out = {'warmShare': float(warm.sum() / nvalid), 'coolShare': float(cool.sum() / nvalid)}
    # C2 / C5 per cell
    g = sobel(L)
    out['cellLab'] = []
    out['cellSobel'] = []
    for i, j, ys, xs in cells(H, W):
        v = valid[ys, xs]
        out['cellLab'].append([float(lab[ys, xs][v][:, k].mean()) if v.any() else float('nan') for k in range(3)])
        out['cellSobel'].append(float(g[ys, xs][v].mean()) if v.any() else float('nan'))
    # C4 bottom third
    b0 = H * 2 // 3
    bv = valid[b0:]
    out['floorBright'] = float(((L[b0:] > 55) & bv).sum() / max(1, bv.sum()))
    sm = 4
    wb = warm[b0:] & (L[b0:] > 55)
    small = wb[: (wb.shape[0] // sm) * sm, : (W // sm) * sm].reshape(wb.shape[0] // sm, sm, W // sm, sm).any(axis=(1, 3))
    out['fireStreaks'] = count_blobs(small, max(2, int(0.0002 * W * H / (sm * sm))))
    # luminance histogram
    hist, _ = np.histogram(L[valid], bins=16, range=(0, 100))
    out['hist'] = (hist / max(1, hist.sum())).round(5).tolist()
    out['Lpct'] = [float(np.percentile(L[valid], q)) for q in (5, 50, 95)]
    # C8
    hz = int(H * horizon)
    colmask = np.ones(W, bool)
    if a_box:
        colmask[max(0, int(a_box[0] * W)): min(W, int(a_box[2] * W) + 1)] = False
    def band(y0, y1):
        y0, y1 = max(0, y0), min(H, y1)
        if y1 <= y0:
            return float('nan')
        m = valid[y0:y1] & colmask[None, :]
        return float(L[y0:y1][m].std()) if m.any() else float('nan')
    far = band(int(H * 0.0), hz - int(0.15 * H))
    mid = band(hz - int(0.15 * H), hz + int(0.03 * H))
    out['farStd'], out['midStd'] = far, mid
    out['farMidRatio'] = float(far / mid) if mid and not math.isnan(mid) and mid > 1e-6 else float('nan')
    return out


def iou(a, b, H):
    lim = int(H * 0.6)
    a, b = a[:lim], b[:lim]
    u = (a | b).sum()
    return float((a & b).sum() / u) if u else 1.0


def profile_mask(tgt, W, H):
    """Sky mask from the by-eye skyline profile (sky above the polyline) plus sky holes."""
    pts = tgt['skyline']
    xs = np.array([p[0] for p in pts]) * W
    ys = np.array([p[1] for p in pts]) * H
    col = np.interp(np.arange(W) + 0.5, xs, ys)
    m = np.arange(H)[:, None] < col[None, :]
    if tgt.get('skyHoles'):
        im = Image.new('L', (W, H), 0)
        d = ImageDraw.Draw(im)
        for poly in tgt['skyHoles']:
            d.polygon([(x * W, y * H) for x, y in poly], fill=255)
        m |= np.asarray(im) > 127
    return m


def game_sky(outdir, info, G, W, H):
    """Visual game sky: pixels where the normal frame matches the sky-only frame (max channel difference
    <= 10 / 255, 3x3 median-filtered), i.e. the sky dome plus geometry the fog has dissolved into it.
    Falls back to the geometric mask (_skygeo.png), then to the colour heuristic."""
    so = os.path.join(outdir, info['file'].replace('.png', '_skyonly.png'))
    if os.path.exists(so):
        S = np.asarray(Image.open(so).convert('RGB').resize((W, H)), dtype=np.int16)
        Gi = np.asarray(G, dtype=np.int16)
        m = (np.abs(S - Gi).max(-1) <= 10).astype(np.uint8) * 255
        return np.asarray(Image.fromarray(m).filter(ImageFilter.MedianFilter(3))) > 127
    geo = os.path.join(outdir, info['file'].replace('.png', '_skygeo.png'))
    if os.path.exists(geo):
        return np.asarray(Image.open(geo).convert('L').resize((W, H), Image.NEAREST)) > 127
    return sky_mask(G)


def skyline_profile(m, valid=None):
    """Per column: first row (0..1 of the height) that is not sky, scanning down from the top
    (excluded pixels, e.g. a painted HUD, are skipped)."""
    H = m.shape[0]
    notsky = ~m if valid is None else (~m & valid)
    first = np.where(notsky.any(0), notsky.argmax(0), H)
    return first / H


def compare(ref, tgt, info, C, G, outdir, q):
    W, H = C.size
    if G.size != C.size:
        G = G.resize(C.size, Image.BILINEAR)
    valid = np.ones((H, W), bool)
    for x0, y0, x1, y1 in tgt.get('hud', []):
        valid[int(y0 * H):int(y1 * H), int(x0 * W):int(x1 * W)] = False
    fA = (info.get('fighters') or [None])[0]
    gbox = fA['bones'] if fA else None
    ghz = info['horizon'][1][1]
    # the concept's A box is not annotated beyond the head point: the game's A columns are masked on both (C8)
    mc = analyse(C, valid, ghz, gbox)
    mg = analyse(G, valid, ghz, gbox)
    mc['sky'] = profile_mask(tgt, W, H) if tgt.get('skyline') else sky_mask(C)
    mg['sky'] = game_sky(outdir, info, G, W, H)
    mc['sky'] &= valid
    mg['sky'] &= valid
    prof_c, prof_g = skyline_profile(mc['sky'], valid), skyline_profile(mg['sky'], valid)
    prof_err = float(np.abs(prof_c - prof_g).mean())
    sky_share = float(mc['sky'][: int(H * 0.6)].mean())
    dE = [math.dist(a, b) for a, b in zip(mc['cellLab'], mg['cellLab'])]
    c5 = [g / c if c > 1e-6 else float('nan') for c, g in zip(mc['cellSobel'], mg['cellSobel'])]
    c1 = iou(mc['sky'], mg['sky'], H)
    warm_r = mg['warmShare'] / mc['warmShare'] if mc['warmShare'] > 1e-6 else float('nan')
    fb_r = mg['floorBright'] / mc['floorBright'] if mc['floorBright'] > 1e-6 else float('nan')
    hist_i = float(np.minimum(mc['hist'], mg['hist']).sum())
    c1pass = PASS['C1hero'] if ref == HERO else PASS['C1']
    checks = {
        'C1': {'value': round(c1, 3), 'pass': c1 >= c1pass, 'rule': f'sky-mask IoU >= {c1pass} (top 60 %)', 'profileErr': round(prof_err, 3),
               'conceptSkyShare': round(sky_share, 3), 'note': 'concept mask = by-eye skyline profile; game mask = visual (frame vs sky-only frame)' + ('; concept has almost no sky: IoU not meaningful, use profileErr' if sky_share < 0.05 else '')},
        'C2': {'median': round(float(np.median(dE)), 2), 'worst': round(float(max(dE)), 2), 'cells': [round(x, 1) for x in dE],
               'pass': float(np.median(dE)) <= PASS['C2median'] and max(dE) <= PASS['C2worst'], 'rule': 'Delta E76 per 3x3 cell: median <= 12, worst <= 20'},
        'C3': {'concept': round(mc['warmShare'], 4), 'game': round(mg['warmShare'], 4), 'ratio': round(warm_r, 3),
               'pass': abs(warm_r - 1) <= PASS['C3tol'], 'rule': 'warm share within +-40 % of the concept',
               'coolConcept': round(mc['coolShare'], 4), 'coolGame': round(mg['coolShare'], 4)},
        'C4': {'concept': round(mc['floorBright'], 4), 'game': round(mg['floorBright'], 4), 'ratio': round(fb_r, 3),
               'streaksConcept': mc['fireStreaks'], 'streaksGame': mg['fireStreaks'],
               'pass': abs(fb_r - 1) <= PASS['C4tol'] and mg['fireStreaks'] >= PASS['C4streaks'], 'rule': 'bottom-third L*>55 share within +-50 %, >= 3 fire streaks'},
        'C5': {'ratios': [round(x, 2) for x in c5], 'pass': all(PASS['C5lo'] <= x <= PASS['C5hi'] for x in c5), 'rule': 'Sobel per cell 0.7-1.3x'},
        'C6': {'manual': True, 'conceptCounts': tgt.get('counts', {}), 'rule': 'dressing counts within +-30 % (count on the render)'},
        'C7': {'manual': True, 'rule': 'floor inlay visible, right style'},
        'C8': {'concept': round(mc['farMidRatio'], 3), 'game': round(mg['farMidRatio'], 3), 'pass': mg['farMidRatio'] < PASS['C8'], 'rule': 'far / mid luminance std < 0.6 (plus a fog band: by eye)'},
        'C9': {'manual': True, 'rule': '4 s clip: waterfalls, flames, banners, particles move, no popping (concept.cjs --clip=4)'},
        'C10': {'manual': True, 'rule': 'cameraAudit readable share not worse than the A0 baseline'},
    }
    # calibration: where the game camera puts the annotated things
    calib = {'horizonGame': ghz, 'landmarkTarget': tgt['landmark']['x'], 'landmarkGame': info['landmark'][0], 'edgeTarget': tgt.get('edge')}
    fB = (info.get('fighters') or [None, None])[1] if len(info.get('fighters') or []) > 1 else None
    if fA:
        calib['A'] = {'headTarget': tgt['A']['head'], 'headGame': fA['head'][:2], 'boxGame': fA['bones']}
    if fB and tgt.get('B'):
        calib['B'] = {'footTarget': tgt['B']['foot'], 'footGame': fB['feet'][:2], 'headTarget': tgt['B']['head'], 'headGame': fB['head'][:2]}
    m = {
        'ref': ref, 'theme': info['theme'], 'layout': info['layout'], 'aseed': info['aseed'], 'quality': q, 'size': [W, H],
        'checks': checks, 'calibration': calib,
        'hist': {'concept': mc['hist'], 'game': mg['hist'], 'intersection': round(hist_i, 3)},
        'Lpct': {'concept': [round(x, 1) for x in mc['Lpct']], 'game': [round(x, 1) for x in mg['Lpct']]},
        'frame': {'calls': info.get('calls'), 'tris': info.get('tris')},
    }
    with open(os.path.join(outdir, f'{ref}_metrics.json'), 'w', encoding='utf-8') as f:
        json.dump(m, f, indent=1)
    # ---- images
    def guides(im, pts, col, horizon_pts=None, landmark=None, boxes=()):
        d = ImageDraw.Draw(im)
        w, h = im.size
        if horizon_pts:
            d.line([(x * w, y * h) for x, y in horizon_pts], fill=col, width=2)
        if landmark is not None:
            d.line([(landmark * w, 0), (landmark * w, h * 0.12)], fill=col, width=3)
        for b in boxes:
            d.rectangle([b[0] * w, b[1] * h, b[2] * w, b[3] * h], outline=col, width=2)
        for x, y in pts:
            d.ellipse([x * w - 6, y * h - 6, x * w + 6, y * h + 6], outline=col, width=3)
        return im
    cyan, yel = (60, 230, 255), (255, 220, 40)
    cpts = [tuple(tgt['A']['head'])] + ([tuple(tgt['A']['foot'])] if tgt['A'].get('foot') else [])
    if tgt.get('B'):
        cpts += [tuple(tgt['B']['foot']), tuple(tgt['B']['head'])]
    if tgt.get('edge'):
        cpts.append(tuple(tgt['edge']))
    gpts = []
    for f in info.get('fighters') or []:
        if f:
            gpts += [tuple(f['head'][:2]), tuple(f['feet'][:2])]
    hz_c = [(0, ghz), (1, ghz)]
    Cg = guides(C.copy(), cpts, cyan, landmark=tgt['landmark']['x'])
    Cg = guides(Cg, [], yel, horizon_pts=hz_c)
    Gg = guides(G.copy(), gpts, yel, horizon_pts=[(p[0], p[1]) for p in info['horizon']], landmark=info['landmark'][0],
                boxes=[f['bones'] for f in (info.get('fighters') or []) if f])
    Gg = guides(Gg, cpts, cyan, landmark=tgt['landmark']['x'])
    side = Image.new('RGB', (W * 2 + 8, H + 34), (12, 12, 14))
    side.paste(Cg, (0, 34))
    side.paste(Gg, (W + 8, 34))
    d = ImageDraw.Draw(side)
    font = _font(20)
    verdict = ' '.join(f"{k}{'+' if v.get('pass') else '-'}" for k, v in checks.items() if not v.get('manual'))
    d.text((8, 6), f"{ref} concept (cyan = annotations, yellow = game camera's horizon)", fill=(230, 230, 230), font=font)
    d.text((W + 16, 6), f"game {info['theme']}/{info['layout']}#{info['aseed']} q{q}   {verdict}   C1 {c1:.2f}  C2 {np.median(dE):.1f}/{max(dE):.1f}  warm x{warm_r:.2f}", fill=(230, 230, 230), font=font)
    side.save(os.path.join(outdir, f'{ref}_side.jpg'), quality=88)
    Image.blend(C, G, 0.5).save(os.path.join(outdir, f'{ref}_blend.jpg'), quality=85)
    sk = Image.new('L', (W * 2 + 8, H), 0)
    sk.paste(Image.fromarray(mc['sky'].astype(np.uint8) * 255), (0, 0))
    sk.paste(Image.fromarray(mg['sky'].astype(np.uint8) * 255), (W + 8, 0))
    sk.resize((sk.width // 3, sk.height // 3)).save(os.path.join(outdir, f'{ref}_sky.png'))
    return m


def _font(px):
    for f in ('arial.ttf', 'DejaVuSans.ttf', 'segoeui.ttf'):
        try:
            return ImageFont.truetype(f, px)
        except Exception:
            pass
    return ImageFont.load_default()


def contact(outdir, infos, q, metrics):
    """One sheet: per preset a row [concept | game | extra views], scaled to 420 px wide tiles."""
    tw = 420
    rows = []
    refs = sorted({i['id'] for i in infos}, key=lambda r: int(r.split('-')[1]))
    for ref in refs:
        row = []
        ci = next((i for i in infos if i['id'] == ref and i['view'] == 'concept'), None)
        if ci:
            row.append(('concept ' + ref, Image.open(os.path.join(ROOT, ci['image'])).convert('RGB')))
            row.append((f"game {ci['theme']}", Image.open(os.path.join(outdir, ci['file'])).convert('RGB')))
        for i in infos:
            if i['id'] == ref and i['view'] != 'concept':
                row.append((i['view'], Image.open(os.path.join(outdir, i['file'])).convert('RGB')))
        rows.append((ref, row))
    ncol = max(len(r) for _, r in rows)
    th = int(tw * 941 / 1672)
    sheet = Image.new('RGB', (ncol * (tw + 6) + 6, len(rows) * (th + 30) + 6), (14, 14, 16))
    d = ImageDraw.Draw(sheet)
    font = _font(15)
    for r, (ref, row) in enumerate(rows):
        y = 6 + r * (th + 30)
        for c, (lab, im) in enumerate(row):
            x = 6 + c * (tw + 6)
            sheet.paste(im.resize((tw, th), Image.BILINEAR), (x, y + 22))
            d.text((x + 2, y + 2), lab, fill=(220, 220, 220), font=font)
        mm = metrics.get(ref)
        if mm:
            ck = mm['checks']
            d.text((6 + 2 * (tw + 6) - 200, y + 2), f"C1 {ck['C1']['value']:.2f} C2 {ck['C2']['median']:.0f}", fill=(255, 220, 40), font=font)
    p = os.path.join(outdir, f'contact_q{q}.jpg')
    sheet.save(p, quality=86)
    return p


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dir', required=True)
    ap.add_argument('--q', default='1')
    a = ap.parse_args()
    outdir = os.path.abspath(a.dir)
    T = json.load(open(TARGETS, encoding='utf-8'))
    infos = json.load(open(os.path.join(outdir, 'info.json'), encoding='utf-8'))
    infos = [i for i in infos if i['file'].endswith(f'_q{a.q}.png')]
    metrics = {}
    for info in infos:
        if info['view'] != 'concept':
            continue
        ref = info['id']
        C = Image.open(os.path.join(ROOT, info['image'])).convert('RGB')
        G = Image.open(os.path.join(outdir, info['file'])).convert('RGB')
        metrics[ref] = compare(ref, T[ref], info, C, G, outdir, a.q)
        ck = metrics[ref]['checks']
        print(f"{ref:6s} {info['theme']:10s} C1 {ck['C1']['value']:.2f}  C2 {ck['C2']['median']:5.1f}/{ck['C2']['worst']:5.1f}  "
              f"C3 warm {ck['C3']['concept']:.3f}->{ck['C3']['game']:.3f}  C4 {ck['C4']['concept']:.3f}->{ck['C4']['game']:.3f} streaks {ck['C4']['streaksConcept']}->{ck['C4']['streaksGame']}  "
              f"C5 {min(ck['C5']['ratios']):.2f}..{max(ck['C5']['ratios']):.2f}  C8 {ck['C8']['concept']:.2f}->{ck['C8']['game']:.2f}  hist {metrics[ref]['hist']['intersection']:.2f}")
    sheet = contact(outdir, infos, a.q, metrics)
    summary = {r: {'theme': m['theme'], **{k: v for k, v in m['checks'].items()}, 'hist': m['hist']['intersection']} for r, m in metrics.items()}
    with open(os.path.join(outdir, f'summary_q{a.q}.json'), 'w', encoding='utf-8') as f:
        json.dump(summary, f, indent=1)
    lines = ['| ref | theme (rendered) | C1 sky IoU | C2 dE median / worst | C3 warm concept -> game | C4 floor bright concept -> game (streaks) | C5 detail min..max | C8 far/mid concept -> game | L* hist overlap | passes (auto) |', '|---|---|---|---|---|---|---|---|---|---|']
    for r, m in sorted(metrics.items(), key=lambda kv: int(kv[0].split('-')[1])):
        ck = m['checks']
        npass = sum(1 for v in ck.values() if not v.get('manual') and v.get('pass'))
        nauto = sum(1 for v in ck.values() if not v.get('manual'))
        lines.append(f"| {r} | {m['theme']} | {ck['C1']['value']:.2f} | {ck['C2']['median']:.1f} / {ck['C2']['worst']:.1f} | {ck['C3']['concept']:.3f} -> {ck['C3']['game']:.3f} | "
                     f"{ck['C4']['concept']:.3f} -> {ck['C4']['game']:.3f} ({ck['C4']['streaksConcept']} -> {ck['C4']['streaksGame']}) | {min(ck['C5']['ratios']):.2f}..{max(ck['C5']['ratios']):.2f} | "
                     f"{ck['C8']['concept']:.2f} -> {ck['C8']['game']:.2f} | {m['hist']['intersection']:.2f} | {npass}/{nauto} |")
    with open(os.path.join(outdir, f'summary_q{a.q}.md'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')
    print('contact sheet', sheet)


if __name__ == '__main__':
    sys.exit(main())
