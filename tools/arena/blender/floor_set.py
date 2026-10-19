"""Floor texture set (arena art plan 5.3 / 5.7, milestone A2): a tileable wet-stone set from a CC0 scan.

One job per set (jobs.json `floor_flagstone`, `floor_slate`). The shipped set is THREE textures over one tile of
--tile-m metres (world-space tiling in the game, src/render/arena/floor.ts):
  baseColor  dry albedo (sRGB): the scan graded to the theme stone (desaturated, tinted, darkened), joints and
             the added cracks darkened, cavity from the baked AO
  normal     OpenGL tangent normal: the scan's nor_gl + the added cracks (UDN blend)
  orm        R = ambient occlusion (Cycles bake, see below), G = dry roughness, B = WATER RANK: a uniform 0..1
             field, 1 where water collects first (low areas of the scan's height, broken up by a tileable noise).
             The game fills puddles with `water = smoothstep(level - k, level + k, B)`, level from the non-tiling
             macro mask x wetness, so puddle coverage is a runtime parameter and puddles sit in the real hollows.

What Blender does (Cycles, GPU when --device ONEAPI finds the iGPU, else CPU): the height (scan displacement +
the added cracks) displaces a 3 x 3 tile grid (--grid vertices per tile); AO is baked from it onto the CENTRE tile
(selected-to-active), so occlusion from the neighbouring tiles is included and the AO tiles seamlessly. A Cycles
preview of the wet set (grazing moon + a warm point light) is rendered for the README. The rest is numpy inside
Blender (tileable Fourier noise, periodic Voronoi cracks, FFT blur): deterministic from --seed.

GLB (texture carrier, plan 4.2):  KIT_<name> {id, role 'texset', kind 'floor', tileM, waterSharp}
                                     TEXSET (1 x 1 m quad, material floor_<name>)
build_assets.mjs attaches the PNGs from asset.json (KTX2 + WebP, low tier = halved), check_budget.mjs checks the
texset row (sizes, power of two, texel density, tileM).
Run:  npm run arena:bake -- floor_flagstone
"""
import json
import math
import os
import sys

import bpy
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import abake  # noqa: E402


def extra(ap):
    ap.add_argument('--name', required=True, help='set name, asset id floor/<name>')
    ap.add_argument('--cc0', required=True, help='scan, e.g. polyhaven/large_grey_tiles')
    ap.add_argument('--tile-m', type=float, required=True, help='metres per texture repeat in the game')
    ap.add_argument('--px', type=int, default=2048)
    ap.add_argument('--grid', type=int, default=384, help='displaced vertices per tile edge (3 x 3 tiles)')
    ap.add_argument('--disp-m', type=float, default=0.03, help='height range of the displacement (m)')
    ap.add_argument('--ao-samples', type=int, default=96)
    ap.add_argument('--device', default='ONEAPI')
    ap.add_argument('--seed', type=int, default=7)
    # grading (albedo is graded in linear space)
    ap.add_argument('--sat', type=float, default=0.3, help='saturation kept')
    ap.add_argument('--tint', default='0.80,0.87,1.0')
    ap.add_argument('--gain', type=float, default=0.55, help='albedo multiplier after grading')
    ap.add_argument('--contrast', type=float, default=1.15)
    ap.add_argument('--joint-lo', type=float, default=0.03, help='height percentile: full joint')
    ap.add_argument('--joint-hi', type=float, default=0.12, help='height percentile: joint ends')
    ap.add_argument('--joint-dark', type=float, default=0.65)
    ap.add_argument('--cracks', type=float, default=0.45, help='share of Voronoi edges kept as cracks')
    ap.add_argument('--crack-cells', type=int, default=22, help='Voronoi cells per tile')
    ap.add_argument('--crack-dark', type=float, default=0.7)
    ap.add_argument('--rough-lo', type=float, default=0.62)
    ap.add_argument('--rough-hi', type=float, default=0.92)
    ap.add_argument('--preview', type=int, default=640, help='preview height (0 = none)')
    # A8: procedural slab mode (the owner's ref-3 floor: big thick irregular broken slabs, deep joints, chips, cracks,
    # soot / blood stains, rough dull stone); --cc0 then only lends its micro surface (disp / diff / rough)
    ap.add_argument('--mode', default='scan', choices=['scan', 'slabs'])
    ap.add_argument('--scan-m', type=float, default=2.0, help='metres covered by the scan (micro surface)')
    ap.add_argument('--albedo', default='0.105,0.112,0.135', help='mean linear stone albedo before AO')
    ap.add_argument('--stains', type=float, default=1.0)


job = abake.Job(extra, __doc__)
a = job.a
S = {}
N = a.px
rng = np.random.default_rng(a.seed)


