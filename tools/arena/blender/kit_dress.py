"""A4 shared dressing kit (arena art plan 5.2, milestone A4): every piece is a procedural low-poly LOD0 / LOD1 with a baked
high (dresskit.py pipeline).  Run one piece:  npm run arena:bake -- kit_<piece>   (tools/arena/jobs.json, group a4)

  braziers   brazier_pedestal (ref-3 bowl on a stone pedestal), brazier_wall (podium-top stand), brazier_pillartop (ref-4
             cradle on a pillar); the sim's tripod prop is A1's kit/brazier_tripod
  lights     lantern_toro (the sim's `lantern` prop: PROP_BASE 0.35 / TOP 1.6, stone), lantern_cage (iron, hanging),
             lantern_paper (hanging), candles (cluster with SOCK_candle_* per wick)
  dressing   bell (bronze + yoke), skull, bone_pile (metaballs), stakes (cheval-de-frise)
  hazards    spike_grate (node SPIKES moves), chain_weight (spiked ball, SOCK_chain), vent_grate (flame jet), crumble
             (cracked heaved slabs SLAB_* + broken RIM), chain_link (LINK_big / LINK_small, instanced at runtime)
  features   banner_pole (sim `banner`: r 0.28, h 4.6, SOCK_banner), barricade (sim `barricade`: r 0.7, h 1.5); FRAC_*
  props      crate / barrel / urn / keg (sim `explosive`) / chunk, fitted EXACTLY to PROP_BASE r / TOP (origin at the base
             centre), FRAC_* breakage pieces per LOD
Blender Z up; glTF +Y up on export. Hanging pieces have their origin at the hang point (extras hang = 1).
"""
import math
import os
import random
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import abake  # noqa: E402
import dresskit as D  # noqa: E402
import stonekit as K  # noqa: E402
from dresskit import Part, T  # noqa: E402

PIECES = {}


def piece(fn):
    PIECES[fn.__name__] = fn
    return fn


def P(name, mat, fn, **kw):
    bm = bmesh.new()
    fn(bm)
    return Part(name, bm, mat, **kw)


def seg(lod, hi, lo):
    return hi if lod == 0 else lo


GLOW_COALS = {'color': (0.045, 0.03, 0.022), 'emit': (1.0, 0.32, 0.06), 'strength': 1.6, 'rough': 0.95}
GLOW_FIRE = {'color': (0.3, 0.15, 0.05), 'emit': (1.0, 0.55, 0.2), 'strength': 3.0}
GLOW_PAPER = {'color': (0.6, 0.35, 0.18), 'emit': (1.0, 0.45, 0.15), 'strength': 1.3, 'rough': 0.85}
IRON_SRC = [D.CC0['iron'], D.CC0['rust']]


def coal_bed(bm, r, z0, z1, segs, seed):
    vs = D.lathe(bm, [(0.0, z0), (r, z0 + 0.01), (r * 0.75, z0 + (z1 - z0) * 0.6), (r * 0.35, z1 - 0.01), (0.0, z1)], segs)
    rng = random.Random(seed)
    for v in vs:
        if v.co.z > z0 + 0.012:
            v.co.z += rng.uniform(-0.012, 0.012)


# ============================================================================ braziers

@piece
def brazier_pedestal(lod):
    s = seg(lod, 24, 12)
    sq = lambda h, z, c=0.025: K.square_ring(h, h, z, c)  # noqa: E731
    parts = [P('pedestal', 'stone', lambda bm: K.loft(bm, [sq(0.52, 0.0), sq(0.52, 0.16), sq(0.44, 0.22), sq(0.38, 0.28), sq(0.35, 1.1), sq(0.42, 1.17), sq(0.47, 1.22), sq(0.47, 1.36)]),
               hi='stone', smooth=False, stone={'H': 1.4, 'chip': 0.03, 'chip_cell': 0.1, 'soot': 0.8})]
    # ref-3: a wide, fairly shallow fire dish on a squat stone pedestal
    bowl = [(0.0, 1.36), (0.2, 1.37), (0.48, 1.45), (0.68, 1.57), (0.8, 1.7), (0.86, 1.79), (0.855, 1.83), (0.815, 1.82), (0.76, 1.74),
            (0.62, 1.6), (0.38, 1.5), (0.0, 1.46)]
    parts.append(P('bowl', 'iron_sooty', lambda bm: D.lathe(bm, bowl, s), hi='sub', levels=2, disp=(0.004, 0.05)))
    parts.append(P('band', 'iron', lambda bm: D.torus(bm, 0.745, 0.02, s, seg(lod, 6, 4), T(z=1.64)), hi='sub', levels=1))
    def straps(bm):
        for i in range(4):
            a = math.pi / 4 + i * math.pi / 2
            pts = [Vector((r * math.cos(a), r * math.sin(a), z)) for r, z in [(0.22, 1.375), (0.49, 1.46), (0.69, 1.58), (0.81, 1.71), (0.87, 1.8)]]
            D.tube(bm, pts, 0.022, seg(lod, 5, 4))
    parts.append(P('straps', 'iron', straps, hi='sub', levels=1))
    if lod == 0:
        def rivets(bm):
            for i in range(24):
                a = 2 * math.pi * (i + 0.5) / 24
                D.sphere(bm, 0.012, 8, 6, T(0.775 * math.cos(a), 0.775 * math.sin(a), 1.68), squash=(1, 1, 0.8))
        parts.append(P('rivets', 'iron', rivets, hi='only'))
    parts.append(P('coals', 'glow:brazier_coals', lambda bm: coal_bed(bm, 0.72, 1.7, 1.8, seg(lod, 16, 8), 3)))
    return parts


@piece
def brazier_wall(lod):
    s = seg(lod, 20, 10)
    bowl = [(0.0, 0.74), (0.1, 0.75), (0.25, 0.82), (0.38, 0.93), (0.45, 1.02), (0.452, 1.05), (0.425, 1.05), (0.36, 0.96), (0.2, 0.84), (0.0, 0.8)]
    parts = [P('bowl', 'iron_sooty', lambda bm: D.lathe(bm, bowl, s), hi='sub', levels=2, disp=(0.003, 0.04))]
    leg = [Vector((0.16, 0, 0.78)), Vector((0.3, 0, 0.58)), Vector((0.22, 0, 0.3)), Vector((0.3, 0, 0.03))]
    def legs(bm):
        for i in range(3):
            a = math.radians(90 + 120 * i)
            rot = Matrix.Rotation(a, 4, 'Z')
            pts = [rot @ p for p in D.bezier(*leg, seg(lod, 9, 5))]
            D.tube(bm, pts, [0.022 - 0.006 * k / len(pts) for k in range(len(pts))], seg(lod, 6, 4))
            D.sphere(bm, 0.035, seg(lod, 8, 6), 4, T(0.31 * math.cos(a), 0.31 * math.sin(a), 0.03), squash=(1, 1, 0.8))
    parts.append(P('legs', 'iron', legs, hi='sub', levels=1))
    parts.append(P('ring', 'iron', lambda bm: D.torus(bm, 0.24, 0.012, s, 4, T(z=0.32)), hi='sub', levels=1))
    parts.append(P('coals', 'glow:brazier_coals', lambda bm: coal_bed(bm, 0.37, 0.92, 0.99, seg(lod, 12, 8), 5)))
    return parts


