"""A3 shared stone kit: hero obstacle pieces with UNIQUE high->low bakes (arena art plan 4.2 / 4.3 / 5.2, milestone A3).

  --piece pillar_square   square masonry pillar (ref-3): plinth + 4 offset courses + capital with a broken top;
                          9-slice: SHAFT {y0, y1} = the courses, stretched at runtime so base + shaft + capital = o.h
  --piece column_ruin     fluted ruin column on a square plinth, broken top (flutes live in the high / normal map);
                          9-slice like the pillar; FRAC_* = drums
  --piece rubble_pile     broken masonry blocks + a toppled drum (the indestructible `rock` obstacle); no stretch

Per piece: LOD0 + LOD1 built procedurally -> UVs -> HIGH = voxel remesh of a detail source + numpy weathering
(stonekit.weather_high: chips, cracks, erosion, soot streaks, wet base, moss) -> bakes per LOD (normal, AO with a
ground plane, base colour, roughness; ORM packed) -> FRAC_* slices per LOD -> COL -> KIT_ root with extras -> GLB
without images + asset.json (tools/arena/build_assets.mjs attaches the textures) -> Cycles preview (high | LOD0 | LOD1).

GLB layout (plan 4.2):
  KIT_<id> {id, role 'obstacle', kind, r0, footprintR, height, debris, dustTint, stretch}
    LOD0 > <id>_lod0 (one mesh, material <id>_stone), FRAC_0..n (hidden at runtime, A5 spawns them)
    LOD1 > <id>_lod1 (material <id>_stone_low), FRAC_*
    COL (hidden LOS proxy)    SHAFT {y0, y1} (empty; 9-slice band in the asset frame, metres)
Run:  npm run arena:bake -- kit_pillar_square   (tools/arena/jobs.json, group a3)
"""
import json
import math
import os
import random
import sys

import bmesh
import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import abake  # noqa: E402
import stonekit as K  # noqa: E402


def extra(ap):
    ap.add_argument('--piece', required=True, choices=['pillar_square', 'column_ruin', 'rubble_pile'])
    ap.add_argument('--px', type=int, default=2048)
    ap.add_argument('--px-low', type=int, default=1024)
    ap.add_argument('--ao-samples', type=int, default=128)
    ap.add_argument('--voxel', type=float, default=0.012)
    ap.add_argument('--seed', type=int, default=7)
    ap.add_argument('--cc0', default='polyhaven/lichen_rock')
    ap.add_argument('--device', default='CPU')
    ap.add_argument('--preview', type=int, default=1)


job = abake.Job(extra, __doc__)
a = job.a
ID = a.piece
S = {}
RND = random.Random(a.seed)


# ---------------------------------------------------------------------------- piece builders