# ---------------------------------------------------------------------------- numpy helpers (all periodic)

def img_np(path, non_color=True):
    """image -> float32 (N, N, 4), Blender row order (row 0 = bottom), resized to N"""
    im = bpy.data.images.load(path, check_existing=False)
    if non_color:
        im.colorspace_settings.name = 'Non-Color'
    if tuple(im.size) != (N, N):
        im.scale(N, N)
    px = np.empty(N * N * 4, dtype=np.float32)
    im.pixels.foreach_get(px)
    bpy.data.images.remove(im)
    return px.reshape(N, N, 4)


def save_np(rgb, path, non_color=True, float_buffer=False):
    """(N, N, 3|4) float array (row 0 = bottom) -> PNG"""
    h, w = rgb.shape[:2]
    im = bpy.data.images.new(os.path.basename(path), w, h, alpha=False, float_buffer=float_buffer)
    if non_color:
        im.colorspace_settings.name = 'Non-Color'
    px = np.ones((h, w, 4), dtype=np.float32)
    px[..., :rgb.shape[2]] = rgb[..., :4]
    im.pixels.foreach_set(px.ravel())
    im.filepath_raw = path
    im.file_format = 'PNG'
    if not float_buffer:
        im.save()
    return im


def fourier_noise(n, kmax, count, beta, seed):
    """tileable noise in [0, 1]: sum of random integer-frequency waves (period = the tile)"""
    r = np.random.default_rng(seed)
    t = (np.arange(n, dtype=np.float32) + 0.5) / n
    x, y = np.meshgrid(t, t)
    acc = np.zeros((n, n), dtype=np.float32)
    for _ in range(count):
        kx, ky = r.integers(-kmax, kmax + 1, 2)
        if kx == 0 and ky == 0:
            continue
        amp = 1.0 / (math.hypot(kx, ky) ** beta)
        acc += amp * np.cos(2 * np.pi * (kx * x + ky * y) + r.uniform(0, 2 * np.pi)).astype(np.float32)
    acc -= acc.min()
    return acc / max(1e-6, acc.max())


def upsample(a2, n):
    """periodic bilinear upsample of a square array to n x n"""
    m = a2.shape[0]
    t = (np.arange(n, dtype=np.float32) + 0.5) * m / n - 0.5
    i0 = np.floor(t).astype(np.int64)
    f = (t - i0).astype(np.float32)
    i0 %= m
    i1 = (i0 + 1) % m
    rows = a2[i0] * (1 - f)[:, None] + a2[i1] * f[:, None]
    return rows[:, i0] * (1 - f)[None, :] + rows[:, i1] * f[None, :]


def blur(h, sigma_px):
    """periodic gaussian blur by FFT"""
    n = h.shape[0]
    k = np.fft.fftfreq(n).astype(np.float32)
    g = np.exp(-2 * (np.pi * sigma_px) ** 2 * (k[:, None] ** 2 + k[None, :] ** 2))
    return np.real(np.fft.ifft2(np.fft.fft2(h) * g)).astype(np.float32)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def voronoi_edges(n, cells, seed):
    """periodic Voronoi: approximate distance to the nearest cell edge (in tile units) and a per-edge id"""
    r = np.random.default_rng(seed)
    p = r.random((cells, 2)).astype(np.float32)
    keep = r.random(cells).astype(np.float32)
    off = np.array([(dx, dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1)], dtype=np.float32)
    P = (p[None, :, :] + off[:, None, :]).reshape(-1, 2)
    K = np.tile(keep, 9)
    t = (np.arange(n, dtype=np.float32) + 0.5) / n
    edge = np.empty((n, n), dtype=np.float32)
    eid = np.empty((n, n), dtype=np.float32)
    rows = 16
    for r0 in range(0, n, rows):
        yy = t[r0:r0 + rows]
        X = np.broadcast_to(t[None, :], (len(yy), n)).reshape(-1)
        Y = np.broadcast_to(yy[:, None], (len(yy), n)).reshape(-1)
        d2 = (X[:, None] - P[None, :, 0]) ** 2 + (Y[:, None] - P[None, :, 1]) ** 2
        idx = np.argpartition(d2, 1, axis=1)[:, :2]
        a0 = np.take_along_axis(d2, idx, 1)
        o = np.argsort(a0, axis=1)
        idx = np.take_along_axis(idx, o, 1)
        a0 = np.sqrt(np.take_along_axis(a0, o, 1))
        edge[r0:r0 + rows] = ((a0[:, 1] - a0[:, 0]) * 0.5).reshape(len(yy), n)
        # an edge's "keep" value: mix of the two cells' values (stable along the edge)
        eid[r0:r0 + rows] = ((K[idx[:, 0]] + K[idx[:, 1]]) * 0.5).reshape(len(yy), n)
    return edge, eid