@piece
def brazier_pillartop(lod):
    s = seg(lod, 22, 12)
    bowl = [(0.0, 0.2), (0.2, 0.21), (0.42, 0.28), (0.56, 0.4), (0.6, 0.5), (0.6, 0.53), (0.565, 0.52), (0.52, 0.45), (0.4, 0.35), (0.2, 0.29), (0.0, 0.28)]
    parts = [P('bowl', 'iron_sooty', lambda bm: D.lathe(bm, bowl, s), hi='sub', levels=2, disp=(0.003, 0.05))]
    def cradle(bm):
        for i in range(4):
            a = math.pi / 4 + i * math.pi / 2
            x, y = math.cos(a), math.sin(a)
            pts = [Vector((0.3 * x, 0.3 * y, 0.0)), Vector((0.36 * x, 0.36 * y, 0.18)), Vector((0.47 * x, 0.47 * y, 0.36)), Vector((0.56 * x, 0.56 * y, 0.46))]
            D.tube(bm, pts, 0.028, seg(lod, 6, 4))
            D.box(bm, 0.12, 0.12, 0.04, T(0.3 * x, 0.3 * y, 0.02, rz=a))
        for i in range(4):
            a = i * math.pi / 2
            D.box(bm, 0.05, 0.62, 0.04, T(0.31 * math.cos(a), 0.31 * math.sin(a), 0.2, rz=a))
    parts.append(P('cradle', 'iron', cradle, hi='sub', levels=1))
    parts.append(P('coals', 'glow:brazier_coals', lambda bm: coal_bed(bm, 0.5, 0.4, 0.49, seg(lod, 14, 8), 7)))
    return parts


# ============================================================================ lanterns, candles

@piece
def lantern_toro(lod):
    s6 = 6
    parts = [
        P('base', 'stone', lambda bm: D.lathe(bm, [(0.0, 0.0), (0.3, 0.0), (0.3, 0.08), (0.22, 0.14), (0.14, 0.16), (0.0, 0.16)], s6, phase=0.0), hi='stone', smooth=False),
        P('post', 'stone', lambda bm: D.lathe(bm, [(0.0, 0.15), (0.1, 0.15), (0.088, 0.74), (0.0, 0.74)], seg(lod, 10, 6)), hi='stone', smooth=True),
        P('platform', 'stone', lambda bm: D.lathe(bm, [(0.0, 0.72), (0.12, 0.72), (0.25, 0.8), (0.25, 0.86), (0.0, 0.86)], s6), hi='stone', smooth=False),
        P('roof', 'stone', lambda bm: D.lathe(bm, [(0.0, 1.14), (0.2, 1.14), (0.35, 1.19), (0.36, 1.235), (0.3, 1.25), (0.13, 1.37), (0.06, 1.41), (0.0, 1.42)], s6), hi='stone', smooth=False),
        P('finial', 'stone', lambda bm: D.lathe(bm, [(0.0, 1.41), (0.05, 1.42), (0.07, 1.47), (0.075, 1.52), (0.05, 1.57), (0.02, 1.59), (0.0, 1.6)], seg(lod, 10, 6)), hi='stone', smooth=True),
    ]
    def box_posts(bm):
        for sx in (-1, 1):
            for sy in (-1, 1):
                D.box(bm, 0.055, 0.055, 0.28, T(0.135 * sx, 0.135 * sy, 1.0))
        D.box(bm, 0.33, 0.33, 0.035, T(z=1.125))
    parts.append(P('firebox', 'stone', box_posts, hi='stone', smooth=False))
    parts.append(P('fire', 'glow:lantern_fire', lambda bm: D.box(bm, 0.17, 0.17, 0.2, T(z=0.97))))
    return parts


@piece
def lantern_cage(lod):
    s = seg(lod, 12, 6)
    parts = [
        P('hook', 'iron', lambda bm: D.torus(bm, 0.035, 0.007, seg(lod, 10, 6), 4, T(z=-0.04, rx=math.pi / 2)), hi='sub', levels=1),
        P('cap', 'iron_sooty', lambda bm: D.lathe(bm, [(0.0, -0.07), (0.04, -0.075), (0.15, -0.15), (0.165, -0.175), (0.0, -0.175)], s), hi='sub', levels=1),
        P('tray', 'iron_sooty', lambda bm: D.lathe(bm, [(0.0, -0.5), (0.165, -0.5), (0.17, -0.53), (0.1, -0.56), (0.0, -0.57)], s), hi='sub', levels=1),
        P('bands', 'iron', lambda bm: (D.torus(bm, 0.155, 0.009, s, 4, T(z=-0.18)), D.torus(bm, 0.155, 0.009, s, 4, T(z=-0.49))), hi='sub', levels=1),
    ]
    def bars(bm):
        for i in range(6):
            a = 2 * math.pi * i / 6
            c, sn = math.cos(a), math.sin(a)
            pts = D.bezier(Vector((0.15 * c, 0.15 * sn, -0.17)), Vector((0.19 * c, 0.19 * sn, -0.27)), Vector((0.19 * c, 0.19 * sn, -0.4)), Vector((0.15 * c, 0.15 * sn, -0.5)), seg(lod, 6, 3))
            D.tube(bm, pts, 0.008, 4)
    parts.append(P('bars', 'iron', bars, hi='sub', levels=1))
    parts.append(P('candle', 'wax', lambda bm: D.lathe(bm, [(0.0, -0.5), (0.03, -0.5), (0.03, -0.37), (0.022, -0.36), (0.0, -0.365)], seg(lod, 8, 6)), hi='sub', levels=1))
    parts.append(P('flame', 'glow:lantern_fire', lambda bm: D.sphere(bm, 0.022, 8, 6, T(z=-0.325), squash=(1, 1, 2.0))))
    return parts


