"""A5 statues and colossi (arena art plan 5.4, milestone A5): posed-fighter statues carved from stone.

  --piece statue_hooded   hooded guardian (ref-3): robe, mantle, deep hood, sleeves, hands on the pommel of a sword
                          planted point-down; base Paladin.fbx (Aldric; Vex's model carries sickles / rings that poke out)
  --piece statue_knight   knight colossus (ref-7): plate armour, hood + cowl, cloak behind, hands on a greatsword;
                          base Paladin.fbx (Aldric)
  --piece statue_mage     staff saint / mage (ref-8): robe, hood, staff with a ring head in the right hand, left hand
                          raised; base erika-archer.fbx (Erika; Ozrel's model carries a shoulder blade that pokes out)
  --piece colossus_goddess   backdrop source (ref-9): veiled goddess in a gown, hands at the chest; base erika-archer.fbx
  --piece colossus_seated    backdrop source (ref-5): hooded seated (lotus) colossus, hands in the lap; base brute.fbx
All bases are the ORIGINAL Mixamo FBX files in Assets/Models (owner 2026-10-18: fighter bases allowed; the Models_HF
characters, licence unknown, are not used).

Pipeline (one Blender process per piece, tools/arena/jobs.json group a5):
  pose      import the FBX, pose the Mixamo rig by AIMING bones (analytic two-bone arm IK + world-space bone directions;
            the 5.0 legacy Action API is gone and our clip JSON is a runtime format) and curl the fingers
  drapery   carved cloth as SOLID shapes built around the posed body (it is stone): robe lofted over the body's own
            cross-sections (sampled from the torso / leg vertices) with folds (rounded ridges, sharp creases, growing
            toward a flared hem), mantle over the shoulders, deep hood (ellipsoid minus a face opening, peak pulled back),
            sleeves along the arm bones, back cloak (knight), lap drape (seated); weapons: sword (point down), staff
  monolith  everything joined and voxel-remeshed + smoothed into one stone body, scaled to the target height
  weather   stonekit.weather_high: chips on every ridge (fold crests, knuckles, hood rim), cracks, erosion pits, soot
            streaks from the top, damp base, moss in up-facing cavities ('tint' attribute) + the CC0 lichen-rock scan
Statues (toppleable sim `statue` obstacles, nominal r0 0.85, H 5.0 = src/sim/arenaGen.ts THEME_RULES.desert):
  + a square plinth (runtime fit 'statue': the plinth takes the sim radius o.r in x / z, the figure scales uniformly so
    the top lands exactly on o.h; a 9-slice band would squash the figure)
  -> LOD0 / LOD1 = decimated monolith + procedural plinth -> Smart UV -> bakes (normal, AO, base colour, roughness)
  -> FRAC_* = fracture.fracture_axis (tilted cuts at plinth top, knees, waist, chest, neck + axial splits, rough caps)
  -> COL hull, KIT_ extras (role 'statue', kind 'statue', r0, footprintR, height, fit 'statue', plinthTop) -> GLB + asset.json
Colossi (A6 backdrop sources): the weathered high only, saved as <piece>_hi.blend (object COLOSSUS, stone material,
  'tint' attribute) + a preview; A6 links it into the backdrop scenes (bpy.data.libraries.load) and scales it.
Run: npm run arena:bake -- statue_hooded     (stage preview of the pose only: --stage figure)
"""
import json
import math
import os
import random
import re
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import abake  # noqa: E402
import dresskit as D  # noqa: E402
import fracture  # noqa: E402
import stonekit as K  # noqa: E402

