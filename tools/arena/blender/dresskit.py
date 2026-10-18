"""Shared helpers for the A4 dressing-kit jobs (kit_dress.py, kit_banner.py). Blender 5.0, bpy + numpy.
Arena art plan 4.2 / 4.3 / 5.2 (braziers, lanterns, candles, bell, bones, stakes, spike grate, chains, props with FRAC_*),
milestone A4. Copies the A1 / A3 job pattern (kit_brazier.py, stonekit.py, kit_rock.py) into one generic pipeline:

  piece builder -> Part list per LOD (bmesh + material key + options)
      lowfirst  LOD0 / LOD1 parts are built procedurally; the HIGH is derived per LOD0 part (bevel / Catmull-Clark +
                displacement, or stonekit.weather_high for stone parts) and carries a procedural material
      highfirst the builder makes the HIGH (metaballs: skulls, bones); the LODs are decimated copies
  -> optional fit to the sim contract (abake.fit_bounds: PROP_BASE radius / TOP height, origin at the base centre)
  -> one textured body per LOD (all non-glow parts joined, Smart UV) + constant emissive 'glow' parts (coals, wicks, paper)
  -> bakes per LOD: tangent NORMAL (OpenGL), AO (ground plane), base colour / roughness / metalness as emission -> ORM
  -> nodes: parts tagged with a node name (e.g. 'SPIKES', 'LINK_small', 'SLAB_3') are split back out of the baked body
     after the bake, so moving pieces share one texture set
  -> FRAC_* pieces (props, features): the baked LOD body sliced by random planes (bmesh bisect + cap fill), hidden in game
  -> KIT_<id> root extras, LOD0 / LOD1, hidden COL (convex hull), SOCK_* empties, GLB without images + asset.json
  -> a Cycles preview (LOD0, LOD1 and the FRAC pieces exploded)

High-poly materials (procedural, baked; never shipped): iron (Poly Haven metal_plate_02 scan), rust (rusty_metal_02),
wood (weathered_planks scan mapped ALONG each part's grain = its principal axis), stone (stonekit: lichen_rock scan + the
weathering 'tint' attribute), clay, bronze (verdigris in cavities), bone, wax, rope, paper, gold, cloth, char.
All albedos are linear, graded dark and weathered for the night look (A3: check in the game, not only the gallery).
"""
import json
import math
import os
import random

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

import abake
import stonekit as K

link = K.link
join = K.join

CC0 = {
    'iron': 'polyhaven/metal_plate_02',
    'rust': 'polyhaven/rusty_metal_02',
    'wood': 'polyhaven/weathered_planks',
    'stone': 'polyhaven/lichen_rock',
}


# ---------------------------------------------------------------------------- primitives (bmesh, Blender Z up)

def xf(verts, M):
    for v in verts:
        v.co = M @ v.co
    return verts


def T(x=0.0, y=0.0, z=0.0, rx=0.0, ry=0.0, rz=0.0, s=None):
    """translation @ rotation (XYZ euler, radians) @ scale"""
    from mathutils import Euler
    M = Matrix.Translation((x, y, z)) @ Euler((rx, ry, rz), 'XYZ').to_matrix().to_4x4()
    if s is not None:
        sv = s if isinstance(s, (tuple, list)) else (s, s, s)
        M = M @ Matrix.Diagonal((*sv, 1.0))
    return M


def box(bm, sx, sy, sz, M=None):
    """box of full sizes sx, sy, sz centred at the origin, then transformed by M"""
    r = bmesh.ops.create_cube(bm, size=1.0)
    vs = r['verts']
    for v in vs:
        v.co = Vector((v.co.x * sx, v.co.y * sy, v.co.z * sz))
    return xf(vs, M) if M is not None else vs


def lathe(bm, prof, segs, M=None, phase=0.0, ripple=None):
    before = set(bm.verts)
    K.lathe(bm, prof, segs, phase=phase, ripple=ripple)
    vs = [v for v in bm.verts if v not in before]
    return xf(vs, M) if M is not None else vs


def cyl(bm, r0, r1, z0, z1, segs, M=None, caps=True):
    prof = ([(0.0, z0)] if caps else []) + [(r0, z0), (r1, z1)] + ([(0.0, z1)] if caps else [])
    return lathe(bm, prof, segs, M)


def bezier(p0, p1, p2, p3, n):
    out = []
    for k in range(n + 1):
        t = k / n
        u = 1 - t
        out.append(p0 * u ** 3 + p1 * 3 * u * u * t + p2 * 3 * u * t * t + p3 * t ** 3)
    return out


def tube(bm, pts, radii, sides, cap=True, up=Vector((0, 0, 1))):
    """tube along a polyline (parallel-transport-ish frames from a fixed up vector)"""
    rings = []
    before = set(bm.verts)
    for k, p in enumerate(pts):
        t = (pts[min(k + 1, len(pts) - 1)] - pts[max(k - 1, 0)]).normalized()
        side = t.cross(up)
        if side.length < 1e-4:
            side = t.cross(Vector((1, 0, 0)))
        side.normalize()
        u2 = side.cross(t).normalized()
        r = radii[k] if isinstance(radii, (list, tuple)) else radii
        rings.append([bm.verts.new(p + (side * math.cos(2 * math.pi * i / sides) + u2 * math.sin(2 * math.pi * i / sides)) * r) for i in range(sides)])
    for A, B in zip(rings, rings[1:]):
        for i in range(sides):
            j = (i + 1) % sides
            bm.faces.new((A[i], A[j], B[j], B[i]))
    if cap:
        bm.faces.new(list(reversed(rings[0])))
        bm.faces.new(rings[-1])
    return [v for v in bm.verts if v not in before]