def pillar(lod):
    """square masonry pillar, nominal r0 0.7, H 5.0. Returns (obj, meta)"""
    H, y0, y1 = 5.0, 0.70, 4.30
    rnd = random.Random(a.seed + (0 if lod == 0 else 0))  # same jitter on both LODs
    c = 0.035
    R = K.square_ring
    rings = [R(0.75, 0.75, 0.0, c), R(0.75, 0.75, 0.30, c), R(0.70, 0.70, 0.36, c), R(0.64, 0.64, 0.36, c), R(0.64, 0.64, 0.56, c),
             R(0.59, 0.59, 0.62, c), R(0.55, 0.55, 0.62, c)]
    # courses between y0 and y1, each offset / twisted a little; joints are inset rings (LOD0 only)
    n = 4
    zs = [y0] + [y0 + (y1 - y0) * (k + rnd.uniform(-0.12, 0.12)) / n for k in range(1, n)] + [y1]
    prev = (0.0, 0.0, 0.0)
    for k in range(n):
        dx, dy, rot = rnd.uniform(-0.012, 0.012), rnd.uniform(-0.012, 0.012), rnd.uniform(-0.008, 0.008)
        hw = 0.55 + rnd.uniform(-0.01, 0.012)
        zb, zt = zs[k], zs[k + 1]
        if lod == 0:
            pd = ((prev[0] + dx) / 2, (prev[1] + dy) / 2, (prev[2] + rot) / 2)
            rings.append(R(hw - 0.028, hw - 0.028, zb, c, *pd))
            rings.append(R(hw, hw, zb + 0.035, c, dx, dy, rot))
            rings.append(R(hw, hw, zt - 0.035, c, dx, dy, rot))
        else:
            rings.append(R(hw, hw, zb, c, dx, dy, rot))
        prev = (dx, dy, rot)
    rings.append(R(0.525, 0.525, y1, c, prev[0] / 2, prev[1] / 2, prev[2] / 2) if lod == 0 else R(0.55, 0.55, y1, c))
    rings += [R(0.55, 0.55, 4.34, c), R(0.62, 0.62, 4.42, c), R(0.67, 0.67, 4.48, c), R(0.67, 0.67, 4.70, c), R(0.61, 0.61, 4.76, c), R(0.48, 0.48, 4.76, c)]
    # broken top: the last ring's corners at random heights, fan to an off-centre peak at exactly H
    top = [Vector((p.x, p.y, 4.80 + rnd.uniform(0.0, 0.14))) for p in R(0.47, 0.47, 0.0, c)]
    rings.append(top)
    bm = bmesh.new()
    K.loft(bm, rings, top_center=Vector((0.12, -0.08, H)))
    # silhouette damage (same planes on both LODs): a capital corner broken off, a plinth corner chipped, a shaft arris bitten
    for co, no in (((0.52, 0.5, 4.62), (0.62, 0.55, 0.56)), ((-0.62, 0.6, 0.30), (-0.62, 0.62, 0.48)), ((0.45, -0.47, 2.45), (0.7, -0.7, 0.12))):
        cut(bm, co, no)
    obj = K.to_object(f'{ID}_lod{lod}', bm)
    return obj, {'H': H, 'y0': y0, 'y1': y1, 'r0': 0.7, 'footprintR': 0.75 * math.sqrt(2), 'kind': 'column', 'frac': [0.0, y0 + (y1 - y0) / 3, y0 + 2 * (y1 - y0) / 3, y1, H]}


def cut(bm, co, no, reach=0.6):
    """broken corner: vertices within `reach` of `co` on the positive side of the plane are projected onto it
    (a bounded planar break; topology unchanged)"""
    n = Vector(no).normalized()
    c = Vector(co)
    for v in bm.verts:
        d = (v.co - c).dot(n)
        if d > 0 and (v.co - c).length < reach + d:
            v.co -= n * d
            v.co.z = max(0.0, v.co.z)


def column_profile(lod):
    """(r, z) profile of the round part (plinth separate); drum joints as small insets on LOD0"""
    H, y0, y1 = 4.2, 0.62, 3.45
    prof = [(0.56, 0.30), (0.57, 0.35), (0.53, 0.42), (0.50, 0.47)] if lod == 0 else [(0.56, 0.30), (0.53, 0.42), (0.49, 0.47)]
    joints = [y0 + (y1 - y0) * k / 3 for k in range(4)]
    rad = lambda z: 0.47 - 0.05 * (z - y0) / (y1 - y0)  # noqa: E731  entasis-free taper
    if lod == 0:
        prof.append((rad(0.5), 0.52))
        for k in range(3):
            zb, zt = joints[k], joints[k + 1]
            prof += [(rad(zb) - 0.022, zb), (rad(zb), zb + 0.03), (rad(zt), zt - 0.03)]
        prof.append((rad(y1) - 0.022, y1))
    else:
        prof += [(rad(y0), y0), (rad(y1), y1)]
    return H, y0, y1, prof, joints


def column(lod, fluted=False):
    H, y0, y1, prof, joints = column_profile(lod)
    rnd = random.Random(a.seed + 3)
    bm = bmesh.new()
    # square plinth (8-vert chamfered rings)
    c = 0.03 if lod == 0 else 0.0
    R = K.square_ring
    K.loft(bm, [R(0.62, 0.62, 0.0, c), R(0.62, 0.62, 0.24, c), R(0.58, 0.58, 0.30, c)])
    segs = 160 if fluted else (24 if lod == 0 else 12)
    rip = None
    if fluted:
        # 20 flutes on the shaft only (z > 0.5), sharp arrises
        zs = [z for _, z in prof]

        def rip(i, k):
            if zs[k] < 0.5:
                return 1.0
            t = (i % 8) / 8.0
            return 1.0 - 0.045 * math.sin(math.pi * t) ** 0.6
    rings = K.lathe(bm, prof, segs, ripple=rip)
    bm.faces.new(list(reversed(rings[0])))
    # broken top: rim at random heights between y1 and H, fan to a peak at exactly H
    top = rings[-1]
    ph = rnd.uniform(0, 6.28)
    rim = []
    for i, v in enumerate(top):
        ang = 2 * math.pi * i / segs
        hh = y1 + 0.05 + (H - y1 - 0.25) * (0.5 + 0.5 * math.sin(ang + ph)) * (0.55 + 0.45 * math.sin(3 * ang + 1.7 * ph) ** 2)
        rim.append(bm.verts.new((v.co.x * 0.985, v.co.y * 0.985, hh)))
    for i in range(segs):
        j = (i + 1) % segs
        bm.faces.new((top[i], top[j], rim[j], rim[i]))
    pk = bm.verts.new((0.18 * math.cos(ph), 0.18 * math.sin(ph), H))
    for i in range(segs):
        bm.faces.new((rim[i], rim[(i + 1) % segs], pk))
    obj = K.to_object(f'{ID}_lod{lod}' if not fluted else 'COLUMN_SRC', bm, smooth=True, sharp_deg=50)
    return obj, {'H': H, 'y0': y0, 'y1': y1, 'r0': 0.6, 'footprintR': 0.62 * math.sqrt(2), 'kind': 'column', 'frac': [0.0] + joints[1:] + [H]}


