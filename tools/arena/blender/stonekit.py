"""Shared stone-kit helpers for the A3 kit jobs (Blender 5.0, bpy + numpy). Arena art plan 4.2 / 5.2 / 5.3, milestone A3.

Low-poly builders (one closed mesh per LOD, Blender Z up, origin at the base centre):
  loft_rings      stack of chamfered square / polygon rings (pillars, plinths, mouldings) with optional jitter
  lathe           profile around Z (columns, balusters)
  block           chamfered box (rubble blocks, steps)
High-poly weathering (the bake source), `weather_high(src, ...)`:
  voxel remesh of a source mesh -> numpy on the remeshed vertices:
    convexity from Laplacian smoothing (edges vs cavities), erosion (3D fbm), conchoidal CHIPS (3D Worley cells that
    bite into convex edges), CRACKS (Worley cell borders of a coarse cell set, only some cells), broken faces
  -> vertices displaced along the normal; a FLOAT_COLOR point attribute 'tint' (RGB = albedo multiplier, A = roughness)
     carries the weathering masks: fresh chipped stone lighter, cracks / cavities dark, SOOT STREAKS running down from
     the top, WET DARKENING at the base, sparse dark moss in up-facing cavities.
Material of the high (`stone_material`): CC0 scan (Poly Haven lichen_rock) box-projected as LUMINANCE detail on a
graded blue-grey stone colour x 'tint', scan height as bump. Bakes per LOD: NORMAL (OpenGL tangent), AO (with a
ground plane), base colour + roughness as emission, ORM packed (metal 0).
"""
import math
import os
import random

import bmesh
import bpy
import numpy as np
from mathutils import Vector, kdtree

import abake

# graded Moon Gate stone (linear albedo): dark blue-grey, plan 3.1 "#2a2a4a to #5a5a8a" under moonlight
STONE_RGB = (0.2, 0.205, 0.235)
# stone trim sheet rows (kit_stone_trim.py): name -> (v0, v1) in metres from the bottom of the 8 x 8 m sheet
TRIM_ROWS = {'ashlar': (6.0, 8.0), 'blocks': (4.0, 6.0), 'moulding': (3.0, 4.0), 'frieze': (2.0, 3.0), 'rough': (1.0, 2.0), 'plain': (0.0, 1.0)}
TRIM_SIZE = 8.0


def link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


def to_object(name, bm, smooth=False, sharp_deg=None):
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.polygons.foreach_set('use_smooth', [smooth] * len(me.polygons))
    if smooth and sharp_deg is not None:
        try:
            me.set_sharp_from_angle(angle=math.radians(sharp_deg))
        except Exception:
            pass
    return link(bpy.data.objects.new(name, me))


def join(objs, name):
    """join mesh objects into the first, renamed"""
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    o.name = name
    o.data.name = name
    return o


# ---------------------------------------------------------------------------- low-poly builders

def square_ring(hx, hy, z, c=0.0, dx=0.0, dy=0.0, rot=0.0):
    """corner points of a rectangle (half sizes hx, hy) with chamfered corners c (8 points, CCW) at height z"""
    if c <= 1e-6:
        pts = [(hx, hy), (-hx, hy), (-hx, -hy), (hx, -hy)]
    else:
        pts = [(hx, hy - c), (hx - c, hy), (-hx + c, hy), (-hx, hy - c), (-hx, -hy + c), (-hx + c, -hy), (hx - c, -hy), (hx, -hy + c)]
    cr, sr = math.cos(rot), math.sin(rot)
    return [Vector((x * cr - y * sr + dx, x * sr + y * cr + dy, z)) for x, y in pts]


