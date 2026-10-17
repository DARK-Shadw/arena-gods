"""Kit asset: tripod brazier (the sim's `brazier` prop). Arena art plan 4.2 / 4.3 / 5.2, milestone A1
(the one test asset that goes through the whole pipeline end to end).

Contract (src/sim/arenaGen.ts PROP_BASE.brazier.r = 0.45, src/sim/world.ts TOP.brazier = 1.2): the visible
mesh's max horizontal radius is EXACTLY --radius and its top EXACTLY --height, origin at the base centre
(abake.fit_bounds, per LOD). tools/arena/check_budget.mjs measures the shipped GLBs against the sim tables.

Steps: build LOD0 (about 1.8k tris) and LOD1 (about 0.6k) procedurally (lathe bowl with a rolled lip, three
curved legs with paw feet, a ring brace, a coal bed) -> fit to the contract -> UVs -> high-poly (Catmull-Clark
+ hammered dents + rivets, high only) with a CC0 iron scan (Poly Haven metal_plate_02, box-projected) plus soot
and edge wear -> bakes per LOD (normal, AO 128 spp with a ground plane, base colour / roughness / metal as
emission) -> ORM pack -> GLB without images (tools/arena/build_assets.mjs attaches the PNG sets per material
from asset.json, then meshopt + KTX2 + WebP + .low) -> a Cycles preview still.

GLB layout (plan 4.2):  KIT_brazier_tripod {role, kind, footprint, height, debris, dustTint}
                          LOD0 -> LOD0_iron (brazier_iron), LOD0_coals (brazier_coals)
                          LOD1 -> LOD1_iron (brazier_iron_low), LOD1_coals (brazier_coals)
                          COL  (hidden LOS proxy, 8-sided)      SOCK_flame {size, palette, light}
Run:  npm run arena:bake -- kit_brazier_tripod   (tools/arena/jobs.json)
"""
import json
import math
import os
import sys

import bmesh
import bpy
from mathutils import Vector, noise

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import abake  # noqa: E402


def extra(ap):
    ap.add_argument('--px', type=int, default=1024, help='LOD0 texture size')
    ap.add_argument('--px-low', type=int, default=512, help='LOD1 texture size (the low tier)')
    ap.add_argument('--ao-samples', type=int, default=128)
    ap.add_argument('--radius', type=float, default=0.45, help='PROP_BASE.brazier.r')
    ap.add_argument('--height', type=float, default=1.2, help='TOP.brazier')
    ap.add_argument('--cc0', default='polyhaven/metal_plate_02')
    ap.add_argument('--preview', type=int, default=512, help='preview still size (0 = none)')


job = abake.Job(extra, desc='tripod brazier kit asset')
a = job.a
ID = 'brazier_tripod'
S = {}


# ---------------------------------------------------------------------------- geometry helpers

def link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


def to_object(name, bm, smooth=True):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.polygons.foreach_set('use_smooth', [smooth] * len(me.polygons))
    return link(bpy.data.objects.new(name, me))


def lathe(bm, prof, segs, phase=0.0):
    """profile [(r, z)] around +Z; r = 0 points become a single axis vertex (fan)."""
    rings = []
    for r, z in prof:
        if r < 1e-6:
            rings.append([bm.verts.new((0, 0, z))])
        else:
            rings.append([bm.verts.new((r * math.cos(phase + 2 * math.pi * i / segs), r * math.sin(phase + 2 * math.pi * i / segs), z)) for i in range(segs)])
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


def bezier(p0, p1, p2, p3, n):
    out = []
    for k in range(n + 1):
        t = k / n
        u = 1 - t
        out.append(p0 * u ** 3 + p1 * 3 * u * u * t + p2 * 3 * u * t * t + p3 * t ** 3)
    return out


def tube(bm, pts, radii, sides, cap=True):
    """tube along a polyline; frames from a fixed side vector (the legs lie in vertical planes)."""
    rings = []
    for k, p in enumerate(pts):
        t = (pts[min(k + 1, len(pts) - 1)] - pts[max(k - 1, 0)]).normalized()
        side = t.cross(Vector((0, 0, 1)))
        if side.length < 1e-4:
            side = Vector((1, 0, 0))
        side.normalize()
        up = side.cross(t).normalized()
        r = radii[k]
        rings.append([bm.verts.new(p + (side * math.cos(2 * math.pi * i / sides) + up * math.sin(2 * math.pi * i / sides)) * r) for i in range(sides)])
    for A, B in zip(rings, rings[1:]):
        for i in range(sides):
            j = (i + 1) % sides
            bm.faces.new((A[i], A[j], B[j], B[i]))
    if cap:
        for ring in (rings[0], rings[-1]):
            bm.faces.new(ring)