def rubble(lod):
    """rubble pile: a big broken block, a toppled drum, smaller blocks and chunks (nominal r0 0.55, radius 0.85)"""
    rnd = random.Random(a.seed + 9)
    bm = bmesh.new()
    c = 0.035 if lod == 0 else 0.0
    K.block(bm, 0.42, 0.34, 0.38, c, center=(-0.12, 0.05, 0.34), rot=0.3, tilt=(0.08, -0.05), cut=((0.6, 0.3, 0.75), 0.18))
    K.block(bm, 0.3, 0.24, 0.2, c, center=(0.42, -0.28, 0.18), rot=-0.5, tilt=(0.0, 0.12))
    K.block(bm, 0.22, 0.18, 0.15, c, center=(-0.3, 0.02, 0.84), rot=0.9, tilt=(0.18, 0.1), cut=((-0.5, 0.7, 0.5), 0.05))
    K.block(bm, 0.18, 0.14, 0.12, c, center=(-0.52, -0.45, 0.1), rot=1.3, cut=((0.3, -0.6, 0.7), 0.04))
    K.block(bm, 0.12, 0.1, 0.09, c, center=(0.58, 0.3, 0.07), rot=0.4, tilt=(0.3, 0.0))
    K.block(bm, 0.1, 0.08, 0.07, c, center=(0.15, -0.62, 0.06), rot=2.1, tilt=(0.2, 0.3), cut=((0.5, 0.5, 0.7), 0.02))
    K.block(bm, 0.08, 0.07, 0.06, c, center=(-0.72, 0.18, 0.05), rot=0.7, tilt=(0.4, 0.1))
    K.block(bm, 0.07, 0.06, 0.05, c, center=(0.34, 0.06, 0.05), rot=1.7, tilt=(0.1, 0.5))
    # toppled column drum lying on its side
    segs = 18 if lod == 0 else 10
    g = bmesh.new()
    rr = K.lathe(g, [(0.28, -0.3), (0.28, 0.3)], segs)
    g.faces.new(list(reversed(rr[0])))
    g.faces.new(rr[1])
    from mathutils import Matrix
    M = Matrix.Translation((0.4, 0.35, 0.27)) @ Matrix.Rotation(-0.6, 4, 'Z') @ Matrix.Rotation(math.pi / 2, 4, 'Y')
    for v in g.verts:
        v.co = M @ v.co
    me = bpy.data.meshes.new('tmp')
    g.to_mesh(me)
    g.free()
    bm.from_mesh(me)
    bpy.data.meshes.remove(me)
    obj = K.to_object(f'{ID}_lod{lod}', bm)
    # exact top / radius: measured after the build
    b = abake.bounds([obj])
    _ = rnd
    return obj, {'H': round(b['zmax'], 4), 'y0': None, 'y1': None, 'r0': 0.6, 'footprintR': round(b['radius'], 4), 'kind': 'rock', 'frac': None}


# ---------------------------------------------------------------------------- steps

