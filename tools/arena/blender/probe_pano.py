"""A0 probe: backdrop panorama render (plan 5.6) -- speed, RAM, passes, at the plan's sizes.

A stand-in vista with roughly the weight of a theme backdrop: a ruined ring of 3000 instanced blocks
(linked duplicates, 40-120 m), 600 "castle" towers on a hill at 300-600 m with emissive windows,
a 60 m arch at azimuth 0, mountains, a ground plane, a sun + gradient world, optional volume fog.
Render: Cycles (or EEVEE with --engine eevee) equirect camera at 1.6 m with latitude limits
-12..60 deg (--engine eevee --slice renders one 45 deg perspective slice instead: the EEVEE
fallback), passes Image + Depth + AOV 'emit' through the 5.0 compositor File Output (multilayer EXR).
  --w 2048 --h 341 --samples 32      quick
  --w 8192 --h 1365 --samples 128 --denoise   the plan's high-tier layer
"""
import math
import os
import random
import sys
import time

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import abake  # noqa: E402


def extra(ap):
    ap.add_argument('--w', type=int, default=2048)
    ap.add_argument('--h', type=int, default=341)
    ap.add_argument('--samples', type=int, default=32)
    ap.add_argument('--denoise', action='store_true')
    ap.add_argument('--fog', action='store_true', help='volume fog in the scene (Cycles volumes)')
    ap.add_argument('--engine', default='cycles', choices=['cycles', 'eevee'])
    ap.add_argument('--device', default='CPU')
    ap.add_argument('--slice', action='store_true', help='45 deg perspective slice (EEVEE fallback) instead of equirect')
    ap.add_argument('--tile', type=int, default=1024)
    ap.add_argument('--tag', default='')
    ap.add_argument('--repeat', type=int, default=1, help='render N times (2nd+ = warm: kernels / BVH caches)')


job = abake.Job(extra, __doc__)
a = job.a
tag = a.tag or f'{a.engine}_{a.w}x{a.h}_s{a.samples}{"_dn" if a.denoise else ""}{"_fog" if a.fog else ""}{"_slice" if a.slice else ""}_{a.device.lower()}'


def emission_mat(name, col, strength):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes.get('Principled BSDF')
    b.inputs['Emission Color'].default_value = col
    b.inputs['Emission Strength'].default_value = strength
    b.inputs['Base Color'].default_value = (0.05, 0.05, 0.06, 1)
    aov = nt.nodes.new('ShaderNodeOutputAOV')
    aov.aov_name = 'emit'
    rgb = nt.nodes.new('ShaderNodeRGB')
    rgb.outputs[0].default_value = (1, 0, 0, 1)
    nt.links.new(rgb.outputs[0], aov.inputs['Color'])
    return m


def stone_mat(name, col):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes.get('Principled BSDF')
    nz = nt.nodes.new('ShaderNodeTexNoise')
    nz.inputs['Scale'].default_value = 3.0
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].color = (col[0] * 0.5, col[1] * 0.5, col[2] * 0.5, 1)
    ramp.color_ramp.elements[1].color = col
    nt.links.new(nz.outputs['Fac'], ramp.inputs['Fac'])
    nt.links.new(ramp.outputs['Color'], b.inputs['Base Color'])
    b.inputs['Roughness'].default_value = 0.85
    return m