def torus(bm, R, r, z, seg, sides):
    rings = []
    for i in range(seg):
        a0 = 2 * math.pi * i / seg
        c = Vector((math.cos(a0), math.sin(a0), 0))
        rings.append([bm.verts.new(c * (R + r * math.cos(2 * math.pi * k / sides)) + Vector((0, 0, z + r * math.sin(2 * math.pi * k / sides)))) for k in range(sides)])
    for i in range(seg):
        A, B = rings[i], rings[(i + 1) % seg]
        for k in range(sides):
            m = (k + 1) % sides
            bm.faces.new((A[k], A[m], B[m], B[k]))


def blob(bm, center, radius, squash, useg, vseg):
    g = bmesh.ops.create_uvsphere(bm, u_segments=useg, v_segments=vseg, radius=radius)
    for v in g['verts']:
        v.co = Vector((v.co.x, v.co.y, v.co.z * squash)) + center


# bowl: outer wall up to a rolled lip (top = 1.2, max r = 0.45), inner wall down to the coal bed
BOWL = [(0.0, 0.84), (0.06, 0.845), (0.14, 0.87), (0.22, 0.92), (0.29, 0.99), (0.35, 1.06), (0.40, 1.12),
        (0.43, 1.16), (0.449, 1.185), (0.447, 1.198), (0.437, 1.2), (0.424, 1.192), (0.417, 1.175),
        (0.385, 1.13), (0.33, 1.07), (0.26, 1.0), (0.17, 0.94), (0.08, 0.905), (0.0, 0.90)]
BOWL_LOW = [(0.0, 0.84), (0.14, 0.87), (0.29, 0.99), (0.40, 1.12), (0.449, 1.185), (0.437, 1.2), (0.417, 1.175),
            (0.33, 1.07), (0.17, 0.94), (0.0, 0.90)]
LEG = [Vector((0.27, 0, 1.0)), Vector((0.345, 0, 0.76)), Vector((0.325, 0, 0.40)), Vector((0.385, 0, 0.05))]
LEG_ANGLES = [math.radians(90 + 120 * i) for i in range(3)]
RING_Z = 0.40


def leg_d_at(z):
    pts = bezier(*LEG, 40)
    for p, q in zip(pts, pts[1:]):
        if (p.z - z) * (q.z - z) <= 0:
            k = (z - p.z) / (q.z - p.z)
            return p.x + (q.x - p.x) * k
    return LEG[-1].x


def build_lod(lod, segs, prof, leg_n, leg_sides, ring_seg, ring_sides, coal_seg, foot):
    """one LOD: (iron object, coals object)"""
    bm = bmesh.new()
    lathe(bm, prof, segs)
    for ang in LEG_ANGLES:
        rot = lambda p: Vector((p.x * math.cos(ang), p.x * math.sin(ang), p.z))  # noqa: E731
        pts = [rot(p) for p in bezier(*LEG, leg_n)]
        radii = [0.024 - 0.007 * (k / leg_n) for k in range(leg_n + 1)]
        tube(bm, pts, radii, leg_sides)
        d = LEG[-1].x + 0.012
        blob(bm, Vector((d * math.cos(ang), d * math.sin(ang), 0.03)), 0.036, 0.85, foot[0], foot[1])
    torus(bm, leg_d_at(RING_Z), 0.011, RING_Z, ring_seg, ring_sides)
    blob(bm, Vector((0, 0, 0.835)), 0.045, 1.0, foot[0], foot[1])  # finial knob under the bowl
    iron = to_object(f'{lod}_iron', bm)
    # coal bed: a lumpy mound sitting in the bowl (top below the rim, so the flame socket reads above it)
    bm = bmesh.new()
    prof = [(0.0, 0.95), (0.325, 1.065)] + [(0.325 * (1 - k / 4), 1.075 + 0.03 * math.sin(math.pi / 2 * k / 4)) for k in range(1, 4)] + [(0.0, 1.11)]
    lathe(bm, prof, coal_seg, phase=0.3)
    for v in bm.verts:
        if v.co.z > 1.07:
            v.co.z += 0.018 * noise.noise(v.co * 14.0)
    coals = to_object(f'{lod}_coals', bm)
    return iron, coals