def loft(bm, rings, cap_bottom=True, cap_top=True, top_center=None):
    """bridge consecutive rings (same vertex count); caps as n-gons or a fan to `top_center` (Vector)"""
    vr = [[bm.verts.new(p) for p in r] for r in rings]
    n = len(rings[0])
    for A, B in zip(vr, vr[1:]):
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((A[i], A[j], B[j], B[i]))
    if cap_bottom:
        bm.faces.new(list(reversed(vr[0])))
    if cap_top:
        if top_center is not None:
            c = bm.verts.new(top_center)
            for i in range(n):
                bm.faces.new((vr[-1][i], vr[-1][(i + 1) % n], c))
        else:
            bm.faces.new(vr[-1])
    return vr


def lathe(bm, prof, segs, phase=0.0, ripple=None):
    """profile [(r, z)] around +Z; r = 0 points become a single axis vertex (fan). ripple(i, k) -> radius multiplier"""
    rings = []
    for k, (r, z) in enumerate(prof):
        if r < 1e-6:
            rings.append([bm.verts.new((0, 0, z))])
        else:
            ring = []
            for i in range(segs):
                a = phase + 2 * math.pi * i / segs
                rr = r * (ripple(i, k) if ripple else 1.0)
                ring.append(bm.verts.new((rr * math.cos(a), rr * math.sin(a), z)))
            rings.append(ring)
    for A, B in zip(rings, rings[1:]):
        for i in range(segs):
            j = (i + 1) % segs
            if len(A) == 1:
                bm.faces.new((A[0], B[j], B[i]))
            elif len(B) == 1:
                bm.faces.new((A[i], A[j], B[0]))
            else:
                bm.faces.new((A[i], A[j], B[j], B[i]))
    return rings


def block(bm, hx, hy, hz, c, center=(0, 0, 0), rot=0.0, tilt=(0.0, 0.0), cut=None):
    """chamfered box (rings at the bottom chamfer, body, top chamfer); `cut` = (normal, offset) slices off a corner
    (broken block). Returns the new verts."""
    cx, cy, cz = center
    rings = [square_ring(hx - c, hy - c, -hz, c * 0.6), square_ring(hx, hy, -hz + c, c), square_ring(hx, hy, hz - c, c), square_ring(hx - c, hy - c, hz, c * 0.6)]
    vr = loft(bm, rings)
    from mathutils import Matrix
    M = Matrix.Translation((cx, cy, cz)) @ Matrix.Rotation(rot, 4, 'Z') @ Matrix.Rotation(tilt[0], 4, 'X') @ Matrix.Rotation(tilt[1], 4, 'Y')
    vs = [v for r in vr for v in r]
    for v in vs:
        v.co = M @ v.co
    if cut is not None:
        nrm, off = cut
        nrm = (M.to_3x3() @ Vector(nrm)).normalized()
        co = M @ (Vector(nrm) * 0)  # unused; plane through the block centre + offset
        plane_co = Vector((cx, cy, cz)) + nrm * off
        geom = list(set([v for v in vs] + [e for v in vs for e in v.link_edges] + [f for v in vs for f in v.link_faces]))
        res = bmesh.ops.bisect_plane(bm, geom=geom, plane_co=plane_co, plane_no=nrm, clear_outer=True)
        edges = [e for e in res['geom_cut'] if isinstance(e, bmesh.types.BMEdge)]
        if edges:
            try:
                bmesh.ops.holes_fill(bm, edges=edges, sides=0)
            except Exception:
                pass
        _ = co
    return vs


