"""A3 stone TRIM SHEET (arena art plan 5.3): one 2048 sheet over 8 x 8 m (256 px/m) for every ring / architecture module
(arcades, walls, arches, stairs, plinths, dais, balustrades, spear-fence courses). Rows tile in U (8 m period); a
module maps each face to a row (stonekit.TRIM_ROWS, metres in V from the bottom of the sheet):

  ashlar   6-8 m   four 0.5 m courses of dressed blocks, deep joints, chipped arrises, cracks, soot from the joints
  blocks   4-6 m   two 1 m courses of big rusticated blocks (piers, plinths, risers)
  moulding 3-4 m   cornice profile (fillet, cyma, corona) cut into 1.2-1.6 m stones, chipped
  frieze   2-3 m   carved rune band between two raised fillets, worn
  rough    1-2 m   fractured stone (broken tops, break faces, rubble cores)
  plain    0-1 m   worn flat slabs (tops, treads, copings)

Pipeline: numpy height field per row (periodic in U by construction) -> NORMAL computed from it (exact, seamless) ->
the field displaces a 9 x 8 m grid (half a metre of wrap margin each side) = the HIGH; Cycles AO baked onto a flat
8 x 8 m plane = the LOW -> albedo composed in numpy (graded stone x CC0 scan luminance (Poly Haven lichen_rock, 2 m
tile) x block tint x joint/crack cavity x fresh chips x soot streaks), roughness, ORM (AO, rough, 0).
GLB: texture-set carrier (role texset, kind trim): KIT_stone_trim {sizeM 8, rows} > TEXSET quad, material stone_trim.
Run:  npm run arena:bake -- kit_stone_trim
"""
import json
import math
import os
import sys

import bpy
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import abake  # noqa: E402
import stonekit as K  # noqa: E402


def extra(ap):
    ap.add_argument('--px', type=int, default=2048)
    ap.add_argument('--grid', type=int, default=1024, help='high vertices per 8 m in V')
    ap.add_argument('--ao-samples', type=int, default=64)
    ap.add_argument('--seed', type=int, default=11)
    ap.add_argument('--cc0', default='polyhaven/lichen_rock')
    ap.add_argument('--device', default='CPU')


job = abake.Job(extra, __doc__)
a = job.a
N = a.px
SZ = 8.0
PXM = N / SZ
S = {}
rng = np.random.default_rng(a.seed)


def fourier_noise(n, kmax, count, beta, seed, aspect=1):
    """periodic noise on an n x n grid (x period = the sheet; y only smooth)"""
    r = np.random.default_rng(seed)
    t = (np.arange(n, dtype=np.float32) + 0.5) / n
    x, y = np.meshgrid(t, t)
    acc = np.zeros((n, n), np.float32)
    for _ in range(count):
        kx, ky = r.integers(-kmax, kmax + 1, 2)
        if kx == 0 and ky == 0:
            continue
        acc += (1.0 / (math.hypot(kx, ky) ** beta)) * np.cos(2 * np.pi * (kx * x + ky * y * aspect) + r.uniform(0, 2 * np.pi)).astype(np.float32)
    acc -= acc.min()
    return acc / max(1e-6, acc.max())


def upsample(a2, n):
    m = a2.shape[0]
    t = (np.arange(n, dtype=np.float32) + 0.5) * m / n - 0.5
    i0 = np.floor(t).astype(np.int64)
    f = (t - i0).astype(np.float32)
    i0 %= m
    i1 = (i0 + 1) % m
    rows = a2[i0] * (1 - f)[:, None] + a2[i1] * f[:, None]
    return rows[:, i0] * (1 - f)[None, :] + rows[:, i1] * f[None, :]


def blur_x_periodic(img, r):
    out = img.copy()
    for k in range(1, r + 1):
        out += np.roll(img, k, 1) + np.roll(img, -k, 1)
    return out / (2 * r + 1)


def blur(img, r):
    b = blur_x_periodic(img, r)
    p = np.pad(b, ((r, r), (0, 0)), mode='edge')
    out = np.zeros_like(b)
    for k in range(2 * r + 1):
        out += p[k:k + b.shape[0]]
    return out / (2 * r + 1)


# ---------------------------------------------------------------------------- the rows