def build():
    s = abake.reset()
    rnd = random.Random(7)
    stone = stone_mat('stone', (0.28, 0.28, 0.33, 1))
    dark = stone_mat('dark', (0.12, 0.12, 0.15, 1))
    win = emission_mat('windows', (1.0, 0.45, 0.15, 1), 25.0)
    # shared meshes (instancing keeps Cycles memory low, plan 5.5)
    bpy.ops.mesh.primitive_cube_add(size=1)
    block = bpy.context.active_object.data
    block.materials.append(stone)
    bpy.data.objects.remove(bpy.context.active_object)
    bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=0.5, depth=1)
    tower = bpy.context.active_object.data
    tower.materials.append(dark)
    bpy.data.objects.remove(bpy.context.active_object)
    bpy.ops.mesh.primitive_cube_add(size=1)
    window = bpy.context.active_object.data
    window.materials.append(win)
    bpy.data.objects.remove(bpy.context.active_object)
    col = s.collection
    n = 0

    def put(me, loc, scl, rz=0.0):
        nonlocal n
        o = bpy.data.objects.new(f'o{n}', me)
        o.location = loc
        o.scale = scl
        o.rotation_euler = (0, 0, rz)
        col.objects.link(o)
        n += 1
    # ruined arcade ring, 40-120 m
    for i in range(3000):
        an = rnd.uniform(0, 2 * math.pi)
        r = rnd.uniform(40, 120)
        h = rnd.uniform(2, 18)
        put(block, (math.cos(an) * r, math.sin(an) * r, h / 2), (rnd.uniform(1, 4), rnd.uniform(1, 4), h), an)
    # castle on a hill at azimuth ~0 (Blender +X), 300-600 m
    for i in range(600):
        an = rnd.uniform(-0.35, 0.35)
        r = rnd.uniform(300, 600)
        h = rnd.uniform(20, 90)
        x, y = math.cos(an) * r, math.sin(an) * r
        put(tower, (x, y, 40 + h / 2), (rnd.uniform(4, 10), rnd.uniform(4, 10), h))
        for k in range(3):
            put(window, (x - 3, y, 40 + rnd.uniform(0.2, 0.9) * h), (0.5, 1.2, 2.5))
    # hill + mountains
    bpy.ops.mesh.primitive_uv_sphere_add(segments=64, ring_count=32, radius=1, location=(450, 0, -60))
    hill = bpy.context.active_object
    hill.scale = (260, 260, 110)
    hill.data.materials.append(dark)
    for i in range(14):
        an = (i / 14) * 2 * math.pi
        bpy.ops.mesh.primitive_cone_add(vertices=24, radius1=1, depth=1, location=(math.cos(an) * 1500, math.sin(an) * 1500, 120))
        m = bpy.context.active_object
        m.scale = (rnd.uniform(300, 500), rnd.uniform(300, 500), rnd.uniform(250, 450))
        m.data.materials.append(dark)
    # the arch landmark at azimuth 0, 70 m, 60 m tall
    for sx in (-1, 1):
        put(block, (70, sx * 18, 30), (8, 8, 60))
    put(block, (70, 0, 62), (8, 44, 8))
    # ground
    bpy.ops.mesh.primitive_plane_add(size=4000)
    bpy.context.active_object.data.materials.append(stone)
    # world: gradient sky + sun (5.0: no Sky Texture sun_direction; plan 5.10)
    w = bpy.data.worlds.new('w')
    w.use_nodes = True
    nt = w.node_tree
    bg = nt.nodes.get('Background')
    grad = nt.nodes.new('ShaderNodeTexGradient')
    tc = nt.nodes.new('ShaderNodeTexCoord')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].color = (0.25, 0.22, 0.4, 1)
    ramp.color_ramp.elements[1].color = (0.03, 0.03, 0.09, 1)
    nt.links.new(tc.outputs['Generated'], sep.inputs[0])
    nt.links.new(sep.outputs['Z'], ramp.inputs['Fac'])
    nt.links.new(ramp.outputs['Color'], bg.inputs['Color'])
    bg.inputs['Strength'].default_value = 1.0
    s.world = w
    sun = bpy.data.lights.new('moon', 'SUN')
    sun.energy = 2.0
    sun.angle = math.radians(1.0)
    so = bpy.data.objects.new('moon', sun)
    so.rotation_euler = (math.radians(63), 0, math.radians(90))
    col.objects.link(so)
    if a.fog:
        bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 40))
        fog = bpy.context.active_object
        fog.scale = (1600, 1600, 80)
        fm = bpy.data.materials.new('fog')
        fm.use_nodes = True
        fnt = fm.node_tree
        fnt.nodes.clear()
        pv = fnt.nodes.new('ShaderNodeVolumePrincipled')
        pv.inputs['Density'].default_value = 0.0015
        out = fnt.nodes.new('ShaderNodeOutputMaterial')
        fnt.links.new(pv.outputs[0], out.inputs['Volume'])
        fog.data.materials.append(fm)
    return {'objects': len(bpy.data.objects), 'instancedBlocks': n}


def setup():
    s = bpy.context.scene
    s.render.resolution_x, s.render.resolution_y = a.w, a.h
    s.render.resolution_percentage = 100
    info = {}
    if a.engine == 'cycles':
        info['device'] = abake.cycles_device(a.device, a.threads)
        s.cycles.samples = a.samples
        s.cycles.use_denoising = a.denoise
        if a.denoise:
            try:
                s.cycles.denoiser = 'OPENIMAGEDENOISE'
            except Exception as ex:
                info['denoiser'] = str(ex)
        s.cycles.tile_size = a.tile
        s.cycles.max_bounces = 6
    else:
        s.render.engine = 'BLENDER_EEVEE'
        s.eevee.taa_render_samples = a.samples
    vl = s.view_layers[0]
    vl.use_pass_z = True
    aov = vl.aovs.add()
    aov.name = 'emit'
    aov.type = 'COLOR'
    if a.slice:
        cd = bpy.data.cameras.new('slice')
        cd.lens_unit = 'FOV'
        cd.sensor_fit = 'HORIZONTAL'
        cd.angle = math.radians(45)
        cd.clip_end = 5000
        cam = bpy.data.objects.new('slice', cd)
        s.collection.objects.link(cam)
        cam.location = (0, 0, 1.6)
        cam.rotation_euler = (math.radians(90 + 24), 0, math.radians(-90))
        s.camera = cam
    else:
        abake.pano_camera(lat_min=-12, lat_max=60, height=1.6)
    info['compositor'] = abake.compositor_outputs(job.out, f'pano_{tag}_', ['Image', 'Depth', 'emit'])
    abake.image_settings('PNG', '8', 'RGB')
    return info


def render():
    times = []
    for i in range(a.repeat):
        t = time.time()
        abake.render_still(os.path.join(job.out, f'pano_{tag}.png'))
        times.append(round(time.time() - t, 1))
    dt = times[-1]
    files = sorted(f for f in os.listdir(job.out) if f.startswith(f'pano_{tag}'))
    return {'seconds': round(dt, 1), 'allRuns': times, 'files': {f: os.path.getsize(os.path.join(job.out, f)) for f in files}, 'tag': tag,
            'msPerMegapixelPerSample': round(dt * 1000 / (a.w * a.h / 1e6) / max(1, a.samples), 2)}


job.step('build_scene', build)
job.step('setup', setup)
job.step('render', render)
job.done()