@piece
def lantern_paper(lod):
    s = seg(lod, 20, 10)
    parts = [
        P('hook', 'iron', lambda bm: D.torus(bm, 0.03, 0.006, seg(lod, 10, 6), 4, T(z=-0.035, rx=math.pi / 2)), hi='sub', levels=1),
        P('capTop', 'wood_dark', lambda bm: D.lathe(bm, [(0.0, -0.06), (0.125, -0.06), (0.13, -0.1), (0.0, -0.1)], s), hi='bevel', bevel=0.004),
        P('capBot', 'wood_dark', lambda bm: D.lathe(bm, [(0.0, -0.6), (0.13, -0.6), (0.125, -0.64), (0.0, -0.64)], s), hi='bevel', bevel=0.004),
    ]
    nr = seg(lod, 15, 7)
    prof = []
    for k in range(nr + 1):
        t = k / nr
        z = -0.095 - t * 0.51
        r = 0.13 + 0.12 * math.sin(math.pi * t)
        if lod == 0 and 0 < k < nr:
            r *= 0.985 if k % 2 else 1.0  # bamboo ribs
        prof.append((r, z))
    parts.append(P('paper', 'glow:paper_glow', lambda bm: D.lathe(bm, [(0.0, -0.095)] + prof + [(0.0, -0.605)], s)))
    return parts


@piece
def candles(lod):
    rng = random.Random(11)
    spots = [(0.0, 0.0, 0.42, 0.045), (0.12, 0.06, 0.3, 0.04), (-0.11, 0.08, 0.26, 0.038), (0.05, -0.13, 0.2, 0.035), (-0.16, -0.08, 0.16, 0.033),
             (0.2, -0.06, 0.12, 0.03), (-0.04, 0.19, 0.1, 0.03), (0.17, 0.17, 0.08, 0.028), (-0.22, 0.14, 0.06, 0.026)]
    pool = [(0.0, 0.0), (0.3, 0.0), (0.33, 0.008), (0.3, 0.02), (0.16, 0.03), (0.0, 0.034)]

    def wax(bm):
        D.lathe(bm, pool, seg(lod, 18, 9), ripple=lambda i, k: 1.0 + 0.12 * math.sin(i * 1.7 + k) if k > 0 else 1.0)
        for (x, y, h, r) in spots:
            D.lathe(bm, [(0.0, 0.0), (r, 0.0), (r, h - 0.012), (r * 0.82, h), (r * 0.45, h - 0.014), (0.0, h - 0.016)], seg(lod, 10, 6), M=T(x, y, 0.0))
            if lod == 0:
                for d in range(2):
                    a = rng.uniform(0, 2 * math.pi)
                    D.sphere(bm, 0.009, 6, 5, T(x + r * math.cos(a), y + r * math.sin(a), h - 0.04 - d * 0.05), squash=(1, 1, 3.0))
    return [P('wax', 'wax', wax, hi='sub', levels=1)]


def candle_sockets():
    spots = [(0.0, 0.0, 0.42, 0.045), (0.12, 0.06, 0.3, 0.04), (-0.11, 0.08, 0.26, 0.038), (0.05, -0.13, 0.2, 0.035), (-0.16, -0.08, 0.16, 0.033),
             (0.2, -0.06, 0.12, 0.03), (-0.04, 0.19, 0.1, 0.03), (0.17, 0.17, 0.08, 0.028), (-0.22, 0.14, 0.06, 0.026)]
    return [(f'SOCK_candle_{k}', (x, y, h - 0.004), {'size': round(0.06 + r, 3)}) for k, (x, y, h, r) in enumerate(spots)]


# ============================================================================ bell, stakes

@piece
def bell(lod):
    s = seg(lod, 24, 12)
    prof = [(0.0, -0.25), (0.12, -0.25), (0.2, -0.28), (0.24, -0.35), (0.26, -0.5), (0.29, -0.7), (0.36, -0.88), (0.42, -0.98), (0.435, -1.02),
            (0.405, -1.025), (0.36, -0.975), (0.3, -0.88), (0.235, -0.72), (0.21, -0.5), (0.19, -0.34), (0.1, -0.3), (0.0, -0.3)]
    parts = [
        P('beam', 'wood_dark', lambda bm: D.box(bm, 1.5, 0.15, 0.17, T(z=-0.085)), hi='bevel', bevel=0.012),
        P('hanger', 'iron', lambda bm: (D.torus(bm, 0.06, 0.016, seg(lod, 12, 6), 5, T(z=-0.2, rx=math.pi / 2)), D.box(bm, 0.2, 0.05, 0.02, T(z=-0.175))), hi='sub', levels=1),
        P('bell', 'bronze', lambda bm: D.lathe(bm, prof, s), hi='sub', levels=2),
        P('clapper', 'iron', lambda bm: (D.cyl(bm, 0.012, 0.012, -0.9, -0.3, 6), D.sphere(bm, 0.05, 8, 6, T(z=-0.92))), hi='sub', levels=1),
    ]
    if lod == 0:
        def relief(bm):
            for z, r in ((-0.44, 0.262), (-0.83, 0.335), (-0.93, 0.39)):
                D.torus(bm, r, 0.009, 64, 6, T(z=z))
            for i in range(16):
                a = 2 * math.pi * i / 16
                D.sphere(bm, 0.022, 10, 8, T(0.282 * math.cos(a), 0.282 * math.sin(a), -0.64), squash=(1, 1, 1.3))
        parts.append(P('relief', 'bronze', relief, hi='only'))
    return parts


@piece
def stakes(lod):
    """cheval-de-frise: a log with crossed sharpened stakes, rope lashings at the crossings"""
    sides = seg(lod, 8, 5)
    parts = []
    def log(bm):
        D.lathe(bm, [(0.0, -1.15), (0.1, -1.15), (0.11, 0.0), (0.1, 1.15), (0.0, 1.15)], seg(lod, 10, 6), M=T(z=0.62, ry=math.pi / 2))
    parts.append(P('log', 'wood_dark', log, hi='sub', levels=1, disp=(0.006, 0.08)))
    rng = random.Random(5)
    def stakes_bm(bm):
        for i, x in enumerate((-0.9, -0.45, 0.0, 0.45, 0.9)):
            for sgn in (-1, 1):
                L = 1.7 + rng.uniform(-0.12, 0.1)
                r = 0.045 + rng.uniform(-0.006, 0.006)
                prof = [(0.0, -L / 2), (r * 0.9, -L / 2 + 0.2), (r, -L / 2 + 0.3), (r, L / 2 - 0.32), (r * 0.9, L / 2 - 0.22), (0.0, L / 2)]
                D.lathe(bm, prof, sides, M=T(x + rng.uniform(-0.03, 0.03), 0.0, 0.62, rx=sgn * math.radians(48 + rng.uniform(-4, 4)), ry=rng.uniform(-0.08, 0.08)))
    parts.append(P('stakes', 'wood', stakes_bm, hi='sub', levels=1, disp=(0.004, 0.05)))
    def rope(bm):
        for x in (-0.9, -0.45, 0.0, 0.45, 0.9):
            for dx in (-0.05, 0.05):
                D.torus(bm, 0.125, 0.014, seg(lod, 12, 6), 4, T(x + dx, 0, 0.62, ry=math.pi / 2))
    parts.append(P('rope', 'rope', rope, hi='sub', levels=1))
    return parts