X = (np.arange(N, dtype=np.float32) + 0.5) / PXM          # metres along U
Y = (np.arange(N, dtype=np.float32) + 0.5) / PXM          # metres along V (row 0 = bottom)
XX, YY = np.meshgrid(X, Y)
H = np.zeros((N, N), np.float32)                          # height (m), 0 = face plane
JOINT = np.zeros((N, N), np.float32)                      # joints / cracks / carvings (cavity)
FRESH = np.zeros((N, N), np.float32)                      # chips (lighter fresh stone)
TINT = np.ones((N, N), np.float32)                        # per stone tint
SOOT = np.zeros((N, N), np.float32)
ROWMASK = {}


def per_course_blocks(y0, y1, lmin, lmax, seed):
    """split [0, 8) into blocks of random length (exactly periodic); returns sorted cut positions incl. 0"""
    r = np.random.default_rng(seed)
    cuts = [0.0]
    while cuts[-1] < SZ - lmin:
        cuts.append(cuts[-1] + r.uniform(lmin, lmax))
    cuts[-1] = SZ
    k = SZ / cuts[-1]
    off = r.uniform(0, SZ)
    return [(c * k + off) % SZ for c in cuts[:-1]]


def dist_to_cuts(x, cuts):
    """periodic distance from x to the nearest cut, and the block index"""
    c = np.array(sorted(cuts), np.float32)
    d = np.abs(x[..., None] - c[None, :])
    d = np.minimum(d, SZ - d)
    return d.min(-1), d.argmin(-1)


def block_local(x, cuts):
    """periodic block index, position from the block start and block length for x (cuts sorted, periodic)"""
    c = np.array(sorted(cuts), np.float32)
    k = np.searchsorted(c, x, side='right') - 1          # -1 = before the first cut: wraps to the last block
    k = np.where(k < 0, len(c) - 1, k)
    start = c[k]
    nxt = np.where(k + 1 < len(c), c[(k + 1) % len(c)], c[0] + SZ)
    u = (x - start) % SZ
    return k, u, (nxt - start) % SZ + (nxt - start == 0) * SZ


WOB = None


def wobble():
    """two periodic noise fields (m) that make joints, arrises and chips irregular"""
    global WOB
    if WOB is None:
        WOB = (upsample(fourier_noise(256, 48, 90, 0.8, a.seed + 90), N) - 0.5, upsample(fourier_noise(256, 48, 90, 0.8, a.seed + 91), N) - 0.5,
               upsample(fourier_noise(128, 16, 60, 0.9, a.seed + 92), N))
    return WOB