def torus(bm, R, r, seg, sides, M=None, stretch=0.0):
    """torus around Z in the XY plane; stretch > 0 makes a stadium (chain link): straight sides of length 2*stretch along X"""
    rings = []
    before = set(bm.verts)
    for i in range(seg):
        a0 = 2 * math.pi * i / seg
        c = Vector((math.cos(a0), math.sin(a0), 0))
        off = Vector((math.copysign(stretch, c.x) if abs(c.x) > 1e-6 else 0.0, 0, 0))
        rings.append([bm.verts.new(c * (R + r * math.cos(2 * math.pi * k / sides)) + off + Vector((0, 0, r * math.sin(2 * math.pi * k / sides)))) for k in range(sides)])
    for i in range(seg):
        A, B = rings[i], rings[(i + 1) % seg]
        for k in range(sides):
            m = (k + 1) % sides
            bm.faces.new((A[k], A[m], B[m], B[k]))
    vs = [v for v in bm.verts if v not in before]
    return xf(vs, M) if M is not None else vs


def sphere(bm, r, useg, vseg, M=None, squash=(1, 1, 1)):
    g = bmesh.ops.create_uvsphere(bm, u_segments=useg, v_segments=vseg, radius=r)
    for v in g['verts']:
        v.co = Vector((v.co.x * squash[0], v.co.y * squash[1], v.co.z * squash[2]))
    return xf(g['verts'], M) if M is not None else g['verts']


def cone_spike(bm, r, h, segs, M=None):
    """a spike: cone from radius r at z 0 to a point at z h"""
    return lathe(bm, [(0.0, 0.0), (r, 0.0), (r * 0.55, h * 0.45), (0.0, h)], segs, M)


def jitter(verts, amp, seed, keep_z0=True):
    rng = random.Random(seed)
    for v in verts:
        if keep_z0 and abs(v.co.z) < 1e-5:
            continue
        v.co += Vector((rng.uniform(-amp, amp), rng.uniform(-amp, amp), rng.uniform(-amp, amp)))


# ---------------------------------------------------------------------------- parts

class Part:
    """one piece of a LOD: bmesh + high material key + options.
    mat    high material key (see hi_material) or 'glow:<name>' (constant emissive part, not baked)
    hi     'bevel' (bevel w, harden) | 'sub' (Catmull-Clark levels) | 'stone' (stonekit.weather_high) | 'none'
    node   name of the GLB node this part ends up in after the bake ('body' = the main mesh)
    disp   (strength, scale) of a cloud displacement on the high (dents, lumps); 0 = none"""

    def __init__(self, name, bm, mat, hi='sub', levels=2, bevel=0.006, node='body', disp=(0.0, 0.0), smooth=True, sharp=None,
                 stone=None):
        self.name, self.bm, self.mat, self.hi, self.levels, self.bevel = name, bm, mat, hi, levels, bevel
        self.node, self.disp, self.smooth, self.sharp, self.stone = node, disp, smooth, sharp, stone or {}
        if hi == 'bevel' and sharp is None:
            self.sharp = 35  # flat faces keep flat normals (the bake then only carries the bevels)


def to_object(name, bm, smooth=True, sharp=None):
    return K.to_object(name, bm, smooth=smooth, sharp_deg=sharp)


def grain_axes(me):
    """principal axes of a part's vertices: (grain = longest, side = second) -> wood scan mapped along the grain"""
    co = np.array([v.co[:] for v in me.vertices], np.float64)
    if len(co) < 3:
        return (0, 0, 1), (1, 0, 0)
    c = co - co.mean(0)
    w, V = np.linalg.eigh(c.T @ c)
    g = V[:, 2]
    s = V[:, 1]
    return tuple(g), tuple(s)


def tag_part(obj, part, node_index):
    """per-vertex attributes carried through join / bake: grain + side axes (wood mapping), node index (split after bake)"""
    me = obj.data
    g, s = grain_axes(me)
    n = len(me.vertices)
    for nm, val in (('grain', g), ('gside', s)):
        at = me.attributes.new(nm, 'FLOAT_VECTOR', 'POINT')
        at.data.foreach_set('vector', np.tile(np.array(val, np.float32), n))
    at = me.attributes.new('node', 'INT', 'FACE')
    at.data.foreach_set('value', np.full(len(me.polygons), node_index, np.int32))


# ---------------------------------------------------------------------------- high-poly materials (procedural, baked)

