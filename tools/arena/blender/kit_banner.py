"""A4 banners (arena art plan 5.2 "Banners (vertical, swag, pole) x 8 sigils": cloth sim + tear masks + 8-sigil atlas, vertex
sway in game). Target: docs/concept-art/ref-3..10 (tattered, heavy, dark-red banners with gold or bone-white sigils).

Geometry: Blender cloth simulation (pinned top, gravity, a light wind + turbulence field, settled over 60 frames, heavy cloth:
high bending stiffness) of
  BANNER_vertical  1.0 x 2.8 m, pinned along the top edge (hangs from a rod / a pole's crossbar); origin at the top centre
  BANNER_swag      2.6 m of cloth hung between two points 2.2 m apart (a sagging swag along a chain); origin at the top centre
  ROD              iron rod with end knobs for wall banners (constant material: no texture)
LOD1 = every other grid vertex of the same simulated cloth. The cloth stays a grid with (u, v) = (across, down) so the game's
vertex sway (src/render/arena/cloth.ts) can bend it by its hang depth (-y) without a CPU loop.

Atlas (numpy, 2048 x 2048 RGBA; normal + ORM at 1024): 8 vertical cells 512 x 768 (4 x 2, top) + 2 swag cells 1024 x 512
(bottom row). Each cell: crimson / oxblood cloth (fbm variation, vertical weathering streaks, sun-bleached blotches), gold
trim bands, a gold or bone-white embroidered SIGIL (claw, sun, moon, horned skull, eye, flame, crossed swords, rune ring)
with a dark stitched outline and worn-off thread, dirt and mud rising from the bottom, burn holes with charred rims, and the
TEAR MASK in alpha: a shredded bottom (ribbons of different lengths between long slits), a ragged frayed edge, holes.
Normal: weave + raised embroidery + hems. ORM: AO 1 (folds come from the geometry), roughness cloth 0.9 / gold 0.4, metal gold.
glTF UVs: cell k at u + (k % 4) * 0.25, v + (k // 4) * 0.375 (the mesh is authored on cell 0); swag cell s at u + s * 0.5.
"""
import json
import math
import os
import random
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import abake  # noqa: E402
import stonekit as K  # noqa: E402


def extra(ap):
    ap.add_argument('--atlas', type=int, default=2048)
    ap.add_argument('--frames', type=int, default=60)
    ap.add_argument('--preview', type=int, default=1)


job = abake.Job(extra, __doc__)
a = job.a
ID = 'banners'
S = {}
VW, VH = 1.0, 2.8          # vertical banner (m)
SW, SH, SPAN = 2.6, 1.0, 2.2  # swag cloth width, drop, pin distance
NV = (10, 28)              # LOD0 grid (across, down) of the vertical banner
NS = (26, 10)


# ============================================================================ cloth

def grid(name, nx, ny, top, depth, uvf, pleats=0, pleat_amp=0.0, seed=0):
    """grid of (nx+1) x (ny+1) verts; top(s) -> (x, z) of the top edge at s in [0,1]; each column hangs `depth` straight down.
    uvf(s, t) -> Blender UV. Vertex group 'pin' holds the pinned top verts (chosen by the caller via pin(s))."""
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new('UVMap')
    V = []
    rng = random.Random(seed)
    ph = [rng.uniform(0, 6.28) for _ in range(3)]
    for j in range(ny + 1):
        t = j / ny
        row = []
        for i in range(nx + 1):
            s = i / nx
            x, z = top(s)
            # starting folds (pleats gathered at the rod, opening downwards): the sim settles them into a heavy drape
            a = pleat_amp * (0.35 + 0.65 * t)
            y = a * (math.sin(2 * math.pi * s * pleats + ph[0]) + 0.4 * math.sin(2 * math.pi * s * pleats * 2.3 + ph[1] + t * 2.0)) if pleats else 0.0
            row.append(bm.verts.new((x, y, z - depth * t)))
        V.append(row)
    for j in range(ny):
        for i in range(nx):
            f = bm.faces.new((V[j][i], V[j + 1][i], V[j + 1][i + 1], V[j][i + 1]))
            for lp, (ii, jj) in zip(f.loops, ((i, j), (i, j + 1), (i + 1, j + 1), (i + 1, j))):
                lp[uvl].uv = uvf(ii / nx, jj / ny)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    K.link(o)
    return o