def masonry(y0, y1, courses, lmin, lmax, joint_w, joint_d, pillow, seed, chips_per_m=1.4, cracks=6):
    """dressed blocks in [y0, y1): wobbly joints, worn irregular arrises, pillow faces, shaped chips along the arrises,
    spalled pockets, cracks, per-block tint, soot / water streaks"""
    r = np.random.default_rng(seed)
    sel = (YY >= y0) & (YY < y1)
    ch = (y1 - y0) / courses
    w1, w2, low = wobble()
    for k in range(courses):
        cy0, cy1 = y0 + k * ch, y0 + (k + 1) * ch
        m = (YY >= cy0) & (YY < cy1)
        cuts = per_course_blocks(cy0, cy1, lmin, lmax, seed * 31 + k)
        xs, ys = XX[m], YY[m]
        bid, u, blen = block_local(xs, cuts)
        # irregular joint lines: distances perturbed by noise (a few mm to 2 cm)
        dx = np.minimum(u, blen - u) + 0.012 * w1[m]
        dy = np.minimum(ys - cy0, cy1 - ys) + 0.010 * w2[m]
        d = np.minimum(dx, dy)
        jw = joint_w * (0.7 + 0.8 * low[m])
        jprof = 1 - K.smoothstep(0.0, jw, d)
        # worn arris: the edge rounds off over 1-6 cm, varying along the edge
        wear_w = joint_w * (1.5 + 4.0 * K.smoothstep(0.3, 0.8, low[m]))
        bevel = (1 - K.smoothstep(0.0, wear_w, d)) ** 1.5
        nb = len(cuts)
        tilt = r.uniform(-0.006, 0.006, (nb, 2))
        tint = r.uniform(0.82, 1.15, nb)
        ny = np.clip(dy / (ch * 0.5), 0, 1)
        nx = np.clip(dx / 0.35, 0, 1)
        h = -joint_d * jprof - 0.018 * bevel + pillow * (np.sqrt(nx * ny) - 0.5) + tilt[bid, 0] * (u - blen / 2) + tilt[bid, 1] * (ys - (cy0 + cy1) / 2)
        H[m] += h
        JOINT[m] = np.maximum(JOINT[m], np.maximum(jprof, 0.35 * bevel))
        TINT[m] *= tint[bid]
        # soot / water streaks: from each course's top joint downwards, long, uneven
        s1 = fourier_noise(256, 60, 80, 0.5, seed * 7 + k)[0]
        prof = np.interp(xs / SZ * 256, np.arange(257), np.r_[s1, s1[:1]])
        fall = np.exp(-(cy1 - ys) / (ch * 1.2))
        SOOT[m] = np.maximum(SOOT[m], K.smoothstep(0.45, 0.8, prof) * fall * r.uniform(0.6, 1.0))
        # chips along the arrises: noise-shaped, elongated along the edge, deepest at the arris
        for _ in range(int(chips_per_m * SZ * (1 + 0.5 * k / courses))):
            vert = r.uniform() < 0.45
            if vert:
                cx, cyy = cuts[r.integers(nb)], r.uniform(cy0, cy1)
                rx, ry = r.uniform(0.03, 0.08), r.uniform(0.06, 0.18)
            else:
                cx, cyy = r.uniform(0, SZ), (cy0 if r.uniform() < 0.5 else cy1)
                rx, ry = r.uniform(0.06, 0.2), r.uniform(0.03, 0.08)
            dep = r.uniform(0.015, 0.045)
            ddx = xs - cx
            ddx = (ddx + SZ / 2) % SZ - SZ / 2
            dd = np.hypot(ddx / rx, (ys - cyy) / ry) * (1 + 0.6 * w1[m] + 0.3 * w2[m])
            inside = dd < 1
            if not inside.any():
                continue
            f = np.where(inside, dep * np.clip((1 - dd) * 1.6, 0, 1) ** 0.8 * (0.7 + 0.6 * (w2[m] + 0.5)) + 0.003, 0)
            H[m] -= f.astype(np.float32)
            FRESH[m] = np.maximum(FRESH[m], np.where(inside, 0.4 + 0.6 * (1 - dd), 0))
    # cracks: random walks across the row
    for _ in range(cracks):
        x, y = r.uniform(0, SZ), r.uniform(y0, y1)
        ang = r.uniform(0, 2 * np.pi)
        L = r.uniform(0.4, 1.4)
        pts = []
        for _s in range(40):
            pts.append((x, y))
            ang += r.normal(0, 0.35)
            x = (x + math.cos(ang) * L / 40) % SZ
            y = min(max(y + math.sin(ang) * L / 40, y0), y1)
        for (xa, ya), (xb, yb) in zip(pts, pts[1:]):
            if abs(xb - xa) > SZ / 2:
                continue
            cx, cyy = (xa + xb) / 2, (ya + yb) / 2
            i0, i1 = int((cyy - 0.05) * PXM), int((cyy + 0.05) * PXM)
            j0, j1 = int((cx - 0.05) * PXM), int((cx + 0.05) * PXM)
            jj = np.arange(j0, j1) % N
            ii = np.clip(np.arange(i0, i1), 0, N - 1)
            sx, sy = np.meshgrid(X[jj], Y[ii])
            vx, vy = xb - xa, yb - ya
            ll = max(1e-6, vx * vx + vy * vy)
            t = np.clip(((sx - xa) * vx + (sy - ya) * vy) / ll, 0, 1)
            dd = np.hypot(sx - (xa + t * vx), sy - (ya + t * vy))
            g = 1 - K.smoothstep(0.0, 0.006, dd)
            H[np.ix_(ii, jj)] -= 0.012 * g
            JOINT[np.ix_(ii, jj)] = np.maximum(JOINT[np.ix_(ii, jj)], g)
    ROWMASK[seed] = sel