# ============================================================================ hazards

@piece
def spike_grate(lod):
    s = seg(lod, 32, 16)
    parts = [P('frame', 'iron_sooty', lambda bm: D.lathe(bm, [(0.86, 0.0), (1.0, 0.0), (1.0, 0.06), (0.93, 0.085), (0.86, 0.065), (0.86, 0.0)], s), hi='sub', levels=1)]
    def bars(bm):
        for k in range(-3, 4):
            y = k * 0.25
            half = math.sqrt(max(0.0, 0.9 ** 2 - y * y))
            D.box(bm, 2 * half, 0.04, 0.05, T(0.0, y, 0.035))
            D.box(bm, 0.04, 2 * half, 0.05, T(y, 0.0, 0.035))
    parts.append(P('bars', 'iron', bars, hi='bevel', bevel=0.005))
    def spikes(bm):
        for i in range(-4, 4):
            for j in range(-4, 4):
                x, y = (i + 0.5) * 0.25, (j + 0.5) * 0.25
                if math.hypot(x, y) < 0.78:
                    D.cone_spike(bm, 0.04, 0.7, seg(lod, 6, 4), T(x, y, 0.0))
    parts.append(P('spikes', 'rust', spikes, hi='sub', levels=1, node='SPIKES'))
    return parts


@piece
def chain_weight(lod):
    def ball(bm):
        g = bmesh.ops.create_icosphere(bm, subdivisions=seg(lod, 2, 1), radius=0.3)
        D.jitter(g['verts'], 0.006, 3, keep_z0=False)
    parts = [P('ball', 'iron_sooty', ball, hi='sub', levels=2, disp=(0.006, 0.06))]
    def spikes(bm):
        dirs = [Vector(v) for v in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, -1), (0.6, 0.6, 0.5), (-0.6, 0.6, 0.5), (0.6, -0.6, 0.5), (-0.6, -0.6, 0.5),
                                    (0.62, 0.62, -0.48), (-0.62, 0.62, -0.48), (0.62, -0.62, -0.48), (-0.62, -0.62, -0.48))]
        for d in dirs:
            d.normalize()
            q = Vector((0, 0, 1)).rotation_difference(d).to_matrix().to_4x4()
            D.cone_spike(bm, 0.07, 0.24, seg(lod, 6, 4), Matrix.Translation(d * 0.26) @ q)
    parts.append(P('spikes', 'iron', spikes, hi='sub', levels=1))
    parts.append(P('shackle', 'iron', lambda bm: (D.cyl(bm, 0.07, 0.06, 0.26, 0.34, seg(lod, 10, 6)), D.torus(bm, 0.065, 0.02, seg(lod, 12, 6), 5, T(z=0.4, rx=math.pi / 2))), hi='sub', levels=1))
    return parts


@piece
def vent_grate(lod):
    s = seg(lod, 28, 14)
    parts = [P('ring', 'stone', lambda bm: D.lathe(bm, [(0.72, 0.0), (1.0, 0.0), (1.0, 0.05), (0.95, 0.1), (0.78, 0.12), (0.72, 0.08), (0.72, 0.0)], s,
                                                     ripple=lambda i, k: 1.0 + 0.025 * math.sin(i * 2.3) * (1 if k > 1 else 0)), hi='stone', smooth=False,
               stone={'H': 0.12, 'soot': 1.0, 'wet_h': 0.05, 'chip': 0.02, 'chip_cell': 0.08})]
    def bars(bm):
        for k in range(-2, 3):
            y = k * 0.24
            half = math.sqrt(max(0.0, 0.76 ** 2 - y * y))
            D.box(bm, 2 * half, 0.05, 0.05, T(0.0, y, 0.07, rz=0.0))
            D.box(bm, 0.05, 2 * half, 0.04, T(y, 0.0, 0.05))
        D.torus(bm, 0.2, 0.025, seg(lod, 16, 8), 4, T(z=0.08))
    parts.append(P('grate', 'iron_sooty', bars, hi='bevel', bevel=0.006))
    return parts


def crumble_slabs(rng):
    """polygons of heaved slabs over a disc r 1.6: a centre slab + 6 sectors"""
    inner = [0.55 * (1 + rng.uniform(-0.15, 0.15)) for _ in range(6)]
    outer_r = 1.6
    ph = rng.uniform(0, 1)
    polys = [[(inner[i] * math.cos((i + ph) * math.pi / 3), inner[i] * math.sin((i + ph) * math.pi / 3)) for i in range(6)]]
    for i in range(6):
        j = (i + 1) % 6
        a0, a1 = (i + ph) * math.pi / 3, (i + 1 + ph) * math.pi / 3  # (not j: the last sector must not wrap backwards)
        p = [(inner[i] * math.cos(a0), inner[i] * math.sin(a0))]
        for t in (0.0, 0.35, 0.7, 1.0):
            a = a0 + (a1 - a0) * t
            r = outer_r * (1 + rng.uniform(-0.04, 0.03))
            p.append((r * math.cos(a), r * math.sin(a)))
        p.append((inner[j] * math.cos(a1), inner[j] * math.sin(a1)))
        polys.append(p)
    return polys


def prism(bm, poly, z0, z1, shrink, tilt, rng):
    cx = sum(p[0] for p in poly) / len(poly)
    cy = sum(p[1] for p in poly) / len(poly)
    pts = []
    for x, y in poly:
        d = math.hypot(x - cx, y - cy)
        k = max(0.0, (d - shrink) / max(1e-6, d))
        pts.append((cx + (x - cx) * k, cy + (y - cy) * k))
    ring0 = [Vector((x, y, z0)) for x, y in pts]
    ring1 = [Vector((x, y, z1)) for x, y in pts]
    vs = K.loft(bm, [ring0, ring1])
    M = Matrix.Translation((cx, cy, 0)) @ Matrix.Rotation(tilt[0], 4, 'X') @ Matrix.Rotation(tilt[1], 4, 'Y') @ Matrix.Translation((-cx, -cy, 0))
    for r in vs:
        for v in r:
            v.co = M @ v.co
    return cx, cy