def simulate(o, nx, ny, pin_idx, frames, wind=1.5):
    vg = o.vertex_groups.new(name='pin')
    vg.add(pin_idx, 1.0, 'REPLACE')
    m = o.modifiers.new('cloth', 'CLOTH')
    cs = m.settings
    cs.quality = 8
    cs.mass = 0.6
    cs.tension_stiffness = cs.compression_stiffness = 60
    cs.shear_stiffness = 30
    cs.bending_stiffness = 6.0  # heavy, stiff cloth (thick woven wool, embroidered)
    cs.air_damping = 3.0
    cs.vertex_group_mass = 'pin'
    try:
        cs.effector_weights.wind = 1.0
        cs.effector_weights.turbulence = 1.0
    except Exception:
        pass
    m.point_cache.frame_start = 1
    m.point_cache.frame_end = frames
    s = bpy.context.scene
    s.frame_start, s.frame_end = 1, frames
    for f in range(1, frames + 1):
        s.frame_set(f)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
    o.modifiers.clear()
    old = o.data
    o.data = me
    bpy.data.meshes.remove(old)
    me.polygons.foreach_set('use_smooth', [True] * len(me.polygons))
    return o


def fields():
    try:
        bpy.ops.object.effector_add(type='WIND', location=(0, -3, -1), rotation=(-math.pi / 2, 0, 0))
        w = bpy.context.active_object
        w.field.strength = 5.0
        w.field.noise = 2.5
        w.field.flow = 0.4
        bpy.ops.object.effector_add(type='TURBULENCE', location=(0.3, 0.2, -1.2))
        t = bpy.context.active_object
        t.field.strength = 6.0
        t.field.size = 0.5
        return 'wind + turbulence'
    except Exception as ex:
        return f'no fields: {ex}'


def decimate_grid(src, name, nx, ny):
    """LOD1: every other row / column of the simulated grid (same UVs)"""
    me = src.data
    uv = me.uv_layers.active.data
    co = [v.co.copy() for v in me.vertices]
    # vertex index = j * (nx + 1) + i (creation order)
    vuv = {}
    for p in me.polygons:
        for li, vi in zip(p.loop_indices, p.vertices):
            vuv[vi] = uv[li].uv.copy()
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new('UVMap')
    nx2, ny2 = nx // 2, ny // 2
    V = [[bm.verts.new(co[(2 * j) * (nx + 1) + 2 * i]) for i in range(nx2 + 1)] for j in range(ny2 + 1)]
    for j in range(ny2):
        for i in range(nx2):
            f = bm.faces.new((V[j][i], V[j + 1][i], V[j + 1][i + 1], V[j][i + 1]))
            for lp, (ii, jj) in zip(f.loops, ((i, j), (i, j + 1), (i + 1, j + 1), (i + 1, j))):
                lp[uvl].uv = vuv[(2 * jj) * (nx + 1) + 2 * ii]
    m2 = bpy.data.meshes.new(name)
    bm.to_mesh(m2)
    bm.free()
    m2.polygons.foreach_set('use_smooth', [True] * len(m2.polygons))
    o = bpy.data.objects.new(name, m2)
    K.link(o)
    return o


