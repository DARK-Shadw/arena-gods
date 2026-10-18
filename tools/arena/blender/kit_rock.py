"""A3 scan-based rocks (arena art plan 5.2 "Rocks, broken masonry, rubble": scanned Poly Haven rocks decimated + baked).

  --piece rock_prop       the sim's throwable `rock` prop: one Poly Haven rock_moss_set_02 scan rock fitted EXACTLY to
                          PROP_BASE.rock.r 0.4 / TOP.rock 0.75 (abake.fit_bounds), origin at the base centre
  --piece rubble_scatter  render-only decor cluster (about 1.8 x 1.2 m, 0.45 m high): five small scan rocks + two broken
                          masonry chunks (stonekit weathering), scattered by dressKit at wall feet

High = the scan meshes with their own CC0 maps (diffuse, GL normal, roughness), colour graded towards the Moon Gate stone
(desaturated, cool, darker); LOD0 / LOD1 = decimated copies; bakes: normal, AO (ground plane), base colour, roughness.
"""
import json
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import abake  # noqa: E402
import stonekit as K  # noqa: E402


def extra(ap):
    ap.add_argument('--piece', required=True, choices=['rock_prop', 'rubble_scatter'])
    ap.add_argument('--px', type=int, default=1024)
    ap.add_argument('--px-low', type=int, default=512)
    ap.add_argument('--ao-samples', type=int, default=96)
    ap.add_argument('--cc0', default='polyhaven/rock_moss_set_02')
    ap.add_argument('--stone', default='polyhaven/lichen_rock')
    ap.add_argument('--seed', type=int, default=4)


job = abake.Job(extra, __doc__)
a = job.a
ID = a.piece
S = {}


def grade_material(mat):
    """insert a grade after the scan's base colour: desaturate, cool and darken toward the kit stone"""
    nt = mat.node_tree
    b = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    if not b.inputs['Base Color'].is_linked:
        return
    src = b.inputs['Base Color'].links[0].from_socket
    hsv = nt.nodes.new('ShaderNodeHueSaturation')
    hsv.inputs['Saturation'].default_value = 0.3
    hsv.inputs['Value'].default_value = 0.62
    nt.links.new(src, hsv.inputs['Color'])
    mul = nt.nodes.new('ShaderNodeVectorMath')
    mul.operation = 'MULTIPLY'
    nt.links.new(hsv.outputs['Color'], mul.inputs[0])
    mul.inputs[1].default_value = (0.86, 0.9, 1.05)
    nt.links.new(mul.outputs['Vector'], b.inputs['Base Color'])


def import_rocks():
    cc = abake.load_cc0(a.cc0, need=('gltf',))
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=cc['gltf'])
    new = [o for o in bpy.data.objects if o not in before and o.type == 'MESH']
    for o in new:
        o.parent = None
    bpy.ops.object.select_all(action='DESELECT')
    for o in new:
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    for m in {s.material for o in new for s in o.material_slots if s.material}:
        grade_material(m)
    return sorted(new, key=lambda o: o.name)


def settle(o):
    """rest the rock on its broadest flat side: of the 6 axis orientations, the one with most vertices near the bottom"""
    me = o.data
    me.transform(o.matrix_world)
    o.matrix_world = Matrix.Identity(4)
    co = np.array([v.co[:] for v in me.vertices])
    best, bs = Matrix.Identity(4), -1
    for R in (Matrix.Identity(4), Matrix.Rotation(math.pi, 4, 'X'), Matrix.Rotation(math.pi / 2, 4, 'X'), Matrix.Rotation(-math.pi / 2, 4, 'X'),
              Matrix.Rotation(math.pi / 2, 4, 'Y'), Matrix.Rotation(-math.pi / 2, 4, 'Y')):
        z = co @ np.array(R)[:3, :3].T
        h = z[:, 2] - z[:, 2].min()
        score = float((h < 0.06 * h.max()).mean())
        if score > bs:
            best, bs = R, score
    me.transform(best)
    me.update()


def recentre(o):
    """move the mesh so its base centre is at the origin (Z up), returns height"""
    me = o.data
    me.transform(o.matrix_world)
    o.matrix_world = Matrix.Identity(4)
    co = np.array([v.co[:] for v in me.vertices])
    c = (co.min(0) + co.max(0)) / 2
    me.transform(Matrix.Translation((-c[0], -c[1], -co[:, 2].min())))
    me.update()
    return float(co[:, 2].max() - co[:, 2].min())