@piece
def crumble(lod):
    rng = random.Random(21)
    polys = crumble_slabs(rng)
    parts = []
    for k, poly in enumerate(polys):
        tilt = (rng.uniform(-0.035, 0.035), rng.uniform(-0.035, 0.035))
        dz = rng.uniform(0.0, 0.03)
        parts.append(P(f'slab{k}', 'stone', lambda bm, poly=poly, tilt=tilt, dz=dz: prism(bm, poly, -0.04 + dz, 0.035 + dz, 0.018, tilt, rng),
                       hi='stone', smooth=False, node=f'SLAB_{k}', stone={'H': 0.1, 'wet_h': 0.1, 'chip': 0.02, 'chip_cell': 0.08, 'crack': 0.006}))
    s = seg(lod, 28, 14)
    def rim(bm):
        rr = random.Random(9)
        D.lathe(bm, [(1.5, -0.08), (1.95, -0.02), (1.95, 0.01), (1.62, 0.03), (1.52, 0.0)], s, ripple=lambda i, k: 1.0 + (0.05 * math.sin(i * 1.9) + rr.uniform(-0.03, 0.03)) * (1 if k >= 3 else 0.0))
    parts.append(P('rim', 'stone', rim, hi='stone', smooth=False, node='RIM', stone={'H': 0.1, 'wet_h': 0.1, 'chip': 0.025, 'chip_cell': 0.08}))
    return parts


@piece
def chain_link(lod):
    sg, sd = seg(lod, 12, 8), seg(lod, 4, 3)
    return [
        P('big', 'iron_sooty', lambda bm: D.torus(bm, 0.045, 0.016, sg, sd, T(-0.3, 0, 0.1), stretch=0.04), hi='sub', levels=2, node='LINK_big', disp=(0.002, 0.02)),
        P('small', 'rust', lambda bm: D.torus(bm, 0.022, 0.008, sg, sd, T(0.3, 0, 0.1), stretch=0.02), hi='sub', levels=2, node='LINK_small', disp=(0.0015, 0.02)),
    ]


# ============================================================================ features (sim obstacles)

@piece
def banner_pole(lod):
    s = seg(lod, 10, 6)
    parts = [
        P('foot', 'stone', lambda bm: K.block(bm, 0.25, 0.25, 0.16, 0.03, center=(0, 0, 0.16)), hi='stone', smooth=False, stone={'H': 0.32, 'wet_h': 0.15}),
        P('collar', 'iron', lambda bm: D.cyl(bm, 0.11, 0.1, 0.3, 0.52, s), hi='sub', levels=1),
        P('pole', 'wood_dark', lambda bm: D.cyl(bm, 0.075, 0.062, 0.3, 4.42, 8), hi='bevel', bevel=0.008, sharp=30),
        P('bands', 'iron', lambda bm: [D.torus(bm, 0.07, 0.013, s, 4, T(z=z)) for z in (1.3, 2.5, 3.6, 4.2)], hi='sub', levels=1),
        P('bar', 'iron', lambda bm: (D.box(bm, 1.3, 0.05, 0.05, T(z=4.33)), D.cone_spike(bm, 0.035, 0.12, 6, T(0.65, 0, 4.33, ry=math.pi / 2)),
                                    D.cone_spike(bm, 0.035, 0.12, 6, T(-0.65, 0, 4.33, ry=-math.pi / 2))), hi='bevel', bevel=0.006),
        P('tip', 'iron', lambda bm: (D.cyl(bm, 0.075, 0.07, 4.38, 4.43, s), D.cone_spike(bm, 0.055, 0.17, seg(lod, 8, 4), T(z=4.43))), hi='sub', levels=1),
    ]
    return parts


@piece
def barricade(lod):
    rng = random.Random(13)
    parts = []
    def posts(bm):
        for x in (-0.78, 0.0, 0.78):
            D.box(bm, 0.14, 0.14, 1.32, T(x, 0.0, 0.66))
            D.lathe(bm, [(0.0, 1.32), (0.1, 1.32), (0.0, 1.5)], 4, M=T(x, 0, 0, rz=math.pi / 4))
    parts.append(P('posts', 'wood_dark', posts, hi='bevel', bevel=0.01))
    def planks(bm):
        for k in range(4):
            D.box(bm, 1.8 + rng.uniform(-0.05, 0.08), 0.05, 0.21, T(rng.uniform(-0.04, 0.04), 0.095, 0.26 + k * 0.29, ry=rng.uniform(-0.05, 0.05)))
        for sgn in (-1, 1):
            D.box(bm, 1.75, 0.045, 0.16, T(0, -0.095 - (0.05 if sgn > 0 else 0.0), 0.7, ry=sgn * math.atan2(1.1, 1.56)))
    parts.append(P('planks', 'wood', planks, hi='bevel', bevel=0.008))
    def straps(bm):
        for x in (-0.78, 0.0, 0.78):
            for z in (0.4, 1.0):
                D.box(bm, 0.07, 0.03, 0.26, T(x, 0.13, z))
    parts.append(P('straps', 'iron', straps, hi='bevel', bevel=0.004))
    def spikes(bm):
        for x in (-0.4, 0.4):
            D.lathe(bm, [(0.0, -0.3), (0.04, -0.3), (0.04, 0.35), (0.0, 0.62)], 5, M=T(x, 0.3, 0.92, rx=-math.radians(62)))
    parts.append(P('spikes', 'wood', spikes, hi='sub', levels=1))
    return parts


# ============================================================================ props (fitted to the sim contract)

@piece
def crate(lod):
    a = 0.3
    H = 0.9
    rng = random.Random(3)
    parts = []
    def frame(bm):
        for sx in (-1, 1):
            for sy in (-1, 1):
                D.box(bm, 0.07, 0.07, H, T(sx * (a - 0.035), sy * (a - 0.035), H / 2))
    parts.append(P('posts', 'wood_dark', frame, hi='bevel', bevel=0.008))
    def boards(bm):
        for side in range(4):
            rot = side * math.pi / 2
            for k in range(4):
                z = 0.12 + k * 0.215
                D.box(bm, 2 * a - 0.02 + rng.uniform(-0.01, 0.01), 0.022, 0.195, T(0, 0, 0, rz=rot) @ T(rng.uniform(-0.01, 0.01), a + 0.008, z, rx=rng.uniform(-0.02, 0.02)))
            ang = math.atan2(H - 0.12, 2 * a - 0.08)
            D.box(bm, math.hypot(H - 0.12, 2 * a - 0.08), 0.022, 0.09, T(0, 0, 0, rz=rot) @ T(0, a + 0.03, H / 2, ry=ang * (1 if side % 2 else -1)))
        for k in range(3):
            D.box(bm, 2 * a + 0.02, 0.19, 0.03, T(0, (k - 1) * 0.2, H - 0.015))
    parts.append(P('boards', 'wood', boards, hi='bevel', bevel=0.006))
    def brackets(bm):
        for sx in (-1, 1):
            for sy in (-1, 1):
                for z in (0.06, H - 0.07):
                    D.box(bm, 0.11, 0.012, 0.1, T(sx * (a - 0.05), sy * (a + 0.026), z))
                    D.box(bm, 0.012, 0.11, 0.1, T(sx * (a + 0.026), sy * (a - 0.05), z))
    parts.append(P('brackets', 'iron', brackets, hi='bevel', bevel=0.003))
    return parts