def build():
    abake.reset()
    abake.cycles_device('CPU', a.threads)
    S['fields'] = fields()
    # vertical: cell 0 = u [0, 0.25], v (Blender, up) [1 - 0.375, 1], top of the banner at v = 1
    v = grid('BANNER_vertical', *NV, lambda s: ((s - 0.5) * VW, 0.0), VH, lambda s, t: (s * 0.25, 1.0 - t * 0.375), pleats=2.5, pleat_amp=0.085, seed=1)
    simulate(v, *NV, list(range(NV[0] + 1)), a.frames)
    # swag: the top edge starts as a sagging arc of length SW between pins SPAN apart; only the corner columns are pinned
    sag = math.sqrt(max(0.0, (SW / 2) ** 2 - (SPAN / 2) ** 2)) * 0.9

    def top(s):
        x = (s - 0.5) * SPAN
        return x, -sag * (1 - (2 * s - 1) ** 2)
    sw = grid('BANNER_swag', *NS, top, SH, lambda s, t: (s * 0.5, 0.25 - t * 0.25), pleats=4, pleat_amp=0.06, seed=2)
    pins = [0, 1, NS[0] - 1, NS[0]]
    simulate(sw, *NS, pins, a.frames)
    lod1 = {'BANNER_vertical': decimate_grid(v, 'BANNER_vertical_l1', *NV), 'BANNER_swag': decimate_grid(sw, 'BANNER_swag_l1', *NS)}
    # rod (wall banners hang from it), constant iron material
    bm = bmesh.new()
    K.lathe(bm, [(0.0, -0.62), (0.03, -0.62), (0.045, -0.6), (0.03, -0.57), (0.02, -0.56), (0.02, 0.56), (0.03, 0.57), (0.045, 0.6), (0.03, 0.62), (0.0, 0.62)], 8)
    rod = K.to_object('ROD', bm, smooth=True)
    rod.data.transform(__import__('mathutils').Matrix.Translation((0, 0, 0.025)) @ __import__('mathutils').Matrix.Rotation(math.pi / 2, 4, 'Y'))
    bm = bmesh.new()
    K.lathe(bm, [(0.0, -0.62), (0.03, -0.62), (0.03, 0.62), (0.0, 0.62)], 5)
    rod1 = K.to_object('ROD_l1', bm, smooth=True)
    rod1.data.transform(__import__('mathutils').Matrix.Translation((0, 0, 0.025)) @ __import__('mathutils').Matrix.Rotation(math.pi / 2, 4, 'Y'))
    S['lod'] = {0: {'BANNER_vertical': v, 'BANNER_swag': sw, 'ROD': rod}, 1: {**lod1, 'ROD': rod1}}
    b = abake.bounds([v])
    bs = abake.bounds([sw])
    pin_err = max(abs(v.data.vertices[i].co.z) for i in range(NV[0] + 1))
    return {'fields': S['fields'], 'vertical': {k: round(x, 3) for k, x in b.items()}, 'swag': {k: round(x, 3) for k, x in bs.items()}, 'pinErr': pin_err,
            'tris': {lod: {k: sum(len(p.vertices) - 2 for p in o.data.polygons) for k, o in d.items()} for lod, d in S['lod'].items()}}


# ============================================================================ atlas (numpy)

def fbm2(X, Y, octaves=4, seed=0, scale=1.0):
    P = np.stack([X.ravel() * scale, Y.ravel() * scale, np.full(X.size, seed * 3.7)], -1)
    return K.fbm3(P, octaves, seed).reshape(X.shape)


def blur(m, r):
    """box blur radius r px (separable, cumulative sums)"""
    if r <= 0:
        return m
    out = m.astype(np.float32)
    for ax in (0, 1):
        pad = [(0, 0), (0, 0)]
        pad[ax] = (r + 1, r)
        c = np.cumsum(np.pad(out, pad, mode='edge'), axis=ax)
        n = out.shape[ax]
        hi = np.take(c, np.arange(2 * r + 1, 2 * r + 1 + n), axis=ax)
        lo = np.take(c, np.arange(0, n), axis=ax)
        out = (hi - lo) / (2 * r + 1)
    return out


def dilate(m, r):
    out = m.copy()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            if dx * dx + dy * dy <= r * r:
                out = np.maximum(out, np.roll(np.roll(m, dy, 0), dx, 1))
    return out


def circ(X, Y, cx, cy, r):
    return np.hypot(X - cx, Y - cy) < r


def crescent(X, Y, c, r, off, r2):
    return circ(X, Y, c[0], c[1], r) & ~circ(X, Y, c[0] + off[0], c[1] + off[1], r2)


def rbox(X, Y, cx, cy, hw, hh, ang):
    ca, sa = math.cos(ang), math.sin(ang)
    u = (X - cx) * ca + (Y - cy) * sa
    v = -(X - cx) * sa + (Y - cy) * ca
    return (np.abs(u) < hw) & (np.abs(v) < hh)


def tri(X, Y, p0, p1, p2):
    def side(a, b):
        return (b[0] - a[0]) * (Y - a[1]) - (b[1] - a[1]) * (X - a[0])
    s0, s1, s2 = side(p0, p1), side(p1, p2), side(p2, p0)
    return ((s0 >= 0) & (s1 >= 0) & (s2 >= 0)) | ((s0 <= 0) & (s1 <= 0) & (s2 <= 0))