def build():
    abake.reset()
    S['dev'] = abake.cycles_device(a.device, a.threads)
    S['cc'] = abake.load_cc0(a.cc0, need=('diff', 'rough', 'disp'))
    fn = {'pillar_square': pillar, 'column_ruin': column, 'rubble_pile': rubble}[ID]
    S['lod'] = {}
    for lod in (0, 1):
        o, meta = fn(lod)
        S['lod'][lod] = o
        S['meta'] = meta if lod == 0 else S['meta']
    # rubble: both LODs share the bounds of LOD0 exactly (fit LOD1 to it)
    for lod, o in S['lod'].items():
        abake.uv_unwrap(o, a.px if lod == 0 else a.px_low, angle=60, margin_px=10 if lod == 0 else 8)
    tris = {lod: abake.tri_count(o) for lod, o in S['lod'].items()}
    b = {lod: abake.bounds([o]) for lod, o in S['lod'].items()}
    return {'tris': tris, 'bounds': b, 'meta': S['meta'], 'cc0': S['cc']['meta']['id'], 'device': S['dev']}


def build_high():
    m = S['meta']
    if ID == 'column_ruin':
        src, _ = column(0, fluted=True)
    else:
        src = S['lod'][0]
    prm = dict(voxel=a.voxel, seed=a.seed, H=m['H'])
    if ID == 'pillar_square':
        prm.update(chip=0.09, chip_cell=0.24, chip_prob=0.55, crack=0.03, crack_cell=0.6, crack_frac=0.45, spall=0.018, spall_prob=0.35, erosion=0.009, wet_h=0.7)
    elif ID == 'column_ruin':
        prm.update(chip=0.045, chip_cell=0.13, chip_prob=0.45, crack=0.022, crack_cell=0.5, crack_frac=0.4)
    else:
        prm.update(chip=0.028, chip_cell=0.1, chip_prob=0.5, crack=0.015, crack_cell=0.35, crack_frac=0.35, wet_h=0.35, soot=0.4, moss=0.8, spall=0.008)
    hi, st = K.weather_high(src, 'HIGH', **prm)
    if src is not S['lod'][0]:
        bpy.data.objects.remove(src)
    hi.data.materials.clear()
    hi.data.materials.append(K.stone_material(S['cc']))
    S['high'] = hi
    return st