def stave_grooves(bm, prof, n, segs=128, depth=0.004):
    """high-only: the barrel body with a groove at every stave joint (the low is a plain lathe)"""
    def rip(i, k):
        if k in (0, len(prof) - 1):
            return 1.0
        f = (i * n / segs) % 1.0
        return 1.0 - (depth / 0.38) * max(0.0, 1.0 - min(f, 1 - f) * segs / n * 2.5)
    D.lathe(bm, prof, segs, ripple=rip)


def barrel_prof(R, H, top_r):
    return [(0.0, 0.03), (top_r, 0.03), (top_r, 0.0), (top_r + 0.005, 0.0), (R * 0.92, H * 0.2), (R, H * 0.5), (R * 0.92, H * 0.8), (top_r + 0.005, H),
            (top_r - 0.012, H), (top_r - 0.012, H - 0.04), (0.0, H - 0.04)]


@piece
def barrel(lod):
    R, H, tr = 0.4, 1.0, 0.33
    prof = barrel_prof(R, H, tr)
    s = seg(lod, 16, 10)
    parts = [P('body', 'wood', lambda bm: D.lathe(bm, prof, s), hi='skip', smooth=True, sharp=50)]
    if lod == 0:
        parts.append(P('staves_hi', 'wood', lambda bm: stave_grooves(bm, prof, 16), hi='only'))
    rz = lambda z: R - (R - tr) * ((z - 0.5 * H) / (0.5 * H)) ** 2  # noqa: E731
    def hoops(bm):
        for z in (0.08, 0.3, 0.7, 0.92):
            D.lathe(bm, [(rz(z) - 0.004, z - 0.03), (rz(z) + 0.006, z - 0.03), (rz(z) + 0.006, z + 0.03), (rz(z) - 0.004, z + 0.03)], s)
    parts.append(P('hoops', 'iron', hoops, hi='bevel', bevel=0.003))
    return parts


@piece
def keg(lod):
    """the sim's explosive keg: dark staves, a red-painted band, heavy hoops, rope handles, a fuse plug (SOCK_glow)"""
    R, H, tr = 0.4, 0.94, 0.32
    s = seg(lod, 16, 10)
    rz = lambda z: R - (R - tr) * ((z - 0.5 * H) / (0.5 * H)) ** 2  # noqa: E731
    lowp = [(0.0, 0.03), (tr, 0.03), (tr, 0.0), (tr + 0.005, 0.0), (rz(0.2), 0.2), (rz(0.38), 0.38)]
    midp = [(rz(0.38), 0.38), (R, 0.5 * H), (rz(0.56), 0.56)]
    topp = [(rz(0.56), 0.56), (rz(0.75), 0.75), (tr + 0.005, H), (tr - 0.012, H), (tr - 0.012, H - 0.04), (0.0, H - 0.04)]
    parts = [
        P('bodyLow', 'wood_dark', lambda bm: D.lathe(bm, lowp + [(0.0, 0.38)], s), hi='sub', levels=1),
        P('band', 'red_paint', lambda bm: D.lathe(bm, [(0.0, 0.38)] + midp + [(0.0, 0.56)], s), hi='sub', levels=1),
        P('bodyTop', 'wood_dark', lambda bm: D.lathe(bm, [(0.0, 0.56)] + topp, s), hi='sub', levels=1),
    ]
    def hoops(bm):
        for z in (0.07, 0.25, 0.4, 0.54, 0.69, 0.87):
            D.lathe(bm, [(rz(z) - 0.004, z - 0.022), (rz(z) + 0.009, z - 0.022), (rz(z) + 0.009, z + 0.022), (rz(z) - 0.004, z + 0.022)], s)
    parts.append(P('hoops', 'iron_sooty', hoops, hi='bevel', bevel=0.003))
    parts.append(P('handles', 'rope', lambda bm: [D.torus(bm, 0.07, 0.014, seg(lod, 10, 6), 4, T(sx * (rz(0.62) + 0.02), 0, 0.62, ry=math.pi / 2)) for sx in (-1, 1)], hi='sub', levels=1))
    parts.append(P('plug', 'iron', lambda bm: D.cyl(bm, 0.045, 0.04, H - 0.04, H + 0.01, seg(lod, 8, 6)), hi='sub', levels=1))
    parts.append(P('fuse', 'rope', lambda bm: D.tube(bm, D.bezier(Vector((0, 0, H)), Vector((0, 0, H + 0.03)), Vector((0.03, 0, H + 0.05)), Vector((0.06, 0, H + 0.055)), 5), 0.008, 4), hi='sub', levels=1))
    return parts


@piece
def urn(lod):
    prof = [(0.0, 0.0), (0.12, 0.0), (0.15, 0.02), (0.26, 0.18), (0.3, 0.32), (0.27, 0.45), (0.17, 0.55), (0.11, 0.6), (0.1, 0.64), (0.13, 0.68), (0.12, 0.7),
            (0.09, 0.7), (0.085, 0.62), (0.0, 0.6)]
    s = seg(lod, 20, 10)
    rng = random.Random(4)
    def body(bm):
        vs = D.lathe(bm, prof, s)
        for v in vs:
            if v.co.z > 0.66 and math.atan2(v.co.y, v.co.x) > 1.6:
                v.co.z -= rng.uniform(0.0, 0.035)  # chipped lip
    parts = [P('body', 'clay', body, hi='sub', levels=2, disp=(0.002, 0.05))]
    if lod == 0:
        parts.append(P('band_hi', 'clay_dark', lambda bm: D.lathe(bm, [(0.0, 0.33), (0.302, 0.33), (0.302, 0.36), (0.296, 0.39), (0.0, 0.39)], 96), hi='only'))
    def handles(bm):
        for sx in (-1, 1):
            pts = D.bezier(Vector((0.09 * sx, 0, 0.63)), Vector((0.2 * sx, 0, 0.64)), Vector((0.27 * sx, 0, 0.55)), Vector((0.255 * sx, 0, 0.45)), seg(lod, 7, 4))
            D.tube(bm, pts, 0.017, seg(lod, 6, 4))
    parts.append(P('handles', 'clay', handles, hi='sub', levels=1))
    return parts