class NB:
    """tiny node builder for the high materials"""

    def __init__(self, name):
        self.m = bpy.data.materials.new(name)
        self.m.use_nodes = True
        self.nt = self.m.node_tree
        self.N, self.L = self.nt.nodes, self.nt.links
        self.bsdf = next(n for n in self.N if n.type == 'BSDF_PRINCIPLED')
        self._tc = None

    def set(self, sock, v):
        if isinstance(v, bpy.types.NodeSocket):
            self.L.new(v, sock)
        elif isinstance(v, (tuple, list)) and len(v) == 3 and sock.type == 'RGBA':
            sock.default_value = (*v, 1.0)
        else:
            sock.default_value = v

    def node(self, kind, **inp):
        n = self.N.new(kind)
        for k, v in inp.items():
            self.set(n.inputs[k], v)
        return n

    @property
    def obj(self):
        if self._tc is None:
            self._tc = self.N.new('ShaderNodeTexCoord')
        return self._tc.outputs['Object']

    def io(self, socks, name, kind):
        return next(x for x in socks if x.name == name and x.type == kind)

    def mix(self, fac, a, b, kind='RGBA', blend='MIX'):
        n = self.N.new('ShaderNodeMix')
        n.data_type = 'RGBA' if kind == 'RGBA' else 'FLOAT'
        n.blend_type = blend
        st = 'RGBA' if kind == 'RGBA' else 'VALUE'
        for nm, v in (('Factor', fac), ('A', a), ('B', b)):
            sk = self.io(n.inputs, nm, 'VALUE' if nm == 'Factor' else st)
            self.set(sk, v)
        return self.io(n.outputs, 'Result', st)

    def math(self, op, a, b=0.0, clamp=False):
        n = self.N.new('ShaderNodeMath')
        n.operation = op
        n.use_clamp = clamp
        self.set(n.inputs[0], a)
        self.set(n.inputs[1], b)
        return n.outputs[0]

    def vmath(self, op, a, b=None):
        n = self.N.new('ShaderNodeVectorMath')
        n.operation = op
        self.set(n.inputs[0], a)
        if b is not None:
            self.set(n.inputs[1], b)
        return n.outputs['Value'] if op in ('DOT_PRODUCT', 'LENGTH', 'DISTANCE') else n.outputs['Vector']

    def noise(self, scale, detail=4.0, rough=0.55, vec=None, dist=0.0):
        n = self.node('ShaderNodeTexNoise', Scale=scale, Detail=detail, Roughness=rough, Distortion=dist)
        self.L.new(vec if vec is not None else self.obj, n.inputs['Vector'])
        return n.outputs['Fac']

    def voronoi(self, scale, vec=None):
        n = self.node('ShaderNodeTexVoronoi', Scale=scale)
        self.L.new(vec if vec is not None else self.obj, n.inputs['Vector'])
        return n.outputs['Distance']

    def ramp(self, v, lo, hi, to_lo=0.0, to_hi=1.0, clamp=True):
        n = self.node('ShaderNodeMapRange')
        n.clamp = clamp
        self.set(n.inputs['Value'], v)
        n.inputs['From Min'].default_value = lo
        n.inputs['From Max'].default_value = hi
        n.inputs['To Min'].default_value = to_lo
        n.inputs['To Max'].default_value = to_hi
        return n.outputs['Result']

    def image(self, path, non_color, vec, proj='FLAT', blend=0.3):
        t = self.N.new('ShaderNodeTexImage')
        t.image = abake.load_image(path, non_color)
        t.projection = proj
        if proj == 'BOX':
            t.projection_blend = blend
        self.L.new(vec, t.inputs['Vector'])
        return t.outputs['Color']

    def box_vec(self, scale):
        mp = self.node('ShaderNodeMapping')
        mp.inputs['Scale'].default_value = (1 / scale, 1 / scale, 1 / scale)
        self.L.new(self.obj, mp.inputs['Vector'])
        return mp.outputs['Vector']

    def pointiness(self):
        return self.N.new('ShaderNodeNewGeometry').outputs['Pointiness']

    def attr(self, name, out='Vector'):
        a = self.N.new('ShaderNodeAttribute')
        a.attribute_name = name
        return a.outputs[out]

    def bump(self, height, strength=1.0, distance=0.002):
        b = self.node('ShaderNodeBump', Strength=strength, Distance=distance)
        self.L.new(height, b.inputs['Height'])
        self.L.new(b.outputs['Normal'], self.bsdf.inputs['Normal'])

    def out(self, color, rough, metal=0.0):
        self.set(self.bsdf.inputs['Base Color'], color)
        self.set(self.bsdf.inputs['Roughness'], rough)
        self.set(self.bsdf.inputs['Metallic'], metal)
        return self.m


_CC = {}


def cc(key, need=('diff', 'rough')):
    if key not in _CC:
        _CC[key] = abake.load_cc0(CC0[key], need=need)
    return _CC[key]


def mat_iron(name='iron', tint=(0.4, 0.39, 0.39), soot=0.35, rust_amt=0.18):
    """CC0 plate scan, dark forged iron, worn lighter edges (pointiness), soot + rust blotches in cavities"""
    c = cc('iron', ('diff', 'rough', 'metal'))
    r = cc('rust', ('diff', 'rough'))
    nb = NB(name)
    v = nb.box_vec(1.35)
    diff0 = nb.image(c['diff'], False, v, 'BOX')
    hsv = nb.node('ShaderNodeHueSaturation', Saturation=0.3, Value=1.0)
    nb.set(hsv.inputs['Color'], diff0)
    diff = hsv.outputs['Color']  # forged iron: the scan's warm cast desaturated (read as copper in the first previews)
    rough = nb.image(c['rough'], True, v, 'BOX')
    metal = nb.image(c['metal'], True, v, 'BOX')
    rv = nb.box_vec(0.9)
    rdiff = nb.image(r['diff'], False, rv, 'BOX')
    edge = nb.ramp(nb.pointiness(), 0.52, 0.6)
    cav = nb.ramp(nb.pointiness(), 0.5, 0.44)
    blot = nb.ramp(nb.noise(3.0, 5.0), 0.5, 0.68)
    rustm = nb.math('MULTIPLY', nb.math('ADD', blot, cav, True), rust_amt, True)
    sootm = nb.math('MULTIPLY', nb.ramp(nb.noise(1.6, 3.0), 0.35, 0.7), soot, True)
    col = nb.mix(1.0, diff, tint, blend='MULTIPLY')
    col = nb.mix(rustm, col, nb.mix(1.0, rdiff, (0.42, 0.33, 0.3), blend='MULTIPLY'))
    col = nb.mix(sootm, col, (0.02, 0.018, 0.016))
    col = nb.mix(edge, col, (0.3, 0.29, 0.28))
    ro = nb.mix(rustm, rough, 0.95, 'FLOAT')
    ro = nb.mix(sootm, ro, 0.9, 'FLOAT')
    ro = nb.mix(edge, ro, 0.4, 'FLOAT')
    me = nb.mix(rustm, metal, 0.2, 'FLOAT')
    me = nb.mix(sootm, me, 0.3, 'FLOAT')
    me = nb.mix(edge, me, 1.0, 'FLOAT')
    # oxidised, sooty forged iron is only partly metallic and fairly rough: a dark mirror read as copper under the fires
    me = nb.math('MULTIPLY', me, 0.45, True)
    ro = nb.math('ADD', nb.math('MULTIPLY', ro, 0.8), 0.18, True)
    nb.bump(nb.noise(60.0, 3.0), 0.25, 0.002)
    return nb.out(col, ro, me)