def material_iron_high(cc):
    """CC0 iron scan (box projected) darkened by soot towards the rim and inside, lighter worn edges."""
    m = bpy.data.materials.new('iron_hi')
    m.use_nodes = True
    nt = m.node_tree
    N, L = nt.nodes, nt.links
    bsdf = next(n for n in N if n.type == 'BSDF_PRINCIPLED')
    tc = N.new('ShaderNodeTexCoord')
    mp = N.new('ShaderNodeMapping')
    mp.inputs['Scale'].default_value = (1 / 1.35, 1 / 1.35, 1 / 1.35)  # the scan covers 1.35 m
    L.new(tc.outputs['Object'], mp.inputs['Vector'])

    def tex(path, non_color):
        t = N.new('ShaderNodeTexImage')
        t.image = abake.load_image(path, non_color)
        t.projection = 'BOX'
        t.projection_blend = 0.3
        L.new(mp.outputs['Vector'], t.inputs['Vector'])
        return t

    diff, rough, metal = tex(cc['diff'], False), tex(cc['rough'], True), tex(cc['metal'], True)
    # soot: object z 0.95 -> 1.2 plus a fine noise breakup
    sep = N.new('ShaderNodeSeparateXYZ')
    L.new(tc.outputs['Object'], sep.inputs['Vector'])
    mr = N.new('ShaderNodeMapRange')
    mr.inputs['From Min'].default_value = 0.93
    mr.inputs['From Max'].default_value = 1.2
    L.new(sep.outputs['Z'], mr.inputs['Value'])
    nz = N.new('ShaderNodeTexNoise')
    nz.inputs['Scale'].default_value = 9.0
    L.new(tc.outputs['Object'], nz.inputs['Vector'])
    soot = N.new('ShaderNodeMath')
    soot.operation = 'MULTIPLY'
    soot.use_clamp = True
    L.new(mr.outputs['Result'], soot.inputs[0])
    nzk = N.new('ShaderNodeMath')
    nzk.operation = 'MULTIPLY_ADD'
    L.new(nz.outputs['Fac'], nzk.inputs[0])
    nzk.inputs[1].default_value = 1.2
    nzk.inputs[2].default_value = 0.2
    L.new(nzk.outputs[0], soot.inputs[1])
    # worn edges from Cycles pointiness (bakes fine: the bake is Cycles)
    geo = N.new('ShaderNodeNewGeometry')
    ramp = N.new('ShaderNodeMapRange')
    ramp.inputs['From Min'].default_value = 0.52
    ramp.inputs['From Max'].default_value = 0.6
    L.new(geo.outputs['Pointiness'], ramp.inputs['Value'])
    # ShaderNodeMix has one A / B / Result socket per data type with the same name: pick by type
    def io(socks, name, kind):
        return next(x for x in socks if x.name == name and x.type == kind)

    def mix(fac, A, B, kind='VALUE', blend='MIX'):
        n = N.new('ShaderNodeMix')
        n.data_type = 'RGBA' if kind == 'RGBA' else 'FLOAT'
        n.blend_type = blend
        for nm, v in (('Factor', fac), ('A', A), ('B', B)):
            sk = io(n.inputs, nm, 'VALUE' if nm == 'Factor' else kind)
            if isinstance(v, bpy.types.NodeSocket):
                L.new(v, sk)
            else:
                sk.default_value = v
        return io(n.outputs, 'Result', kind)

    # base colour: scan * dark iron tint -> lighter worn edges -> near-black soot
    c = mix(1.0, diff.outputs['Color'], (0.62, 0.56, 0.5, 1), 'RGBA', 'MULTIPLY')
    c = mix(ramp.outputs['Result'], c, (0.42, 0.39, 0.35, 1), 'RGBA')
    c = mix(soot.outputs[0], c, (0.022, 0.019, 0.017, 1), 'RGBA')
    L.new(c, bsdf.inputs['Base Color'])
    # roughness: scan, rougher in soot, smoother on worn edges
    r = mix(soot.outputs[0], rough.outputs['Color'], 0.92)
    r = mix(ramp.outputs['Result'], r, 0.38)
    L.new(r, bsdf.inputs['Roughness'])
    # metalness: scan metal, killed by soot, full on worn edges
    mm = mix(soot.outputs[0], metal.outputs['Color'], 0.15)
    mm = mix(ramp.outputs['Result'], mm, 1.0)
    L.new(mm, bsdf.inputs['Metallic'])
    return m