def sigil(kind, X, Y):
    """boolean mask of a sigil in sigil space ([-1, 1], Y up)"""
    R = np.hypot(X, Y)
    A = np.arctan2(Y, X)
    if kind == 'claw':
        # three curved claw slashes, raked diagonally
        ca, sa = math.cos(-0.45), math.sin(-0.45)
        Xr, Yr = X * ca - Y * sa, X * sa + Y * ca
        m = np.zeros_like(X, bool)
        for i, dx in enumerate((-0.42, 0.0, 0.42)):
            L = 0.95 - abs(dx) * 0.35
            m |= crescent(Xr, Yr, (dx - 0.95, -0.05), 1.0, (-0.13, 0.03), 0.965) & (np.abs(Yr + 0.05) < L)
        return m
    if kind == 'sun':
        m = (R < 0.3) | ((R > 0.36) & (R < 0.43))
        for k in range(12):
            a0 = k * math.pi / 6
            d = np.angle(np.exp(1j * (A - a0)))
            w = 0.16 * np.clip((0.95 - R) / 0.45, 0, 1)
            m |= (R > 0.48) & (R < 0.95) & (np.abs(d) < w * (1.0 if k % 2 == 0 else 0.7)) & (R < (0.95 if k % 2 == 0 else 0.78))
        return m
    if kind == 'moon':
        m = crescent(X, Y, (-0.08, 0.0), 0.72, (0.32, 0.14), 0.62)
        sx, sy = X - 0.42, Y - 0.42
        m |= (np.sqrt(np.abs(sx)) + np.sqrt(np.abs(sy))) < math.sqrt(0.2)
        sx, sy = X - 0.55, Y + 0.05
        m |= (np.sqrt(np.abs(sx)) + np.sqrt(np.abs(sy))) < math.sqrt(0.09)
        return m
    if kind == 'skull':
        m = circ(X, Y, 0, 0.05, 0.42) | rbox(X, Y, 0, -0.38, 0.25, 0.16, 0.0)
        m &= ~circ(X, Y, 0.17, 0.0, 0.12) & ~circ(X, Y, -0.17, 0.0, 0.12)
        m &= ~tri(X, Y, (-0.06, -0.24), (0.06, -0.24), (0.0, -0.12))
        for x in (-0.15, -0.05, 0.05, 0.15):
            m &= ~rbox(X, Y, x, -0.45, 0.018, 0.1, 0.0)
        for sgn in (-1, 1):
            m |= crescent(X, Y, (sgn * 0.62, 0.22), 0.42, (sgn * 0.06, -0.16), 0.38) & (Y > 0.22) & (np.abs(X) > 0.25)
        return m
    if kind == 'eye':
        t = tri(X, Y, (-0.9, -0.62), (0.9, -0.62), (0.0, 0.92))
        ti = tri(X, Y, (-0.7, -0.5), (0.7, -0.5), (0.0, 0.69))
        m = t & ~ti
        almond = circ(X, Y, 0, -0.45, 0.62) & circ(X, Y, 0, 0.27, 0.62)
        m |= almond & ~(circ(X, Y, 0, -0.45, 0.55) & circ(X, Y, 0, 0.27, 0.55))
        m |= circ(X, Y, 0, -0.08, 0.13)
        return m
    if kind == 'flame':
        def drop(cx, cy, s):
            return circ(X, Y, cx, cy, 0.34 * s) | tri(X, Y, (cx - 0.31 * s, cy + 0.12 * s), (cx + 0.31 * s, cy + 0.12 * s), (cx + 0.12 * s, cy + 1.05 * s))
        m = drop(0.0, -0.35, 1.0) | drop(-0.42, -0.5, 0.6) | drop(0.42, -0.5, 0.6)
        m &= ~drop(0.03, -0.42, 0.55)
        return m
    if kind == 'swords':
        m = np.zeros_like(X, bool)
        for sgn in (-1, 1):
            ang = sgn * math.radians(38)
            m |= rbox(X, Y, 0, 0.05, 0.055, 0.82, ang)
            gx, gy = -math.sin(ang) * -0.55, math.cos(ang) * -0.55
            m |= rbox(X, Y, gx, gy + 0.05, 0.26, 0.04, ang)
            px, py = -math.sin(ang) * -0.85, math.cos(ang) * -0.85
            m |= circ(X, Y, px, py + 0.05, 0.08)
        m |= (R > 0.18) & (R < 0.26)
        return m
    # 'ring': the Moon Gate rune ring
    m = ((R > 0.66) & (R < 0.8)) | ((R > 0.34) & (R < 0.41)) | (R < 0.12)
    rng = random.Random(4)
    for k in range(14):
        a0 = k * 2 * math.pi / 14
        L = rng.uniform(0.06, 0.1)
        cx, cy = 0.53 * math.cos(a0), 0.53 * math.sin(a0)
        m |= rbox(X, Y, cx, cy, 0.018, L, a0)
        if k % 2:
            m |= rbox(X, Y, cx + 0.03 * math.cos(a0 + 1.5), cy + 0.03 * math.sin(a0 + 1.5), 0.04, 0.014, a0)
    return m