def rank01(f):
    """uniform 0..1 rank of every value (CDF transform)"""
    o = np.argsort(f.ravel(), kind='stable')
    r = np.empty(o.size, dtype=np.float32)
    r[o] = np.arange(o.size, dtype=np.float32) / (o.size - 1)
    return r.reshape(f.shape)


def to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def to_lin(c):
    return np.where(c <= 0.04045, c / 12.92, np.power((c + 0.055) / 1.055, 2.4))


def set_world_uv(me, tile, off):
    """planar UVs from the vertex x / y (numpy foreach, fast on million-vertex grids): uv = (p + off) / tile"""
    co = np.empty(len(me.vertices) * 3, dtype=np.float32)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    vi = np.empty(len(me.loops), dtype=np.int64)
    me.loops.foreach_get('vertex_index', vi)
    uv = (co[vi, :2] + off) / tile
    me.uv_layers.active.data.foreach_set('uv', uv.astype(np.float32).ravel())


# ---------------------------------------------------------------------------- steps

def synth():
    """scan -> graded albedo, roughness, combined height (+ cracks), crack normal, water rank"""
    src = abake.load_cc0(a.cc0, need=('diff', 'rough', 'nor_gl', 'disp'))
    S['src'] = src
    diff = img_np(src['diff'], non_color=True)[..., :3]  # sRGB values as stored
    rough = img_np(src['rough'])[..., 0]
    nor = img_np(src['nor_gl'])[..., :3] * 2 - 1
    disp = img_np(src['disp'])[..., 0]
    # height normalised by percentiles (robust to a few outliers)
    lo, hi = np.percentile(disp, [0.5, 99.5])
    Hn = np.clip((disp - lo) / max(1e-6, hi - lo), 0, 1).astype(np.float32)
    q = np.quantile(Hn, [a.joint_lo, a.joint_hi])
    joint = 1 - smoothstep(q[0], q[1], Hn)
    # cracks across the stones: periodic Voronoi edges, wobbly, a share kept, only on stone (not in joints)
    edge, eid = voronoi_edges(N, a.crack_cells, a.seed + 11)
    wob = upsample(fourier_noise(256, 24, 60, 0.6, a.seed + 3), N) - 0.5
    e = np.abs(edge + wob * 0.012)
    width = 0.0016 + 0.0016 * upsample(fourier_noise(128, 6, 20, 0.8, a.seed + 5), N)  # tile units (2-5 mm)
    crack = (1 - smoothstep(0, width, e)) * (eid < a.cracks) * (1 - joint)
    taper = smoothstep(0.25, 0.6, upsample(fourier_noise(128, 5, 24, 0.8, a.seed + 9), N))
    crack = (crack * taper).astype(np.float32)
    # combined height in metres (0 = top): scan + cracks (5 mm deep)
    Hm = (Hn - 1) * a.disp_m - crack * 0.005
    S['Hm'] = Hm
    # crack normal (OpenGL: +x right, +y = image top = Blender +y), UDN onto the scan normal
    px_m = a.tile_m / N
    ch = -crack * 0.005
    gx = (np.roll(ch, -1, 1) - np.roll(ch, 1, 1)) / (2 * px_m)
    gy = (np.roll(ch, -1, 0) - np.roll(ch, 1, 0)) / (2 * px_m)
    n = np.stack([nor[..., 0] - gx * 0.6, nor[..., 1] - gy * 0.6, nor[..., 2]], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    S['normal'] = n
    # albedo: linear, desaturate, tint, contrast around the mean, gain, joints and cracks dark
    lin = to_lin(diff)
    lum = (lin * np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)).sum(-1, keepdims=True)
    g = lum + (lin - lum) * a.sat
    g *= np.array([float(x) for x in a.tint.split(',')], dtype=np.float32)
    m = g.mean()
    g = m * np.power(np.maximum(g, 1e-5) / m, a.contrast)
    macro = 0.88 + 0.24 * upsample(fourier_noise(128, 4, 30, 1.0, a.seed + 21), N)
    g *= a.gain * macro[..., None]
    g *= (1 - a.joint_dark * joint)[..., None]
    g *= (1 - a.crack_dark * crack)[..., None]
    S['albedo_lin'] = g.astype(np.float32)
    # dry roughness
    S['rough'] = (a.rough_lo + (a.rough_hi - a.rough_lo) * np.clip(rough, 0, 1)).astype(np.float32)
    S['rough'] = np.maximum(S['rough'], 0.75 * joint + (1 - joint) * S['rough'])
    # water rank: low (blurred) height + a tileable noise; joints and cracks rank high
    Hs = blur(Hn, 3.0)
    basin = Hs - blur(Hn, N / 24) * 0.6
    f = basin + 0.45 * (upsample(fourier_noise(256, 6, 40, 0.9, a.seed + 31), N) - 0.5) - joint * 0.15 - crack * 0.1
    S['water'] = 1 - rank01(f)
    S['crack'] = crack
    S['joint'] = joint
    return {'heightRangeM': a.disp_m, 'jointShare': float((joint > 0.5).mean()), 'crackShare': float((crack > 0.5).mean()), 'albedoMeanSrgb': float(to_srgb(S['albedo_lin']).mean())}