def bake_lod(lod):
    low = S['lod'][lod]
    px = a.px if lod == 0 else a.px_low
    pre = f'{ID}_lod{lod}'
    maps = K.bake_set(low, [S['high']], px, job.out, pre, ao_samples=a.ao_samples if lod == 0 else max(32, a.ao_samples // 2), extrusion=0.05, max_ray=0.14)
    S.setdefault('maps', {})[lod] = maps
    return {**maps, 'normalCheck': K.normal_stats(os.path.join(job.out, maps['normal']))}


def frac_slices(obj, cuts, lod):
    """FRAC_k: the LOD mesh cut into horizontal slices at `cuts` (z), holes filled (render-only pieces for A5)"""
    out = []
    for k in range(len(cuts) - 1):
        z0, z1 = cuts[k], cuts[k + 1]
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        for zc, keep_above in ((z0, True), (z1, False)):
            if (keep_above and zc <= 1e-4) or (not keep_above and zc >= S['meta']['H'] - 1e-4):
                continue
            geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
            r = bmesh.ops.bisect_plane(bm, geom=geom, plane_co=(0, 0, zc), plane_no=(0, 0, 1), clear_inner=keep_above, clear_outer=not keep_above)
            edges = [e for e in r['geom_cut'] if isinstance(e, bmesh.types.BMEdge)]
            if edges:
                bmesh.ops.holes_fill(bm, edges=edges, sides=0)
        me = bpy.data.meshes.new(f'FRAC_{k}_{lod}')
        bm.to_mesh(me)
        bm.free()
        o = K.link(bpy.data.objects.new(f'FRAC_{k}' if lod == 0 else f'FRAC_{k}.L1', me))
        o.data.materials.clear()
        out.append(o)
    return out


def assemble_and_export():
    m = S['meta']
    S['high'].hide_render = True
    mats = {}
    for lod, low in S['lod'].items():
        name = f'{ID}_stone' if lod == 0 else f'{ID}_stone_low'
        mat = K.textured_material(name, job.out, S['maps'][lod])
        low.data.materials.clear()
        low.data.materials.append(mat)
        mats[lod] = name
    extras = dict(id=f'kit/{ID}', role='obstacle', kind=m['kind'], r0=m['r0'], footprintR=round(m['footprintR'], 4), height=m['H'], debris='stone', dustTint='#4a4a58')
    if m['y0'] is not None:
        extras['stretch'] = 'SHAFT'
    root = abake.empty(f'KIT_{ID}', **extras)
    fr = {}
    for lod, low in S['lod'].items():
        e = abake.empty(f'LOD{lod}', parent=root, lod=lod)
        low.parent = e
        if m['frac']:
            pcs = frac_slices(low, m['frac'], lod)
            for p in pcs:
                p.data.materials.append(bpy.data.materials[mats[lod]])
                p.parent = e
                p['frac'] = 1
            fr[lod] = [abake.tri_count(p) for p in pcs]
    # COL: hidden proxy (base box + shaft box), Blender Z up
    bm = bmesh.new()
    if ID == 'rubble_pile':
        K.loft(bm, [K.square_ring(m['footprintR'] * 0.7, m['footprintR'] * 0.7, 0.0), K.square_ring(m['footprintR'] * 0.55, m['footprintR'] * 0.55, m['H'] * 0.9)])
    else:
        bh = 0.62 if ID == 'column_ruin' else 0.75
        K.loft(bm, [K.square_ring(bh, bh, 0.0), K.square_ring(bh, bh, 0.36)])
        K.loft(bm, [K.square_ring(0.5, 0.5, 0.36), K.square_ring(0.5, 0.5, m['H'] - 0.25)])
    col = K.to_object('COL', bm)
    col.parent = root
    col['col'] = 1
    col.hide_render = True
    objs = [root, col] + list(S['lod'].values()) + [c for c in root.children_recursive]
    if m['y0'] is not None:
        objs.append(abake.empty('SHAFT', parent=root, y0=m['y0'], y1=m['y1']))
    glb = abake.export_glb(os.path.join(job.out, f'{ID}_raw.glb'), objects=list(dict.fromkeys(objs)))
    asset = {
        'id': f'kit/{ID}', 'glb': os.path.basename(glb['path']), 'role': 'obstacle', 'kind': m['kind'],
        'contract': {'r0': m['r0'], 'height': m['H'], 'footprintR': round(m['footprintR'], 4), 'shaft': [m['y0'], m['y1']] if m['y0'] is not None else None,
                     'source': 'nominal sim obstacle (src/sim/arenaGen.ts THEME_RULES obstacleR / obstacleH); dressKit scales xz by o.r / r0 and stretches SHAFT to o.h'},
        'lods': {'LOD0': {'materials': [mats[0]]}, 'LOD1': {'materials': [mats[1]]}},
        'materials': {mats[lod]: {k: v for k, v in S['maps'][lod].items() if k in ('baseColor', 'normal', 'orm', 'size')} | {'metallicFactor': 0.0, 'roughnessFactor': 1.0} for lod in (0, 1)},
        'sources': [a.cc0],
        'job': os.path.basename(job.out),
    }
    with open(os.path.join(job.out, 'asset.json'), 'w', encoding='utf-8') as f:
        json.dump(asset, f, indent=1)
    return {'glb': glb, 'fracTris': fr}


def preview():
    if not a.preview:
        return 'skipped'
    m = S['meta']
    hi = S['high']
    l0 = bpy.data.objects[f'LOD0']
    l1 = bpy.data.objects[f'LOD1']
    root = bpy.data.objects[f'KIT_{ID}']
    l1.parent = None
    l0.parent = None
    for o in bpy.data.objects:
        if o.name.startswith('FRAC_'):
            o.hide_render = True
    sp = max(1.9, m['footprintR'] * 2.6)
    hi.location = (0, 0, 0)
    tall = m['H']
    _ = root
    if tall < 2:
        return K.preview_scene([(hi, -sp), (l0, 0.0), (l1, sp)], os.path.join(job.out, f'{ID}_preview.png'), size=(1440, 700),
                               cam_loc=(0, -sp * 2.6, sp * 1.1), look=(0, 0, 0.3), lens=38, device=a.device)
    return K.preview_scene([(hi, -sp), (l0, 0.0), (l1, sp)], os.path.join(job.out, f'{ID}_preview.png'), size=(1440, 900),
                           cam_loc=(0, -tall * 1.55 - sp * 0.8, tall * 0.42), look=(0, 0, tall * 0.45), lens=38, device=a.device)


job.step('build', build)
job.step('build_high', build_high)
job.step('bake_lod0', bake_lod, 0)
job.step('bake_lod1', bake_lod, 1)
job.step('export', assemble_and_export)
job.step('preview', preview)
fails = [r['step'] for r in job.steps if not r['ok']]
job.result['failed'] = fails
job.done()
if fails:
    sys.exit(1)