def mat_rust(name='rust'):
    r = cc('rust', ('diff', 'rough'))
    nb = NB(name)
    v = nb.box_vec(0.9)
    diff = nb.image(r['diff'], False, v, 'BOX')
    rough = nb.image(r['rough'], True, v, 'BOX')
    edge = nb.ramp(nb.pointiness(), 0.53, 0.62)
    col = nb.mix(1.0, diff, (0.45, 0.4, 0.38), blend='MULTIPLY')
    col = nb.mix(edge, col, (0.3, 0.28, 0.26))
    me = nb.mix(edge, 0.25, 0.9, 'FLOAT')
    nb.bump(nb.noise(80.0, 4.0), 0.35, 0.002)
    return nb.out(col, nb.mix(edge, rough, 0.45, 'FLOAT'), me)


def mat_wood(name='wood', tint=(0.6, 0.57, 0.55), grime=0.4):
    """weathered planks scan mapped along each part's grain axis (point attributes 'grain' / 'gside', see tag_part):
    v = P . grain, u = P . side + 0.73 P . (grain x side); darker grime in cavities, lighter worn edges"""
    c = cc('wood', ('diff', 'rough', 'disp'))
    nb = NB(name)
    P = nb.obj
    G = nb.attr('grain')
    S = nb.attr('gside')
    C = nb.vmath('CROSS_PRODUCT', G, S)
    v = nb.vmath('DOT_PRODUCT', P, G)
    u = nb.math('ADD', nb.vmath('DOT_PRODUCT', P, S), nb.math('MULTIPLY', nb.vmath('DOT_PRODUCT', P, C), 0.73))
    cmb = nb.node('ShaderNodeCombineXYZ')
    nb.set(cmb.inputs['X'], nb.math('MULTIPLY', u, 1 / 2.2))
    nb.set(cmb.inputs['Y'], nb.math('MULTIPLY', v, 1 / 2.2))
    uv = cmb.outputs['Vector']
    diff = nb.image(c['diff'], False, uv)
    rough = nb.image(c['rough'], True, uv)
    disp = nb.image(c['disp'], True, uv)
    edge = nb.ramp(nb.pointiness(), 0.52, 0.6)
    cav = nb.ramp(nb.pointiness(), 0.5, 0.43)
    dirt = nb.math('MULTIPLY', nb.math('ADD', cav, nb.ramp(nb.noise(2.2, 4.0), 0.45, 0.75), True), grime, True)
    hsv = nb.node('ShaderNodeHueSaturation', Saturation=0.55, Value=1.0)
    nb.set(hsv.inputs['Color'], diff)
    col = nb.mix(1.0, hsv.outputs['Color'], tint, blend='MULTIPLY')
    # weathered grey: sun / rain-bleached patches
    col = nb.mix(nb.math('MULTIPLY', nb.ramp(nb.noise(1.3, 3.0), 0.4, 0.7), 0.45), col, (0.11, 0.105, 0.1))
    col = nb.mix(dirt, col, (0.03, 0.026, 0.022))
    col = nb.mix(nb.math('MULTIPLY', edge, 0.5), col, (0.24, 0.22, 0.19))
    nb.bump(disp, 0.6, 0.003)
    return nb.out(col, nb.mix(dirt, rough, 0.95, 'FLOAT'), 0.0)


def mat_flat(name, rgb, rough=0.8, metal=0.0, var=0.15, scale=6.0, cav_dark=0.5, edge_light=0.0, bump=0.0):
    """flat albedo with large noise variation, cavity darkening (pointiness) and optional lighter edges + bump"""
    nb = NB(name)
    n = nb.noise(scale, 4.0)
    col = nb.mix(nb.math('MULTIPLY', n, var * 2), rgb, tuple(x * (1 - var) for x in rgb))
    cav = nb.ramp(nb.pointiness(), 0.5, 0.42)
    col = nb.mix(nb.math('MULTIPLY', cav, cav_dark), col, tuple(x * 0.25 for x in rgb))
    if edge_light:
        edge = nb.ramp(nb.pointiness(), 0.53, 0.62)
        col = nb.mix(nb.math('MULTIPLY', edge, edge_light), col, tuple(min(1.0, x * 1.8) for x in rgb))
    if bump:
        nb.bump(nb.noise(scale * 9, 5.0), bump, 0.002)
    return nb.out(col, rough, metal)


def mat_bronze(name='bronze'):
    nb = NB(name)
    cav = nb.ramp(nb.pointiness(), 0.51, 0.44)
    patch = nb.ramp(nb.noise(4.0, 5.0), 0.48, 0.7)
    verd = nb.math('MAXIMUM', cav, nb.math('MULTIPLY', patch, 0.7))
    edge = nb.ramp(nb.pointiness(), 0.53, 0.6)
    col = nb.mix(verd, (0.32, 0.2, 0.09), (0.12, 0.2, 0.17))
    col = nb.mix(edge, col, (0.55, 0.38, 0.18))
    ro = nb.mix(verd, 0.42, 0.85, 'FLOAT')
    me = nb.mix(verd, 1.0, 0.1, 'FLOAT')
    nb.bump(nb.noise(70.0, 4.0), 0.2, 0.002)
    return nb.out(col, ro, me)


def mat_bone(name='bone'):
    nb = NB(name)
    cav = nb.ramp(nb.pointiness(), 0.5, 0.42)
    stain = nb.ramp(nb.noise(5.0, 6.0), 0.4, 0.75)
    col = nb.mix(stain, (0.5, 0.46, 0.37), (0.28, 0.23, 0.16))
    col = nb.mix(cav, col, (0.06, 0.05, 0.035))
    nb.bump(nb.noise(120.0, 6.0), 0.25, 0.001)
    return nb.out(col, nb.mix(cav, 0.62, 0.9, 'FLOAT'), 0.0)


def mat_stone(name='stone'):
    return K.stone_material(cc('stone', ('diff', 'rough', 'disp')), name=name)