def drum(bm, r0, r1, z0, z1, segs, flutes=0, flute_depth=0.0, broken_top=None, seed=0):
    """a column drum (tapered cylinder); flutes as a radius ripple; broken_top = jitter amplitude of the top rim"""
    rnd = random.Random(seed)
    rip = (lambda i, k: 1.0 - flute_depth * (0.5 + 0.5 * math.cos(2 * math.pi * flutes * i / segs))) if flutes else None
    rings = [[(r0, z0)], [(r1, z1)]]
    prof = [(r0, z0), (r1, z1)]
    rr = lathe(bm, prof, segs, ripple=rip)
    bm.faces.new(list(reversed(rr[0])))
    if broken_top:
        c = bm.verts.new((rnd.uniform(-0.1, 0.1) * r1, rnd.uniform(-0.1, 0.1) * r1, z1 + broken_top * 0.3))
        ph = rnd.uniform(0, 6.28)
        for i, v in enumerate(rr[1]):
            a = 2 * math.pi * i / segs
            v.co.z = z1 - broken_top * (0.5 + 0.5 * math.sin(a * 2 + ph)) * rnd.uniform(0.4, 1.0)
        for i in range(segs):
            bm.faces.new((rr[1][i], rr[1][(i + 1) % segs], c))
    else:
        bm.faces.new(rr[1])
    _ = rings
    return rr


# ---------------------------------------------------------------------------- numpy noise

def _hash3(ix, iy, iz, seed):
    h = (ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791) ^ (seed * 2654435761)
    h = (h ^ (h >> 13)) * 1274126177
    h = h ^ (h >> 16)
    return (h & 0xFFFFFF).astype(np.float32) / float(0xFFFFFF)


def value_noise3(p, seed=0):
    """smooth 3D value noise in [0, 1] for points p (N, 3)"""
    f = np.floor(p)
    t = p - f
    t = t * t * (3 - 2 * t)
    i = f.astype(np.int64)
    out = np.zeros(len(p), dtype=np.float32)
    for dx in (0, 1):
        wx = t[:, 0] if dx else 1 - t[:, 0]
        for dy in (0, 1):
            wy = t[:, 1] if dy else 1 - t[:, 1]
            for dz in (0, 1):
                wz = t[:, 2] if dz else 1 - t[:, 2]
                out += wx * wy * wz * _hash3(i[:, 0] + dx, i[:, 1] + dy, i[:, 2] + dz, seed)
    return out


def fbm3(p, octaves=4, seed=0, lac=2.03, gain=0.5):
    amp, tot, acc = 1.0, 0.0, np.zeros(len(p), dtype=np.float32)
    q = p.astype(np.float64)
    for o in range(octaves):
        acc += amp * value_noise3(q, seed + o * 17)
        tot += amp
        amp *= gain
        q = q * lac + 3.17
    return acc / tot


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def worley(points, bmin, bmax, cell, seed):
    """F1, F2 distances and the nearest feature id for points (N, 3); features jittered on a `cell` grid"""
    rnd = np.random.default_rng(seed)
    lo = np.asarray(bmin) - cell
    hi = np.asarray(bmax) + cell
    n = np.maximum(1, np.ceil((hi - lo) / cell).astype(int))
    g = np.stack(np.meshgrid(*[np.arange(k) for k in n], indexing='ij'), -1).reshape(-1, 3)
    feats = lo + (g + rnd.uniform(0.1, 0.9, g.shape)) * cell
    kd = kdtree.KDTree(len(feats))
    for i, f in enumerate(feats):
        kd.insert(Vector(f), i)
    kd.balance()
    F1 = np.empty(len(points), np.float32)
    F2 = np.empty(len(points), np.float32)
    ID = np.empty(len(points), np.int64)
    for k, p in enumerate(points):
        r = kd.find_n(Vector(p), 2)
        F1[k], F2[k], ID[k] = r[0][2], r[1][2], r[0][1]
    return F1, F2, ID, len(feats)


# ---------------------------------------------------------------------------- high-poly weathering

def mesh_arrays(me):
    nv = len(me.vertices)
    co = np.empty(nv * 3, np.float32)
    me.vertices.foreach_get('co', co)
    nr = np.empty(nv * 3, np.float32)
    me.vertex_normals.foreach_get('vector', nr)
    ed = np.empty(len(me.edges) * 2, np.int64)
    me.edges.foreach_get('vertices', ed)
    return co.reshape(-1, 3), nr.reshape(-1, 3), ed.reshape(-1, 2)