PIECES = {
    'statue_hooded': dict(fbx='Paladin.fbx', fighter='aldric', kind='statue', fig=3.95, drape=('robe', 'mantle', 'hood', 'sleeves'), prop='sword', pose='guard', tris=(7000, 2200), px=(1024, 512)),
    'statue_knight': dict(fbx='Paladin.fbx', fighter='aldric', kind='statue', fig=3.95, drape=('cloak', 'mantle', 'hood'), prop='greatsword', pose='guard', tris=(7000, 2200), px=(1024, 512)),
    'statue_mage': dict(fbx='erika-archer.fbx', fighter='erika', kind='statue', fig=3.95, drape=('robe', 'mantle', 'hood', 'sleeves'), prop='staff', pose='staff', tris=(7000, 2200), px=(1024, 512)),
    'colossus_goddess': dict(fbx='erika-archer.fbx', fighter='erika', kind='colossus', fig=12.0, drape=('gown', 'mantle', 'veil', 'sleeves'), prop=None, pose='pray'),
    'colossus_seated': dict(fbx='brute.fbx', fighter='gorak', kind='colossus', fig=9.0, drape=('robe_upper', 'lap', 'mantle', 'hood', 'sleeves'), prop=None, pose='seated'),
}
PLINTH = dict(r0=0.85, H=5.0, half=0.78, h=1.05, y0=0.32, y1=0.78)  # y0 / y1: the die (plain band between the mouldings)
TORSO = ('Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'LeftShoulder', 'RightShoulder')
LEGS = ('LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg', 'LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase', 'LeftToe_End', 'RightToe_End')
HEAD = ('Head', 'HeadTop_End', 'LeftEye', 'RightEye')


def extra(ap):
    ap.add_argument('--piece', required=True, choices=list(PIECES))
    ap.add_argument('--stage', default='all', choices=['all', 'figure'])
    ap.add_argument('--seed', type=int, default=11)
    ap.add_argument('--preview', type=int, default=1)
    ap.add_argument('--cc0', default='polyhaven/lichen_rock')


job = abake.Job(extra, __doc__)
a = job.a
ID = a.piece
SP = PIECES[ID]
S = {}
FBX = os.path.join(abake.ROOT, '..', 'Assets', 'Models', SP['fbx'])


# ============================================================================ rig + pose

class Rig:
    def __init__(self, path):
        before = set(bpy.data.objects)
        bpy.ops.import_scene.fbx(filepath=path)
        new = [o for o in bpy.data.objects if o not in before]
        self.arm = next(o for o in new if o.type == 'ARMATURE')
        self.meshes = [o for o in new if o.type == 'MESH']
        # carried weapons are separate meshes in some models (brute's axe): statues get their own props
        for o in [m for m in self.meshes if re.search(r'axe|sword|shield|bow|weapon|quiver', m.name, re.I)]:
            self.meshes.remove(o)
            bpy.data.objects.remove(o)
        self.pre = next((b.name.split(':')[0] + ':' for b in self.arm.data.bones if ':' in b.name), '')
        bpy.context.view_layer.update()
        zs = [(m.matrix_world @ Vector(c)).z for m in self.meshes for c in m.bound_box]
        self.Hm = max(zs) - min(zs)
        self.z0 = min(zs)

    def pb(self, n):
        return self.arm.pose.bones[self.pre + n]

    def has(self, n):
        return (self.pre + n) in self.arm.pose.bones

    def head(self, n):
        bpy.context.view_layer.update()
        return self.arm.matrix_world @ self.pb(n).head

    def tail(self, n):
        bpy.context.view_layer.update()
        return self.arm.matrix_world @ self.pb(n).tail

    def aim(self, n, d):
        """rotate bone n (minimal rotation) so its head->tail points along world direction d"""
        if not self.has(n):
            return
        bpy.context.view_layer.update()
        pb = self.pb(n)
        A3 = self.arm.matrix_world.to_3x3().inverted()
        da = (A3 @ Vector(d)).normalized()
        M = pb.matrix.copy()
        R = M.to_3x3().normalized()
        q = R.col[1].normalized().rotation_difference(da)
        M2 = (q.to_matrix() @ R).to_4x4()
        M2.translation = M.translation
        pb.matrix = M2
        bpy.context.view_layer.update()

    def arm_ik(self, side, wrist, pole, hand_dir):
        Sh = self.head(side + 'Arm')
        L1 = (self.head(side + 'ForeArm') - Sh).length
        L2 = (self.head(side + 'Hand') - self.head(side + 'ForeArm')).length
        T = Vector(wrist)
        d = T - Sh
        dist = min(max(d.length, 1e-3), (L1 + L2) * 0.998)
        u = d.normalized()
        aa = (L1 * L1 - L2 * L2 + dist * dist) / (2 * dist)
        h = math.sqrt(max(0.0, L1 * L1 - aa * aa))
        p = Vector(pole)
        p = (p - u * p.dot(u)).normalized()
        E = Sh + u * aa + p * h
        self.aim(side + 'Arm', E - Sh)
        self.aim(side + 'ForeArm', T - self.head(side + 'ForeArm'))
        self.aim(side + 'Hand', hand_dir)

    def curl(self, side, amount=1.0, thumb=0.5):
        """fingers curled into a grip: each phalanx bent about its own local X"""
        for f in ('Index', 'Middle', 'Ring', 'Pinky', 'Thumb'):
            for k in (1, 2, 3):
                n = f'{side}Hand{f}{k}'
                if not self.has(n):
                    continue
                pb = self.pb(n)
                pb.rotation_mode = 'XYZ'
                ang = (thumb if f == 'Thumb' else amount) * (0.55 if k == 1 else 0.95)
                pb.rotation_euler = (ang, 0.0, 0.0)
        bpy.context.view_layer.update()

    def leg(self, side, thigh, shin, foot):
        self.aim(side + 'UpLeg', thigh)
        self.aim(side + 'Leg', shin)
        self.aim(side + 'Foot', foot)


def pose(R):
    """the piece's pose; returns props in model (import) space: dict of grip / staff anchors"""
    H = R.Hm
    hips = R.head('Hips')
    out = {}
    kind = SP['pose']
    # head bowed a little (statues look down at the arena)
    if kind in ('guard', 'staff', 'pray', 'seated'):
        R.aim('Spine2', (0, -0.04, 1))
        R.aim('Neck', (0, -0.18, 1))
        R.aim('Head', (0, -0.32 if kind != 'pray' else -0.2, 1))
    if kind == 'guard':
        # both hands on the pommel of a sword planted point-down in front of the feet
        G = Vector((hips.x, hips.y - 0.19 * H, hips.z + 0.1 * H))
        R.arm_ik('Left', G + Vector((0.045 * H, 0.012 * H, 0.03 * H)), (1, 0.7, -0.2), (-1, -0.25, -0.15))
        R.arm_ik('Right', G + Vector((-0.045 * H, 0.012 * H, -0.035 * H)), (-1, 0.7, -0.2), (1, -0.25, 0.15))
        R.curl('Left')
        R.curl('Right')
        out['grip'] = G
    elif kind == 'staff':
        St = Vector((hips.x - 0.22 * H, hips.y - 0.07 * H, 0.0))
        R.arm_ik('Right', Vector((St.x + 0.045 * H, St.y + 0.01 * H, hips.z + 0.16 * H)), (-0.6, 0.8, -0.3), (-1, -0.15, 0.05))
        R.curl('Right')
        R.arm_ik('Left', Vector((hips.x + 0.07 * H, hips.y - 0.21 * H, hips.z + 0.2 * H)), (1, 0.4, -0.6), (0.1, -1, 0.25))
        R.curl('Left', 0.35, 0.2)
        out['staff'] = St
    elif kind == 'pray':
        C = Vector((hips.x, hips.y - 0.13 * H, hips.z + 0.2 * H))
        R.arm_ik('Left', C + Vector((0.03 * H, 0.0, -0.035 * H)), (1, 0.5, -0.6), (-0.35, -0.25, 1))
        R.arm_ik('Right', C + Vector((-0.03 * H, 0.0, -0.035 * H)), (-1, 0.5, -0.6), (0.35, -0.25, 1))
        R.curl('Left', 0.15, 0.1)
        R.curl('Right', 0.15, 0.1)
    elif kind == 'seated':
        # lotus: thighs out and forward, shins crossed in front, soles up; hands resting in the lap
        R.leg('Left', (0.72, -0.66, -0.2), (-0.86, -0.42, 0.05), (-0.4, 0.2, 0.9))
        R.leg('Right', (-0.72, -0.66, -0.16), (0.86, -0.42, 0.12), (0.4, 0.2, 0.9))
        L = Vector((hips.x, hips.y - 0.17 * H, hips.z + 0.035 * H))
        R.arm_ik('Left', L + Vector((0.075 * H, 0.02 * H, 0)), (1, 0.6, -0.1), (-1, -0.35, -0.1))
        R.arm_ik('Right', L + Vector((-0.05 * H, 0.0, 0.02 * H)), (-1, 0.6, -0.1), (1, -0.35, -0.1))
        R.curl('Left', 0.25, 0.3)
        R.curl('Right', 0.25, 0.3)
    return out


# ============================================================================ drapery (solid carved cloth)

def fold(theta, z, n, ph, amps=None):
    """carved cloth folds: rounded ridges and sharp creases (2|sin| - 1), the phase drifting with height (folds run a little
    diagonal), each fold with its own depth (amps, smoothly interpolated around the ring)"""
    x = n * theta / 2 + ph + 0.45 * math.sin(z * 1.7 + ph * 1.7)
    y = 0.7 * (2 * abs(math.sin(x)) - 1) + 0.3 * (2 * abs(math.sin(2.13 * x + 0.8 * ph)) - 1)
    if amps:
        u = (theta / (2 * math.pi)) * len(amps)
        i0 = int(u) % len(amps)
        t = u - int(u)
        y *= amps[i0] * (1 - t) + amps[(i0 + 1) % len(amps)] * t
    return y


def interp(z, ctrl):
    ctrl = sorted(ctrl, key=lambda c: c[0])
    if z <= ctrl[0][0]:
        return ctrl[0][1]
    for (z0, v0), (z1, v1) in zip(ctrl, ctrl[1:]):
        if z <= z1:
            t = (z - z0) / max(1e-9, z1 - z0)
            return v0.lerp(v1, t) if isinstance(v0, Vector) else v0 * (1 - t) + v1 * t
    return ctrl[-1][1]


def pct_extent(P, G, names, z, band):
    """robust half extents (3 / 97 percentiles) and centre of the named bones' vertices around height z"""
    Q = P[np.isin(G, names)]
    m = np.abs(Q[:, 2] - z) < band
    if m.sum() < 12:
        return None
    q = Q[m]
    lo, hi = np.percentile(q[:, 0], 3), np.percentile(q[:, 0], 97)
    lo2, hi2 = np.percentile(q[:, 1], 3), np.percentile(q[:, 1], 97)
    return ((lo + hi) / 2, (lo2 + hi2) / 2, (hi - lo) / 2, (hi2 - lo2) / 2)


def loft_rings(bm, rings, cap=True):
    return K.loft(bm, rings, cap_bottom=cap, cap_top=cap)


def robe(bm, L, P, G, H, z_bot, z_top, rng, folds=9, amp=(0.02, 0.085), flare=1.28, flare_h=0.38, depth=0.72, n=144,
         back_only=False, names=('Hips', 'Spine', 'Spine1', 'Spine2'), sampled=False, widths=None):
    """a solid robe from z_top down to z_bot. Default: the section comes from the skeleton (centre along feet -> hips ->
    chest, half widths from landmark proportions), widened to cover the named bones' vertices; sampled=True follows
    the named vertices only (lap drape). Folds deepen toward the flared hem, each fold with its own depth."""
    K_ = 40
    zs = [z_top + (z_bot - z_top) * k / (K_ - 1) for k in range(K_)]
    feet = (L['ftL'] + L['ftR']) / 2
    cen = [(feet.z, feet), (L['hips'].z, L['hips']), (L['sp2'].z, L['sp2']), (L['neck'].z, L['neck'])]
    w = widths or [(z_bot, 0.135 * H), (L['kn'], 0.128 * H), (L['hips'].z, 0.12 * H), (L['sp1'].z, 0.108 * H), (L['z_sh'], L['hw'] * 0.92)]
    rings = []
    ph = rng.uniform(0, 6.28)
    amps = [rng.uniform(0.45, 1.25) for _ in range(folds)]
    prev = None
    sec = []
    for z in zs:
        if sampled:
            e = pct_extent(P, G, names, z, 0.03 * H) or prev
            prev = e
            sec.append([e[0], e[1], e[2] + 0.025 * H, e[3] + 0.025 * H])
        else:
            c = interp(z, cen)
            rx = interp(z, w)
            ry = rx * depth
            e = pct_extent(P, G, names, z, 0.03 * H)
            if e:
                rx = max(rx, abs(e[0] - c.x) + e[2] + 0.02 * H)
                ry = max(ry, abs(e[1] - c.y) + e[3] + 0.02 * H)
            sec.append([c.x, c.y, rx, ry])
    # smooth the sections along the height (no belts / bulges where a sample band catches armour plates)
    A = np.array(sec)
    for _ in range(3):
        B = A.copy()
        B[1:-1] = (A[:-2] + 2 * A[1:-1] + A[2:]) / 4
        A = B
    if not sampled:
        # hanging cloth: from the hips down the section never narrows
        hz = L['hips'].z
        for k in range(1, len(zs)):
            if zs[k] < hz:
                A[k, 2] = max(A[k, 2], A[k - 1, 2])
                A[k, 3] = max(A[k, 3], A[k - 1, 3])
    for z, (cx, cy, rx, ry) in zip(zs, A):
        t = (z_top - z) / max(1e-6, z_top - z_bot)  # 0 top .. 1 hem
        fz = flare_h * H
        f = 1.0 + (flare - 1.0) * max(0.0, (fz - (z - z_bot)) / fz) ** 1.6
        am = amp[0] + (amp[1] - amp[0]) * t ** 1.2
        ring = []
        for i in range(n):
            th = 2 * math.pi * i / n
            rr = 1.0 + am * fold(th, z / H * 6, folds, ph, amps)
            x = cx + rx * f * rr * math.cos(th)
            y = cy + ry * f * rr * math.sin(th)
            if back_only:
                # a cloak hanging behind (+y): the back half keeps the robe section, the front half is a flat inner face
                # behind the body's centre plane, so the legs and armour stay visible from the front
                sy = math.sin(th)
                y = max(cy + 0.075 * H, cy + ry * f * rr * sy) if sy > 0 else cy + 0.075 * H
                x = cx + rx * f * rr * 1.04 * math.cos(th)
            ring.append(Vector((x, y, z)))
        rings.append(ring)
    loft_rings(bm, rings)


def tube_ripple(bm, pts, radii, sides, rng, amp=0.08, folds=7):
    ph = rng.uniform(0, 6.28)
    rings = []
    up = Vector((0, 0, 1))
    for k, p in enumerate(pts):
        t = (pts[min(k + 1, len(pts) - 1)] - pts[max(k - 1, 0)]).normalized()
        side = t.cross(up)
        if side.length < 1e-4:
            side = t.cross(Vector((1, 0, 0)))
        side.normalize()
        u2 = side.cross(t).normalized()
        r = radii[k]
        ring = []
        for i in range(sides):
            th = 2 * math.pi * i / sides
            rr = r * (1 + amp * fold(th, k * 0.7, folds, ph))
            ring.append(p + (side * math.cos(th) + u2 * math.sin(th)) * rr)
        rings.append(ring)
    loft_rings(bm, rings)


def ellipsoid(bm, C, axes, radii, useg=40, vseg=28):
    g = bmesh.ops.create_uvsphere(bm, u_segments=useg, v_segments=vseg, radius=1.0)
    s, f, u = axes
    for v in g['verts']:
        x, y, z = v.co
        v.co = C + s * (x * radii[0]) + f * (y * radii[1]) + u * (z * radii[2])
    return g['verts']


def head_frame(R, P, G):
    u = (R.tail('Head') - R.head('Head')).normalized()
    f = Vector((0, -1, 0))
    f = (f - u * f.dot(u)).normalized()
    s = f.cross(u).normalized()
    sel = np.isin(G, HEAD)
    Q = P[sel] if sel.sum() > 20 else P[np.isin(G, ('Neck',))]
    c = Vector(Q.mean(0))
    rel = Q - np.array(c[:])
    ext = [float(np.abs(rel @ np.array(ax[:])).max()) for ax in (s, f, u)]
    return c, (s, f, u), ext


def obj_from(name, build):
    bm = bmesh.new()
    build(bm)
    return K.to_object(name, bm, smooth=True)


def boolean_diff(o, cutter):
    m = o.modifiers.new('cut', 'BOOLEAN')
    m.operation = 'DIFFERENCE'
    m.object = cutter
    try:
        m.solver = 'EXACT'
    except Exception:
        pass
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
    o.modifiers.clear()
    old = o.data
    o.data = me
    bpy.data.meshes.remove(old)
    bpy.data.objects.remove(cutter)
    return o


def hood(R, P, G, H, rng, veil=False):
    c, (s, f, u), ext = head_frame(R, P, G)
    rad = (ext[0] * 1.32 + 0.012 * H, ext[1] * 1.28 + 0.012 * H, ext[2] * 1.22 + 0.014 * H)
    C = c + u * (0.008 * H) + f * (-0.006 * H)

    def build(bm):
        vs = ellipsoid(bm, C, (s, f, u), rad)
        for v in vs:
            d = v.co - C
            back = -d.dot(f) / rad[1]
            top = d.dot(u) / rad[2]
            # the peak: top-back pulled back and up
            w = max(0.0, back) * max(0.0, top)
            v.co += (-f * 0.6 + u * 0.4) * (0.06 * H * w * (0.6 if veil else 1.0))
            # cowl: the lower half flares onto the shoulders
            low = max(0.0, -top)
            v.co += (v.co - C - u * d.dot(u)).normalized() * (0.02 * H * low ** 2) if low > 0 else Vector()
            # soft fold ridges running back from the rim
            v.co += (v.co - C).normalized() * (0.004 * H * math.sin(math.atan2(d.dot(s), d.dot(u)) * 9))
    o = obj_from('hood', build)
    # the face opening: a deep oval cut from the front
    oc = C + f * (rad[1] * (0.88 if not veil else 0.8)) - u * (0.004 * H)
    cr = (ext[0] * (0.95 if not veil else 1.05), rad[1] * 0.75, ext[2] * (1.0 if not veil else 1.15))
    cut = obj_from('hood_cut', lambda bm: ellipsoid(bm, oc, (s, f, u), cr, 32, 24))
    return boolean_diff(o, cut)


def sleeves(R, H, rng):
    def build(bm):
        for side in ('Left', 'Right'):
            Sh, E, W = R.head(side + 'Arm'), R.head(side + 'ForeArm'), R.head(side + 'Hand')
            pts = []
            for k in range(7):
                t = k / 6
                pts.append(Sh.lerp(E, t))
            for k in range(1, 7):
                t = k / 6
                pts.append(E.lerp(W - (W - E).normalized() * 0.03 * H, t))
            radii = [0.048 * H] * 7 + [0.046 * H + 0.014 * H * (k / 6) ** 1.5 for k in range(1, 7)]
            tube_ripple(bm, pts, radii, 28, rng, amp=0.1, folds=6)
    return obj_from('sleeves', build)


def sword(G, H, great=False):
    def build(bm):
        w = (0.06 if great else 0.05) * H
        th = 0.014 * H
        gz = G.z - 0.06 * H
        tip = 0.02 * H
        # blade (diamond section, tapering to the point at the ground)
        rings = []
        for z, k in ((gz, 1.0), (gz - 0.1 * H, 0.95), (tip + 0.12 * H, 0.75), (tip + 0.03 * H, 0.3)):
            rings.append([Vector((G.x + w / 2 * k, G.y, z)), Vector((G.x, G.y + th / 2, z)), Vector((G.x - w / 2 * k, G.y, z)), Vector((G.x, G.y - th / 2, z))])
        K.loft(bm, rings, cap_bottom=False, cap_top=True, top_center=None)
        # crossguard, grip, pommel
        D.box(bm, (0.24 if great else 0.2) * H, 0.035 * H, 0.03 * H, D.T(G.x, G.y, gz))
        D.cyl(bm, 0.017 * H, 0.016 * H, gz, G.z + 0.055 * H, 12, D.T(G.x, G.y, 0))
        D.sphere(bm, 0.03 * H, 14, 10, D.T(G.x, G.y, G.z + 0.07 * H))
    return obj_from('sword', build)


def sword_tip_fix(o):
    """close the blade bottom with a cap (the loft leaves it open)"""
    bm = bmesh.new()
    bm.from_mesh(o.data)
    edges = [e for e in bm.edges if e.is_boundary]
    if edges:
        bmesh.ops.holes_fill(bm, edges=edges, sides=0)
    bm.to_mesh(o.data)
    bm.free()
    return o


def staff(St, H):
    def build(bm):
        top = 1.12 * H
        D.cyl(bm, 0.016 * H, 0.02 * H, 0.0, top, 12, D.T(St.x, St.y, 0))
        # ring head (vertical, facing forward) + an orb inside, a collar below
        D.torus(bm, 0.075 * H, 0.013 * H, 28, 10, D.T(St.x, St.y, top + 0.075 * H, rx=math.pi / 2))
        D.sphere(bm, 0.035 * H, 16, 12, D.T(St.x, St.y, top + 0.075 * H))
        D.cyl(bm, 0.028 * H, 0.022 * H, top - 0.06 * H, top + 0.005 * H, 12, D.T(St.x, St.y, 0))
    return obj_from('staff', build)


def figure():
    abake.reset()
    R = Rig(FBX)
    H = R.Hm
    rng = random.Random(a.seed)
    anchors = pose(R)
    hips = R.head('Hips')
    z_sh = R.head('LeftArm').z
    dr = SP['drape']
    # bone-based pieces first (the rig goes away with body_mesh)
    pre = []
    if 'sleeves' in dr:
        pre.append(sleeves(R, H, rng))
    lm = lambda n: R.head(n) if R.has(n) else hips  # noqa: E731
    landmarks = {'hips': hips, 'sp1': lm('Spine1'), 'sp2': lm('Spine2'), 'neck': lm('Neck'), 'z_sh': z_sh, 'z_neck': lm('Neck').z,
                 'hw': abs(R.head('LeftArm').x - R.head('RightArm').x) / 2, 'ftL': lm('LeftFoot'), 'ftR': lm('RightFoot'),
                 'kn': (lm('LeftLeg').z + lm('RightLeg').z) / 2}
    body, P, G = body_mesh_keep(R)
    if 'hood' in dr or 'veil' in dr:
        pre.append(hood(R, P, G, H, rng, veil='veil' in dr))
    for m in R.meshes:
        bpy.data.objects.remove(m)
    parts = [body] + pre
    zmin = float(P[:, 2].min())
    L = landmarks
    if 'robe' in dr:
        parts.append(obj_from('robe', lambda bm: robe(bm, L, P, G, H, zmin, z_sh - 0.04 * H, rng)))
    if 'gown' in dr:
        parts.append(obj_from('gown', lambda bm: robe(bm, L, P, G, H, zmin, z_sh - 0.04 * H, rng, folds=13, amp=(0.01, 0.06), flare=1.45, flare_h=0.55)))
    if 'robe_upper' in dr:
        parts.append(obj_from('robe_upper', lambda bm: robe(bm, L, P, G, H, hips.z - 0.03 * H, z_sh - 0.04 * H, rng, folds=8, amp=(0.01, 0.035), flare=1.12, flare_h=0.12)))
    if 'lap' in dr:
        legs = P[np.isin(G, LEGS)]
        parts.append(obj_from('lap', lambda bm: robe(bm, L, P, G, H, float(legs[:, 2].min()), float(legs[:, 2].max()) + 0.02 * H, rng, folds=12, amp=(0.02, 0.05),
                                                    flare=1.06, flare_h=0.05, names=LEGS + ('Hips',), sampled=True)))
    if 'cloak' in dr:
        parts.append(obj_from('cloak', lambda bm: robe(bm, L, P, G, H, zmin, z_sh - 0.01 * H, rng, folds=8, amp=(0.02, 0.09), flare=1.22, back_only=True,
                                                     names=('Hips', 'Spine', 'Spine1', 'Spine2', 'LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg'))))
    if 'mantle' in dr:
        parts.append(mantle_from(landmarks, P, G, H, rng))
    if SP['prop'] in ('sword', 'greatsword'):
        parts.append(sword_tip_fix(sword(anchors['grip'], H, SP['prop'] == 'greatsword')))
    elif SP['prop'] == 'staff':
        parts.append(staff(anchors['staff'], H))
    for o in parts:
        o.data.materials.clear()
    if a.stage == 'figure':
        bc = body.copy()
        bc.data = body.data.copy()
        bc.name = 'BODYCOPY'
        K.link(bc)
        S['bodycopy'] = bc
    fig = K.join(parts, 'FIG')
    # one stone monolith: voxel union + smoothing (model space; ~H / 300 voxels)
    if not os.environ.get('STATUE_NOREMESH'):
        rm = fig.modifiers.new('rm', 'REMESH')
        rm.mode = 'VOXEL'
        rm.voxel_size = H / 300
        sm = fig.modifiers.new('sm', 'SMOOTH')
        sm.factor = 0.6
        sm.iterations = 5
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(fig.evaluated_get(dg))
    fig.modifiers.clear()
    old = fig.data
    fig.data = me
    bpy.data.meshes.remove(old)
    me.name = 'FIG'
    # scale to the target figure height; centred on the footprint, standing at z 0
    co = np.array([v.co[:] for v in me.vertices])
    lo, hi = co.min(0), co.max(0)
    foot = co[co[:, 2] < lo[2] + 0.15 * (hi[2] - lo[2])]
    cx, cy = (foot[:, 0].min() + foot[:, 0].max()) / 2, (foot[:, 1].min() + foot[:, 1].max()) / 2
    s = SP['fig'] / (hi[2] - lo[2])
    if SP['kind'] == 'statue':
        # fits the plinth top (half size PLINTH half - 0.06) at the base; the upper body may overhang a little
        half = max(abs(foot[:, 0] - cx).max(), abs(foot[:, 1] - cy).max())
        s = min(s, (PLINTH['half'] - 0.07) / half)
    Mn = Matrix.Diagonal((s, s, s, 1.0)) @ Matrix.Translation((-cx, -cy, -lo[2]))
    me.transform(Mn)
    me.update()
    if 'bodycopy' in S:
        S['bodycopy'].data.transform(Mn)
    me.polygons.foreach_set('use_smooth', [True] * len(me.polygons))
    co = np.array([v.co[:] for v in me.vertices])
    S['fig'] = fig
    return {'Hm': round(H, 3), 'scale': round(s, 4), 'size': [round(float(x), 3) for x in (co.max(0) - co.min(0))], 'tris': abake.tri_count(fig),
            'groups': sorted(set(G.tolist()))[:40]}


def body_mesh_keep(R):
    """body_mesh without removing the rig meshes (the hood needs the head frame from the bones afterwards)"""
    dg = bpy.context.evaluated_depsgraph_get()
    objs, groups = [], []
    for m in R.meshes:
        ev = m.evaluated_get(dg)
        me = bpy.data.meshes.new_from_object(ev)
        me.transform(ev.matrix_world)
        names = [g.name.split(':')[-1] for g in m.vertex_groups]
        dom = []
        for v in m.data.vertices:
            best = max(v.groups, key=lambda g: g.weight, default=None)
            dom.append(names[best.group] if best is not None and best.group < len(names) else '')
        if len(dom) != len(me.vertices):
            dom = [''] * len(me.vertices)
        o = K.link(bpy.data.objects.new('body_' + m.name, me))
        o.data.materials.clear()
        objs.append(o)
        groups += dom
    body = K.join(objs, 'BODY')
    P = np.array([v.co[:] for v in body.data.vertices], np.float64)
    # game meshes are open shells (armour plates, sleeves): give every shell a thickness so the voxel union sees a
    # closed volume (without it whole legs vanish in the remesh)
    bm = bmesh.new()
    bm.from_mesh(body.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(body.data)
    bm.free()
    so = body.modifiers.new('solid', 'SOLIDIFY')
    so.thickness = R.Hm / 140
    so.offset = -1.0
    so.use_even_offset = False
    so.use_quality_normals = True
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(body.evaluated_get(dg))
    body.modifiers.clear()
    old_me = body.data
    body.data = me
    bpy.data.meshes.remove(old_me)
    return body, P, np.array(groups)


def mantle_from(L, P, G, H, rng):
    """the shoulder cape: a short cone from the neck over the shoulders, its hem wavy (no flat shelf)"""
    hw, z_sh = L['hw'], L['z_sh']
    nk, sp2 = L['neck'], L['sp2']

    def build(bm):
        ph = rng.uniform(0, 6.28)
        amps = [rng.uniform(0.5, 1.3) for _ in range(11)]
        ctrl = [(nk.z + 0.015 * H, 0.07 * H, 0.065 * H, 0.0), (z_sh + 0.025 * H, hw + 0.03 * H, 0.105 * H, 0.008),
                (z_sh - 0.03 * H, hw + 0.05 * H, 0.122 * H, 0.02), (z_sh - 0.085 * H, hw + 0.058 * H, 0.13 * H, 0.03), (z_sh - 0.1 * H, hw + 0.045 * H, 0.118 * H, 0.03)]
        rings = []
        for k, (z, rx, ry, am) in enumerate(ctrl):
            c = nk.lerp(sp2, min(1.0, max(0.0, (nk.z - z) / max(1e-6, nk.z - sp2.z))))
            ring = []
            for i in range(112):
                th = 2 * math.pi * i / 112
                fv = fold(th, k * 0.4, 11, ph, amps)
                rr = 1 + am * fv
                zz = z + (0.03 * H * fv if k >= 3 else 0.0)
                ring.append(Vector((c.x + rx * rr * math.cos(th), c.y + ry * rr * math.sin(th), zz)))
            rings.append(ring)
        loft_rings(bm, rings)
    return obj_from('mantle', build)


# ============================================================================ quick look (workbench) for pose iteration

def look(path):
    s = bpy.context.scene
    s.render.engine = 'BLENDER_WORKBENCH'
    s.display.shading.light = 'STUDIO'
    s.display.shading.color_type = 'SINGLE'
    s.display.shading.show_cavity = True
    s.render.resolution_x, s.render.resolution_y = 2000, 760
    fig = S['fig']
    co = np.array([v.co[:] for v in fig.data.vertices])
    h = float(co[:, 2].max())
    objs = [fig]
    for k, rz in enumerate((math.radians(-35), math.radians(-90), math.radians(-150))):
        c = fig.copy()
        c.data = fig.data
        K.link(c)
        c.rotation_euler = (0, 0, rz)
        c.location = ((k + 1) * h * 0.55, 0, 0)
        objs.append(c)
    if 'bodycopy' in S:
        S['bodycopy'].location = (4 * h * 0.55, 0, 0)
        S['bodycopy'].rotation_euler = (0, 0, math.radians(-35))
    cam = K.link(bpy.data.objects.new('cam', bpy.data.cameras.new('cam')))
    cam.data.type = 'ORTHO'
    cam.data.ortho_scale = h * 2.9
    cam.location = (h * 1.1, -h * 4, h * 0.5)
    cam.rotation_euler = (math.radians(90), 0, 0)
    s.camera = cam
    abake.image_settings('PNG', '8', 'RGB')
    return abake.render_still(path)


# ============================================================================ statue: plinth, high, LODs, bakes, FRAC, export

def plinth(lod):
    P_ = PLINTH
    c = 0.03 if lod == 0 else 0.0
    Rq = K.square_ring
    hh, h = P_['half'], P_['h']
    rings = [Rq(hh, hh, 0.0, c), Rq(hh, hh, 0.14, c), Rq(hh - 0.06, hh - 0.06, 0.2, c), Rq(hh - 0.1, hh - 0.1, 0.24, c),
             Rq(hh - 0.1, hh - 0.1, P_['y0'], c), Rq(hh - 0.1, hh - 0.1, P_['y1'], c), Rq(hh - 0.1, hh - 0.1, 0.84, c),
             Rq(hh - 0.04, hh - 0.04, 0.9, c), Rq(hh - 0.02, hh - 0.02, 0.96, c), Rq(hh - 0.02, hh - 0.02, h, c)]
    if lod == 1:
        rings = [rings[0], rings[1], rings[3], rings[4], rings[5], rings[6], rings[8], rings[9]]
    bm = bmesh.new()
    K.loft(bm, rings)
    o = K.to_object(f'plinth_lod{lod}', bm)
    return o


def build_statue():
    fig = S['fig']
    h0 = PLINTH['h']
    fig.data.transform(Matrix.Translation((0, 0, h0)))
    fig.data.update()
    co = np.array([v.co[:] for v in fig.data.vertices])
    top = float(co[:, 2].max())
    # the sim nominal height: plinth + figure = H exactly (the top is the hood peak)
    if abs(top - PLINTH['H']) > 1e-3:
        k = (PLINTH['H'] - h0) / (top - h0)
        fig.data.transform(Matrix.Translation((0, 0, h0)) @ Matrix.Diagonal((k, k, k, 1.0)) @ Matrix.Translation((0, 0, -h0)))
        fig.data.update()
    S['cc'] = abake.load_cc0(a.cc0, need=('diff', 'rough', 'disp'))
    # LOD sources: decimated monolith (smooth, before weathering) + the procedural plinth
    lods = {}
    for lod in (0, 1):
        d = D.decimated(fig, f'fig_lod{lod}', SP['tris'][lod])
        pl = plinth(lod)
        lods[lod] = K.join([d, pl], f'{ID}_lod{lod}')
        lods[lod].data.polygons.foreach_set('use_smooth', [True] * len(lods[lod].data.polygons))
        try:
            lods[lod].data.set_sharp_from_angle(angle=math.radians(50))
        except Exception:
            pass
        abake.uv_unwrap(lods[lod], SP['px'][lod], angle=55, margin_px=6 if lod == 0 else 4)
    S['lods'] = lods
    return {'tris': {lod: abake.tri_count(o) for lod, o in lods.items()}, 'top': PLINTH['H']}


def build_high():
    fig = S['fig']
    hi, st = K.weather_high(fig, 'HIGH_fig', voxel=0.012, seed=a.seed, H=PLINTH['H'], chip=0.03, chip_cell=0.09, chip_prob=0.5, crack=0.012,
                            crack_cell=0.45, crack_frac=0.35, erosion=0.004, soot=0.55, wet_h=0.0, moss=0.45, spall=0.008, spall_prob=0.25, smooth_iter=8)
    pl = plinth(0)
    phi, st2 = K.weather_high(pl, 'HIGH_plinth', voxel=0.012, seed=a.seed + 3, H=PLINTH['H'], chip=0.07, chip_cell=0.2, chip_prob=0.55, crack=0.025,
                              crack_cell=0.5, crack_frac=0.45, spall=0.015, erosion=0.008, wet_h=0.55, moss=0.6)
    bpy.data.objects.remove(pl)
    mat = K.stone_material(S['cc'])
    for o in (hi, phi):
        o.data.materials.clear()
        o.data.materials.append(mat)
    S['highs'] = [hi, phi]
    return {'fig': st, 'plinth': st2}


def bake_lod(lod):
    low = S['lods'][lod]
    pre = f'{ID}_lod{lod}'
    maps = K.bake_set(low, S['highs'], SP['px'][lod], job.out, pre, ao_samples=96 if lod == 0 else 48, extrusion=0.05, max_ray=0.12)
    S.setdefault('maps', {})[lod] = maps
    return {**maps, 'normalCheck': K.normal_stats(os.path.join(job.out, maps['normal']))}


def export():
    for h in S['highs']:
        h.hide_render = True
    S['fig'].hide_render = True
    H, h0 = PLINTH['H'], PLINTH['h']
    mats = {}
    for lod, low in S['lods'].items():
        name = f'{ID}_stone' if lod == 0 else f'{ID}_stone_low'
        mt = K.textured_material(name, job.out, S['maps'][lod])
        low.data.materials.clear()
        low.data.materials.append(mt)
        mats[lod] = name
    b = abake.bounds([S['lods'][0]])
    # fit 'statue' (dressKit.kitObstacle): the plinth (y < plinthTop) scales in x / z by o.r / r0, the figure uniformly by
    # o.h / height, so the top lands exactly on the sim height and the figure is never squashed (no 9-slice band)
    extras = dict(id=f'kit/{ID}', role='statue', kind='statue', r0=PLINTH['r0'], footprintR=round(b['radius'], 4), height=H, debris='stone', dustTint='#4a4a58',
                  fit='statue', plinthTop=PLINTH['h'], fighter=SP['fighter'])
    root = abake.empty(f'KIT_{ID}', **extras)
    fr = {}
    # fracture: plinth top, knees, hips, chest, neck (+ the two biggest pieces split along the body)
    fz = h0 + (H - h0) * np.array([0.0, 0.27, 0.47, 0.66, 0.84])
    cuts = [float(h0 * 0.55)] + [float(z) for z in fz]
    for lod, low in S['lods'].items():
        e = abake.empty(f'LOD{lod}', parent=root, lod=lod)
        low.parent = e
        pcs = fracture.fracture_axis(low, cuts, 300 + lod, f'FRAC{lod}', tilt=0.32, split=2, rough=0.045 if lod == 0 else 0.0, jitter=0.12)
        for k, p in enumerate(pcs):
            p.name = f'FRAC_{k}' if lod == 0 else f'FRAC_{k}_l1'
            p.parent = e
            p['frac'] = 1
        fr[lod] = {'pieces': len(pcs), 'tris': sum(abake.tri_count(p) for p in pcs)}
    col = D.col_proxy([S['lods'][1]], max_tris=200)
    col.parent = root
    objs = [root, col] + list(root.children_recursive)
    glb = abake.export_glb(os.path.join(job.out, f'{ID}_raw.glb'), objects=list(dict.fromkeys(objs)))
    asset = {
        'id': f'kit/{ID}', 'glb': os.path.basename(glb['path']), 'role': 'statue', 'kind': 'statue',
        'contract': {'r0': PLINTH['r0'], 'height': H, 'footprintR': round(b['radius'], 4), 'plinthTop': PLINTH['h'],
                     'source': 'sim statue obstacle (src/sim/arenaGen.ts THEME_RULES.desert obstacleR 0.85 / obstacleH 5.0); dressKit scales the plinth in xz by o.r / r0 and the figure uniformly by o.h / height'},
        'lods': {'LOD0': {'materials': [mats[0]]}, 'LOD1': {'materials': [mats[1]]}},
        'materials': {mats[lod]: {k: v for k, v in S['maps'][lod].items() if k in ('baseColor', 'normal', 'orm', 'size')} | {'metallicFactor': 0.0, 'roughnessFactor': 1.0} for lod in (0, 1)},
        'sources': [a.cc0, 'mixamo/' + SP['fbx'][:-4]],
        'job': os.path.basename(job.out),
    }
    with open(os.path.join(job.out, 'asset.json'), 'w', encoding='utf-8') as f:
        json.dump(asset, f, indent=1)
    return {'glb': glb, 'frac': fr, 'footprintR': round(b['radius'], 4)}


def preview():
    if not a.preview:
        return 'skipped'
    hi = S['highs']
    l0 = bpy.data.objects['LOD0']
    l1 = bpy.data.objects['LOD1']
    l0.parent = l1.parent = None
    for o in bpy.data.objects:
        if o.name.startswith('FRAC_'):
            o.hide_render = True
    for h in hi:
        h.hide_render = False
    # high | LOD0 | LOD1 | FRAC pieces laid out along a fall line
    fr = [o for o in bpy.data.objects if o.name.startswith('FRAC_') and not o.name.endswith('_l1')]
    for o in fr:
        # lying along +x from x = 3.6 (a toppled statue), each piece pulled apart along the line by its height
        o.parent = None
        o.hide_render = False
        c = Vector(np.array([v.co[:] for v in o.data.vertices]).mean(0))
        o.rotation_euler = (0, math.radians(88), 0)
        o.location = (3.6 + c.z * 0.12, 0.0, 0.62)
    for h in hi:
        h.location.x -= 2.2
    l1.location.x += 2.2
    return K.preview_scene([], os.path.join(job.out, f'{ID}_preview.png'), size=(1600, 900), cam_loc=(2.6, -12.5, 3.6), look=(2.6, 0, 1.9), lens=34)


# ============================================================================ colossus (A6 backdrop source)

def build_colossus_high():
    fig = S['fig']
    k = SP['fig'] / 4.0
    S['cc'] = abake.load_cc0(a.cc0, need=('diff', 'rough', 'disp'))
    hi, st = K.weather_high(fig, 'COLOSSUS', voxel=0.012 * k, seed=a.seed, H=SP['fig'], chip=0.03 * k, chip_cell=0.09 * k, chip_prob=0.5, crack=0.012 * k,
                            crack_cell=0.45 * k, crack_frac=0.35, erosion=0.004 * k, soot=0.55, wet_h=0.0, moss=0.5, spall=0.008 * k, spall_prob=0.25)
    hi.data.materials.clear()
    hi.data.materials.append(K.stone_material(S['cc'], scale=0.8 * k))
    bpy.data.objects.remove(fig)
    S['high'] = hi
    return st


def save_colossus():
    hi = S['high']
    for o in list(bpy.data.objects):
        if o is not hi:
            bpy.data.objects.remove(o)
    path = os.path.join(job.out, f'{ID}_hi.blend')
    bpy.ops.wm.save_as_mainfile(filepath=path, copy=True, compress=True)
    co = np.array([v.co[:] for v in hi.data.vertices])
    meta = {'id': ID, 'blend': os.path.basename(path), 'object': 'COLOSSUS', 'height': round(float(co[:, 2].max()), 3), 'tris': abake.tri_count(hi),
            'note': 'A6 backdrop source: link the object COLOSSUS (stone material, tint attribute) and scale to the theme landmark height',
            'sources': [a.cc0, 'mixamo/' + SP['fbx'][:-4]]}
    with open(os.path.join(job.out, 'colossus.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, indent=1)
    return {'blend': path, 'bytes': os.path.getsize(path), **meta}


def preview_colossus():
    if not a.preview:
        return 'skipped'
    h = SP['fig']
    return K.preview_scene([(S['high'], 0.0)], os.path.join(job.out, f'{ID}_preview.png'), size=(1200, 1200), cam_loc=(h * 0.5, -h * 2.2, h * 0.55), look=(0, 0, h * 0.48), lens=40)


# ============================================================================ run

job.step('figure', figure)
if a.stage == 'figure':
    job.step('look', look, os.path.join(job.out, f'{ID}_look.png'))
elif SP['kind'] == 'statue':
    job.step('build', build_statue)
    job.step('build_high', build_high)
    job.step('bake_lod0', bake_lod, 0)
    job.step('bake_lod1', bake_lod, 1)
    job.step('export', export)
    job.step('preview', preview)
else:
    job.step('build_high', build_colossus_high)
    job.step('preview', preview_colossus)
    job.step('save', save_colossus)
fails = [r['step'] for r in job.steps if not r['ok']]
job.result['failed'] = fails
job.done()
if fails:
    sys.exit(1)