@piece
def chunk(lod):
    def blk(bm):
        K.block(bm, 0.24, 0.2, 0.28, 0.03, center=(0, 0, 0.28), rot=0.3, tilt=(0.06, 0.04), cut=((0.6, 0.3, 0.75), 0.12))
    return [P('block', 'stone', blk, hi='stone', smooth=False, stone={'H': 0.6, 'chip': 0.04, 'chip_cell': 0.1, 'crack': 0.012, 'wet_h': 0.2})]


# ============================================================================ highfirst: skull, bone pile (metaballs)

def mesh_of(name, build):
    bm = bmesh.new()
    build(bm)
    return D.to_object(name, bm, True)


def apply_mods(o):
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
    o.modifiers.clear()
    old = o.data
    o.data = me
    bpy.data.meshes.remove(old)
    return o


def remesh_smooth(o, voxel, smooth_iter=8, factor=0.6):
    r = o.modifiers.new('rm', 'REMESH')
    r.mode = 'VOXEL'
    r.voxel_size = voxel
    sm = o.modifiers.new('sm', 'SMOOTH')
    sm.factor = factor
    sm.iterations = smooth_iter
    return apply_mods(o)


def boolean_cut(o, cutters):
    for c in cutters:
        m = o.modifiers.new('cut', 'BOOLEAN')
        m.operation = 'DIFFERENCE'
        m.object = c
        try:
            m.solver = 'EXACT'
        except Exception:
            pass
        apply_mods(o)
        bpy.data.objects.remove(c)
    return o


def skull_parts(bm, M):
    """cranium, face, cheekbones, maxilla, jaw as overlapping ellipsoids (skull ~ 0.2 m long, face toward -y)"""
    D.sphere(bm, 0.085, 20, 14, M @ T(0, 0.02, 0.12), squash=(0.92, 1.15, 0.92))
    D.sphere(bm, 0.06, 18, 12, M @ T(0, -0.05, 0.085), squash=(1.05, 0.75, 0.85))
    for sx in (-1, 1):
        D.sphere(bm, 0.02, 10, 8, M @ T(sx * 0.047, -0.07, 0.07), squash=(1.0, 1.3, 0.8))
    D.sphere(bm, 0.04, 14, 10, M @ T(0, -0.085, 0.045), squash=(1.05, 0.85, 0.75))
    D.sphere(bm, 0.046, 14, 10, M @ T(0, -0.07, 0.016), squash=(1.12, 1.0, 0.42))


def skull_cutters(M, tag):
    cs = []
    for sx in (-1, 1):
        cs.append(mesh_of(f'eye{tag}{sx}', lambda bm, sx=sx: D.sphere(bm, 0.025, 14, 10, M @ T(sx * 0.031, -0.098, 0.088), squash=(1.0, 1.0, 0.9))))
    cs.append(mesh_of(f'nose{tag}', lambda bm: D.sphere(bm, 0.015, 10, 8, M @ T(0, -0.115, 0.056), squash=(0.65, 1.0, 1.4))))
    cs.append(mesh_of(f'mouth{tag}', lambda bm: D.box(bm, 0.075, 0.06, 0.008, M @ T(0, -0.11, 0.03))))
    return cs


def recentre(o):
    co = [o.matrix_world @ v.co for v in o.data.vertices]
    zmin = min(c.z for c in co)
    cx = (min(c.x for c in co) + max(c.x for c in co)) / 2
    cy = (min(c.y for c in co) + max(c.y for c in co)) / 2
    o.data.transform(Matrix.Translation((-cx, -cy, -zmin)))
    o.data.update()


def skull_high():
    M = Matrix.Identity(4)
    o = mesh_of('skull_hi', lambda bm: skull_parts(bm, M))
    remesh_smooth(o, 0.003, 10, 0.6)
    boolean_cut(o, skull_cutters(M, 's'))
    remesh_smooth(o, 0.0025, 3, 0.4)
    recentre(o)
    return [(o, 'bone')]


def bone(bm, L, r, M):
    """a long bone: shaft with knobbly double ends (femur-ish)"""
    D.lathe(bm, [(0.0, -L / 2), (r * 0.9, -L / 2), (r * 0.55, -L / 2 + r * 1.6), (r * 0.45, 0.0), (r * 0.55, L / 2 - r * 1.6), (r * 0.9, L / 2), (0.0, L / 2)], 10, M=M @ T(rx=math.pi / 2))
    for sy in (-1, 1):
        for sx in (-1, 1):
            D.sphere(bm, r * 0.75, 10, 8, M @ T(sx * r * 0.45, sy * L / 2, 0))


def bone_pile_high():
    rng = random.Random(8)

    def build(bm):
        for k in range(14):
            a = rng.uniform(0, 2 * math.pi)
            d = rng.uniform(0.0, 0.5)
            L = rng.uniform(0.25, 0.45)
            r = rng.uniform(0.018, 0.026)
            z = r + 0.012 * k * (1 - d / 0.6)
            M = T(d * math.cos(a), d * math.sin(a), z, rz=rng.uniform(0, math.pi), rx=rng.uniform(-0.25, 0.25))
            bone(bm, L, r, M)
        # rib arcs
        for k in range(6):
            pts = [Vector((-0.28 + 0.16 * math.sin(t), 0.22 + k * 0.045, 0.02 + 0.14 * math.cos(t) * 0.7)) for t in [-1.2 + i * 0.3 for i in range(9)]]
            D.tube(bm, pts, 0.009, 6)
        for (sx, sy, rot, tilt) in ((0.12, -0.16, 0.6, 0.0), (-0.3, -0.12, -1.1, 0.4), (0.3, 0.2, 2.4, -0.2)):
            skull_parts(bm, T(sx, sy, 0.0, rz=rot, ry=tilt))
    o = mesh_of('bones_hi', build)
    remesh_smooth(o, 0.005, 6, 0.5)
    cut = []
    for k, (sx, sy, rot, tilt) in enumerate(((0.12, -0.16, 0.6, 0.0), (-0.3, -0.12, -1.1, 0.4), (0.3, 0.2, 2.4, -0.2))):
        cut += skull_cutters(T(sx, sy, 0.0, rz=rot, ry=tilt), f'b{k}')
    boolean_cut(o, cut)
    remesh_smooth(o, 0.004, 2, 0.4)
    recentre(o)
    return [(o, 'bone')]