def moulding(y0, y1, seed):
    """cornice profile (V only) cut into stones; returns nothing (writes H, JOINT)"""
    r = np.random.default_rng(seed)
    m = (YY >= y0) & (YY < y1)
    t = (YY[m] - y0) / (y1 - y0)
    # profile (m, outward positive): base fillet, cyma recta, corona, top fillet, then the soffit shadow line
    prof = np.interp(t, [0, 0.08, 0.1, 0.32, 0.36, 0.42, 0.62, 0.66, 0.78, 0.82, 0.95, 1.0],
                     [0.0, 0.0, 0.015, 0.035, 0.035, 0.055, 0.06, 0.03, 0.03, 0.045, 0.045, 0.02])
    cyma = 0.02 * np.sin(np.clip((t - 0.1) / 0.22, 0, 1) * np.pi) ** 2
    H[m] += (prof + cyma - 0.04).astype(np.float32)
    grooves = np.zeros_like(t)
    for tc in (0.09, 0.36, 0.64, 0.8):
        grooves = np.maximum(grooves, 1 - K.smoothstep(0.0, 0.012, np.abs(t - tc)))
    JOINT[m] = np.maximum(JOINT[m], 0.6 * grooves)
    cuts = per_course_blocks(y0, y1, 1.2, 1.6, seed)
    dx, bid = dist_to_cuts(XX[m], cuts)
    j = 1 - K.smoothstep(0.0, 0.01, dx)
    H[m] -= 0.02 * j
    JOINT[m] = np.maximum(JOINT[m], j)
    TINT[m] *= r.uniform(0.88, 1.1, len(cuts))[bid]
    # chips on the projecting edges (t around the corona)
    for _ in range(26):
        cx, ct = r.uniform(0, SZ), r.choice([0.42, 0.62, 0.82, 0.95])
        rad, dep = r.uniform(0.04, 0.12), r.uniform(0.015, 0.04)
        ddx = np.abs(XX[m] - cx)
        ddx = np.minimum(ddx, SZ - ddx)
        dd = np.hypot(ddx, (t - ct) * (y1 - y0)) / rad
        f = np.where(dd < 1, dep * (1 - dd) ** 0.7, 0)
        H[m] -= f.astype(np.float32)
        FRESH[m] = np.maximum(FRESH[m], np.where(dd < 1, 1 - dd ** 3, 0))
    SOOT[m] = np.maximum(SOOT[m], 0.5 * K.smoothstep(0.6, 0.0, t) * K.smoothstep(0.5, 0.8, upsample(fourier_noise(128, 24, 40, 0.7, seed + 3), N)[m]))


RUNES = [
    [(0, -1, 0, 1), (0, 1, 0.8, 0.45), (0, 0.4, 0.8, -0.1)], [(0, -1, 0, 1), (0, 1, 0.75, 0.3), (0.75, 0.3, 0.75, -1)],
    [(0, -1, 0, 1), (0, 0.55, 0.65, 0), (0.65, 0, 0, -0.55)], [(-0.6, -1, -0.6, 1), (-0.6, 1, 0.6, 0.5), (0.6, 0.5, -0.6, 0), (-0.6, 0, 0.6, -1)],
    [(0.6, 1, -0.4, 0), (-0.4, 0, 0.6, -1)], [(-0.7, 1, 0.7, -1), (0.7, 1, -0.7, -1)], [(-0.6, -1, -0.6, 1), (0.6, -1, 0.6, 1), (-0.6, 0.5, 0.6, 0.0)],
    [(0, -1, 0, 1), (-0.6, 0.2, 0, 0.6), (0, -0.6, 0.6, -0.2)], [(0, -1, 0, 1), (0, 0.2, -0.7, 0.9), (0, 0.2, 0.7, 0.9)],
    [(-0.5, 1, 0.5, 0.35), (0.5, 0.35, -0.5, -0.3), (-0.5, -0.3, 0.5, -1)], [(0, -1, 0, 1), (0, 1, -0.6, 0.45), (0, 1, 0.6, 0.45)],
    [(-0.7, -1, -0.7, 1), (0.7, -1, 0.7, 1), (-0.7, 1, 0.7, 0.2), (0.7, 1, -0.7, 0.2)], [(-0.7, 1, 0.7, -1), (0.7, 1, -0.7, -1), (-0.7, 1, -0.7, -1), (0.7, 1, 0.7, -1)],
]