def hi_material(key, cache={}):
    """high material by key (one Blender material per key per job)"""
    if key in cache and cache[key].name in bpy.data.materials:
        return cache[key]
    m = {
        'iron': lambda: mat_iron('iron'),
        'iron_sooty': lambda: mat_iron('iron_sooty', soot=0.8),
        'rust': lambda: mat_rust('rust'),
        'wood': lambda: mat_wood('wood'),
        'wood_dark': lambda: mat_wood('wood_dark', tint=(0.42, 0.36, 0.32), grime=0.55),
        'stone': lambda: mat_stone('stone'),
        'clay': lambda: mat_flat('clay', (0.26, 0.12, 0.065), rough=0.82, var=0.18, cav_dark=0.6, edge_light=0.5, bump=0.25),
        'clay_dark': lambda: mat_flat('clay_dark', (0.09, 0.07, 0.06), rough=0.7, var=0.2, cav_dark=0.6, edge_light=0.4, bump=0.25),
        'bronze': lambda: mat_bronze('bronze'),
        'bone': lambda: mat_bone('bone'),
        'wax': lambda: mat_flat('wax', (0.62, 0.55, 0.42), rough=0.45, var=0.12, scale=9, cav_dark=0.25),
        'rope': lambda: mat_flat('rope', (0.24, 0.18, 0.11), rough=0.95, var=0.25, scale=30, cav_dark=0.6, bump=0.5),
        'paper': lambda: mat_flat('paper', (0.7, 0.5, 0.3), rough=0.85, var=0.15, scale=8),
        'gold': lambda: mat_flat('gold', (0.62, 0.42, 0.14), rough=0.38, metal=1.0, var=0.2, cav_dark=0.6, edge_light=0.4),
        'cloth': lambda: mat_flat('cloth', (0.16, 0.015, 0.02), rough=0.92, var=0.3, scale=5, cav_dark=0.5),
        'char': lambda: mat_flat('char', (0.02, 0.018, 0.016), rough=0.95, var=0.4, scale=20),
        'red_paint': lambda: mat_flat('red_paint', (0.2, 0.025, 0.02), rough=0.75, var=0.3, scale=12, cav_dark=0.5, edge_light=0.6),
    }[key]()
    cache[key] = m
    return m


# ---------------------------------------------------------------------------- high derivation

def make_high(obj, part, seed):
    """the bake source for one LOD0 part (copy; the part stays the low)"""
    if part.hi == 'stone':
        kw = dict(voxel=0.008, seed=seed, chip=0.02, chip_cell=0.07, crack=0.008, crack_cell=0.25, erosion=0.003, soot=0.4, wet_h=0.25, moss=0.25)
        kw.update(part.stone)
        hi, _st = K.weather_high(obj, obj.name + '_hi', **kw)
        hi.data.materials.clear()
        hi.data.materials.append(hi_material('stone'))
        return hi
    hi = obj.copy()
    hi.data = obj.data.copy()
    hi.name = obj.name + '_hi'
    link(hi)
    if part.hi == 'bevel':
        b = hi.modifiers.new('bev', 'BEVEL')
        b.width = part.bevel
        b.segments = 3
        b.limit_method = 'ANGLE'
        b.harden_normals = False
    elif part.hi == 'sub':
        s = hi.modifiers.new('sub', 'SUBSURF')
        s.levels = s.render_levels = part.levels
    if part.disp[0] > 0:
        t = bpy.data.textures.new(f'd_{hi.name}', 'CLOUDS')
        t.noise_scale = part.disp[1]
        d = hi.modifiers.new('disp', 'DISPLACE')
        d.texture = t
        d.texture_coords = 'LOCAL'
        d.strength = part.disp[0]
        d.mid_level = 0.5
    # apply the modifiers so the bake rays see a plain mesh
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(hi.evaluated_get(dg))
    hi.modifiers.clear()
    hi.data = me
    me.polygons.foreach_set('use_smooth', [True] * len(me.polygons))
    hi.data.materials.clear()
    hi.data.materials.append(hi_material(part.mat))
    return hi


def decimated(src, name, tris):
    o = src.copy()
    o.data = src.data.copy()
    o.name = name
    link(o)
    o.data.materials.clear()
    n0 = sum(len(p.vertices) - 2 for p in o.data.polygons)
    d = o.modifiers.new('dec', 'DECIMATE')
    d.ratio = min(1.0, tris / max(1, n0))
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
    o.modifiers.clear()
    o.data = me
    me.name = name
    me.polygons.foreach_set('use_smooth', [True] * len(me.polygons))
    return o


# ---------------------------------------------------------------------------- bakes

def bake_pbr(low, highs, px, out_dir, prefix, ao_samples=96, extrusion=0.02, max_ray=0.06, ground=True):
    """NORMAL + AO (ground plane) + base colour / roughness / metalness emission bakes; ORM packed (A1 / A3 pattern)"""
    s = bpy.context.scene
    tmp = K.material_plain(f'bake_{prefix}', (0.5, 0.5, 0.5))
    low.data.materials.clear()
    low.data.materials.append(tmp)
    s.render.bake.max_ray_distance = max_ray
    hidden = [o for o in s.objects if o not in highs and o is not low and o.type == 'MESH' and not o.hide_render]
    for o in hidden:
        o.hide_render = True
    vis = {k: getattr(low, k) for k in ('visible_camera', 'visible_diffuse', 'visible_glossy', 'visible_shadow', 'visible_transmission', 'visible_volume_scatter')}
    for k in vis:
        setattr(low, k, False)
    gp = None
    if ground:
        bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, -0.002))
        gp = bpy.context.active_object
        gp.data.materials.append(K.material_plain('ground_ao', (0.2, 0.2, 0.2)))
    res = abake.bake_maps(low, highs, ['NORMAL'], px, out_dir, samples=1, extrusion=extrusion, prefix=prefix)
    res.update(abake.bake_maps(low, highs, ['AO'], px, out_dir, samples=ao_samples, extrusion=extrusion, prefix=prefix))
    res.update(abake.bake_emit_inputs(low, highs, ['Base Color', 'Roughness', 'Metallic'], px, out_dir, prefix, samples=4, extrusion=extrusion))
    if gp is not None:
        bpy.data.objects.remove(gp)
    for o in hidden:
        o.hide_render = False
    for k, v in vis.items():
        setattr(low, k, v)
    orm = abake.pack_orm(res['AO']['path'], res['Roughness']['path'], res['Metallic']['path'], os.path.join(out_dir, f'{prefix}_orm.png'))
    return {'baseColor': os.path.basename(res['Base Color']['path']), 'normal': os.path.basename(res['NORMAL']['path']), 'orm': os.path.basename(orm), 'size': px,
            'seconds': {k: v['seconds'] for k, v in res.items()}}