def material_plain(name, color, rough=0.9, metal=0.0, emit=None, strength=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    b.inputs['Base Color'].default_value = (*color, 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    if emit:
        b.inputs['Emission Color'].default_value = (*emit, 1)
        b.inputs['Emission Strength'].default_value = strength
    return m


# ---------------------------------------------------------------------------- steps

def build():
    s = abake.reset()
    S['dev'] = abake.cycles_device('CPU', a.threads)
    S['cc'] = abake.load_cc0(a.cc0, need=('diff', 'rough', 'metal'))
    lod0 = build_lod('LOD0', 24, BOWL, 10, 8, 24, 6, 12, (7, 4))
    lod1 = build_lod('LOD1', 12, BOWL_LOW, 5, 5, 12, 4, 8, (6, 4))
    fit = {'LOD0': abake.fit_bounds(list(lod0), a.radius, a.height), 'LOD1': abake.fit_bounds(list(lod1), a.radius, a.height)}
    S['lod'] = {'LOD0': lod0, 'LOD1': lod1}
    for lod, (iron, coals) in S['lod'].items():
        abake.uv_unwrap(iron, a.px if lod == 'LOD0' else a.px_low)
        abake.uv_unwrap(coals, 256)
    tris = {lod: {'iron': abake.tri_count(i), 'coals': abake.tri_count(c)} for lod, (i, c) in S['lod'].items()}
    s.frame_set(1)
    return {'fit': fit, 'tris': tris, 'cc0': S['cc']['meta']['id'], 'device': S['dev']}


def build_high():
    iron0 = S['lod']['LOD0'][0]
    hi = iron0.copy()
    hi.data = iron0.data.copy()
    hi.name = 'HIGH_iron'
    link(hi)
    sub = hi.modifiers.new('sub', 'SUBSURF')
    sub.levels = sub.render_levels = 3
    t = bpy.data.textures.new('dents', 'VORONOI')
    t.noise_scale = 0.045
    t.distance_metric = 'DISTANCE_SQUARED'
    d = hi.modifiers.new('dents', 'DISPLACE')
    d.texture = t
    d.texture_coords = 'LOCAL'
    d.strength = 0.004
    d.mid_level = 0.6
    t2 = bpy.data.textures.new('pits', 'CLOUDS')
    t2.noise_scale = 0.012
    d2 = hi.modifiers.new('pits', 'DISPLACE')
    d2.texture = t2
    d2.texture_coords = 'LOCAL'
    d2.strength = 0.0012
    # rivets around the outer bowl below the lip, and where the legs meet the bowl (high only: normal map)
    bm = bmesh.new()
    rz = 1.13
    rr = 0.405 * (a.radius / 0.449)
    for i in range(18):
        ang = 2 * math.pi * (i + 0.5) / 18
        blob(bm, Vector((rr * math.cos(ang), rr * math.sin(ang), rz * (a.height / 1.2))), 0.011, 0.8, 8, 6)
    for ang in LEG_ANGLES:
        for dz in (0.0, 0.05):
            p = bezier(*LEG, 40)[3]
            blob(bm, Vector(((p.x + 0.02) * math.cos(ang), (p.x + 0.02) * math.sin(ang), p.z - dz)), 0.012, 0.8, 8, 6)
    torus(bm, 0.343, 0.008, 1.05, 64, 6)  # raised band (high only)
    riv = to_object('HIGH_rivets', bm)
    mat = material_iron_high(S['cc'])
    for o in (hi, riv):
        o.data.materials.append(mat)
    # ground plane for the AO bake (contact darkening at the feet); not selected, so not a bake source
    bpy.ops.mesh.primitive_plane_add(size=4, location=(0, 0, -0.001))
    S['ground'] = bpy.context.active_object
    S['ground'].data.materials.append(material_plain('ground', (0.2, 0.2, 0.2)))
    S['high'] = [hi, riv]
    return {'highTris': abake.tri_count(hi) + abake.tri_count(riv)}


def bake_lod(lod):
    iron, coals = S['lod'][lod]
    px = a.px if lod == 'LOD0' else a.px_low
    tmp = material_plain(f'bake_{lod}', (0.5, 0.5, 0.5))
    iron.data.materials.clear()
    iron.data.materials.append(tmp)
    coals.hide_render = True
    pre = f'{ID}_{lod.lower()}'
    res = abake.bake_maps(iron, S['high'], ['NORMAL'], px, job.out, samples=1, extrusion=0.03, prefix=pre)
    res.update(abake.bake_maps(iron, S['high'], ['AO'], px, job.out, samples=a.ao_samples, extrusion=0.03, prefix=pre))
    res.update(abake.bake_emit_inputs(iron, S['high'], ['Base Color', 'Roughness', 'Metallic'], px, job.out, pre, samples=4, extrusion=0.03))
    orm = abake.pack_orm(res['AO']['path'], res['Roughness']['path'], res['Metallic']['path'], os.path.join(job.out, f'{pre}_orm.png'))
    coals.hide_render = False
    S.setdefault('maps', {})[lod] = {'baseColor': os.path.basename(res['Base Color']['path']), 'normal': os.path.basename(res['NORMAL']['path']), 'orm': os.path.basename(orm), 'size': px}
    return {k: v['seconds'] for k, v in res.items()}


def assemble_and_export():
    """final materials, hierarchy, COL, socket, extras; GLB without images + asset.json"""
    for o in S['high'] + [S['ground']]:
        o.hide_render = True
    coal_mat = material_plain('brazier_coals', (0.045, 0.03, 0.022), rough=0.95, emit=(1.0, 0.32, 0.06), strength=1.6)
    final = {}
    for lod, (iron, coals) in S['lod'].items():
        name = 'brazier_iron' if lod == 'LOD0' else 'brazier_iron_low'
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        nt = m.node_tree
        b = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
        mp = S['maps'][lod]
        tb = nt.nodes.new('ShaderNodeTexImage')
        tb.image = abake.load_image(os.path.join(job.out, mp['baseColor']))
        nt.links.new(tb.outputs['Color'], b.inputs['Base Color'])
        to = nt.nodes.new('ShaderNodeTexImage')
        to.image = abake.load_image(os.path.join(job.out, mp['orm']), True)
        sc = nt.nodes.new('ShaderNodeSeparateColor')
        nt.links.new(to.outputs['Color'], sc.inputs['Color'])
        nt.links.new(sc.outputs['Green'], b.inputs['Roughness'])
        nt.links.new(sc.outputs['Blue'], b.inputs['Metallic'])
        tn = nt.nodes.new('ShaderNodeTexImage')
        tn.image = abake.load_image(os.path.join(job.out, mp['normal']), True)
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nt.links.new(tn.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
        # the AO channel multiplies the base colour for the preview only (glTF carries it as occlusionTexture)
        iron.data.materials.clear()
        iron.data.materials.append(m)
        coals.data.materials.clear()
        coals.data.materials.append(coal_mat)
        final[lod] = name
    root = abake.empty(f'KIT_{ID}', id=f'kit/{ID}', role='prop', kind='brazier', footprint=a.radius, height=a.height, debris='metal', dustTint='#3a3530')
    for lod, (iron, coals) in S['lod'].items():
        e = abake.empty(lod, parent=root, lod=int(lod[-1]))
        iron.parent = e
        coals.parent = e
    # COL: 8-sided tapered prism around the bowl + legs (line-of-sight / anchor proxy, hidden in game)
    bm = bmesh.new()
    lathe(bm, [(0.0, 0.0), (a.radius * 0.9, 0.0), (a.radius * 0.75, 0.9), (a.radius, a.height), (0.0, a.height)], 8)
    col = to_object('COL', bm, smooth=False)
    col.parent = root
    col['col'] = 1
    col.hide_render = True
    sock = abake.empty('SOCK_flame', loc=(0, 0, a.height), parent=root, size=0.9, palette='theme', light=1)
    objs = [root, col, sock] + [x for lod in S['lod'].values() for x in lod] + [abake_child for abake_child in root.children if abake_child.type == 'EMPTY']
    glb = abake.export_glb(os.path.join(job.out, f'{ID}_raw.glb'), objects=list(dict.fromkeys(objs)))
    asset = {
        'id': f'kit/{ID}', 'glb': os.path.basename(glb['path']), 'role': 'prop', 'kind': 'brazier',
        'contract': {'radius': a.radius, 'height': a.height, 'source': 'src/sim/arenaGen.ts PROP_BASE.brazier.r, src/sim/world.ts TOP.brazier'},
        'lods': {'LOD0': {'materials': [final['LOD0'], 'brazier_coals']}, 'LOD1': {'materials': [final['LOD1'], 'brazier_coals']}},
        'materials': {
            final['LOD0']: {**S['maps']['LOD0'], 'metallicFactor': 1.0, 'roughnessFactor': 1.0},
            final['LOD1']: {**S['maps']['LOD1'], 'metallicFactor': 1.0, 'roughnessFactor': 1.0},
            'brazier_coals': {'baseColorFactor': [0.045, 0.03, 0.022, 1], 'emissiveFactor': [1.0, 0.32, 0.06], 'emissiveStrength': 1.6, 'roughnessFactor': 0.95, 'metallicFactor': 0.0},
        },
        'sources': [a.cc0],
        'job': os.path.basename(job.out),
    }
    with open(os.path.join(job.out, 'asset.json'), 'w', encoding='utf-8') as f:
        json.dump(asset, f, indent=1)
    return {'glb': glb, 'asset': 'asset.json'}


def preview():
    """Cycles still of LOD0 (left) and LOD1 (right) on a dark floor, warm light from the bowl + cool rim:
    for the README / by-eye check only (not shipped)."""
    if not a.preview:
        return 'skipped'
    s = bpy.context.scene
    s.render.engine = 'CYCLES'
    s.cycles.samples = 48
    s.render.resolution_x = a.preview * 2
    s.render.resolution_y = a.preview
    S['ground'].hide_render = False
    S['ground'].scale = (3, 3, 1)
    root = bpy.data.objects[f'KIT_{ID}']
    root.location.x = -0.6
    # duplicate LOD1 to the right
    l1 = bpy.data.objects['LOD1']
    l0 = bpy.data.objects['LOD0']
    l1.parent = None
    l1.location = (0.6, 0, 0)
    l0.location = (0, 0, 0)
    w = bpy.data.worlds.new('w')
    s.world = w
    w.use_nodes = True
    w.node_tree.nodes['Background'].inputs['Color'].default_value = (0.02, 0.025, 0.04, 1)
    w.node_tree.nodes['Background'].inputs['Strength'].default_value = 1.0
    for x in (-0.6, 0.6):
        ld = bpy.data.lights.new('fire', 'POINT')
        ld.energy = 60
        ld.color = (1.0, 0.55, 0.25)
        ld.shadow_soft_size = 0.15
        lo = link(bpy.data.objects.new('fire', ld))
        lo.location = (x, 0, 1.35)
    sd = bpy.data.lights.new('moon', 'SUN')
    sd.energy = 2.2
    sd.color = (0.6, 0.7, 1.0)
    so = link(bpy.data.objects.new('moon', sd))
    so.rotation_euler = (math.radians(55), 0, math.radians(150))
    ld = bpy.data.lights.new('key', 'AREA')
    ld.energy = 80
    ld.size = 1.5
    ko = link(bpy.data.objects.new('key', ld))
    ko.location = (1.2, -2.2, 1.8)
    ko.rotation_euler = (math.radians(60), 0, math.radians(28))
    cd = bpy.data.cameras.new('cam')
    cd.lens = 50
    cam = link(bpy.data.objects.new('cam', cd))
    cam.location = (0, -4.2, 1.15)
    cam.rotation_euler = (math.radians(82.5), 0, 0)
    s.camera = cam
    abake.image_settings('PNG', '8', 'RGB')
    s.view_settings.view_transform = 'AgX'
    return abake.render_still(os.path.join(job.out, f'{ID}_preview.png'))


job.step('build', build)
job.step('build_high', build_high)
job.step('bake_lod0', bake_lod, 'LOD0')
job.step('bake_lod1', bake_lod, 'LOD1')
job.step('export', assemble_and_export)
job.step('preview', preview)
fails = [r['step'] for r in job.steps if not r['ok']]
job.result['failed'] = fails
job.done()
if fails:
    sys.exit(1)
