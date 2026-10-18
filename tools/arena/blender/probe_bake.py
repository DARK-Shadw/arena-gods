"""A0 probe: high -> low bake, SDF-grid erosion, voxel remesh peak, glTF export (plan 5.2 / 5.8).

A 0.9 x 0.9 x 3 m square pillar (the kit's 9-slice pillar stand-in):
  low   = bevelled box, Smart UV Project + pack (5.0 API), about 300 tris
  high  = low + subdivision + noise displacement (--high-level sets the subdivision, i.e. the triangle count)
  steps = build, GN SDF erosion (Mesh to SDF Grid -> Grid to Mesh, if present), voxel remesh at --voxel m,
          Cycles bake NORMAL (tangent, OpenGL) + AO (--ao-samples) at --px, material with the baked maps,
          GLB export with extras (custom properties) -> probe_pillar.glb (the KTX2 / meshopt probe input).
"""
import math
import os
import sys

import bpy
import bmesh

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import abake  # noqa: E402


def extra(ap):
    ap.add_argument('--px', type=int, default=256)
    ap.add_argument('--high-level', type=int, default=6, help='subdivision levels of the high-poly')
    ap.add_argument('--ao-samples', type=int, default=128)
    ap.add_argument('--voxel', type=float, default=0.01, help='voxel remesh size (m); 0 = skip')
    ap.add_argument('--device', default='CPU')


job = abake.Job(extra, __doc__)
a = job.a
S = {}


def tri_count(o):
    dg = bpy.context.evaluated_depsgraph_get()
    m = o.evaluated_get(dg).to_mesh()
    n = sum(len(p.vertices) - 2 for p in m.polygons)
    o.evaluated_get(dg).to_mesh_clear()
    return n


def build():
    s = abake.reset()
    s.render.engine = 'CYCLES'
    S['dev'] = abake.cycles_device(a.device, a.threads)
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 1.5))
    low = bpy.context.active_object
    low.name = 'KIT_pillar_probe'
    low.scale = (0.9, 0.9, 3.0)
    bpy.ops.object.transform_apply(scale=True)
    bev = low.modifiers.new('bev', 'BEVEL')
    bev.width = 0.04
    bev.segments = 2
    bpy.ops.object.modifier_apply(modifier='bev')
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.02)
    try:
        bpy.ops.uv.pack_islands(margin=8 / a.px, shape_method='CONCAVE')
        S['pack'] = 'shape_method=CONCAVE'
    except Exception as ex:
        bpy.ops.uv.pack_islands(margin=8 / a.px)
        S['pack'] = f'default ({ex})'
    bpy.ops.object.mode_set(mode='OBJECT')
    mat = bpy.data.materials.new('stone')
    mat.use_nodes = True
    low.data.materials.append(mat)
    low['role'] = 'column'
    low['footprint'] = 0.64
    low['height'] = 3.0
    # high: duplicate + subdivision + displacement (real geometry, plan 5.2: bake from geometry, not render-time displacement)
    high = low.copy()
    high.data = low.data.copy()
    high.name = 'HIGH'
    bpy.context.scene.collection.objects.link(high)
    sub = high.modifiers.new('sub', 'SUBSURF')
    sub.levels = sub.render_levels = a.high_level
    sub.subdivision_type = 'SIMPLE'
    tex = bpy.data.textures.new('n', 'CLOUDS')
    tex.noise_scale = 0.08
    tex.noise_depth = 4
    disp = high.modifiers.new('disp', 'DISPLACE')
    disp.texture = tex
    disp.strength = 0.03
    disp.mid_level = 0.5
    S['low'], S['high'] = low, high
    return {'lowTris': tri_count(low), 'highTris': tri_count(high), 'device': S['dev'], 'pack': S['pack']}