DESIGNS = [  # sigil, cloth (linear), thread (linear), metallic thread; ref-3: deep maroon-crimson (#5a1020 .. #8a1a2a)
    ('claw', (0.13, 0.012, 0.022), (0.55, 0.36, 0.1), True),
    ('sun', (0.1, 0.01, 0.018), (0.55, 0.36, 0.1), True),
    ('moon', (0.075, 0.01, 0.016), (0.5, 0.46, 0.37), False),
    ('skull', (0.12, 0.011, 0.02), (0.5, 0.46, 0.37), False),
    ('eye', (0.14, 0.013, 0.024), (0.55, 0.36, 0.1), True),
    ('flame', (0.09, 0.01, 0.016), (0.55, 0.36, 0.1), True),
    ('swords', (0.115, 0.011, 0.02), (0.5, 0.33, 0.1), True),
    ('ring', (0.13, 0.012, 0.022), (0.55, 0.36, 0.1), True),
]


def paint_cell(w, h, W, H, design, seed, swag=False):
    """one cell: (rgb, alpha, height, rough, metal) arrays (h, w), top-down; W, H in metres"""
    sig, cloth, thread, metallic = design
    rng = random.Random(seed)
    xs = (np.arange(w) + 0.5) / w * W
    ys = (np.arange(h) + 0.5) / h * H
    X, Y = np.meshgrid(xs, ys)
    px = W / w
    # ---- cloth colour
    n1 = fbm2(X, Y, 4, seed, 3.0)
    streak = fbm2(X * 4.0, Y * 0.25, 3, seed + 1, 2.0)
    blot = np.clip((fbm2(X, Y, 3, seed + 2, 1.4) - 0.45) / 0.2, 0, 1)
    rgb = np.array(cloth)[None, None, :] * (0.8 + 0.45 * n1)[..., None] * (0.85 + 0.3 * streak)[..., None]
    faded = np.array([0.13, 0.065, 0.075])
    rgb = rgb * (1 - 0.4 * blot[..., None]) + faded[None, None, :] * (0.4 * blot[..., None])
    # ---- trim bands + sigil (embroidery mask)
    emb = np.zeros((h, w), np.float32)
    e = 0.055
    if not swag:
        emb += ((X > e) & (X < e + 0.035)) | ((X > W - e - 0.035) & (X < W - e)) | ((Y > 0.1) & (Y < 0.135))
        emb += ((X > e + 0.055) & (X < e + 0.065)) | ((X > W - e - 0.065) & (X < W - e - 0.055)) | ((Y > 0.155) & (Y < 0.165))
        emb += (Y > H * 0.72) & (Y < H * 0.72 + 0.03)
        cx, cy, S0 = W / 2, H * 0.33, W * 0.4
    else:
        emb += (Y > 0.06) & (Y < 0.09)
        emb += (Y > 0.11) & (Y < 0.12)
        cx, cy, S0 = W / 2, H * 0.42, H * 0.3
    SX, SY = (X - cx) / S0, -(Y - cy) / S0
    emb = np.clip(emb + sigil(sig, SX, SY), 0, 1)
    emb = blur(emb, 1)
    outline = np.clip(blur(dilate((emb > 0.5).astype(np.float32), 3), 1) - emb, 0, 1)
    wear = np.clip((fbm2(X, Y, 4, seed + 3, 9.0) - 0.28) / 0.1, 0, 1)
    thread_m = emb * wear
    rgb = rgb * (1 - 0.8 * outline[..., None]) + np.array([0.02, 0.008, 0.006])[None, None, :] * (0.8 * outline[..., None])
    th = np.array(thread)[None, None, :] * (0.75 + 0.5 * fbm2(X, Y, 3, seed + 4, 20.0))[..., None]
    rgb = rgb * (1 - thread_m[..., None]) + th * thread_m[..., None]
    # ---- dirt from the bottom, mud splashes
    t = Y / H
    dirt = np.clip((t - 0.45) / 0.55, 0, 1) ** 1.5 * (0.6 + 0.6 * fbm2(X, Y, 4, seed + 5, 3.5))
    dirt = np.clip(dirt + np.clip((fbm2(X, Y, 3, seed + 6, 12.0) - 0.68) / 0.08, 0, 1) * np.clip((t - 0.5) / 0.3, 0, 1) * 0.6, 0, 1)
    mud = np.array([0.025, 0.017, 0.012])
    rgb = rgb * (1 - 0.85 * dirt[..., None]) + mud[None, None, :] * (0.85 * dirt[..., None])
    # ---- tears (alpha)
    alpha = np.ones((h, w), np.float32)
    fray = fbm2(X, Y, 3, seed + 7, 60.0)
    if not swag:
        # ribbons: slits from the bottom, each ribbon ends at its own height
        # shredded bottom: ribbons of different lengths between V-shaped slits, each end torn on a slant, ragged
        cuts = sorted(rng.uniform(0.08, 0.92) * W for _ in range(rng.randint(5, 8)))
        edges = [0.0] + cuts + [W]
        bottom = np.full(w, H, np.float32)
        for x0, x1 in zip(edges, edges[1:]):
            yb = H - rng.uniform(0.05, 0.95) * (1.0 if rng.random() < 0.75 else 1.35)
            sel = (xs >= x0) & (xs < x1)
            slant = rng.uniform(-0.6, 0.6)
            bottom[sel] = yb + slant * (xs[sel] - (x0 + x1) / 2)
        for xc in cuts:
            L = rng.uniform(0.5, 1.5)
            wd = rng.uniform(0.012, 0.05)
            alpha[(np.abs(X - xc + 0.03 * (fbm2(X, Y, 2, seed + 13, 4.0) - 0.5)) < wd * (1 - np.clip((H - Y) / L, 0, 1)) + 0.002) & (Y > H - L)] = 0
        ragged = (fbm2(X, Y * 0.3, 3, seed + 8, 6.0) - 0.5) * 0.22 + (fbm2(X, Y, 2, seed + 14, 30.0) - 0.5) * 0.05
        alpha[Y > bottom[None, :] + ragged] = 0
        # side edge notch
        if rng.random() < 0.6:
            yy = rng.uniform(H * 0.45, H * 0.8)
            sd = rng.choice([0.0, W])
            alpha[np.hypot((X - sd) * 1.6, Y - yy) < rng.uniform(0.06, 0.13) + 0.03 * (fray - 0.5)] = 0
    else:
        # dagged swag bottom (pointed flaps) + tears
        k = 7
        ph = (X / W * k) % 1.0
        dag = H - 0.18 * (np.abs(ph - 0.5) * 2)
        ragged = (fbm2(X, Y, 3, seed + 8, 10.0) - 0.5) * 0.07
        alpha[Y > dag + ragged] = 0
        for _ in range(2):
            xc = rng.uniform(0.2, W - 0.2)
            L = rng.uniform(0.2, 0.5)
            alpha[(np.abs(X - xc) < 0.012 * (1 - np.clip((H - Y) / L, 0, 1)) + 0.002) & (Y > H - L)] = 0
    # burn holes with charred rims
    char = np.zeros((h, w), np.float32)
    for _ in range(rng.randint(0, 2) if not swag else 1):
        hx, hy = rng.uniform(0.15, 0.85) * W, rng.uniform(0.55, 0.85) * H
        r = rng.uniform(0.025, 0.07)
        d = np.hypot(X - hx, (Y - hy) * 0.8) + (fbm2(X, Y, 3, seed + 9, 25.0) - 0.5) * 0.05
        alpha[d < r] = 0
        char = np.maximum(char, np.clip(1 - (d - r) / 0.05, 0, 1) * (d >= r))
    # fine fray along every cut edge
    edge = blur(alpha, 2)
    alpha[(edge < 0.75) & (fray < 0.5)] = 0
    rgb = rgb * (1 - 0.9 * char[..., None]) + np.array([0.012, 0.009, 0.007])[None, None, :] * (0.9 * char[..., None])
    # darker, frayed band along torn edges
    edark = np.clip((0.95 - blur(alpha, 4)) / 0.4, 0, 1) * alpha
    rgb *= (1 - 0.5 * edark)[..., None]
    # ---- height (normal), roughness, metal
    i = np.arange(w)[None, :]
    j = np.arange(h)[:, None]
    weave = (np.sin(i * math.pi / 4.0) * np.sin(j * math.pi / 4.0)) * 0.35
    hem = np.zeros((h, w), np.float32)
    if not swag:
        hem += np.clip(1 - np.minimum(X, W - X) / 0.03, 0, 1) * 0.6
    hem += np.clip(1 - Y / 0.05, 0, 1) * 0.6
    height = weave + 1.2 * blur(emb, 2) * wear + hem
    rough = 0.9 - 0.5 * thread_m * (1.0 if metallic else 0.4) + 0.05 * dirt
    metal = thread_m * (0.85 if metallic else 0.0) * (1 - dirt)
    return np.clip(rgb, 0, 1), alpha, height.astype(np.float32), np.clip(rough, 0.25, 1), np.clip(metal, 0, 1), px