def frieze(y0, y1, seed):
    r = np.random.default_rng(seed)
    m = (YY >= y0) & (YY < y1)
    t = (YY[m] - y0) / (y1 - y0)
    band = np.interp(t, [0, 0.06, 0.1, 0.16, 0.2, 0.8, 0.84, 0.9, 0.94, 1.0], [0, 0, 0.025, 0.025, 0, 0, 0.025, 0.025, 0, 0])
    H[m] += band.astype(np.float32)
    # runes in the field (0.2..0.8), one every ~0.4 m, carved 1.5 cm, worn by noise
    sub = H[m]
    jm = JOINT[m]
    xs = XX[m]
    ys = YY[m]
    carve = np.zeros_like(sub)
    nglyph = int(SZ / 0.4)
    gh = (y1 - y0) * 0.26
    for k in range(nglyph):
        cx = (k + 0.5) * SZ / nglyph
        cyy = y0 + (y1 - y0) * 0.5
        segs = RUNES[r.integers(len(RUNES))]
        ddx = xs - cx
        ddx = (ddx + SZ / 2) % SZ - SZ / 2
        loc = (np.abs(ddx) < gh * 1.2) & (np.abs(ys - cyy) < gh * 1.2)
        if not loc.any():
            continue
        u = ddx[loc] / (gh * 0.6)
        v = (ys[loc] - cyy) / gh
        dmin = np.full(u.shape, 9.0, np.float32)
        for (u0, v0, u1, v1) in segs:
            vx, vy = u1 - u0, v1 - v0
            ll = max(1e-6, vx * vx + vy * vy)
            tt = np.clip(((u - u0) * vx + (v - v0) * vy) / ll, 0, 1)
            dmin = np.minimum(dmin, np.hypot((u - (u0 + tt * vx)) * gh * 0.6, (v - (v0 + tt * vy)) * gh))
        g = 1 - K.smoothstep(0.012, 0.022, dmin)
        carve[loc] = np.maximum(carve[loc], g * r.uniform(0.5, 1.0))
    wear = K.smoothstep(0.3, 0.6, upsample(fourier_noise(128, 20, 40, 0.8, seed + 1), N)[m])
    carve *= 0.45 + 0.55 * wear
    H[m] = sub - 0.015 * carve
    JOINT[m] = np.maximum(jm, carve)
    cuts = per_course_blocks(y0, y1, 1.1, 1.5, seed + 2)
    dx, bid = dist_to_cuts(xs, cuts)
    j = 1 - K.smoothstep(0.0, 0.01, dx)
    H[m] -= 0.02 * j
    JOINT[m] = np.maximum(JOINT[m], j)
    TINT[m] *= r.uniform(0.9, 1.08, len(cuts))[bid]


def rough(y0, y1, seed):
    """fractured stone: faceted Worley-like planes (2D, periodic in U) + noise"""
    r = np.random.default_rng(seed)
    m = (YY >= y0) & (YY < y1)
    nf = 90
    fx, fy = r.uniform(0, SZ, nf), r.uniform(y0 - 0.2, y1 + 0.2, nf)
    sl = r.normal(0, 0.2, (nf, 2))
    off = r.uniform(-0.06, 0.03, nf)
    xs, ys = XX[m], YY[m]
    best = np.full(xs.shape, 9.0, np.float32)
    best2 = np.full(xs.shape, 9.0, np.float32)
    hb = np.zeros_like(xs)
    for k in range(nf):
        ddx = xs - fx[k]
        ddx = (ddx + SZ / 2) % SZ - SZ / 2
        d = np.hypot(ddx, ys - fy[k])
        hk = off[k] + sl[k, 0] * ddx + sl[k, 1] * (ys - fy[k])
        closer = d < best
        best2 = np.where(closer, best, np.minimum(best2, d))
        hb = np.where(closer, hk, hb)
        best = np.minimum(best, d)
    edge = 1 - K.smoothstep(0.0, 0.02, best2 - best)
    nz = upsample(fourier_noise(256, 60, 80, 0.7, seed + 1), N)[m] - 0.5
    H[m] += (np.clip(hb, -0.09, 0.05) - 0.015 * edge + 0.03 * nz).astype(np.float32)
    JOINT[m] = np.maximum(JOINT[m], 0.7 * edge)
    FRESH[m] = np.maximum(FRESH[m], 0.35 * K.smoothstep(0.0, 0.04, hb))