# ---------------------------------------------------------------------------- split / slice

def split_nodes(obj, names):
    """split a joined (baked) LOD body by its 'node' face attribute into one object per node name; returns {name: obj}"""
    me = obj.data
    att = me.attributes.get('node')
    if att is None or len(names) == 1:
        return {names[0]: obj}
    vals = np.empty(len(me.polygons), np.int32)
    att.data.foreach_get('value', vals)
    out = {}
    for idx, nm in enumerate(names):
        if not (vals == idx).any():
            continue
        o = obj.copy()
        o.data = me.copy()
        o.name = f'{obj.name}_{nm}'
        link(o)
        bm = bmesh.new()
        bm.from_mesh(o.data)
        la = bm.faces.layers.int.get('node')
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if f[la] != idx], context='FACES')
        bm.to_mesh(o.data)
        bm.free()
        out[nm] = o
    bpy.data.objects.remove(obj)
    return out


def slice_pieces(src, n, seed, name, vertical_bias=0.5, min_verts=8):
    """FRAC_* pieces: copies of `src` cut by random planes through the biggest piece (bmesh bisect + cap fill). Cap UVs are
    copied from a nearby loop of the cut (interior reads as the same material). Returns a list of objects."""
    rng = random.Random(seed)
    bm0 = bmesh.new()
    bm0.from_mesh(src.data)
    pieces = [bm0]
    tries = 0
    while len(pieces) < n and tries < n * 6:
        tries += 1
        pieces.sort(key=lambda b: _bm_extent(b), reverse=True)
        b = pieces.pop(0)
        co = np.array([v.co[:] for v in b.verts])
        c = Vector(co.mean(0)) + Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1))) * 0.12 * _bm_extent(b)
        # long axis of the piece, cut across it (with a random tilt)
        ext = co.max(0) - co.min(0)
        ax = int(np.argmax(ext * np.array([1.0, 1.0, 1.0 + vertical_bias])))
        nrm = Vector((rng.uniform(-0.45, 0.45), rng.uniform(-0.45, 0.45), rng.uniform(-0.45, 0.45)))
        nrm[ax] = 1.0
        nrm.normalize()
        halves = []
        for clear_outer in (True, False):
            h = b.copy()
            geom = h.verts[:] + h.edges[:] + h.faces[:]
            r = bmesh.ops.bisect_plane(h, geom=geom, plane_co=c, plane_no=nrm, clear_outer=clear_outer, clear_inner=not clear_outer, dist=1e-5)
            cut = [e for e in r['geom_cut'] if isinstance(e, bmesh.types.BMEdge)]
            _cap(h, cut)
            halves.append(h)
        if all(len(h.verts) >= min_verts for h in halves):
            b.free()
            pieces.extend(halves)
        else:
            for h in halves:
                h.free()
            pieces.append(b)
    out = []
    for k, b in enumerate(pieces):
        me = bpy.data.meshes.new(f'{name}_{k}')
        b.to_mesh(me)
        b.free()
        me.polygons.foreach_set('use_smooth', [False] * len(me.polygons))
        o = link(bpy.data.objects.new(f'{name}_{k}', me))
        for m in src.data.materials:
            o.data.materials.append(m)
        out.append(o)
    return out


def _bm_extent(b):
    if not b.verts:
        return 0.0
    co = np.array([v.co[:] for v in b.verts])
    return float(np.linalg.norm(co.max(0) - co.min(0)))


def _cap(h, cut):
    """fill the cut loops; cap loops take the UV of a neighbouring loop"""
    edges = [e for e in cut if e.is_valid and e.is_boundary]
    if not edges:
        return
    try:
        r = bmesh.ops.holes_fill(h, edges=edges, sides=0)
        faces = r.get('faces', [])
        if faces:
            bmesh.ops.triangulate(h, faces=faces)
    except Exception:
        return
    uvl = h.loops.layers.uv.active
    if uvl is None:
        return
    for f in h.faces:
        for lp in f.loops:
            pass
    # cap faces are the ones whose loops have uv (0, 0) and all verts on the cut: give them a neighbour's uv
    for f in h.faces:
        if all(lp[uvl].uv.length < 1e-9 for lp in f.loops):
            src = None
            for v in f.verts:
                for lp in v.link_loops:
                    if lp.face is not f and lp[uvl].uv.length > 1e-9:
                        src = lp[uvl].uv.copy()
                        break
                if src:
                    break
            if src:
                for lp in f.loops:
                    lp[uvl].uv = src


# ---------------------------------------------------------------------------- COL proxy

def col_proxy(objs, name='COL', max_tris=300):
    """hidden line-of-sight / anchor proxy: convex hull of the given objects' vertices (decimated to <= max_tris)"""
    bm = bmesh.new()
    for o in objs:
        for v in o.data.vertices:
            bm.verts.new(o.matrix_world @ v.co)
    bmesh.ops.convex_hull(bm, input=bm.verts[:])
    o = K.to_object(name, bm)
    n = sum(len(p.vertices) - 2 for p in o.data.polygons)
    if n > max_tris:
        d = o.modifiers.new('dec', 'DECIMATE')
        d.ratio = max_tris / n
        dg = bpy.context.evaluated_depsgraph_get()
        me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
        o.modifiers.clear()
        o.data = me
    o['col'] = 1
    o.hide_render = True
    return o


# ---------------------------------------------------------------------------- the generic asset job