def to_normal(height, px_m, strength=0.0012):
    """tangent-space normal (OpenGL, +Y = up in the image) from a top-down height field in arbitrary units"""
    gx = (np.roll(height, -1, 1) - np.roll(height, 1, 1)) * 0.5
    gy = (np.roll(height, -1, 0) - np.roll(height, 1, 0)) * 0.5
    k = strength / px_m
    nx, ny, nz = -gx * k, gy * k, np.ones_like(height)
    L = np.sqrt(nx * nx + ny * ny + nz * nz)
    return np.stack([nx / L, ny / L, nz / L], -1) * 0.5 + 0.5


def save_rgba(arr_topdown, path, non_color, alpha=True):
    h, w = arr_topdown.shape[:2]
    im = bpy.data.images.new(os.path.basename(path), w, h, alpha=alpha)
    if non_color:
        im.colorspace_settings.name = 'Non-Color'
    px = np.ones((h, w, 4), np.float32)
    px[..., :arr_topdown.shape[2]] = arr_topdown
    px = px[::-1]  # Blender rows go bottom-up
    im.pixels.foreach_set(px.ravel())
    im.filepath_raw = path
    im.file_format = 'PNG'
    if alpha:
        im.alpha_mode = 'STRAIGHT'
    im.save()
    bpy.data.images.remove(im)
    return path