def sdf_erosion():
    """GN: Mesh to SDF Grid -> (Fillet) -> Grid to Mesh on a copy of the low pillar (5.0 volume grid nodes)."""
    low = S['low']
    o = low.copy()
    o.data = low.data.copy()
    o.name = 'SDF_probe'
    bpy.context.scene.collection.objects.link(o)
    ng = bpy.data.node_groups.new('sdf', 'GeometryNodeTree')
    ng.interface.new_socket('Geometry', in_out='INPUT', socket_type='NodeSocketGeometry')
    ng.interface.new_socket('Geometry', in_out='OUTPUT', socket_type='NodeSocketGeometry')
    gi = ng.nodes.new('NodeGroupInput')
    go = ng.nodes.new('NodeGroupOutput')
    m2s = ng.nodes.new('GeometryNodeMeshToSDFGrid')
    vs = m2s.inputs.get('Voxel Size')
    if vs is not None:
        vs.default_value = 0.02
    g2m = ng.nodes.new('GeometryNodeGridToMesh')
    # SDF iso-surface is at 0: Grid to Mesh's default Threshold (0.1, a density value) gives an EMPTY mesh
    g2m.inputs['Threshold'].default_value = 0.0
    chain = m2s.outputs[0]
    try:
        fil = ng.nodes.new('GeometryNodeSDFGridFillet')
        ng.links.new(chain, fil.inputs[0])
        chain = fil.outputs[0]
    except Exception as ex:
        S['fillet'] = str(ex)
    ng.links.new(gi.outputs[0], m2s.inputs[0])
    ng.links.new(chain, g2m.inputs[0])
    ng.links.new(g2m.outputs[0], go.inputs[0])
    mod = o.modifiers.new('sdf', 'NODES')
    mod.node_group = ng
    n = tri_count(o)
    bpy.data.objects.remove(o)
    return {'tris': n, 'fillet': S.get('fillet', 'ok'), 'inputs': [i.name for i in m2s.inputs]}


def voxel_remesh():
    if a.voxel <= 0:
        return 'skipped'
    high = S['high']
    o = high.copy()
    o.data = high.data.copy()
    bpy.context.scene.collection.objects.link(o)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
    o.modifiers.clear()
    o.data = me
    rm = o.modifiers.new('rm', 'REMESH')
    rm.mode = 'VOXEL'
    rm.voxel_size = a.voxel
    n = tri_count(o)
    bpy.data.objects.remove(o)
    return {'voxel': a.voxel, 'tris': n}


def bake():
    return abake.bake_maps(S['low'], S['high'], ['NORMAL', 'AO'], a.px, job.out, samples=a.ao_samples, extrusion=0.03, margin=8, prefix=f'pillar_{a.px}')


def material_and_export(baked):
    low = S['low']
    mat = low.data.materials[0]
    nt = mat.node_tree
    bsdf = nt.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (0.32, 0.33, 0.38, 1)
    bsdf.inputs['Roughness'].default_value = 0.8
    for n in [n for n in nt.nodes if n.name == 'BAKE_TARGET']:
        nt.nodes.remove(n)
    if baked and 'NORMAL' in baked:
        img = bpy.data.images.load(baked['NORMAL']['path'])
        img.colorspace_settings.name = 'Non-Color'
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = img
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nt.links.new(t.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    if baked and 'AO' in baked:
        img = bpy.data.images.load(baked['AO']['path'])
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = img
        mix = nt.nodes.new('ShaderNodeMix')
        mix.data_type = 'RGBA'
        mix.blend_type = 'MULTIPLY'
        mix.inputs['Factor'].default_value = 1.0
        mix.inputs[6].default_value = (0.32, 0.33, 0.38, 1)
        nt.links.new(t.outputs['Color'], mix.inputs[7])
        nt.links.new(mix.outputs[2], bsdf.inputs['Base Color'])
    S['high'].hide_render = True
    return abake.export_glb(os.path.join(job.out, 'probe_pillar.glb'), objects=[low])


info = job.step('build', build)
job.step('gn_sdf_erosion', sdf_erosion)
job.step('voxel_remesh', voxel_remesh)
baked = job.step('bake_normal_ao', bake)
job.step('export_glb', material_and_export, baked)
job.done()