def neighbor_mean(P, ed, deg):
    acc = np.zeros_like(P)
    np.add.at(acc, ed[:, 0], P[ed[:, 1]])
    np.add.at(acc, ed[:, 1], P[ed[:, 0]])
    return acc / deg[:, None]


def weather_high(src, name, voxel=0.012, seed=1, H=None, chip=0.05, chip_cell=0.16, chip_prob=0.45, crack=0.022,
                 crack_cell=0.55, crack_frac=0.35, erosion=0.006, soot=0.7, wet_h=0.55, moss=0.5, smooth_iter=10,
                 fresh=1.25, keep=None, spall=0.014, spall_prob=0.3):
    """weathered high-poly from `src` (copied; src untouched). Returns the new object (with a 'tint' attribute).
    Displacements are in metres (negative = into the stone). `H` = height used for the top-down soot gradient."""
    hi = src.copy()
    hi.data = src.data.copy()
    hi.name = name
    link(hi)
    for m in list(hi.modifiers):
        hi.modifiers.remove(m)
    rm = hi.modifiers.new('remesh', 'REMESH')
    rm.mode = 'VOXEL'
    rm.voxel_size = voxel
    rm.adaptivity = 0.0
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(hi.evaluated_get(dg))
    hi.modifiers.clear()
    old = hi.data
    hi.data = me
    bpy.data.meshes.remove(old)
    me.name = name
    P0, N, ed = mesh_arrays(me)
    nv = len(P0)
    deg = np.bincount(ed.ravel(), minlength=nv).astype(np.float32)
    deg[deg == 0] = 1
    # convexity: how far Laplacian smoothing pulls a vertex along its normal (inward on convex edges)
    P = P0.copy()
    for _ in range(smooth_iter):
        P = 0.5 * P + 0.5 * neighbor_mean(P, ed, deg)
    d = np.einsum('ij,ij->i', P - P0, N)
    q = max(1e-6, float(np.quantile(np.abs(d), 0.985)))
    convex = np.clip(-d / q, 0, 1)
    concave = np.clip(d / q, 0, 1)
    # a wider band (more smoothing) for the chips: bites reach 8-15 cm into the faces from the arris
    for _ in range(smooth_iter * 3):
        P = 0.5 * P + 0.5 * neighbor_mean(P, ed, deg)
    dw = np.einsum('ij,ij->i', P - P0, N)
    convw = np.clip(-dw / max(1e-6, float(np.quantile(np.abs(dw), 0.97))), 0, 1)
    bmin, bmax = P0.min(0), P0.max(0)
    Htop = H if H else float(bmax[2])
    z = P0[:, 2]
    # erosion: fbm everywhere, stronger on edges
    e1 = fbm3(P0 * 9.0, 4, seed) - 0.5
    e2 = fbm3(P0 * 31.0, 3, seed + 5) - 0.5
    pits = smoothstep(0.62, 0.8, fbm3(P0 * 55.0, 2, seed + 6))
    disp = erosion * (1.6 * e1 + 0.8 * e2) * (0.7 + 1.3 * convex) - erosion * 0.6 * pits
    # chips: Worley cells; a cell is "chipped" with probability chip_prob; the bite follows the convex band, deepest
    # mid-cell (conchoidal flake), hard steps at the cell borders
    F1, F2, ID, nf = worley(P0, bmin, bmax, chip_cell, seed + 11)
    rnd = np.random.default_rng(seed + 12)
    cell_on = rnd.uniform(0, 1, nf) < chip_prob
    cell_dep = rnd.uniform(0.35, 1.0, nf)
    # each chipped cell breaks along its own threshold of the wide convex band: a crisp fracture rim where convw crosses
    # the threshold, a sloping facet towards the arris (reads as a flake knocked off, not a rounded groove)
    thr = rnd.uniform(0.15, 0.55, nf)
    t = thr[ID]
    facet = np.clip((convw - t) / np.maximum(1e-3, 1 - t), 0, 1)
    rim = smoothstep(0.0, 0.06, convw - t)
    bite = cell_on[ID] * cell_dep[ID] * (0.25 * rim + 0.75 * facet) * (0.6 + 0.4 * smoothstep(0.0, 0.25, (F2 - F1) / chip_cell))
    chipd = chip * bite
    disp -= chipd
    # spalling: shallow flakes lost from flat faces (same cells, independent draw), hard rims
    sp_on = rnd.uniform(0, 1, nf) < spall_prob
    flake = sp_on[ID] * smoothstep(0.0, 0.35, (F2 - F1) / chip_cell) * (1 - smoothstep(0.2, 0.6, convex)) * cell_dep[ID]
    disp -= spall * flake
    chipd = chipd + 0.5 * spall * flake
    # cracks: borders of a coarse Worley set, only between some cells, narrow V grooves, plus a fine hairline layer
    C1, C2, CID, nc = worley(P0, bmin, bmax, crack_cell, seed + 21)
    con = np.random.default_rng(seed + 22).uniform(0, 1, nc) < crack_frac
    edge_d = C2 - C1
    width = 0.010 + 0.012 * fbm3(P0 * 4.0, 2, seed + 23)
    cr = con[CID] * (1 - smoothstep(0.0, width, edge_d)) * smoothstep(0.35, 0.6, fbm3(P0 * 2.2, 2, seed + 24))
    disp -= crack * cr
    keepm = np.ones(nv, np.float32) if keep is None else keep(P0, N).astype(np.float32)
    disp *= keepm
    P1 = P0 + N * disp[:, None]
    me.vertices.foreach_set('co', P1.astype(np.float32).ravel())
    me.update()
    # weathering masks -> tint (albedo multiplier) + roughness
    up = N[:, 2]
    cav = np.clip(concave * 1.2 + cr + 0.5 * pits, 0, 1)
    fr = np.clip(chipd / max(1e-6, chip) * 1.6, 0, 1)
    tint = np.ones((nv, 3), np.float32)
    lum = 1.0 + 0.18 * (fbm3(P0 * 1.3, 3, seed + 31) - 0.5) * 2  # large-scale block-to-block variation
    tint *= lum[:, None]
    tint *= (1.0 + (fresh - 1.0) * fr * (0.6 + 0.4 * convex))[:, None]
    tint *= (1.0 - 0.62 * cav)[:, None]
    # soot streaks: vertical noise (stretched along z) starting from the top and from ledges, fading downwards
    st = fbm3(np.c_[P0[:, 0] * 5.0, P0[:, 1] * 5.0, P0[:, 2] * 0.35], 3, seed + 41)
    st = smoothstep(0.42, 0.6, st)
    topfade = smoothstep(0.15, 1.0, z / max(1e-3, Htop))
    sootm = np.clip(soot * st * (0.25 + 0.75 * topfade), 0, 0.9)
    tint *= (1.0 - 0.7 * sootm)[:, None]
    # wet base: darker + glossier, with a ragged wet line
    wl = wet_h * (0.75 + 0.5 * fbm3(P0 * 3.0, 3, seed + 51))
    wet = 1 - smoothstep(wl * 0.55, wl, z)
    tint *= (1.0 - 0.6 * wet)[:, None]
    # moss: up-facing cavities and the wet base, sparse
    mm = moss * smoothstep(0.45, 0.8, up) * np.clip(cav * 1.5 + 0.6 * wet, 0, 1) * smoothstep(0.5, 0.7, fbm3(P0 * 6.0, 3, seed + 61))
    moss_rgb = np.array([0.42, 0.55, 0.30], np.float32)
    tint = tint * (1 - mm[:, None]) + (tint * moss_rgb[None, :] * 0.8) * mm[:, None]
    rough = np.clip(0.86 - 0.08 * fr + 0.06 * sootm - 0.45 * wet + 0.04 * cav, 0.3, 0.97)
    att = me.color_attributes.new('tint', 'FLOAT_COLOR', 'POINT')
    att.data.foreach_set('color', np.c_[tint, rough].astype(np.float32).ravel())
    me.polygons.foreach_set('use_smooth', [True] * len(me.polygons))
    stats = {'verts': nv, 'tris': sum(len(p.vertices) - 2 for p in me.polygons), 'chipMax': float(chipd.max()), 'convexShare': float((convex > 0.3).mean()),
             'crackShare': float((cr > 0.5).mean()), 'wetShare': float((wet > 0.5).mean()), 'mossShare': float((mm > 0.2).mean())}
    return hi, stats