# ============================================================================ registry -> job specs

def spec_for(name):
    S = dict(px=1024, px_low=512, ao=96, sources=list(IRON_SRC), sockets=[], extras={})
    glows = {'brazier_coals': GLOW_COALS, 'lantern_fire': GLOW_FIRE, 'paper_glow': GLOW_PAPER}
    dress = dict(role='dress')
    stone_src = [D.CC0['stone']]
    wood_src = [D.CC0['wood']]
    table = {
        'brazier_pedestal': dict(dress, kind='brazier', sources=IRON_SRC + stone_src, sockets=[('SOCK_flame', (0, 0, 1.8), {'size': 1.6, 'palette': 'theme', 'light': 1})]),
        'brazier_wall': dict(dress, kind='brazier', px=512, px_low=256, sockets=[('SOCK_flame', (0, 0, 1.0), {'size': 1.0, 'palette': 'theme', 'light': 0})]),
        'brazier_pillartop': dict(dress, kind='brazier', px=512, px_low=256, sockets=[('SOCK_flame', (0, 0, 0.5), {'size': 1.25, 'palette': 'theme', 'light': 0})]),
        'lantern_toro': dict(role='prop', kind='lantern', sources=stone_src, contract={'radius': 0.35, 'height': 1.6, 'source': 'src/sim/arenaGen.ts PROP_BASE.lantern.r, src/sim/world.ts TOP.lantern'},
                             frac=6, sockets=[('SOCK_glow', (0, 0, 0.97), {'color': '#ffb060', 'radius': 2.5})]),
        'lantern_cage': dict(dress, kind='lantern', px=512, px_low=256, sources=IRON_SRC, extras={'hang': 1}, sockets=[('SOCK_glow', (0, 0, -0.33), {'color': '#ffb060', 'radius': 2.0})]),
        'lantern_paper': dict(dress, kind='lantern', px=512, px_low=256, sources=IRON_SRC + wood_src, extras={'hang': 1}, sockets=[('SOCK_glow', (0, 0, -0.35), {'color': '#ff9a40', 'radius': 2.2})]),
        'candles': dict(dress, kind='candle', px=512, px_low=256, sources=[], sockets=candle_sockets()),
        'bell': dict(dress, kind='bell', px=512, px_low=256, sources=IRON_SRC + wood_src, extras={'hang': 1}),
        'skull': dict(dress, kind='skull', px=512, px_low=256, sources=[], high=skull_high, lod_tris={0: 1200, 1: 360}),
        'bone_pile': dict(dress, kind='bones', px=512, px_low=256, sources=[], high=bone_pile_high, lod_tris={0: 3600, 1: 1400}),
        'stakes': dict(dress, kind='stakes', sources=wood_src),
        'spike_grate': dict(role='hazard', kind='spikes', nodes=['body', 'SPIKES'], extras={'r0': 1.0, 'spikeDrop': 0.72}),
        'chain_weight': dict(role='hazard', kind='chains', px=512, px_low=256, extras={'r0': 0.36}, sockets=[('SOCK_chain', (0, 0, 0.42), {})]),
        'vent_grate': dict(role='hazard', kind='flamejet', sources=IRON_SRC + stone_src, extras={'r0': 1.0}),
        'crumble': dict(role='hazard', kind='crumble', sources=stone_src, nodes=['RIM'] + [f'SLAB_{k}' for k in range(7)], extras={'r0': 1.6}),
        'chain_link': dict(role='chain', kind='chain', px=512, px_low=256, nodes=['LINK_big', 'LINK_small'],
                           extras={'pitchBig': round(2 * 0.04 + 2 * (0.045 - 0.016), 4), 'pitchSmall': round(2 * 0.02 + 2 * (0.022 - 0.008), 4)}),
        'banner_pole': dict(role='feature', kind='banner', sources=IRON_SRC + wood_src + stone_src, frac=3, frac_vbias=3.0, extras={'r0': 0.28, 'height': 4.6},
                            sockets=[('SOCK_banner', (0, 0, 4.305), {'w': 1.1, 'h': 2.6})]),
        'barricade': dict(role='feature', kind='barricade', sources=IRON_SRC + wood_src, frac=8, frac_vbias=-0.5, extras={'r0': 0.7, 'height': 1.5}),
        'crate': dict(role='prop', kind='crate', sources=IRON_SRC + wood_src, frac=8, contract={'radius': 0.45, 'height': 0.9, 'source': 'src/sim/arenaGen.ts PROP_BASE.crate.r, src/sim/world.ts TOP.crate'}),
        'barrel': dict(role='prop', kind='barrel', sources=IRON_SRC + wood_src, frac=8, contract={'radius': 0.4, 'height': 1.0, 'source': 'src/sim/arenaGen.ts PROP_BASE.barrel.r, src/sim/world.ts TOP.barrel'}),
        'keg': dict(role='prop', kind='explosive', sources=IRON_SRC + wood_src, frac=8, contract={'radius': 0.4, 'height': 1.0, 'source': 'src/sim/arenaGen.ts PROP_BASE.explosive.r, src/sim/world.ts TOP.explosive'},
                    sockets=[('SOCK_glow', (0.06, 0, 0.995), {'color': '#ffd080', 'radius': 0.6, 'fuse': 1})]),
        'urn': dict(role='prop', kind='urn', px=512, px_low=256, sources=[], frac=7, contract={'radius': 0.32, 'height': 0.7, 'source': 'src/sim/arenaGen.ts PROP_BASE.urn.r, src/sim/world.ts TOP.urn'}),
        'chunk': dict(role='prop', kind='chunk', px=512, px_low=256, sources=stone_src, frac=4, contract={'radius': 0.38, 'height': 0.6, 'source': 'src/sim/world.ts chunk props (r 0.38) + TOP.chunk'}),
    }
    S.update(table[name])
    S['id'] = name
    S['glows'] = glows
    if 'high' not in S:
        S['build'] = PIECES[name]
    if name in ('candles',):
        S['sources'] = []
    if name in ('skull', 'bone_pile', 'urn'):
        S['sources'] = []
    return S


def extra(ap):
    ap.add_argument('--piece', required=True)
    ap.add_argument('--preview', type=int, default=1)


job = abake.Job(extra, __doc__)
spec = spec_for(job.a.piece)
fails = D.Asset(job, spec).run()
if fails:
    sys.exit(1)