def compose_height():
    rows = K.TRIM_ROWS
    masonry(*rows['ashlar'], courses=4, lmin=0.7, lmax=1.5, joint_w=0.012, joint_d=0.025, pillow=0.008, seed=a.seed + 1, chips_per_m=4.0, cracks=8)
    masonry(*rows['blocks'], courses=2, lmin=1.0, lmax=2.0, joint_w=0.016, joint_d=0.035, pillow=0.02, seed=a.seed + 2, chips_per_m=4.5, cracks=10)
    moulding(*rows['moulding'], seed=a.seed + 3)
    frieze(*rows['frieze'], seed=a.seed + 4)
    rough(*rows['rough'], seed=a.seed + 5)
    masonry(*rows['plain'], courses=1, lmin=1.0, lmax=1.9, joint_w=0.01, joint_d=0.015, pillow=0.003, seed=a.seed + 6, chips_per_m=2.5, cracks=6)
    # surface: erosion + pits everywhere
    n1 = upsample(fourier_noise(256, 64, 120, 0.6, a.seed + 50), N) - 0.5
    n2 = upsample(fourier_noise(512, 200, 160, 0.4, a.seed + 51), N) - 0.5
    pits = K.smoothstep(0.75, 0.9, upsample(fourier_noise(512, 220, 200, 0.3, a.seed + 52), N))
    H[:] += (0.004 * n1 + 0.0018 * n2 - 0.004 * pits).astype(np.float32)
    # CC0 scan height (Poly Haven lichen_rock disp, tiles every 2 m) as micro relief: real weathered rock surface
    cc = abake.load_cc0(a.cc0, need=('disp',))
    im = bpy.data.images.load(cc['disp'], check_existing=False)
    im.colorspace_settings.name = 'Non-Color'
    im.scale(512, 512)
    dp = np.empty(512 * 512 * 4, np.float32)
    im.pixels.foreach_get(dp)
    bpy.data.images.remove(im)
    dp = dp.reshape(512, 512, 4)[..., 0]
    dp = (dp - dp.mean()) / max(1e-4, float(dp.std()))
    H[:] += (0.0035 * np.clip(np.tile(dp, (N // 512, N // 512)), -3, 3)).astype(np.float32)
    JOINT[:] = np.maximum(JOINT, 0.4 * pits)
    return {'hMin': float(H.min()), 'hMax': float(H.max())}


def normal_from_height():
    """OpenGL tangent normal (+x = +U, +y = +V) from the field; periodic in U, clamped at the row borders"""
    gx = (np.roll(H, -1, 1) - np.roll(H, 1, 1)) * (PXM / 2)
    gy = np.zeros_like(H)
    gy[1:-1] = (H[2:] - H[:-2]) * (PXM / 2)
    # no slope across row borders (rows are separate faces on the modules)
    for (y0, y1) in K.TRIM_ROWS.values():
        for yb in (y0, y1):
            i = int(round(yb * PXM))
            for k in (i - 1, i):
                if 0 <= k < N:
                    gy[k] = 0
    n = np.stack([-gx, -gy, np.ones_like(H)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n


def build_high():
    abake.reset()
    S['dev'] = abake.cycles_device(a.device, a.threads)
    S['h'] = compose_height()
    S['n'] = normal_from_height()
    # height image for the displacement (0..1 over the field's range)
    lo, hi = float(H.min()), float(H.max())
    S['hr'] = (lo, hi)
    hv = (H - lo) / (hi - lo)
    im = bpy.data.images.new('h', N, N, alpha=False, float_buffer=True)
    im.colorspace_settings.name = 'Non-Color'
    px = np.ones((N, N, 4), np.float32)
    px[..., 0] = px[..., 1] = px[..., 2] = hv
    im.pixels.foreach_set(px.ravel())
    tex = bpy.data.textures.new('h', 'IMAGE')
    tex.image = im
    tex.extension = 'REPEAT'
    gx = int(a.grid * 9 / 8)
    bpy.ops.mesh.primitive_grid_add(x_subdivisions=gx, y_subdivisions=a.grid, size=1.0)
    g = bpy.context.active_object
    g.name = 'high'
    g.scale = (9.0, 8.0, 1.0)
    g.location = (4.0, 4.0, 0.0)
    bpy.ops.object.transform_apply(location=True, scale=True)
    me = g.data
    co = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    vi = np.empty(len(me.loops), np.int64)
    me.loops.foreach_get('vertex_index', vi)
    me.uv_layers.active.data.foreach_set('uv', (co[vi, :2] / SZ).astype(np.float32).ravel())
    d = g.modifiers.new('disp', 'DISPLACE')
    d.texture = tex
    d.texture_coords = 'UV'
    d.mid_level = 0.0
    d.strength = hi - lo
    g.location.z = lo
    g.data.materials.append(K.material_plain('hi', (0.5, 0.5, 0.5)))
    bpy.ops.mesh.primitive_plane_add(size=SZ, location=(4.0, 4.0, 0.0))
    low = bpy.context.active_object
    low.name = 'low'
    low.data.materials.append(K.material_plain('bake_low', (0.5, 0.5, 0.5)))
    S['hi'], S['lo'] = g, low
    return {'height': S['h'], 'highTris': abake.tri_count(g), 'device': S['dev']}


def bake():
    s = bpy.context.scene
    s.render.bake.max_ray_distance = 0.3
    r = abake.bake_maps(S['lo'], S['hi'], ['AO'], N, job.out, samples=a.ao_samples, extrusion=0.12, margin=0, prefix='stone_trim')
    S['ao'] = K.load_np(r['AO']['path'])[..., 0]
    return {k: v['seconds'] for k, v in r.items()}


def to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def compose_maps():
    cc = abake.load_cc0(a.cc0, need=('diff', 'rough'))
    im = bpy.data.images.load(cc['diff'], check_existing=False)
    im.scale(512, 512)
    sc = np.empty(512 * 512 * 4, np.float32)
    im.pixels.foreach_get(sc)
    bpy.data.images.remove(im)
    sc = sc.reshape(512, 512, 4)[..., :3]
    lum = sc @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    lum = np.tile(lum / max(1e-4, float(lum.mean())), (N // 512, N // 512))
    det = np.clip(1.0 + 0.14 * (lum - 1.0) / max(1e-4, float(lum.std())), 0.7, 1.3)
    convex = np.clip((H - blur(H, 3)) / 0.004, 0, 1)
    cav = np.clip(np.maximum(JOINT, np.clip((blur(H, 6) - H) / 0.012, 0, 1)), 0, 1)
    ao = np.clip(S['ao'], 0, 1)
    big = upsample(fourier_noise(64, 6, 30, 1.0, a.seed + 70), N)
    tint = TINT * (0.9 + 0.2 * big)
    grime = upsample(fourier_noise(128, 30, 60, 0.7, a.seed + 71), N)
    f = det * tint * (1 - 0.65 * cav) * (1 + 0.35 * FRESH * (0.5 + 0.5 * convex)) * (1 + 0.15 * convex) * (1 - 0.7 * SOOT) * (0.8 + 0.4 * grime)
    alb = np.array(K.STONE_RGB, np.float32)[None, None, :] * f[..., None]
    # lichen / moss blotches (sparse, dark olive) in low spots
    lich = K.smoothstep(0.68, 0.8, upsample(fourier_noise(256, 50, 80, 0.6, a.seed + 72), N)) * (1 - FRESH) * 0.6
    alb = alb * (1 - lich[..., None]) + alb * np.array([0.7, 0.85, 0.55], np.float32) * lich[..., None]
    alb *= 1 + (TINT - 1.0)[..., None] * np.array([0.25, 0.05, -0.2], np.float32)
    rgh = np.clip(0.84 + 0.08 * cav - 0.06 * FRESH + 0.05 * SOOT - 0.04 * convex, 0.5, 0.97)
    out = {'baseColor': 'stone_trim_basecolor.png', 'normal': 'stone_trim_normal.png', 'orm': 'stone_trim_orm.png'}
    K.save_np(to_srgb(alb), os.path.join(job.out, out['baseColor']), non_color=False)
    K.save_np(S['n'] * 0.5 + 0.5, os.path.join(job.out, out['normal']))
    K.save_np(np.stack([ao * (1 - 0.25 * cav), rgh, np.zeros_like(ao)], -1), os.path.join(job.out, out['orm']))
    S['maps'] = out
    # seam check: U wrap continuity of every map (max difference between the first and last columns vs the inner mean)
    def seam(arr):
        a0 = arr[:, 0].astype(np.float64)
        a1 = arr[:, -1].astype(np.float64)
        inner = np.abs(np.diff(arr.astype(np.float64), axis=1)).mean()
        return round(float(np.abs(a0 - a1).mean() / max(1e-9, inner)), 3)
    S['seam'] = {'height': seam(H), 'albedo': seam(f), 'ao': seam(ao), 'normalX': seam(S['n'][..., 0])}
    return {**out, 'albedoMeanLinear': [round(float(x), 4) for x in alb.reshape(-1, 3).mean(0)], 'seamRatio(1 = like any inner column pair)': S['seam'],
            'aoMean': float(ao.mean())}


def export():
    abake.reset()
    mat = bpy.data.materials.new('stone_trim')
    mat.use_nodes = True
    bpy.ops.mesh.primitive_plane_add(size=1.0)
    q = bpy.context.active_object
    q.name = 'TEXSET'
    q.data.materials.append(mat)
    rows = {k: list(v) for k, v in K.TRIM_ROWS.items()}
    root = abake.empty('KIT_stone_trim', id='kit/stone_trim', role='texset', kind='trim', sizeM=SZ, rows=json.dumps(rows))
    q.parent = root
    glb = abake.export_glb(os.path.join(job.out, 'stone_trim_raw.glb'), objects=[root, q])
    asset = {
        'id': 'kit/stone_trim', 'glb': os.path.basename(glb['path']), 'role': 'texset', 'kind': 'trim',
        'texset': {'sizeM': SZ, 'px': N, 'rows': rows, 'channels': {'orm': 'R occlusion, G roughness, B 0'}},
        'lods': {'LOD0': {'materials': ['stone_trim']}, 'LOD1': {'materials': ['stone_trim'], 'ownTextures': False}},
        'materials': {'stone_trim': {**S['maps'], 'metallicFactor': 0.0, 'roughnessFactor': 1.0}},
        'sources': [a.cc0],
        'job': os.path.basename(job.out),
    }
    with open(os.path.join(job.out, 'asset.json'), 'w', encoding='utf-8') as f:
        json.dump(asset, f, indent=1)
    return {'glb': glb}


def preview():
    """the sheet lit at a grazing angle (one quad with the composed maps), for the README seam / artefact check"""
    abake.reset()
    s = bpy.context.scene
    bpy.ops.mesh.primitive_plane_add(size=SZ, location=(0, 0, 0))
    p = bpy.context.active_object
    p.rotation_euler = (math.radians(90), 0, 0)
    me = p.data
    me.uv_layers.active.data.foreach_set('uv', np.array([[0, 0], [1, 0], [1, 1], [0, 1]], np.float32).ravel())
    p.data.materials.append(K.textured_material('prev', job.out, S['maps']))
    s.render.engine = 'CYCLES'
    s.cycles.samples = 16
    s.render.resolution_x = s.render.resolution_y = 1024
    sd = bpy.data.lights.new('sun', 'SUN')
    sd.energy = 4
    so = K.link(bpy.data.objects.new('sun', sd))
    so.rotation_euler = (math.radians(20), math.radians(-55), 0)
    w = bpy.data.worlds.new('w')
    s.world = w
    w.use_nodes = True
    w.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.4
    cd = bpy.data.cameras.new('c')
    cd.type = 'ORTHO'
    cd.ortho_scale = SZ
    cam = K.link(bpy.data.objects.new('c', cd))
    cam.location = (0, -10, 0)
    cam.rotation_euler = (math.radians(90), 0, 0)
    s.camera = cam
    abake.image_settings('PNG', '8', 'RGB')
    s.view_settings.view_transform = 'AgX'
    return abake.render_still(os.path.join(job.out, 'stone_trim_preview.png'))


job.step('build_high', build_high)
job.step('bake', bake)
job.step('compose', compose_maps)
job.step('export', export)
job.step('preview', preview)
fails = [r['step'] for r in job.steps if not r['ok']]
job.result['failed'] = fails
job.done()
if fails:
    sys.exit(1)
