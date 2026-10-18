"""A5 fracture sets (arena art plan 5.2 / 5.4, milestone A5): FRAC_* pieces for toppling obstacles (pillars, columns,
statues). Blender 5.0, bmesh only (no booleans, so it is fast and never fails on non-manifold decimated meshes).

fracture_axis(src, cuts, ...)
    The mesh is cut ACROSS its long axis (+Z) at the given heights by TILTED planes (a toppled pillar breaks into
    drums / blocks, a statue into plinth, legs, torso, head), then the biggest pieces are split once more ALONG the axis
    by a vertical plane (so the debris is not a stack of neat discs). Every cut is capped; the cap is triangulated and its
    interior diagonals subdivided and pushed in / out along the cut normal, so the fracture face is rough, not a clean
    saw cut. Cap faces take the UV of a neighbouring surface loop (the interior reads as the same stone) and are flat
    shaded; the original surface keeps its shading. Pieces keep the source frame (positions are the intact pose), so the
    runtime (src/render/arena/debris.ts FracSet) can start them exactly where the intact mesh was.
"""
import math
import random

import bmesh
import bpy
from mathutils import Vector


def _bm_of(src):
    bm = bmesh.new()
    bm.from_mesh(src.data)
    return bm


def _cut(bm, co, no, keep_positive, rough, rng):
    """bisect + rough cap; keep_positive keeps the side the normal points to"""
    geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
    r = bmesh.ops.bisect_plane(bm, geom=geom, plane_co=co, plane_no=no, clear_inner=keep_positive, clear_outer=not keep_positive, dist=1e-5)
    edges = [e for e in r['geom_cut'] if isinstance(e, bmesh.types.BMEdge) and e.is_valid and e.is_boundary]
    if not edges:
        return 0
    out_n = -Vector(no) if keep_positive else Vector(no)  # the cap faces away from the kept part
    return _cap(bm, edges, out_n, rough, rng)


def _cap(bm, edges, out_n, rough, rng, max_sub=40):
    cap_l = bm.faces.layers.int.get('cap') or bm.faces.layers.int.new('cap')
    try:
        r = bmesh.ops.holes_fill(bm, edges=edges, sides=0)
    except Exception:
        return 0
    faces = r.get('faces', [])
    if not faces:
        return 0
    for f in faces:
        f[cap_l] = 1
    t = bmesh.ops.triangulate(bm, faces=faces, quad_method='BEAUTY', ngon_method='BEAUTY')
    faces = [f for f in t['faces'] if f.is_valid]
    fs = set(faces)
    # interior diagonals (both sides cap faces) -> midpoints displaced along the cut normal: a rough fracture face
    inner = [e for e in {e for f in faces for e in f.edges} if len(e.link_faces) == 2 and all(lf in fs for lf in e.link_faces)]
    # only the longest diagonals (a few dozen at most): enough relief for a broken face without doubling the triangles
    inner.sort(key=lambda e: e.calc_length(), reverse=True)
    inner = inner[:min(max_sub, max(3, len(inner) // 4))]
    if inner and rough > 0:
        sd = bmesh.ops.subdivide_edges(bm, edges=inner, cuts=1, use_grid_fill=False)
        for v in sd['geom_inner']:
            if isinstance(v, bmesh.types.BMVert):
                v.co += out_n * (rng.uniform(-1.0, 1.0) * rough)
    # cap UVs: one neighbouring surface loop's UV for the whole cap (interior = the nearby stone colour), flat shading
    uvl = bm.loops.layers.uv.active
    caps = [f for f in bm.faces if f[cap_l] == 1]
    if uvl is not None:
        src = None
        for f in caps:
            for v in f.verts:
                for lp in v.link_loops:
                    if lp.face[cap_l] == 0:
                        src = lp[uvl].uv.copy()
                        break
                if src:
                    break
            if src:
                break
        if src is not None:
            for f in caps:
                for lp in f.loops:
                    lp[uvl].uv = src
    for f in caps:
        f.smooth = False
        f[cap_l] = 2  # done (a later cut on this piece must not re-UV it)
    return len(caps)


def _extent(bm):
    if not bm.verts:
        return 0.0, Vector()
    xs = [v.co for v in bm.verts]
    mn = Vector((min(p.x for p in xs), min(p.y for p in xs), min(p.z for p in xs)))
    mx = Vector((max(p.x for p in xs), max(p.y for p in xs), max(p.z for p in xs)))
    return (mx - mn).length, (mx + mn) / 2


def fracture_axis(src, cuts, seed, name, tilt=0.3, split=1, rough=0.03, jitter=0.08, min_verts=8):
    """FRAC pieces of `src` (mesh object, its own frame) cut across Z at `cuts` (heights) by planes tilted up to `tilt`
    rad, then the `split` biggest pieces halved along the axis. Returns a list of new objects named f'{name}_{k}'."""
    rng = random.Random(seed)
    planes = []
    for z in cuts:
        t = rng.uniform(0.35, 1.0) * tilt
        a = rng.uniform(0, 2 * math.pi)
        planes.append((Vector((rng.uniform(-jitter, jitter), rng.uniform(-jitter, jitter), z)), Vector((math.sin(t) * math.cos(a), math.sin(t) * math.sin(a), math.cos(t)))))
    pieces = []
    for k in range(len(planes) + 1):
        bm = _bm_of(src)
        if k > 0:
            _cut(bm, planes[k - 1][0], planes[k - 1][1], True, rough, rng)
        if k < len(planes):
            _cut(bm, planes[k][0], planes[k][1], False, rough, rng)
        if len(bm.verts) >= min_verts:
            pieces.append(bm)
        else:
            bm.free()
    # split the biggest pieces along the axis (vertical plane through the piece centre, random azimuth)
    for _ in range(split):
        pieces.sort(key=lambda b: _extent(b)[0], reverse=True)
        b = pieces[0]
        _e, c = _extent(b)
        a = rng.uniform(0, 2 * math.pi)
        n = Vector((math.cos(a), math.sin(a), rng.uniform(-0.15, 0.15))).normalized()
        co = c + Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), 0)) * 0.08 * _e
        halves = []
        for keep in (True, False):
            h = b.copy()
            _cut(h, co, n, keep, rough * 0.7, rng)
            halves.append(h)
        if all(len(h.verts) >= min_verts for h in halves):
            pieces.pop(0)
            b.free()
            pieces.extend(halves)
        else:
            for h in halves:
                h.free()
    out = []
    for k, b in enumerate(pieces):
        me = bpy.data.meshes.new(f'{name}_{k}')
        b.to_mesh(me)
        b.free()
        o = bpy.data.objects.new(f'{name}_{k}', me)
        bpy.context.scene.collection.objects.link(o)
        for m in src.data.materials:
            o.data.materials.append(m)
        if 'cap' in me.attributes:
            me.attributes.remove(me.attributes['cap'])
        out.append(o)
    return out