def lin2srgb(c):
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(np.clip(c, 0, 1), 1 / 2.4) - 0.055)


def atlas():
    N = a.atlas
    cw, ch = N // 4, int(N * 0.375)
    rgb = np.zeros((N, N, 3), np.float32)
    al = np.zeros((N, N), np.float32)
    hgt = np.zeros((N, N), np.float32)
    ro = np.ones((N, N), np.float32)
    me = np.zeros((N, N), np.float32)
    pxm = []
    for k, d in enumerate(DESIGNS):
        x0, y0 = (k % 4) * cw, (k // 4) * ch
        c, A, H, R, M, px = paint_cell(cw, ch, VW, VH, d, 100 + k)
        rgb[y0:y0 + ch, x0:x0 + cw] = c
        al[y0:y0 + ch, x0:x0 + cw] = A
        hgt[y0:y0 + ch, x0:x0 + cw] = H
        ro[y0:y0 + ch, x0:x0 + cw] = R
        me[y0:y0 + ch, x0:x0 + cw] = M
        pxm.append(px)
    sw, sh = N // 2, N - 2 * ch
    for s, d in enumerate((DESIGNS[0], DESIGNS[7])):
        x0, y0 = s * sw, 2 * ch
        c, A, H, R, M, px = paint_cell(sw, sh, SW, SH, d, 200 + s, swag=True)
        rgb[y0:y0 + sh, x0:x0 + sw] = c
        al[y0:y0 + sh, x0:x0 + sw] = A
        hgt[y0:y0 + sh, x0:x0 + sw] = H
        ro[y0:y0 + sh, x0:x0 + sw] = R
        me[y0:y0 + sh, x0:x0 + sw] = M
    # bleed the colour under transparent texels (no dark fringes when mips average across the alpha edge)
    for _ in range(3):
        m = al > 0.5
        wsum = blur(m.astype(np.float32), 3) + 1e-6
        for ch_i in range(3):
            bl = blur(rgb[..., ch_i] * m, 3) / wsum
            rgb[..., ch_i] = np.where(m, rgb[..., ch_i], bl)
    out = {}
    out['baseColor'] = save_rgba(np.concatenate([lin2srgb(rgb), al[..., None]], -1), os.path.join(job.out, f'{ID}_atlas.png'), non_color=True, alpha=True)
    half = lambda x: x.reshape(N // 2, 2, N // 2, 2, *x.shape[2:]).mean((1, 3))  # noqa: E731
    nrm = to_normal(half(hgt), VW / (cw / 2))
    out['normal'] = save_rgba(nrm, os.path.join(job.out, f'{ID}_normal.png'), non_color=True, alpha=False)
    orm = np.stack([np.ones_like(ro), ro, me], -1)
    out['orm'] = save_rgba(half(orm), os.path.join(job.out, f'{ID}_orm.png'), non_color=True, alpha=False)
    S['maps'] = {k: os.path.basename(v) for k, v in out.items()}
    return {**S['maps'], 'alphaCoverage': float(al.mean()), 'cellPxPerM': round(cw / VW), 'swagPxPerM': round(sw / SW)}


# ============================================================================ export + preview

def export():
    mat = bpy.data.materials.new('banners')
    mat.use_nodes = True
    nt = mat.node_tree
    b = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    t = nt.nodes.new('ShaderNodeTexImage')
    t.image = abake.load_image(os.path.join(job.out, S['maps']['baseColor']))
    t.image.colorspace_settings.name = 'sRGB'
    nt.links.new(t.outputs['Color'], b.inputs['Base Color'])
    nt.links.new(t.outputs['Alpha'], b.inputs['Alpha'])
    b.inputs['Roughness'].default_value = 0.9
    try:
        mat.blend_method = 'CLIP'
    except Exception:
        pass
    rod = K.material_plain('banner_rod', (0.03, 0.028, 0.026), rough=0.5, metal=0.85)
    root = abake.empty(f'KIT_{ID}', id=f'kit/{ID}', role='cloth', kind='banner', cells=8, cellUV=[0.25, 0.375], swagCells=2, swagUV=[0.5, 0.25], swagV0=0.75,
                       vertical=[VW, VH], swag=[SPAN, SH, SW], hang=1)
    for lod in (0, 1):
        e = abake.empty(f'LOD{lod}', parent=root, lod=lod)
        for nm, o in S['lod'][lod].items():
            o.data.materials.clear()
            o.data.materials.append(rod if nm == 'ROD' else mat)
            o.parent = e
            o.name = nm if lod == 0 else f'{nm}_l1'
    # COL: a thin box around the vertical banner (camera LOS proxy)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * VW, v.co.y * 0.3, v.co.z * VH - VH / 2))
    col = K.to_object('COL', bm)
    col['col'] = 1
    col.parent = root
    col.hide_render = True
    glb = abake.export_glb(os.path.join(job.out, f'{ID}_raw.glb'), objects=[root, col] + list(root.children_recursive))
    asset = {
        'id': f'kit/{ID}', 'glb': os.path.basename(glb['path']), 'role': 'cloth', 'kind': 'banner',
        'lods': {'LOD0': {'materials': ['banners', 'banner_rod']}, 'LOD1': {'materials': ['banners', 'banner_rod']}},
        'materials': {
            'banners': {**S['maps'], 'size': a.atlas, 'alpha': 'MASK', 'alphaCutoff': 0.5, 'doubleSided': True, 'metallicFactor': 1.0, 'roughnessFactor': 1.0},
            'banner_rod': {'baseColorFactor': [0.03, 0.028, 0.026, 1], 'metallicFactor': 0.85, 'roughnessFactor': 0.5},
        },
        'sources': [], 'job': os.path.basename(job.out),
    }
    with open(os.path.join(job.out, 'asset.json'), 'w', encoding='utf-8') as f:
        json.dump(asset, f, indent=1)
    return {'glb': glb}


def preview():
    if not a.preview:
        return 'skipped'
    # four vertical banners with different cells side by side + one swag, lit like the kit previews
    v0 = S['lod'][0]['BANNER_vertical']
    sw0 = S['lod'][0]['BANNER_swag']
    for o in list(bpy.data.objects):
        if o.type == 'EMPTY' and o.name.startswith('LOD'):
            for c in list(o.children):
                c.parent = None
    items = []
    for k in range(4):
        o = v0.copy()
        o.data = v0.data.copy()
        K.link(o)
        uv = o.data.uv_layers.active.data
        for l in uv:
            l.uv.x += (k % 4) * 0.25 if k < 4 else 0
        o.location = (0, 0, 3.4)
        items.append((o, (k - 1.5) * 1.4))
    v0.hide_render = True
    S['lod'][0]['ROD'].hide_render = True
    sw0.location = (0, 0.6, 3.4 + 0.2)
    for nm, o in S['lod'][1].items():
        o.hide_render = True
    sw0.location.y = 1.2
    return K.preview_scene(items + [(sw0, 0.0)], os.path.join(job.out, f'{ID}_preview.png'), size=(1440, 900), cam_loc=(0, -7.5, 2.4), look=(0, 0, 2.0), lens=40)


job.step('build', build)
job.step('atlas', atlas)
job.step('export', export)
job.step('preview', preview)
fails = [r['step'] for r in job.steps if not r['ok']]
job.result['failed'] = fails
job.done()
if fails:
    sys.exit(1)