# ---------------------------------------------------------------------------- materials

def stone_material(cc, name='stone_hi', scale=0.8, rgb=STONE_RGB, bump=0.004):
    """CC0 scan luminance as detail over the graded stone colour, x the 'tint' attribute; roughness = tint alpha x scan.
    cc = abake.load_cc0(...) with diff, rough, disp."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    N, L = nt.nodes, nt.links
    bsdf = next(n for n in N if n.type == 'BSDF_PRINCIPLED')
    tc = N.new('ShaderNodeTexCoord')
    mp = N.new('ShaderNodeMapping')
    mp.inputs['Scale'].default_value = (1 / scale, 1 / scale, 1 / scale)
    L.new(tc.outputs['Object'], mp.inputs['Vector'])

    def tex(path, non_color):
        t = N.new('ShaderNodeTexImage')
        t.image = abake.load_image(path, non_color)
        t.projection = 'BOX'
        t.projection_blend = 0.35
        L.new(mp.outputs['Vector'], t.inputs['Vector'])
        return t

    diff, rough, disp = tex(cc['diff'], False), tex(cc['rough'], True), tex(cc['disp'], True)
    bw = N.new('ShaderNodeRGBToBW')
    L.new(diff.outputs['Color'], bw.inputs['Color'])
    mr = N.new('ShaderNodeMapRange')  # scan luminance (linear, mean ~0.05) -> detail multiplier 0.45..1.65
    mr.inputs['From Min'].default_value = 0.0
    mr.inputs['From Max'].default_value = 0.12
    mr.inputs['To Min'].default_value = 0.72
    mr.inputs['To Max'].default_value = 1.28
    L.new(bw.outputs['Val'], mr.inputs['Value'])
    att = N.new('ShaderNodeAttribute')
    att.attribute_name = 'tint'
    m1 = N.new('ShaderNodeVectorMath')
    m1.operation = 'MULTIPLY'
    L.new(att.outputs['Color'], m1.inputs[0])
    m1.inputs[1].default_value = rgb
    m2 = N.new('ShaderNodeVectorMath')
    m2.operation = 'SCALE'
    L.new(m1.outputs['Vector'], m2.inputs[0])
    L.new(mr.outputs['Result'], m2.inputs['Scale'])
    L.new(m2.outputs['Vector'], bsdf.inputs['Base Color'])
    # roughness: attribute alpha, modulated a little by the scan roughness
    rm = N.new('ShaderNodeMapRange')
    rm.inputs['To Min'].default_value = 0.88
    rm.inputs['To Max'].default_value = 1.08
    L.new(rough.outputs['Color'], rm.inputs['Value'])
    rr = N.new('ShaderNodeMath')
    rr.operation = 'MULTIPLY'
    rr.use_clamp = True
    L.new(att.outputs['Alpha'], rr.inputs[0])
    L.new(rm.outputs['Result'], rr.inputs[1])
    L.new(rr.outputs[0], bsdf.inputs['Roughness'])
    bsdf.inputs['Metallic'].default_value = 0.0
    b = N.new('ShaderNodeBump')
    b.inputs['Distance'].default_value = bump
    b.inputs['Strength'].default_value = 1.0
    L.new(disp.outputs['Color'], b.inputs['Height'])
    L.new(b.outputs['Normal'], bsdf.inputs['Normal'])
    return m


def material_plain(name, color, rough=0.9, metal=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    b.inputs['Base Color'].default_value = (*color, 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    return m


def textured_material(name, maps_dir, maps):
    """preview material from a baked set (base colour, ORM, normal)"""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    tb = nt.nodes.new('ShaderNodeTexImage')
    tb.image = abake.load_image(os.path.join(maps_dir, maps['baseColor']))
    to = nt.nodes.new('ShaderNodeTexImage')
    to.image = abake.load_image(os.path.join(maps_dir, maps['orm']), True)
    sc = nt.nodes.new('ShaderNodeSeparateColor')
    nt.links.new(to.outputs['Color'], sc.inputs['Color'])
    mul = nt.nodes.new('ShaderNodeMix')
    mul.data_type = 'RGBA'
    mul.blend_type = 'MULTIPLY'
    mul.inputs['Factor'].default_value = 1.0
    nt.links.new(tb.outputs['Color'], next(x for x in mul.inputs if x.name == 'A' and x.type == 'RGBA'))
    nt.links.new(sc.outputs['Red'], next(x for x in mul.inputs if x.name == 'B' and x.type == 'RGBA'))
    nt.links.new(next(x for x in mul.outputs if x.name == 'Result' and x.type == 'RGBA'), b.inputs['Base Color'])
    nt.links.new(sc.outputs['Green'], b.inputs['Roughness'])
    nt.links.new(sc.outputs['Blue'], b.inputs['Metallic'])
    tn = nt.nodes.new('ShaderNodeTexImage')
    tn.image = abake.load_image(os.path.join(maps_dir, maps['normal']), True)
    nm = nt.nodes.new('ShaderNodeNormalMap')
    nt.links.new(tn.outputs['Color'], nm.inputs['Color'])
    nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
    return m


# ---------------------------------------------------------------------------- bakes

def save_np(arr, path, non_color=True):
    h, w = arr.shape[:2]
    im = bpy.data.images.new(os.path.basename(path), w, h, alpha=False)
    if non_color:
        im.colorspace_settings.name = 'Non-Color'
    px = np.ones((h, w, 4), np.float32)
    px[..., :arr.shape[2]] = arr
    im.pixels.foreach_set(px.ravel())
    im.filepath_raw = path
    im.file_format = 'PNG'
    im.save()
    bpy.data.images.remove(im)
    return path


def load_np(path):
    im = bpy.data.images.load(path, check_existing=False)
    im.colorspace_settings.name = 'Non-Color'
    w, h = im.size
    px = np.empty(w * h * 4, np.float32)
    im.pixels.foreach_get(px)
    bpy.data.images.remove(im)
    return px.reshape(h, w, 4)


def bake_set(low, highs, px, out_dir, prefix, ao_samples=128, extrusion=0.04, max_ray=0.12, ground=True):
    """NORMAL + AO (+ ground plane for contact AO) + base colour / roughness emission bakes onto `low`; ORM packed with
    metal 0. Returns {'baseColor', 'normal', 'orm', 'size', 'seconds': {...}} (file names in out_dir)."""
    s = bpy.context.scene
    tmp = material_plain(f'bake_{prefix}', (0.5, 0.5, 0.5))
    low.data.materials.clear()
    low.data.materials.append(tmp)
    s.render.bake.max_ray_distance = max_ray
    # only the high (and the ground plane) may occlude: other LODs / pieces are hidden, the low itself is invisible to rays
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
        gp.data.materials.append(material_plain('ground_ao', (0.2, 0.2, 0.2)))
    res = abake.bake_maps(low, highs, ['NORMAL'], px, out_dir, samples=1, extrusion=extrusion, prefix=prefix)
    res.update(abake.bake_maps(low, highs, ['AO'], px, out_dir, samples=ao_samples, extrusion=extrusion, prefix=prefix))
    res.update(abake.bake_emit_inputs(low, highs, ['Base Color', 'Roughness'], px, out_dir, prefix, samples=4, extrusion=extrusion))
    if gp is not None:
        bpy.data.objects.remove(gp)
    for o in hidden:
        o.hide_render = False
    for k, v in vis.items():
        setattr(low, k, v)
    ao = load_np(res['AO']['path'])[..., 0]
    ro = load_np(res['Roughness']['path'])[..., 0]
    orm = os.path.join(out_dir, f'{prefix}_orm.png')
    save_np(np.stack([ao, ro, np.zeros_like(ao)], -1), orm)
    return {'baseColor': os.path.basename(res['Base Color']['path']), 'normal': os.path.basename(res['NORMAL']['path']), 'orm': os.path.basename(orm), 'size': px,
            'seconds': {k: v['seconds'] for k, v in res.items()}}


def normal_stats(path):
    """quick artefact check of a baked tangent normal map: share of texels far from 'up' and of invalid (z < 0)"""
    n = load_np(path)[..., :3] * 2 - 1
    z = n[..., 2]
    return {'meanZ': float(z.mean()), 'belowZ0.3': float((z < 0.3).mean()), 'negativeZ': float((z < 0).mean())}


# ---------------------------------------------------------------------------- preview

def preview_scene(objs_offsets, path, size=(1280, 720), cam_loc=(0, -9, 2.6), look=(0, 0, 2.2), lens=40, samples=48, device='CPU'):
    """Cycles still of the given (object, x offset) pairs on a dark wet-ish floor, moonlight from behind + a warm fire
    light and a soft key: for the README / by-eye check only (not shipped)."""
    s = bpy.context.scene
    s.render.engine = 'CYCLES'
    abake.cycles_device(device)
    s.cycles.samples = samples
    try:
        s.cycles.use_denoising = True
    except Exception:
        pass
    s.render.resolution_x, s.render.resolution_y = size
    for o, dx in objs_offsets:
        o.location.x += dx
        o.hide_render = False
    bpy.ops.mesh.primitive_plane_add(size=60, location=(0, 0, 0))
    fl = bpy.context.active_object
    fl.data.materials.append(material_plain('floor', (0.03, 0.032, 0.04), rough=0.35))
    w = bpy.data.worlds.new('w')
    s.world = w
    w.use_nodes = True
    w.node_tree.nodes['Background'].inputs['Color'].default_value = (0.012, 0.014, 0.03, 1)
    sd = bpy.data.lights.new('moon', 'SUN')
    sd.energy = 2.6
    sd.color = (0.72, 0.74, 1.0)
    sd.angle = math.radians(1.5)
    so = link(bpy.data.objects.new('moon', sd))
    so.rotation_euler = (math.radians(62), 0, math.radians(200))
    ld = bpy.data.lights.new('fire', 'POINT')
    ld.energy = 900
    ld.color = (1.0, 0.5, 0.2)
    ld.shadow_soft_size = 0.3
    lo = link(bpy.data.objects.new('fire', ld))
    lo.location = (-3.5, -3.0, 1.6)
    kd = bpy.data.lights.new('key', 'AREA')
    kd.energy = 300
    kd.size = 4
    kd.color = (0.75, 0.78, 1.0)
    ko = link(bpy.data.objects.new('key', kd))
    ko.location = (5, -7, 6)
    ko.rotation_euler = (math.radians(55), 0, math.radians(35))
    cd = bpy.data.cameras.new('cam')
    cd.lens = lens
    cam = link(bpy.data.objects.new('cam', cd))
    cam.location = cam_loc
    dvec = Vector(look) - Vector(cam_loc)
    cam.rotation_euler = dvec.to_track_quat('-Z', 'Y').to_euler()
    s.camera = cam
    abake.image_settings('PNG', '8', 'RGB')
    s.view_settings.view_transform = 'AgX'
    return abake.render_still(path)