def rect_cells(n, T, seed, warp_m=0.09):
    """periodic running-bond slab layout: rows of 0.9-1.8 m, each split into slabs of 1.0-2.6 m with a random row
    offset, the coordinates warped by a few cm so no edge is ruler-straight. Per pixel: slab id, distance to the
    nearest slab edge (m), slab centre (m), slab size (m)"""
    r = np.random.default_rng(seed)
    hs = []
    while sum(hs) < T - 0.6:
        hs.append(r.uniform(0.9, 1.8))
    hs = np.array(hs) * T / sum(hs)
    y_edges = np.concatenate([[0], np.cumsum(hs)])
    rows = []
    for i in range(len(hs)):
        ls = []
        while sum(ls) < T - 0.7:
            ls.append(r.uniform(1.0, 2.6))
        ls = np.array(ls) * T / sum(ls)
        rows.append((np.concatenate([[0], np.cumsum(ls)]), r.uniform(0, T)))
    t = (np.arange(n, dtype=np.float32) + 0.5) / n * T
    X, Y = np.meshgrid(t, t)
    wx = (upsample(fourier_noise(128, 6, 40, 1.2, seed + 101), n) - 0.5) * 2 * warp_m
    wy = (upsample(fourier_noise(128, 6, 40, 1.2, seed + 102), n) - 0.5) * 2 * warp_m
    Xw, Yw = (X + wx) % T, (Y + wy) % T
    ri = np.clip(np.searchsorted(y_edges, Yw, side='right') - 1, 0, len(hs) - 1)
    cid = np.zeros((n, n), np.int32)
    dist = np.zeros((n, n), np.float32)
    cx = np.zeros((n, n), np.float32)
    cy = np.zeros((n, n), np.float32)
    sz = np.zeros((n, n), np.float32)
    base = 0
    for i, (xe, sh) in enumerate(rows):
        m = ri == i
        xs = (Xw[m] + sh) % T
        si = np.clip(np.searchsorted(xe, xs, side='right') - 1, 0, len(xe) - 2)
        x0, x1 = xe[si], xe[si + 1]
        y0, y1 = y_edges[i], y_edges[i + 1]
        yy = Yw[m]
        # a third of the slabs split once more (across or along), so the joints do not read as a regular bond
        nsl = len(xe) - 1
        cut = r.random(nsl)
        frac = r.uniform(0.35, 0.65, nsl)
        ys = y0 + (y1 - y0) * frac[si]
        xc = x0 + (x1 - x0) * frac[si]
        splitY = (cut[si] < 0.2) & ((y1 - y0) > 1.15)
        splitX = (cut[si] > 0.82) & ((x1 - x0) > 1.6)
        lo_y = np.where(splitY & (yy >= ys), ys, y0)
        hi_y = np.where(splitY & (yy < ys), ys, y1)
        lo_x = np.where(splitX & (xs >= xc), xc, x0)
        hi_x = np.where(splitX & (xs < xc), xc, x1)
        x0, x1, y0, y1 = lo_x, hi_x, lo_y, hi_y
        dist[m] = np.minimum(np.minimum(xs - x0, x1 - xs), np.minimum(yy - y0, y1 - yy))
        cid[m] = (base + si) * 4 + (splitY & (yy >= ys)) * 1 + (splitX & (xs >= xc)) * 2
        cx[m] = X[m] + ((x0 + x1) / 2 - xs)
        cy[m] = Y[m] + ((y0 + y1) / 2 - yy)
        sz[m] = np.minimum(x1 - x0, y1 - y0)
        base += len(xe) - 1
    return cid, dist, cx, cy, sz, base * 4