class Asset:
    """one dressing-kit asset job. See the module doc. `spec` keys:
      id, role, kind, px, px_low, ao (samples), extrusion, max_ray
      build(lod) -> [Part]            (lowfirst)   or   high() -> [(obj, matkey)], lod_tris {0: n, 1: n}   (highfirst)
      contract {radius, height, source} (fit, props)
      nodes [names]                   (body first); sockets [(name, (x, y, z), {extras})] in the final asset frame
      frac n (pieces per LOD), extras {...} (KIT_ root extras), col (callable -> objs) optional
    """

    def __init__(self, job, spec):
        self.job, self.sp, self.out = job, spec, job.out
        self.id = spec['id']
        self.S = {}

    # -- build
    def build(self):
        sp = self.sp
        abake.reset()
        abake.cycles_device('CPU', self.job.a.threads)
        nodes = sp.get('nodes', ['body'])
        self.S['nodes'] = nodes
        lods, glows, highs, only_hi = {}, {}, [], []
        if 'high' in sp:
            src = sp['high']()
            for o, mk in src:
                o.data.materials.clear()
                o.data.materials.append(hi_material(mk))
                highs.append(o)
            parts_hi = []
            for o in highs:
                c = o.copy()
                c.data = o.data.copy()
                link(c)
                parts_hi.append(c)
            j = join(parts_hi, 'hi_join')
            for lod in (0, 1):
                d = decimated(j, f'LOD{lod}_body', sp['lod_tris'][lod])
                tag_part(d, Part('x', None, 'none'), 0)
                lods[lod] = {'body': d, 'glow': []}
            bpy.data.objects.remove(j)
            glows = {0: [], 1: []}
            for lod in (0, 1):
                for p in sp.get('glow', lambda l: [])(lod):
                    o = to_object(f'LOD{lod}_{p.name}', p.bm, p.smooth, p.sharp)
                    glows[lod].append((o, p.mat))
                lods[lod]['glow'] = glows[lod]
        else:
            seed = 7
            for lod in (0, 1):
                parts = sp['build'](lod)
                objs, gl = [], []
                for p in parts:
                    if p.hi == 'only':
                        # high-only detail (rivets, stave grooves, relief bands): a bake source, never a low
                        if lod == 0:
                            o = to_object(f'HIONLY_{p.name}', p.bm, True)
                            tag_part(o, p, 0)
                            o.data.materials.append(hi_material(p.mat))
                            only_hi.append(o)
                        else:
                            p.bm.free()
                        continue
                    o = to_object(f'LOD{lod}_{p.name}', p.bm, p.smooth, p.sharp)
                    if p.mat.startswith('glow:'):
                        gl.append((o, p.mat))
                    else:
                        tag_part(o, p, nodes.index(p.node))
                        objs.append((o, p))
                lods[lod] = {'parts': objs, 'glow': gl}
        # fit to the sim contract (per LOD, every visible mesh of it)
        fit = {}
        if sp.get('contract'):
            C = sp['contract']
            for lod in (0, 1):
                L = lods[lod]
                objs = ([o for o, _p in L['parts']] if 'parts' in L else [L['body']]) + [o for o, _m in L['glow']]
                if lod == 0 and highs:
                    objs = objs + highs
                fit[lod] = abake.fit_bounds(objs, C['radius'], C['height'])
                if lod == 0 and only_hi:
                    f = fit[0]
                    M = Matrix.Diagonal((f['scaleXY'], f['scaleXY'], f['scaleZ'], 1.0)) @ Matrix.Translation((0, 0, -f['before']['zmin']))
                    for o in only_hi:
                        o.data.transform(M)
                        o.data.update()
                if lod == 0 and highs:
                    # the highs were fitted together with LOD0: refit LOD0 alone so it is exact
                    fit[lod] = abake.fit_bounds([L['body']] + [o for o, _m in L['glow']], C['radius'], C['height'])
        # highs (lowfirst) from the fitted LOD0 parts
        if not highs:
            for k, (o, p) in enumerate(lods[0]['parts']):
                if p.hi == 'skip':
                    continue
                highs.append(make_high(o, p, seed + k))
            highs.extend(only_hi)
            for lod in (0, 1):
                L = lods[lod]
                L['body'] = join([o for o, _p in L['parts']], f'LOD{lod}_body')
        for lod in (0, 1):
            abake.uv_unwrap(lods[lod]['body'], sp['px'] if lod == 0 else sp['px_low'], angle=sp.get('uv_angle', 60))
            for o, _m in lods[lod]['glow']:
                abake.uv_unwrap(o, 128)
        self.S['lods'], self.S['highs'], self.S['fit'] = lods, highs, fit
        tris = {lod: {'body': abake.tri_count(L['body']), 'glow': sum(abake.tri_count(o) for o, _ in L['glow'])} for lod, L in lods.items()}
        return {'fit': fit, 'tris': tris, 'highTris': sum(abake.tri_count(h) for h in highs)}

    # -- bake
    def bake(self, lod):
        sp = self.sp
        L = self.S['lods'][lod]
        for o, _m in L['glow']:
            o.hide_render = True
        px = sp['px'] if lod == 0 else sp['px_low']
        maps = bake_pbr(L['body'], self.S['highs'], px, self.out, f'{self.id}_lod{lod}', ao_samples=sp.get('ao', 96),
                        extrusion=sp.get('extrusion', 0.02), max_ray=sp.get('max_ray', 0.06))
        for o, _m in L['glow']:
            o.hide_render = False
        self.S.setdefault('maps', {})[lod] = maps
        return {**maps, 'normalCheck': K.normal_stats(os.path.join(self.out, maps['normal']))}

    # -- export
    def export(self):
        sp = self.sp
        for h in self.S['highs']:
            h.hide_render = True
        nodes = self.S['nodes']
        mats, glow_mats = {}, {}
        x = dict(sp.get('extras', {}))
        x.update(id=f'kit/{self.id}', role=sp['role'], kind=sp['kind'])
        if sp.get('contract'):
            x.update(footprint=sp['contract']['radius'], height=sp['contract']['height'])
        root = abake.empty(f'KIT_{self.id}', **x)
        frac_info = {}
        lod_mats = {}
        for lod in (0, 1):
            L = self.S['lods'][lod]
            name = self.id if lod == 0 else f'{self.id}_low'
            mt = K.textured_material(name, self.out, self.S['maps'][lod])
            body = L['body']
            body.data.materials.clear()
            body.data.materials.append(mt)
            mats[lod] = name
            e = abake.empty(f'LOD{lod}', parent=root, lod=lod)
            split = split_nodes(body, nodes)
            for nm, o in split.items():
                o.name = f'LOD{lod}_{nm}' if nm != 'body' else f'LOD{lod}_body'
                o.parent = e
                if nm != 'body':
                    o['node'] = nm
            L['split'] = split
            names = [name]
            for o, mk in L['glow']:
                gname = mk.split(':', 1)[1]
                if gname not in glow_mats:
                    spec = sp['glows'][gname]
                    gm = K.material_plain(gname, spec['color'], rough=spec.get('rough', 0.8))
                    b = next(n for n in gm.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
                    b.inputs['Emission Color'].default_value = (*spec['emit'], 1)
                    b.inputs['Emission Strength'].default_value = spec['strength']
                    glow_mats[gname] = gm
                o.data.materials.clear()
                o.data.materials.append(glow_mats[gname])
                o.parent = e
                names.append(gname)
            lod_mats[lod] = list(dict.fromkeys(names))
            # fracture pieces from the main body of this LOD (hidden in game; A5 spawns them)
            if sp.get('frac'):
                src = split.get('body') or next(iter(split.values()))
                pcs = slice_pieces(src, sp['frac'], 100 + lod, f'FRAC{lod}', vertical_bias=sp.get('frac_vbias', 0.5))
                for k, pc in enumerate(pcs):
                    pc.name = f'FRAC_{k}' if lod == 0 else f'FRAC_{k}_l1'
                    pc.parent = e
                    pc['frac'] = 1
                frac_info[lod] = {'pieces': len(pcs), 'tris': sum(abake.tri_count(p) for p in pcs)}
        col_src = [self.S['lods'][1]['split'].get('body') or next(iter(self.S['lods'][1]['split'].values()))]
        col = col_proxy(col_src)
        col.parent = root
        socks = []
        Mfit = Matrix.Identity(4)
        if self.S['fit'].get(0):
            f = self.S['fit'][0]
            Mfit = Matrix.Diagonal((f['scaleXY'], f['scaleXY'], f['scaleZ'], 1.0)) @ Matrix.Translation((0, 0, -f['before']['zmin']))
        for nm, pos, ex in sp.get('sockets', []):
            socks.append(abake.empty(nm, loc=tuple(Mfit @ Vector(pos)), parent=root, **ex))
        objs = [root, col] + list(root.children_recursive)
        glb = abake.export_glb(os.path.join(self.out, f'{self.id}_raw.glb'), objects=list(dict.fromkeys(objs)))
        materials = {}
        for lod in (0, 1):
            materials[mats[lod]] = {k: v for k, v in self.S['maps'][lod].items() if k in ('baseColor', 'normal', 'orm', 'size')} | {'metallicFactor': 1.0, 'roughnessFactor': 1.0}
        for gname, spec in sp.get('glows', {}).items():
            materials[gname] = {'baseColorFactor': [*spec['color'], 1], 'emissiveFactor': list(spec['emit']), 'emissiveStrength': spec['strength'],
                                'roughnessFactor': spec.get('rough', 0.8), 'metallicFactor': 0.0}
        asset = {
            'id': f'kit/{self.id}', 'glb': os.path.basename(glb['path']), 'role': sp['role'], 'kind': sp['kind'],
            'lods': {'LOD0': {'materials': lod_mats[0]}, 'LOD1': {'materials': lod_mats[1]}},
            'materials': materials, 'sources': sorted(set(sp.get('sources', []))), 'job': os.path.basename(self.out),
        }
        if sp.get('contract'):
            asset['contract'] = sp['contract']
        with open(os.path.join(self.out, 'asset.json'), 'w', encoding='utf-8') as f:
            json.dump(asset, f, indent=1)
        b0 = abake.bounds([o for o in self.S['lods'][0]['split'].values()] + [o for o, _ in self.S['lods'][0]['glow']])
        return {'glb': glb, 'frac': frac_info, 'bounds': {k: round(v, 4) for k, v in b0.items()}}

    # -- preview
    def preview(self):
        if not self.job.a.preview:
            return 'skipped'
        l0, l1 = bpy.data.objects['LOD0'], bpy.data.objects['LOD1']
        l0.parent = l1.parent = None
        b = abake.bounds([o for o in self.S['lods'][0]['split'].values()])
        w = max(0.5, b['radius'] * 2.6)
        H = max(0.3, b['zmax'] - min(0.0, b['zmin']))
        items = [(l0, -w), (l1, 0.0)]
        fr = [o for o in bpy.data.objects if o.name.startswith('FRAC_') and o.parent is l0]
        for k, o in enumerate(fr):
            o.parent = None
            o.hide_render = False
            c = Vector(np.array([v.co[:] for v in o.data.vertices]).mean(0))
            off = Vector((c.x, c.y, 0)) * 0.6 + Vector((0, 0, 0.15 * k / max(1, len(fr))))
            o.location = (w + off.x, off.y, off.z)
        for o in bpy.data.objects:
            if o.name.startswith('FRAC_') and o.parent is not None:
                o.hide_render = True
        zc = (b['zmax'] + b['zmin']) / 2
        # flat pieces (grates, vents, crumbling slabs) are seen from above, tall ones from the side
        return K.preview_scene(items, os.path.join(self.out, f'{self.id}_preview.png'), size=(1440, 640),
                               cam_loc=(0, -max(w * 3.2, H * 2.6), zc + max(H * 0.35, w * 1.1 if H < w * 0.4 else 0.0)), look=(0, 0, zc), lens=40)

    def run(self):
        j = self.job
        j.step('build', self.build)
        j.step('bake_lod0', self.bake, 0)
        j.step('bake_lod1', self.bake, 1)
        j.step('export', self.export)
        j.step('preview', self.preview)
        fails = [r['step'] for r in j.steps if not r['ok']]
        j.result['failed'] = fails
        j.done()
        return fails
