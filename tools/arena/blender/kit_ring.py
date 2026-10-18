"""A3 architecture modules on the shared STONE TRIM SHEET (arena art plan 5.2 / 5.3, milestone A3).

  --piece wall_a | wall_b     podium wall course 4 m x 0.9 m x 3.45 m (intact coping at the camera's wallH 3.45)
  --piece wall_broken         the same wall with a stepped, broken top (missing blocks down to 1.9 m, rough break faces)
  --piece arcade_bay          gallery bay 3.5 m x 0.9 m x 6.4 m: two piers, a round arch, upper storey, cornice
  --piece arcade_broken       the bay with a ruined upper storey (stepped broken top, no cornice)
  --piece arch                freestanding gate arch 6.6 m x 1.6 m x 7.5 m (3.2 m opening)
  --piece stairs              6-step flight 4 m wide (rise 0.2, tread 0.4) with cheek walls and a 1 m landing
  --piece plinth              statue plinth 1.6 x 1.6 x 1.2 (base course, rune frieze body, moulded cap)
  --piece dais                two-tier platform 4 x 4 x 0.6
  --piece balustrade          2 m balustrade (base course, 7 lathe balusters, one broken, moulded rail)
  --piece spear_fence         2 m spear fence (stone course + wrought-iron spears with leaf tips)

Faces are built with a trim ROW tag and a UV mode; then the mesh is cut on a 0.5 m grid (planes x / y / z), which
keeps every face inside one trim row band and gives vertices for the vertex AO. UVs: walls u = horizontal distance,
v = height within the row (2 m bands for ashlar / blocks); tops u = x, v = y; arch soffits u = arc length, v = depth;
balusters u = angle x radius. Vertex colour COLOR_0 (linear) = Cycles AO baked to vertices x wet darkening at the base,
so the shared trim material reads differently per module. Materials: 'stone_trim' (no textures in the module GLB: the
runtime binds the kit/stone_trim texture set, one material for every module = few draw calls) and 'iron' (factors).
GLB: KIT_<id> {role 'module', kind, width, depth, height, trim} > LOD0 / LOD1 (0.5 m / 1 m cut grid) + COL.
Run:  npm run arena:bake -- kit_wall_a   (group a3)
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

PIECES = ['wall_a', 'wall_b', 'wall_broken', 'arcade_bay', 'arcade_broken', 'arch', 'stairs', 'plinth', 'dais', 'balustrade', 'spear_fence']


def extra(ap):
    ap.add_argument('--piece', required=True, choices=PIECES)
    ap.add_argument('--ao-samples', type=int, default=96)
    ap.add_argument('--seed', type=int, default=5)
    ap.add_argument('--preview', type=int, default=1)


job = abake.Job(extra, __doc__)
a = job.a
ID = a.piece
ROWS = list(K.TRIM_ROWS.keys())
RH = {k: v[1] - v[0] for k, v in K.TRIM_ROWS.items()}
MODE_WALL, MODE_TOP, MODE_ARC, MODE_CYL = 0, 1, 2, 3
S = {}


class TB:
    """trim-mapped mesh builder: faces carry row / mode / extra float tags (arch centre + radius, v offset)"""

    def __init__(self):
        self.bm = bmesh.new()
        L = self.bm.faces.layers
        self.row = L.int.new('row')
        self.mode = L.int.new('mode')
        self.voff = L.float.new('voff')
        self.ax = L.float.new('ax')
        self.az = L.float.new('az')
        self.ar = L.float.new('ar')
        self.mat = L.int.new('matid')
        self.uoff = 0.0

    def face(self, pts, row, mode=MODE_WALL, voff=0.0, arc=None, mat=0):
        vs = [self.bm.verts.new(Vector(p)) for p in pts]
        f = self.bm.faces.new(vs)
        f[self.row] = ROWS.index(row)
        f[self.mode] = mode
        f[self.voff] = voff
        f[self.mat] = mat
        if arc:
            f[self.ax], f[self.az], f[self.ar] = arc
        return f

    def box(self, x0, x1, y0, y1, z0, z1, side='ashlar', top='plain', bottom=None, front=True, back=True, ends=True, voff_side=0.0, mat=0):
        """axis-aligned block; faces wound outward (front = -y)"""
        if front:
            self.face([(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)], side, voff=voff_side, mat=mat)
        if back:
            self.face([(x1, y1, z0), (x0, y1, z0), (x0, y1, z1), (x1, y1, z1)], side, voff=voff_side, mat=mat)
        if ends:
            self.face([(x0, y1, z0), (x0, y0, z0), (x0, y0, z1), (x0, y1, z1)], side, voff=voff_side, mat=mat)
            self.face([(x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1)], side, voff=voff_side, mat=mat)
        if top:
            self.face([(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)], top, MODE_TOP, mat=mat)
        if bottom:
            self.face([(x0, y1, z0), (x1, y1, z0), (x1, y0, z0), (x0, y0, z0)], bottom, MODE_TOP, mat=mat)


# ---------------------------------------------------------------------------- pieces

def wall(tb, w=4.0, d=0.9, h=3.45, broken=False, seed=0):
    r = random.Random(seed)
    x0, y0, y1 = -w / 2, -d / 2, d / 2
    cols = int(round(w / 0.5))
    tops = []
    for k in range(cols):
        if broken:
            # stepped ruin: missing courses, deeper in the middle of the run
            mid = 1 - abs((k + 0.5) / cols - 0.55) * 1.6
            lose = max(0, min(3, int(r.uniform(0, 3.2) * (0.5 + mid))))
            tops.append(3.0 - 0.5 * lose if lose else h)
        else:
            tops.append(h)
    if broken:
        tops[0] = tops[-1] = h  # ends keep the full height (neighbours line up)
    for k in range(cols):
        xa, xb = x0 + k * 0.5, x0 + (k + 1) * 0.5
        t = tops[k]
        body = min(t, 3.0)
        for y, sgn in ((y0, -1), (y1, 1)):
            pts = [(xa, y, 0), (xb, y, 0), (xb, y, body), (xa, y, body)] if sgn < 0 else [(xb, y, 0), (xa, y, 0), (xa, y, body), (xb, y, body)]
            tb.face(pts, 'ashlar')
            if t > 3.0:
                pts = [(xa, y, 3.0), (xb, y, 3.0), (xb, y, t), (xa, y, t)] if sgn < 0 else [(xb, y, 3.0), (xa, y, 3.0), (xa, y, t), (xb, y, t)]
                tb.face(pts, 'moulding', voff=0.55)
        tb.face([(xa, y0, t), (xb, y0, t), (xb, y1, t), (xa, y1, t)], 'rough' if t < h else 'plain', MODE_TOP)
        # step faces between columns of different height (break faces)
        if k + 1 < cols and tops[k + 1] != t:
            lo, hi = sorted((t, tops[k + 1]))
            if tops[k + 1] > t:
                tb.face([(xb, y1, lo), (xb, y0, lo), (xb, y0, hi), (xb, y1, hi)], 'rough')
            else:
                tb.face([(xb, y0, lo), (xb, y1, lo), (xb, y1, hi), (xb, y0, hi)], 'rough')
    tb.face([(x0, y1, 0), (x0, y0, 0), (x0, y0, tops[0]), (x0, y1, tops[0])], 'blocks')
    tb.face([(-x0, y0, 0), (-x0, y1, 0), (-x0, y1, tops[-1]), (-x0, y0, tops[-1])], 'blocks')
    return {'kind': 'wall', 'width': w, 'depth': d, 'height': h, 'tops': tops}


def arch_front(tb, y, sgn, w, aw, spring, top, n=12):
    """facade with a round arch opening (radius aw / 2, centre (0, spring)) from z 0 to `top`; piers + spandrels"""
    R = aw / 2
    hw = w / 2
    def F(pts, row, **kw):
        if sgn > 0:
            pts = [(p[0], p[1], p[2]) for p in pts]
            pts = [pts[1], pts[0], pts[3], pts[2]] if len(pts) == 4 else list(reversed(pts))
        tb.face(pts, row, **kw)
    # piers
    for xa, xb in ((-hw, -R), (R, hw)):
        F([(xa, y, 0), (xb, y, 0), (xb, y, spring), (xa, y, spring)], 'ashlar')
    # spandrels: fan from the arch curve to the bounding rectangle [-hw, hw] x [spring, top]
    corner = math.degrees(math.atan2(top - spring, hw))
    angs = sorted(set([0.0, corner, 180 - corner, 180.0] + [180.0 * k / n for k in range(n + 1)]))
    def bound(t):
        c, s = math.cos(math.radians(t)), math.sin(math.radians(t))
        k = min(hw / abs(c) if abs(c) > 1e-6 else 1e9, (top - spring) / s if s > 1e-6 else 1e9)
        return (c * k, spring + s * k)
    for t0, t1 in zip(angs, angs[1:]):
        a0 = (R * math.cos(math.radians(t0)), spring + R * math.sin(math.radians(t0)))
        a1 = (R * math.cos(math.radians(t1)), spring + R * math.sin(math.radians(t1)))
        b0, b1 = bound(t0), bound(t1)
        pts = [(a1[0], y, a1[1]), (a0[0], y, a0[1]), (b0[0], y, b0[1]), (b1[0], y, b1[1])]  # CCW in (x, z): faces -y
        tb.face(pts if sgn < 0 else pts[::-1], 'ashlar')
    return R


def arcade(tb, w=3.5, d=0.9, aw=1.9, spring=3.0, top=4.0, h=6.4, broken=False, seed=0):
    r = random.Random(seed)
    y0, y1 = -d / 2, d / 2
    R = aw / 2
    for y, sgn in ((y0, -1), (y1, 1)):
        arch_front(tb, y, sgn, w, aw, spring, top)
    # jambs (pier inner faces) and the soffit
    tb.face([(-R, y0, 0), (-R, y1, 0), (-R, y1, spring), (-R, y0, spring)], 'ashlar')
    tb.face([(R, y1, 0), (R, y0, 0), (R, y0, spring), (R, y1, spring)], 'ashlar')
    n = 12
    for k in range(n):
        t0, t1 = math.pi * k / n, math.pi * (k + 1) / n
        p0 = (R * math.cos(t0), spring + R * math.sin(t0))
        p1 = (R * math.cos(t1), spring + R * math.sin(t1))
        tb.face([(p0[0], y1, p0[1]), (p0[0], y0, p0[1]), (p1[0], y0, p1[1]), (p1[0], y1, p1[1])], 'plain', MODE_ARC, arc=(0.0, spring, R))
    # upper storey (z top .. h - 0.4) and cornice, stepped broken top when ruined
    cols = int(round(w / 0.5))
    hw = w / 2
    tops = []
    for k in range(cols):
        if broken:
            mid = 1 - abs((k + 0.5) / cols - r.uniform(0.3, 0.7)) * 1.5
            tops.append(max(top + 0.5, round((h - 0.4 - r.uniform(0.0, 2.2) * (0.4 + mid)) * 2) / 2))
        else:
            tops.append(h)
    for k in range(cols):
        xa, xb = -hw + k * 0.5, -hw + (k + 1) * 0.5
        t = tops[k]
        body = min(t, h - 0.4)
        for y, sgn in ((y0, -1), (y1, 1)):
            q = [(xa, y, top), (xb, y, top), (xb, y, body), (xa, y, body)]
            tb.face(q if sgn < 0 else [q[1], q[0], q[3], q[2]], 'ashlar')
            if t > h - 0.4:
                q = [(xa - 0.0, y - sgn * 0.0, h - 0.4), (xb, y, h - 0.4), (xb, y, t), (xa, y, t)]
                tb.face(q if sgn < 0 else [q[1], q[0], q[3], q[2]], 'moulding', voff=0.6)
        tb.face([(xa, y0, t), (xb, y0, t), (xb, y1, t), (xa, y1, t)], 'rough' if t < h else 'plain', MODE_TOP)
        if k + 1 < cols and tops[k + 1] != t:
            lo, hi = sorted((t, tops[k + 1]))
            if tops[k + 1] > t:
                tb.face([(xb, y1, lo), (xb, y0, lo), (xb, y0, hi), (xb, y1, hi)], 'rough')
            else:
                tb.face([(xb, y0, lo), (xb, y1, lo), (xb, y1, hi), (xb, y0, hi)], 'rough')
    tb.face([(-hw, y1, 0), (-hw, y0, 0), (-hw, y0, tops[0]), (-hw, y1, tops[0])], 'blocks')
    tb.face([(hw, y0, 0), (hw, y1, 0), (hw, y1, tops[-1]), (hw, y0, tops[-1])], 'blocks')
    return {'kind': 'arcade', 'width': w, 'depth': d, 'height': max(tops), 'opening': [aw, spring + R]}


def stairs(tb, w=4.0, n=6, rise=0.2, run=0.4, land=1.0, seed=0):
    r = random.Random(seed)
    hw = w / 2
    cheek = 0.35
    y = -(n * run + land) / 2
    for k in range(n):
        z0, z1 = k * rise, (k + 1) * rise
        ya = y + k * run
        # riser (worn: the nosing dips a little at random)
        dip = r.uniform(0, 0.025)
        tb.face([(-hw + cheek, ya, z0), (hw - cheek, ya, z0), (hw - cheek, ya, z1 - dip), (-hw + cheek, ya, z1 - dip)], 'blocks', voff=0.0)
        yb = ya + run if k < n - 1 else ya + run + land
        tb.face([(-hw + cheek, ya, z1 - dip), (hw - cheek, ya, z1 - dip), (hw - cheek, yb, z1), (-hw + cheek, yb, z1)], 'plain', MODE_TOP)
    ye = y + n * run + land
    top = n * rise
    # cheek walls: stepped side blocks
    for s in (-1, 1):
        xo, xi = s * hw, s * (hw - cheek)
        x0, x1 = (min(xo, xi), max(xo, xi))
        tb.box(x0, x1, y, ye, 0, top + 0.25, side='ashlar', top='plain', front=True, back=True, ends=True)
    tb.face([(-hw + cheek, ye, 0), (hw - cheek, ye, 0), (hw - cheek, ye, top), (-hw + cheek, ye, top)][::-1], 'ashlar')
    return {'kind': 'stairs', 'width': w, 'depth': ye - y, 'height': top + 0.25}


def plinth(tb):
    tb.box(-0.8, 0.8, -0.8, 0.8, 0.0, 0.25, side='blocks', top='plain')
    tb.box(-0.7, 0.7, -0.7, 0.7, 0.25, 0.95, side='frieze', top=None, voff_side=0.15)
    tb.box(-0.8, 0.8, -0.8, 0.8, 0.95, 1.2, side='moulding', top='plain', bottom='plain', voff_side=0.7)
    return {'kind': 'plinth', 'width': 1.6, 'depth': 1.6, 'height': 1.2}


def dais(tb):
    tb.box(-2.0, 2.0, -2.0, 2.0, 0.0, 0.3, side='blocks', top='plain')
    tb.box(-1.6, 1.6, -1.6, 1.6, 0.3, 0.6, side='blocks', top='plain', voff_side=0.3)
    return {'kind': 'dais', 'width': 4.0, 'depth': 4.0, 'height': 0.6}


def baluster(tb, x, y, z0, z1, broken=False, segs=10, lod=0):
    prof = [(0.075, 0.0), (0.075, 0.05), (0.05, 0.09), (0.055, 0.2), (0.09, 0.36), (0.085, 0.46), (0.05, 0.55), (0.045, 0.6), (0.07, 0.64), (0.07, 0.7)]
    hh = z1 - z0
    if lod:
        segs = 6
        prof = [prof[0], prof[2], prof[4], prof[6], prof[8], prof[9]]
    if broken:
        prof = [p for p in prof if p[1] < 0.37] + [(0.07, 0.4)]
    prev = None
    for k, (rr, zz) in enumerate(prof):
        ring = [(x + rr * math.cos(2 * math.pi * i / segs), y + rr * math.sin(2 * math.pi * i / segs), z0 + zz / 0.7 * hh) for i in range(segs + 1)]
        if prev is not None:
            for i in range(segs):
                tb.face([prev[i], prev[i + 1], ring[i + 1], ring[i]], 'plain', MODE_CYL, arc=(x, y, 0.0))
        prev = ring
    if broken:
        c = (x, y, z0 + 0.43 / 0.7 * hh)
        for i in range(segs):
            tb.face([prev[i], prev[i + 1], c], 'rough', MODE_TOP)


def balustrade(tb, seed=0):
    r = random.Random(seed)
    tb.box(-1.0, 1.0, -0.21, 0.21, 0.0, 0.22, side='blocks', top='plain')
    nb = 7
    broken = r.randrange(nb)
    for k in range(nb):
        x = -1.0 + (k + 0.5) * 2.0 / nb
        baluster(tb, x, 0.0, 0.22, 0.92, broken=(k == broken), lod=S.get('lodnow', 0))
    tb.box(-1.0, 1.0, -0.18, 0.18, 0.92, 1.08, side='moulding', top='plain', bottom='plain', voff_side=0.8)
    return {'kind': 'balustrade', 'width': 2.0, 'depth': 0.42, 'height': 1.08}


def spear_fence(tb, seed=0):
    tb.box(-1.0, 1.0, -0.25, 0.25, 0.0, 0.32, side='blocks', top='plain')
    tb.box(-1.0, 1.0, -0.27, 0.27, 0.32, 0.4, side='moulding', top='plain', bottom='plain', voff_side=0.82)
    r = random.Random(seed)
    for z in (0.55, 1.55):
        tb.box(-1.0, 1.0, -0.02, 0.02, z, z + 0.04, side='plain', top='plain', bottom='plain', mat=1)
    for k in range(9):
        x = -1.0 + (k + 0.5) * 2.0 / 9
        lean = r.uniform(-0.02, 0.02)
        e = 0.016
        tb.box(x - e, x + e, -e, e, 0.4, 1.78, side='plain', top=None, mat=1)
        # leaf spear tip: 4-sided double pyramid
        b, m, t = 1.78, 1.86, 2.0
        rr = 0.045
        P = [(x + rr, 0, m), (x, rr * 0.6, m), (x - rr, 0, m), (x, -rr * 0.6, m)]
        for i in range(4):
            p0, p1 = P[i], P[(i + 1) % 4]
            tb.face([p0, p1, (x + lean, 0, t)], 'plain', MODE_TOP, mat=1)
            tb.face([p1, p0, (x, 0, b)], 'plain', MODE_TOP, mat=1)
    return {'kind': 'spearfence', 'width': 2.0, 'depth': 0.54, 'height': 2.0}


def build_piece(tb):
    if ID in ('wall_a', 'wall_b', 'wall_broken'):
        return wall(tb, broken=ID == 'wall_broken', seed=a.seed + (0 if ID == 'wall_a' else 7))
    if ID in ('arcade_bay', 'arcade_broken'):
        return arcade(tb, broken=ID == 'arcade_broken', seed=a.seed + 3)
    if ID == 'arch':
        m = arcade(tb, w=6.6, d=1.6, aw=3.2, spring=3.4, top=6.0, h=7.5, seed=a.seed)
        m['kind'] = 'arch'
        return m
    if ID == 'stairs':
        return stairs(tb, seed=a.seed)
    if ID == 'plinth':
        return plinth(tb)
    if ID == 'dais':
        return dais(tb)
    if ID == 'balustrade':
        return balustrade(tb, seed=a.seed)
    return spear_fence(tb, seed=a.seed)


# ---------------------------------------------------------------------------- finish: cut grid, UVs, vertex AO

def cut_grid(bm, step, bounds):
    (x0, y0, z0), (x1, y1, z1) = bounds
    for axis, lo, hi in ((0, x0, x1), (1, y0, y1), (2, z0, z1)):
        k = math.floor(lo / step) + 1
        while k * step < hi - 1e-4:
            no = [0, 0, 0]
            no[axis] = 1
            co = [0, 0, 0]
            co[axis] = k * step
            bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=co, plane_no=no)
            k += 1


def assign_uvs(tb, bm, uoff):
    uv = bm.loops.layers.uv.verify()
    T = K.TRIM_SIZE
    for f in bm.faces:
        row = ROWS[f[tb.row]]
        v0, v1 = K.TRIM_ROWS[row]
        rh = v1 - v0
        mode = f[tb.mode]
        c = f.calc_center_median()
        n = f.normal
        for lp in f.loops:
            p = lp.vert.co
            if mode == MODE_WALL and abs(n.z) < 0.75:
                t = Vector((-n.y, n.x, 0.0))
                t = t.normalized() if t.length > 1e-6 else Vector((1, 0, 0))
                zref = math.floor(c.z / rh + 1e-4) * rh
                u = p.dot(t) + uoff
                v = v0 + min(rh - 0.002, max(0.002, p.z - zref + f[tb.voff]))
            elif mode == MODE_ARC:
                ang = math.atan2(p.z - f[tb.az], p.x - f[tb.ax])
                u = ang * f[tb.ar] + uoff
                v = v0 + min(rh - 0.002, max(0.002, p.y + 0.5))
            elif mode == MODE_CYL:
                ang = math.atan2(p.y - f[tb.az], p.x - f[tb.ax])
                u = ang * 0.08 + uoff
                v = v0 + min(rh - 0.002, max(0.002, (p.z % rh)))
            else:  # tops / bottoms (and walls tilted > ~40 deg)
                yref = math.floor(c.y / rh + 1e-4) * rh
                u = p.x + uoff
                v = v0 + min(rh - 0.002, max(0.002, p.y - yref))
            lp[uv].uv = (u / T, v / T)


def ruin_silhouette(bm, b0, b1):
    """position-driven (so the unshared face corners stay welded) damage of the outline: the top edge sags and is
    bitten by up to 9 cm, the module ends lean in by up to 4 cm (not a straight CG box)"""
    co = np.array([v.co[:] for v in bm.verts], np.float64)
    n1 = K.fbm3(co * 1.9, 3, a.seed + 101)
    n2 = K.fbm3(co * 4.3, 2, a.seed + 102)
    top = b1[2]
    for v, k1, k2 in zip(bm.verts, n1, n2):
        if v.co.z > top - 0.6:
            w = (v.co.z - (top - 0.6)) / 0.6
            v.co.z -= w * w * (0.09 * K.smoothstep(0.4, 0.75, k1) + 0.025 * k2)
        for ax, lo, hi in ((0, b0[0], b1[0]),):
            if v.co[ax] > hi - 0.3 or v.co[ax] < lo + 0.3:
                v.co[ax] += (-1 if v.co[ax] > 0 else 1) * 0.04 * K.smoothstep(0.45, 0.8, k2) * (v.co.z / max(1e-3, top))


def make_lod(lod, step):
    S['lodnow'] = lod
    tb = TB()
    tb.uoff = random.Random(a.seed + hash(ID) % 997).uniform(0, 8)
    meta = build_piece(tb)
    bm = tb.bm
    xs = [v.co for v in bm.verts]
    b0 = (min(p.x for p in xs), min(p.y for p in xs), min(p.z for p in xs))
    b1 = (max(p.x for p in xs), max(p.y for p in xs), max(p.z for p in xs))
    if step:
        cut_grid(bm, step, (b0, b1))
    bm.normal_update()
    assign_uvs(tb, bm, tb.uoff)
    if meta['kind'] in ('wall', 'arcade', 'arch'):
        ruin_silhouette(bm, b0, b1)
        bm.normal_update()
        xs = [v.co for v in bm.verts]
        b0 = (min(p.x for p in xs), min(p.y for p in xs), min(p.z for p in xs))
        b1 = (max(p.x for p in xs), max(p.y for p in xs), max(p.z for p in xs))
    me = bpy.data.meshes.new(f'{ID}_lod{lod}')
    mats = [bm.faces.layers.int.get('matid')]
    mi = [f[mats[0]] for f in bm.faces]
    bm.to_mesh(me)
    bm.free()
    o = K.link(bpy.data.objects.new(f'{ID}_lod{lod}', me))
    o.data.materials.append(S['mat_stone'])
    o.data.materials.append(S['mat_iron'])
    me.polygons.foreach_set('material_index', mi)
    meta['bounds'] = [list(b0), list(b1)]
    return o, meta


def vertex_ao(o, ground):
    """Cycles AO baked to a POINT colour attribute, then x wet darkening at the base -> 'Col' (linear float)"""
    s = bpy.context.scene
    me = o.data
    att = me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
    me.color_attributes.active_color = att
    try:
        me.color_attributes.render_color_index = me.color_attributes.active_color_index
    except Exception:
        pass
    s.render.engine = 'CYCLES'
    s.cycles.samples = a.ao_samples
    s.render.bake.target = 'VERTEX_COLORS'
    s.render.bake.use_selected_to_active = False
    s.render.bake.max_ray_distance = 2.0
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.bake(type='AO')
    nv = len(me.vertices)
    col = np.empty(nv * 4, np.float32)
    att.data.foreach_get('color', col)
    col = col.reshape(-1, 4)
    co = np.empty(nv * 3, np.float32)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    ao = np.clip(col[:, 0], 0, 1)
    z = co[:, 2]
    rnd = np.random.default_rng(a.seed)
    wl = 0.5 * (0.8 + 0.4 * K.fbm3(co * 1.7, 3, a.seed))
    wet = 1 - K.smoothstep(wl * 0.4, wl, z)
    # grime: stone near the top of tall modules a little lighter (washed), streaky darker below ledges via AO
    shade = (0.35 + 0.65 * ao) * (1 - 0.42 * wet) * (0.94 + 0.12 * K.fbm3(co * 0.6, 2, a.seed + 3))
    _ = rnd
    out = np.c_[shade, shade, shade, np.ones(nv)].astype(np.float32)
    att.data.foreach_set('color', out.ravel())
    s.render.bake.target = 'IMAGE_TEXTURES'
    return {'aoMean': float(ao.mean()), 'wetShare': float((wet > 0.5).mean())}


def build():
    abake.reset()
    abake.cycles_device('CPU', a.threads)
    S['mat_stone'] = K.material_plain('stone_trim', (0.12, 0.12, 0.14), rough=0.85)
    S['mat_iron'] = K.material_plain('iron', (0.035, 0.032, 0.03), rough=0.55, metal=0.85)
    lods = {}
    for lod, step in ((0, 0.5), (1, 1.0)):
        o, meta = make_lod(lod, step)
        lods[lod] = o
        S['meta'] = meta if lod == 0 else S['meta']
    S['lod'] = lods
    bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, -0.001))
    S['ground'] = bpy.context.active_object
    S['ground'].data.materials.append(K.material_plain('ground', (0.2, 0.2, 0.2)))
    res = {}
    for lod, o in lods.items():
        lods[1 - lod].hide_render = True
        res[lod] = vertex_ao(o, S['ground'])
        lods[1 - lod].hide_render = False
    tris = {lod: abake.tri_count(o) for lod, o in lods.items()}
    return {'meta': S['meta'], 'tris': tris, 'vertexAO': res}


def export():
    m = S['meta']
    S['ground'].hide_render = True
    (bx0, by0, bz0), (bx1, by1, bz1) = m['bounds']
    root = abake.empty(f'KIT_{ID}', id=f'kit/{ID}', role='module', kind=m['kind'], width=m['width'], depth=m['depth'], height=round(bz1, 4), trim='kit/stone_trim')
    used_iron = False
    for lod, o in S['lod'].items():
        e = abake.empty(f'LOD{lod}', parent=root, lod=lod)
        o.parent = e
        used_iron = used_iron or any(p.material_index == 1 for p in o.data.polygons)
    bm = bmesh.new()
    K.loft(bm, [K.square_ring((bx1 - bx0) / 2, (by1 - by0) / 2, 0.0, 0, (bx0 + bx1) / 2, (by0 + by1) / 2), K.square_ring((bx1 - bx0) / 2, (by1 - by0) / 2, bz1, 0, (bx0 + bx1) / 2, (by0 + by1) / 2)])
    col = K.to_object('COL', bm)
    col.parent = root
    col['col'] = 1
    col.hide_render = True
    objs = [root, col] + [c for c in root.children_recursive]
    # drop the unused iron slot (glTF would still export an empty material otherwise)
    if not used_iron:
        for o in S['lod'].values():
            o.data.materials.pop(index=1)
    path = os.path.join(job.out, f'{ID}_raw.glb')
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    kw = dict(filepath=path, export_format='GLB', export_yup=True, export_apply=True, export_extras=True, use_selection=True,
              export_draco_mesh_compression_enable=False, export_image_format='NONE')
    for k, v in (('export_vertex_color', 'ACTIVE'), ('export_all_vertex_colors', False), ('export_active_vertex_color_when_no_material', True)):
        try:
            bpy.ops.export_scene.gltf.get_rna_type().properties[k]
            kw[k] = v
        except Exception:
            pass
    bpy.ops.export_scene.gltf(**kw)
    mats = {'stone_trim': {'trim': 'kit/stone_trim', 'baseColorFactor': [1, 1, 1, 1], 'metallicFactor': 0.0, 'roughnessFactor': 1.0}}
    if used_iron:
        mats['iron'] = {'baseColorFactor': [0.035, 0.032, 0.03, 1], 'metallicFactor': 0.85, 'roughnessFactor': 0.55}
    asset = {
        'id': f'kit/{ID}', 'glb': os.path.basename(path), 'role': 'module', 'kind': m['kind'],
        'contract': {'width': m['width'], 'depth': m['depth'], 'height': round(bz1, 4), 'bounds': m['bounds'], 'trim': 'kit/stone_trim',
                     'frame': 'origin at the base centre; Blender -y (three +z) = the face towards the arena'},
        'lods': {'LOD0': {'materials': list(mats)}, 'LOD1': {'materials': list(mats)}},
        'materials': mats,
        'sources': [],
        'job': os.path.basename(job.out),
    }
    with open(os.path.join(job.out, 'asset.json'), 'w', encoding='utf-8') as f:
        json.dump(asset, f, indent=1)
    return {'bytes': os.path.getsize(path), 'iron': used_iron}


def preview():
    """the module with the trim sheet applied (if built) x vertex AO, LOD0 left / LOD1 right"""
    if not a.preview:
        return 'skipped'
    tdir = os.path.join(os.path.dirname(job.out), 'kit_stone_trim')
    maps = {'baseColor': 'stone_trim_basecolor.png', 'normal': 'stone_trim_normal.png', 'orm': 'stone_trim_orm.png'}
    if os.path.exists(os.path.join(tdir, maps['baseColor'])):
        mt = K.textured_material('trim_prev', tdir, maps)
        nt = mt.node_tree
        b = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
        ca = nt.nodes.new('ShaderNodeVertexColor')
        ca.layer_name = 'Col'
        mix = nt.nodes.new('ShaderNodeMix')
        mix.data_type = 'RGBA'
        mix.blend_type = 'MULTIPLY'
        mix.inputs['Factor'].default_value = 1.0
        src = b.inputs['Base Color'].links[0].from_socket
        nt.links.new(src, next(x for x in mix.inputs if x.name == 'A' and x.type == 'RGBA'))
        nt.links.new(ca.outputs['Color'], next(x for x in mix.inputs if x.name == 'B' and x.type == 'RGBA'))
        nt.links.new(next(x for x in mix.outputs if x.name == 'Result' and x.type == 'RGBA'), b.inputs['Base Color'])
        for o in S['lod'].values():
            o.data.materials[0] = mt
    m = S['meta']
    (bx0, by0, bz0), (bx1, by1, bz1) = m['bounds']
    W = bx1 - bx0
    l0, l1 = bpy.data.objects['LOD0'], bpy.data.objects['LOD1']
    l0.parent = l1.parent = None
    sp = W * 0.5 + 0.5
    tall = max(bz1, 1.2)
    dist = max(W * 2.2, tall * 1.9) + 2
    return K.preview_scene([(l0, -sp), (l1, sp)], os.path.join(job.out, f'{ID}_preview.png'), size=(1440, 800),
                           cam_loc=(dist * 0.25, -dist, tall * 0.55 + 0.6), look=(0, 0, tall * 0.42), lens=40)


job.step('build', build)
job.step('export', export)
job.step('preview', preview)
fails = [r['step'] for r in job.steps if not r['ok']]
job.result['failed'] = fails
job.done()
if fails:
    sys.exit(1)