def synth_slabs():
    """A8 procedural slab floor: running-bond slabs (rows 0.9-1.8 m, slabs 1.0-2.6 m, warped edges), each with its own height offset and tilt,
    rounded and chipped edges, deep wide joints, heavy cracks (some slabs broken through), a rock scan for the
    micro surface (random offset per slab), soot / blood stains; water ranks joints, cracks, chips and the low
    corners of tilted slabs first"""
    src = abake.load_cc0(a.cc0, need=('diff', 'rough', 'disp'))
    S['src'] = src
    T = a.tile_m
    pxm = T / N
    cid, em, ccx, ccy, csz, ncell = rect_cells(N, T, a.seed)
    r = np.random.default_rng(a.seed + 1)
    h0 = r.uniform(0, 0.025, ncell).astype(np.float32)
    tx, ty = (r.uniform(-0.016, 0.016, (2, ncell))).astype(np.float32)
    tint = r.uniform(0.74, 1.2, ncell).astype(np.float32)
    ox, oy = r.integers(0, 4096, (2, ncell))
    t = (np.arange(N, dtype=np.float32) + 0.5) / N * T
    X, Y = np.meshgrid(t, t)
    dx = X - ccx
    dy = Y - ccy
    # broken slabs: a third of them carry a break line straight through (random angle, wobbly)
    brk = r.random(ncell) < 0.4
    ang = r.uniform(0, np.pi, ncell).astype(np.float32)
    offb = r.uniform(-0.25, 0.25, ncell).astype(np.float32)
    wobB = (upsample(fourier_noise(256, 24, 80, 0.7, a.seed + 41), N) - 0.5) * 0.06
    dline = np.abs(np.cos(ang[cid]) * dx + np.sin(ang[cid]) * dy - offb[cid] * csz + wobB)
    bw = 0.004 + 0.008 * upsample(fourier_noise(128, 8, 30, 0.8, a.seed + 43), N)
    breakL = ((1 - smoothstep(bw * 0.5, bw, dline)) * brk[cid]).astype(np.float32)
    # chips: noise bites out of the slab edges (up to 7 cm); irregular joint half-width 0.6-1.6 cm
    chipN = upsample(fourier_noise(512, 26, 140, 0.75, a.seed + 3), N)
    chip = smoothstep(0.58, 0.85, chipN) * 0.16
    jw = 0.008 + 0.014 * upsample(fourier_noise(128, 10, 40, 0.8, a.seed + 5), N)
    e2 = em - chip * smoothstep(0.2, 0.0, em)
    joint = (1 - smoothstep(jw, jw + 0.006, e2)).astype(np.float32)
    chipped = ((e2 < jw + 0.004) & (em > jw)).astype(np.float32)
    bevel = smoothstep(jw, jw + 0.045, e2)
    # micro surface from the scan (per-slab offset; the scan covers --scan-m metres)
    sd = img_np_native(src['disp'])[..., 0]
    Nsc = sd.shape[0]
    stp = Nsc / (a.scan_m / pxm)
    ii = ((np.arange(N)[:, None] * stp + oy[cid]) % Nsc).astype(np.int64)
    jj = ((np.arange(N)[None, :] * stp + ox[cid]) % Nsc).astype(np.int64)
    lo_, hi_ = np.percentile(sd, [1, 99])
    det = np.clip((sd[ii, jj] - lo_) / max(1e-6, hi_ - lo_), 0, 1).astype(np.float32)
    det = blur(det, 1.0)
    dl = to_lin(img_np_native(src['diff'])[..., :3])
    dlum = (dl * np.array([0.2126, 0.7152, 0.0722], np.float32)).sum(-1)[ii, jj]
    dlum = blur(np.clip(dlum / max(1e-6, float(np.median(dlum))), 0.8, 1.25).astype(np.float32), 2.5)
    srough = img_np_native(src['rough'])[..., 0][ii, jj]
    # cracks: a coarser periodic Voronoi, wobbly, a share kept; a few wide breaks straight through slabs
    edgeC, eidC = voronoi_edges(N, 26, a.seed + 11)
    wob = upsample(fourier_noise(256, 30, 80, 0.6, a.seed + 13), N) - 0.5
    ec = np.abs(edgeC + wob * 0.010) * T
    cw = 0.003 + 0.005 * upsample(fourier_noise(128, 8, 30, 0.8, a.seed + 15), N)
    wide = (eidC < 0.18).astype(np.float32)
    cw = cw + wide * 0.006
    crack = (1 - smoothstep(cw * 0.4, cw, ec)) * (eidC < a.cracks) * (1 - joint)
    taper = smoothstep(0.2, 0.5, upsample(fourier_noise(128, 5, 24, 0.8, a.seed + 9), N))
    crack = np.maximum(np.maximum(crack * taper, crack * wide), breakL * (1 - joint)).astype(np.float32)
    # height (m, 0 = highest): slab offset + tilt + micro surface + rounded edge; joints 5 cm, chips 1-2.5 cm, cracks
    H = h0[cid] + (tx[cid] * dx + ty[cid] * dy) + det * 0.008
    # the two halves of a broken slab settle differently
    side = (np.cos(ang[cid]) * dx + np.sin(ang[cid]) * dy - offb[cid] * csz) > 0
    H += np.where(side & brk[cid], -0.012, 0.0).astype(np.float32)
    H -= (1 - bevel) * 0.014
    H -= chipped * (0.012 + 0.012 * chipN)
    H -= crack * (0.008 + 0.012 * wide)
    H = H * (1 - joint) + (-0.05) * joint
    H = H.astype(np.float32)
    H -= H.max()
    a.disp_m = float(-H.min()) - 0.005
    S['Hm'] = H
    # normal (OpenGL; row 0 = bottom, +row = +y)
    gx = (np.roll(H, -1, 1) - np.roll(H, 1, 1)) / (2 * pxm)
    gy = (np.roll(H, -1, 0) - np.roll(H, 1, 0)) / (2 * pxm)
    n = np.stack([-gx, -gy, np.ones_like(H)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    S['normal'] = n.astype(np.float32)
    # albedo (linear): base stone x per-slab tint x scan luminance, joints / cracks dark, chips paler, stains
    base = np.array([float(x) for x in a.albedo.split(',')], np.float32)
    alb = base[None, None, :] * (tint[cid] * dlum)[..., None]
    alb *= (0.9 + 0.2 * upsample(fourier_noise(128, 4, 30, 1.0, a.seed + 21), N))[..., None]
    alb *= (1 + 0.18 * chipped)[..., None]
    alb *= (1 - 0.85 * joint)[..., None]
    alb *= (1 - 0.7 * crack)[..., None]
    soot = smoothstep(0.58, 0.78, upsample(fourier_noise(256, 9, 60, 0.9, a.seed + 23), N)) * a.stains
    soot = np.maximum(soot, smoothstep(0.1, 0.0, em) * 0.5 * a.stains)  # grime along the joints
    alb *= (1 - 0.55 * soot)[..., None]
    blood = smoothstep(0.72, 0.88, upsample(fourier_noise(256, 14, 70, 0.8, a.seed + 25), N)) * smoothstep(0.35, 0.75, upsample(fourier_noise(512, 50, 120, 0.6, a.seed + 27), N)) * a.stains
    stain = np.array([0.035, 0.012, 0.013], np.float32)
    alb = alb * (1 - 0.75 * blood[..., None]) + stain * 0.75 * blood[..., None]
    S['albedo_lin'] = alb.astype(np.float32)
    # roughness: dull dry stone; joints / cracks rougher (the game's damp / water terms make the puddles)
    S['rough'] = np.clip(a.rough_lo + (a.rough_hi - a.rough_lo) * np.clip(srough, 0, 1) + 0.08 * joint, 0, 1).astype(np.float32)
    # water rank: low height first (joints, cracks, chips, low corners of tilted slabs), broken by noise
    f = blur(H, 2.0) - blur(H, N / 20) * 0.3 + 0.006 * (upsample(fourier_noise(256, 6, 40, 0.9, a.seed + 31), N) - 0.5)
    S['water'] = 1 - rank01(f)
    S['crack'] = crack
    S['joint'] = joint
    # small-scale cavity AO in numpy (the Cycles AO grid is coarser than the joints)
    S['cavity'] = np.clip(1 - 18.0 * np.maximum(0, blur(H, 6.0) - H), 0.35, 1).astype(np.float32)
    S['debug'] = {'breaks': int(brk.sum())}
    return {'cells': int(ncell), 'brokenSlabs': int(brk.sum()), 'heightRangeM': round(a.disp_m + 0.005, 4), 'jointShare': float((joint > 0.5).mean()), 'crackShare': float((crack > 0.5).mean()),
            'chipShare': float(chipped.mean()), 'albedoMeanSrgb': float(to_srgb(S['albedo_lin']).mean())}


def img_np_native(path):
    """image at its own (square) size -> float32 (n, n, 4), row 0 = bottom (no resize: the slab mode samples the scan
    at its own scale)"""
    im = bpy.data.images.load(path, check_existing=False)
    im.colorspace_settings.name = 'Non-Color'
    w, h = im.size
    px = np.empty(w * h * 4, dtype=np.float32)
    im.pixels.foreach_get(px)
    bpy.data.images.remove(im)
    return px.reshape(h, w, 4)


def build_high():
    """3 x 3 displaced tiles (high) + the centre tile (low) for the AO bake"""
    abake.reset()
    S['dev'] = abake.cycles_device(a.device, a.threads)
    T = a.tile_m
    # height image (float) for the Displace modifier: 1 = top, 0 = disp_m + 5 mm below
    rngm = a.disp_m + 0.005
    him = save_np(np.repeat(((S['Hm'] + rngm) / rngm)[..., None], 3, -1), os.path.join(job.out, 'height_tmp.png'), float_buffer=True)
    tex = bpy.data.textures.new('h', 'IMAGE')
    tex.image = him
    tex.extension = 'REPEAT'
    n = a.grid * 3
    bpy.ops.mesh.primitive_grid_add(x_subdivisions=n, y_subdivisions=n, size=3 * T)
    hi = bpy.context.active_object
    hi.name = 'high'
    # UVs 0..3 (the image repeats)
    set_world_uv(hi.data, T, 1.5 * T)
    d = hi.modifiers.new('disp', 'DISPLACE')
    d.texture = tex
    d.texture_coords = 'UV'
    d.mid_level = 1.0
    d.strength = rngm
    bpy.ops.mesh.primitive_plane_add(size=T, location=(0, 0, 0))
    lo = bpy.context.active_object
    lo.name = 'low'
    mat = bpy.data.materials.new('bake')
    mat.use_nodes = True
    lo.data.materials.append(mat)
    hi.data.materials.append(bpy.data.materials.new('hi'))
    S['hi'], S['lo'] = hi, lo
    return {'highTris': abake.tri_count(hi), 'device': S['dev']}


def bake():
    s = bpy.context.scene
    s.render.bake.max_ray_distance = a.disp_m * 3
    r = abake.bake_maps(S['lo'], S['hi'], ['AO'], a.px, job.out, samples=a.ao_samples, extrusion=a.disp_m * 1.5, margin=0, prefix=a.name)
    S['ao_path'] = r['AO']['path']
    return r


def compose():
    """final PNGs: baseColor (sRGB), normal, orm"""
    ao = img_np(S['ao_path'])[..., 0]
    ao = np.clip(ao, 0, 1)
    if 'cavity' in S:
        ao = ao * S['cavity']
    S['ao'] = ao
    alb = S['albedo_lin'] * (0.55 + 0.45 * ao)[..., None]
    out = {}
    out['baseColor'] = f'{a.name}_basecolor.png'
    save_np(to_srgb(alb), os.path.join(job.out, out['baseColor']), non_color=False)
    out['normal'] = f'{a.name}_normal.png'
    save_np(S['normal'] * 0.5 + 0.5, os.path.join(job.out, out['normal']))
    out['orm'] = f'{a.name}_orm.png'
    save_np(np.stack([ao, S['rough'], S['water']], -1), os.path.join(job.out, out['orm']))
    S['maps'] = out
    return {**out, 'aoMean': float(ao.mean()), 'albedoMeanSrgb': float(to_srgb(alb).mean())}


def export():
    """carrier GLB: KIT_<name> {extras} > TEXSET quad with the named material; asset.json"""
    abake.reset()
    mname = f'floor_{a.name}'
    mat = bpy.data.materials.new(mname)
    mat.use_nodes = True
    bpy.ops.mesh.primitive_plane_add(size=1.0)
    q = bpy.context.active_object
    q.name = 'TEXSET'
    q.data.materials.append(mat)
    root = abake.empty(f'KIT_{a.name}', id=f'floor/{a.name}', role='texset', kind='floor', tileM=a.tile_m, source=a.cc0, mode=a.mode)
    q.parent = root
    glb = abake.export_glb(os.path.join(job.out, f'{a.name}_raw.glb'), objects=[root, q])
    asset = {
        'id': f'floor/{a.name}', 'glb': os.path.basename(glb['path']), 'role': 'texset', 'kind': 'floor',
        'texset': {'tileM': a.tile_m, 'px': a.px, 'channels': {'orm': 'R occlusion, G dry roughness, B water rank (uniform 0..1)'}},
        'lods': {'LOD0': {'materials': [mname]}, 'LOD1': {'materials': [mname], 'ownTextures': False}},
        'materials': {mname: {**S['maps'], 'metallicFactor': 0.0, 'roughnessFactor': 1.0}},
        'sources': [a.cc0],
        'job': os.path.basename(job.out),
    }
    with open(os.path.join(job.out, 'asset.json'), 'w', encoding='utf-8') as f:
        json.dump(asset, f, indent=1)
    return {'glb': glb, 'asset': 'asset.json'}


def preview():
    """Cycles still of the set, wet (puddles at about 35 %), grazing moon + warm point light: README only"""
    if not a.preview:
        return 'skipped'
    abake.reset()
    dev = abake.cycles_device(a.device, a.threads)
    s = bpy.context.scene
    s.cycles.samples = 48
    s.render.resolution_x = a.preview * 2
    s.render.resolution_y = a.preview
    T = a.tile_m
    bpy.ops.mesh.primitive_plane_add(size=3 * T)
    p = bpy.context.active_object
    set_world_uv(p.data, T, 1.5 * T)
    mat = bpy.data.materials.new('prev')
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')

    def tex(name, non_color):
        n = nt.nodes.new('ShaderNodeTexImage')
        n.image = bpy.data.images.load(os.path.join(job.out, name))
        if non_color:
            n.image.colorspace_settings.name = 'Non-Color'
        return n
    tc = tex(S['maps']['baseColor'], False)
    tn = tex(S['maps']['normal'], True)
    to = tex(S['maps']['orm'], True)
    sep = nt.nodes.new('ShaderNodeSeparateColor')
    nt.links.new(to.outputs['Color'], sep.inputs['Color'])
    # water = smoothstep(0.63, 0.67, B)  (35 % coverage)
    mr = nt.nodes.new('ShaderNodeMapRange')
    mr.interpolation_type = 'SMOOTHSTEP'
    mr.inputs['From Min'].default_value = 0.63
    mr.inputs['From Max'].default_value = 0.67
    nt.links.new(sep.outputs['Blue'], mr.inputs['Value'])
    # roughness: damp everywhere (x 0.6), 0.04 in water
    mul = nt.nodes.new('ShaderNodeMath')
    mul.operation = 'MULTIPLY'
    mul.inputs[1].default_value = 0.6
    nt.links.new(sep.outputs['Green'], mul.inputs[0])
    mixr = nt.nodes.new('ShaderNodeMix')
    mixr.data_type = 'FLOAT'
    nt.links.new(mr.outputs['Result'], mixr.inputs['Factor'])
    nt.links.new(mul.outputs['Value'], mixr.inputs['A'])
    mixr.inputs['B'].default_value = 0.04
    nt.links.new(mixr.outputs['Result'], bsdf.inputs['Roughness'])
    # albedo darkened 35 % when wet, 55 % in water
    mixc = nt.nodes.new('ShaderNodeMix')
    mixc.data_type = 'RGBA'
    mixc.blend_type = 'MULTIPLY'
    mixc.inputs['Factor'].default_value = 1.0
    nt.links.new(tc.outputs['Color'], mixc.inputs['A'])
    dk = nt.nodes.new('ShaderNodeMapRange')
    nt.links.new(mr.outputs['Result'], dk.inputs['Value'])
    dk.inputs['To Min'].default_value = 0.65
    dk.inputs['To Max'].default_value = 0.45
    nt.links.new(dk.outputs['Result'], mixc.inputs['B'])
    nt.links.new(mixc.outputs['Result'], bsdf.inputs['Base Color'])
    nm = nt.nodes.new('ShaderNodeNormalMap')
    nt.links.new(tn.outputs['Color'], nm.inputs['Color'])
    st = nt.nodes.new('ShaderNodeMapRange')
    nt.links.new(mr.outputs['Result'], st.inputs['Value'])
    st.inputs['To Min'].default_value = 1.0
    st.inputs['To Max'].default_value = 0.1
    nt.links.new(st.outputs['Result'], nm.inputs['Strength'])
    nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    p.data.materials.append(mat)
    w = bpy.data.worlds.new('w')
    s.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes['Background']
    bg.inputs['Color'].default_value = (0.05, 0.055, 0.12, 1)
    bg.inputs['Strength'].default_value = 1.0
    sd = bpy.data.lights.new('moon', 'SUN')
    sd.energy = 1.4
    sd.color = (0.78, 0.8, 1.0)
    sd.angle = math.radians(1.0)
    so = bpy.data.objects.new('moon', sd)
    s.collection.objects.link(so)
    so.rotation_euler = (math.radians(-62), 0, 0)  # low, in front of the camera (backlight)
    for i, (x, y) in enumerate([(-2.2, 3.5), (2.6, 5.5)]):
        ld = bpy.data.lights.new(f'fire{i}', 'POINT')
        ld.energy = 900
        ld.color = (1.0, 0.45, 0.15)
        ld.shadow_soft_size = 0.2
        lo = bpy.data.objects.new(f'fire{i}', ld)
        s.collection.objects.link(lo)
        lo.location = (x, y, 1.3)
    cd = bpy.data.cameras.new('cam')
    cd.lens = 28
    cam = bpy.data.objects.new('cam', cd)
    s.collection.objects.link(cam)
    cam.location = (0, -T * 1.4, 1.0)
    cam.rotation_euler = (math.radians(83), 0, 0)
    s.camera = cam
    abake.image_settings('PNG', '8', 'RGB')
    s.view_settings.view_transform = 'AgX'
    out = abake.render_still(os.path.join(job.out, f'{a.name}_preview.png'))
    return {'path': out, 'device': dev.get('used')}


job.step('synth', synth_slabs if a.mode == 'slabs' else synth)
job.step('build_high', build_high)
job.step('bake_ao', bake)
job.step('compose', compose)
job.step('export', export)
job.step('preview', preview)
fails = [r['step'] for r in job.steps if not r['ok']]
job.result['failed'] = fails
job.done()
if fails:
    sys.exit(1)