def decimated(src, name, tris):
    o = src.copy()
    o.data = src.data.copy()
    o.name = name
    K.link(o)
    o.data.materials.clear()
    n0 = sum(len(p.vertices) - 2 for p in o.data.polygons)
    d = o.modifiers.new('dec', 'DECIMATE')
    d.ratio = min(1.0, tris / max(1, n0))
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
    o.modifiers.clear()
    o.data = me
    me.name = name
    for p in me.polygons:
        p.use_smooth = True
    return o


def build():
    abake.reset()
    abake.cycles_device('CPU', a.threads)
    rocks = import_rocks()
    S['rocks'] = [r.name for r in rocks]
    if ID == 'rock_prop':
        # the most compact rock (height / footprint closest to the prop's 0.75 / 0.8)
        best, bs = None, 9
        for r in rocks:
            co = np.array([v.co[:] for v in r.data.vertices]) @ np.array(r.matrix_world)[:3, :3].T
            ext = co.max(0) - co.min(0)
            score = abs(ext[2] / max(ext[0], ext[1]) - 0.75 / 0.8)
            if score < bs:
                best, bs = r, score
        for r in rocks:
            if r is not best:
                bpy.data.objects.remove(r)
        settle(best)
        recentre(best)
        fit = abake.fit_bounds([best], 0.4, 0.75)
        highs = [best]
        lods = {0: decimated(best, 'rock_prop_lod0', 900), 1: decimated(best, 'rock_prop_lod1', 260)}
        for o in lods.values():  # decimation moves the extremes: refit each LOD to the contract exactly
            abake.fit_bounds([o], 0.4, 0.75)
        S['meta'] = {'role': 'prop', 'kind': 'rock', 'radius': 0.4, 'height': 0.75, 'fit': fit}
    else:
        rng = np.random.default_rng(a.seed)
        place = [(-0.45, -0.05, 0.62, 0.0), (0.3, 0.22, 0.48, 1.2), (0.75, -0.25, 0.34, 2.3), (-0.05, -0.45, 0.26, 0.7), (1.0, 0.3, 0.2, 4.0)]
        highs = []
        for (x, y, sz, rot), r in zip(place, rocks[:5]):
            settle(r)
            recentre(r)
            co = np.array([v.co[:] for v in r.data.vertices])
            ext = co.max(0) - co.min(0)
            k = sz / max(ext)
            r.data.transform(Matrix.Translation((x, y, -0.02)) @ Matrix.Rotation(rot, 4, 'Z') @ Matrix.Scale(k, 4))
            highs.append(r)
        for r in rocks[5:]:
            bpy.data.objects.remove(r)
        # two broken masonry chunks (weathered like the kit pieces)
        import bmesh
        bm = bmesh.new()
        K.block(bm, 0.2, 0.15, 0.11, 0.025, center=(-0.85, 0.3, 0.09), rot=0.4, tilt=(0.15, 0.05), cut=((0.5, 0.4, 0.7), 0.03))
        K.block(bm, 0.13, 0.1, 0.08, 0.02, center=(0.4, -0.5, 0.06), rot=1.9, tilt=(0.0, 0.3))
        mas = K.to_object('chunks_src', bm)
        hi_m, _st = K.weather_high(mas, 'chunks_hi', voxel=0.008, seed=a.seed, H=0.3, chip=0.03, chip_cell=0.08, crack=0.01, crack_cell=0.2, wet_h=0.2, soot=0.2, moss=0.8)
        hi_m.data.materials.append(K.stone_material(abake.load_cc0(a.stone, need=('diff', 'rough', 'disp'))))
        highs.append(hi_m)
        parts0, parts1 = [], []
        for r in highs[:-1]:
            parts0.append(decimated(r, r.name + '_l0', 260))
            parts1.append(decimated(r, r.name + '_l1', 70))
        m0 = mas.copy()
        m0.data = mas.data.copy()
        K.link(m0)
        m1 = mas.copy()
        m1.data = mas.data.copy()
        K.link(m1)
        parts0.append(m0)
        parts1.append(m1)
        bpy.data.objects.remove(mas)
        lods = {0: K.join(parts0, 'rubble_scatter_lod0'), 1: K.join(parts1, 'rubble_scatter_lod1')}
        b = abake.bounds([lods[0]])
        S['meta'] = {'role': 'decor', 'kind': 'rubble', 'radius': round(b['radius'], 4), 'height': round(b['zmax'], 4)}
    S['highs'] = highs
    S['lod'] = lods
    for lod, o in lods.items():
        abake.uv_unwrap(o, a.px if lod == 0 else a.px_low, angle=55)
    return {'meta': S['meta'], 'tris': {lod: abake.tri_count(o) for lod, o in lods.items()}, 'highTris': sum(abake.tri_count(h) for h in highs), 'rocks': S['rocks']}


