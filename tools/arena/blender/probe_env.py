"""A0 probe: what this Blender 5.0 install can do (no heavy work, about 30 s).

Cycles devices (CPU / oneAPI ...; the runner starts it twice, with and without CYCLES_ONEAPI_ALL_DEVICES=1),
geometry-nodes SDF grid nodes, bake settings, glTF exporter options (meshopt / KTX / WebP / extras),
Sky Texture inputs, EEVEE with a panoramic camera (does it render equirect or fall back to perspective?),
and whether a Python thread keeps running during a render (for in-process RAM sampling).
"""
import math
import os
import sys
import threading
import time

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import abake  # noqa: E402

job = abake.Job(desc=__doc__)
R = job.result
R['env'] = {'CYCLES_ONEAPI_ALL_DEVICES': os.environ.get('CYCLES_ONEAPI_ALL_DEVICES', ''), 'cpus': os.cpu_count()}


def devices():
    abake.reset()
    return abake.list_cycles_devices()


def gn_nodes():
    ng = bpy.data.node_groups.new('probe', 'GeometryNodeTree')
    want = ['GeometryNodeMeshToSDFGrid', 'GeometryNodeSDFGridBoolean', 'GeometryNodeSDFGridFillet', 'GeometryNodeSDFGridOffset',
            'GeometryNodeGridToMesh', 'GeometryNodeMeshToVolume', 'GeometryNodeVolumeToMesh', 'GeometryNodeRealizeInstances',
            'GeometryNodeUVPackIslands', 'GeometryNodeUVTangent', 'GeometryNodeMeshBoolean', 'GeometryNodeDistributePointsOnFaces']
    out = {}
    for t in want:
        try:
            n = ng.nodes.new(t)
            out[t] = {'ok': True, 'inputs': [i.name for i in n.inputs][:8]}
        except Exception as ex:
            out[t] = {'ok': False, 'error': str(ex)[:120]}
    grid_like = sorted(n for n in dir(bpy.types) if n.startswith('GeometryNode') and ('Grid' in n or 'SDF' in n))
    bpy.data.node_groups.remove(ng)
    return {'nodes': out, 'allGridNodeTypes': grid_like}


def bake_settings():
    s = bpy.context.scene
    bk = s.render.bake
    return {'bakeOp': hasattr(bpy.ops.object, 'bake'), 'bakeProps': [p.identifier for p in bk.bl_rna.properties][:60],
            'cyclesBakeType': [i.identifier for i in s.cycles.bl_rna.properties['bake_type'].enum_items]}


def gltf_options():
    props = bpy.ops.export_scene.gltf.get_rna_type().properties
    keys = [p.identifier for p in props]
    hit = [k for k in keys if any(w in k.lower() for w in ('draco', 'meshopt', 'ktx', 'webp', 'image', 'extras', 'texture', 'yup', 'apply', 'lod'))]
    img = props['export_image_format'] if 'export_image_format' in keys else None
    try:
        import io_scene_gltf2
        ver = '.'.join(str(x) for x in io_scene_gltf2.bl_info.get('version', ()))
    except Exception as ex:
        ver = f'unknown ({ex})'
    return {'count': len(keys), 'relevant': hit, 'imageFormats': [i.identifier for i in img.enum_items] if img else None, 'version': ver}


def sky_inputs():
    m = bpy.data.materials.new('sky')
    try:
        m.use_nodes = True
    except Exception:
        pass
    n = m.node_tree.nodes.new('ShaderNodeTexSky')
    return {'skyTypes': [i.identifier for i in n.bl_rna.properties['sky_type'].enum_items], 'props': [p.identifier for p in n.bl_rna.properties if not p.identifier.startswith('bl_')][:40]}


def eevee_pano():
    """Four coloured pillars around the camera (+X red, +Y green, -X blue, -Y yellow). An equirect render
    shows all four; a perspective fallback shows one or two."""
    s = abake.reset()
    s.render.engine = 'BLENDER_EEVEE'
    s.render.resolution_x, s.render.resolution_y = 512, 256
    s.eevee.taa_render_samples = 4
    w = bpy.data.worlds.new('w')
    w.color = (0.02, 0.02, 0.02)
    s.world = w
    cols = {'red': ((8, 0, 0), (1, 0, 0, 1)), 'green': ((0, 8, 0), (0, 1, 0, 1)), 'blue': ((-8, 0, 0), (0, 0, 1, 1)), 'yellow': ((0, -8, 0), (1, 1, 0, 1))}
    for name, (loc, c) in cols.items():
        bpy.ops.mesh.primitive_cube_add(size=2, location=(loc[0], loc[1], 1))
        o = bpy.context.active_object
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
        nt = mat.node_tree
        nt.nodes.clear()
        e = nt.nodes.new('ShaderNodeEmission')
        e.inputs['Color'].default_value = c
        e.inputs['Strength'].default_value = 2.0
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        nt.links.new(e.outputs[0], out.inputs['Surface'])
        o.data.materials.append(mat)
    abake.pano_camera(lat_min=-60, lat_max=60, height=1.0)
    abake.image_settings('PNG', '8', 'RGB')
    p = os.path.join(job.out, 'eevee_pano.png')
    t = time.time()
    abake.render_still(p)
    dt = time.time() - t
    img = bpy.data.images.load(p)
    px = list(img.pixels)
    W, H = img.size
    seen = {k: 0 for k in cols}
    for i in range(0, len(px), 4):
        r, g, b = px[i], px[i + 1], px[i + 2]
        if r > 0.5 and g < 0.3 and b < 0.3:
            seen['red'] += 1
        elif g > 0.5 and r < 0.3 and b < 0.3:
            seen['green'] += 1
        elif b > 0.5 and r < 0.3 and g < 0.3:
            seen['blue'] += 1
        elif r > 0.5 and g > 0.5 and b < 0.3:
            seen['yellow'] += 1
    vis = [k for k, v in seen.items() if v > 20]
    return {'seconds': round(dt, 2), 'pixels': seen, 'visible': vis, 'equirect': len(vis) == 4, 'file': p}


def thread_during_render():
    """Does a Python thread run while bpy.ops.render.render() blocks? (in-process RAM sampling)"""
    s = abake.reset()
    abake.cycles_device('CPU')
    s.cycles.samples = 256
    s.render.resolution_x, s.render.resolution_y = 320, 180
    bpy.ops.mesh.primitive_monkey_add()
    cd = bpy.data.cameras.new('c')
    c = bpy.data.objects.new('c', cd)
    s.collection.objects.link(c)
    c.location = (0, -4, 0)
    c.rotation_euler = (math.radians(90), 0, 0)
    s.camera = c
    ticks = []
    stop = []

    def run():
        while not stop:
            ticks.append(time.time())
            time.sleep(0.1)
    th = threading.Thread(target=run, daemon=True)
    th.start()
    t0 = time.time()
    bpy.ops.render.render(write_still=False)
    t1 = time.time()
    stop.append(1)
    during = [t for t in ticks if t0 + 0.05 < t < t1 - 0.05]
    return {'renderSeconds': round(t1 - t0, 2), 'ticksDuringRender': len(during), 'expected': int((t1 - t0) / 0.1)}


job.step('cycles_devices', devices)
job.step('gn_sdf_nodes', gn_nodes)
job.step('bake_settings', bake_settings)
job.step('gltf_exporter', gltf_options)
job.step('sky_texture', sky_inputs)
job.step('eevee_panorama', eevee_pano)
job.step('python_thread_during_render', thread_during_render)
job.done()