def bake_lod(lod):
    low = S['lod'][lod]
    px = a.px if lod == 0 else a.px_low
    maps = K.bake_set(low, S['highs'], px, job.out, f'{ID}_lod{lod}', ao_samples=a.ao_samples, extrusion=0.03, max_ray=0.08)
    S.setdefault('maps', {})[lod] = maps
    return {**maps, 'normalCheck': K.normal_stats(os.path.join(job.out, maps['normal']))}


def export():
    m = S['meta']
    for h in S['highs']:
        h.hide_render = True
    mats = {}
    for lod, low in S['lod'].items():
        name = f'{ID}_stone' if lod == 0 else f'{ID}_stone_low'
        mt = K.textured_material(name, job.out, S['maps'][lod])
        low.data.materials.clear()
        low.data.materials.append(mt)
        mats[lod] = name
    extras = dict(id=f'kit/{ID}', role=m['role'], kind=m['kind'], debris='stone', dustTint='#4a4a58')
    if m['role'] == 'prop':
        extras.update(footprint=m['radius'], height=m['height'])
    else:
        extras.update(footprintR=m['radius'], height=m['height'])
    root = abake.empty(f'KIT_{ID}', **extras)
    for lod, low in S['lod'].items():
        e = abake.empty(f'LOD{lod}', parent=root, lod=lod)
        low.parent = e
    import bmesh
    bm = bmesh.new()
    rr = m['radius'] * 0.8
    K.loft(bm, [K.square_ring(rr, rr, 0.0), K.square_ring(rr * 0.7, rr * 0.7, m['height'] * 0.95)])
    col = K.to_object('COL', bm)
    col.parent = root
    col['col'] = 1
    col.hide_render = True
    glb = abake.export_glb(os.path.join(job.out, f'{ID}_raw.glb'), objects=[root, col] + [c for c in root.children_recursive])
    contract = {'radius': m['radius'], 'height': m['height']}
    if m['role'] == 'prop':
        contract['source'] = 'src/sim/arenaGen.ts PROP_BASE.rock.r, src/sim/world.ts TOP.rock'
    asset = {
        'id': f'kit/{ID}', 'glb': os.path.basename(glb['path']), 'role': m['role'], 'kind': m['kind'], 'contract': contract,
        'lods': {'LOD0': {'materials': [mats[0]]}, 'LOD1': {'materials': [mats[1]]}},
        'materials': {mats[lod]: {k: v for k, v in S['maps'][lod].items() if k in ('baseColor', 'normal', 'orm', 'size')} | {'metallicFactor': 0.0, 'roughnessFactor': 1.0} for lod in (0, 1)},
        'sources': [a.cc0] + ([a.stone] if ID == 'rubble_scatter' else []),
        'job': os.path.basename(job.out),
    }
    with open(os.path.join(job.out, 'asset.json'), 'w', encoding='utf-8') as f:
        json.dump(asset, f, indent=1)
    return {'glb': glb}


def preview():
    l0, l1 = bpy.data.objects['LOD0'], bpy.data.objects['LOD1']
    l0.parent = l1.parent = None
    hi = S['highs']
    sp = max(1.0, S['meta']['radius'] * 2.4)
    for h in hi:
        h.hide_render = False
        h.location.x -= sp
    return K.preview_scene([(l0, 0.0), (l1, sp)], os.path.join(job.out, f'{ID}_preview.png'), size=(1440, 700),
                           cam_loc=(0, -sp * 2.6, sp * 0.9), look=(0, 0, 0.2), lens=40)


job.step('build', build)
job.step('bake_lod0', bake_lod, 0)
job.step('bake_lod1', bake_lod, 1)
job.step('export', export)
job.step('preview', preview)
fails = [r['step'] for r in job.steps if not r['ok']]
job.result['failed'] = fails
job.done()
if fails:
    sys.exit(1)
