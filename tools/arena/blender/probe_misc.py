"""A0 probe: banner cloth settle (plan 5.2) and an EEVEE card sequence (plan 5.6 fog / shaft cards).

cloth  a 40 x 80 grid banner (1.2 x 2.4 m), top row pinned, wind force field, --frames of simulation
       (bpy cloth bake through the point cache), then the settled mesh exported as GLB
cards  EEVEE, 512 px, --card-frames frames of a volumetric fog bank (noise density), PNG per frame
"""
import math
import os
import sys
import time

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import abake  # noqa: E402


def extra(ap):
    ap.add_argument('--frames', type=int, default=60)
    ap.add_argument('--card-frames', type=int, default=8)
    ap.add_argument('--card-px', type=int, default=512)


job = abake.Job(extra, __doc__)
a = job.a


def cloth():
    s = abake.reset()
    bpy.ops.mesh.primitive_grid_add(x_subdivisions=40, y_subdivisions=80, size=1)
    o = bpy.context.active_object
    o.scale = (1.2, 2.4, 1)
    o.rotation_euler = (math.radians(90), 0, 0)
    o.location = (0, 0, 3)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    vg = o.vertex_groups.new(name='pin')
    top = max(v.co.z for v in o.data.vertices)
    vg.add([v.index for v in o.data.vertices if v.co.z > top - 1e-4], 1.0, 'REPLACE')
    cm = o.modifiers.new('cloth', 'CLOTH')
    cm.settings.vertex_group_mass = 'pin'
    cm.settings.quality = 6
    cm.point_cache.frame_start = 1
    cm.point_cache.frame_end = a.frames
    s.frame_start, s.frame_end = 1, a.frames
    bpy.ops.object.effector_add(type='WIND', location=(0, -3, 3), rotation=(math.radians(-90), 0, 0))
    bpy.context.active_object.field.strength = 120
    t = time.time()
    with bpy.context.temp_override(scene=s, active_object=o, point_cache=cm.point_cache):
        bpy.ops.ptcache.bake(bake=True)
    dt = time.time() - t
    s.frame_set(a.frames)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
    z = [v.co.z for v in me.vertices]
    out = abake.export_glb(os.path.join(job.out, 'probe_banner.glb'), objects=[o])
    return {'frames': a.frames, 'verts': len(me.vertices), 'bakeSeconds': round(dt, 2), 'zRange': [round(min(z), 3), round(max(z), 3)], 'glb': out}


def cards():
    s = abake.reset()
    s.render.engine = 'BLENDER_EEVEE'
    s.render.resolution_x = s.render.resolution_y = a.card_px
    s.render.film_transparent = True
    s.eevee.taa_render_samples = 16
    s.eevee.volumetric_tile_size = '2'
    s.eevee.volumetric_samples = 64
    bpy.ops.mesh.primitive_cube_add(size=4, location=(0, 0, 0))
    d = bpy.context.active_object
    mat = bpy.data.materials.new('fog')
    mat.use_nodes = True
    g = abake.fxbake.G(mat)
    co = g.coords('Object')
    t = g.param('t', 0.0)
    fac, _ = g.noise(co, w=t, scale=1.2, detail=5)
    dens = g.mul(g.smooth(0.45, 0.75, fac), 4.0)
    g.vol_out(dens, color=(0.8, 0.8, 0.9, 1))
    d.data.materials.append(mat)
    sun = bpy.data.lights.new('s', 'SUN')
    sun.energy = 4
    so = bpy.data.objects.new('s', sun)
    so.rotation_euler = (math.radians(50), 0, math.radians(30))
    s.collection.objects.link(so)
    cd = bpy.data.cameras.new('c')
    cd.type = 'ORTHO'
    cd.ortho_scale = 4.2
    c = bpy.data.objects.new('c', cd)
    s.collection.objects.link(c)
    c.location = (0, -10, 0)
    c.rotation_euler = (math.radians(90), 0, 0)
    s.camera = c
    abake.image_settings('PNG', '8', 'RGBA')
    times = []
    for i in range(a.card_frames):
        g.set('t', i / a.card_frames * 2.0)
        t0 = time.time()
        abake.render_still(os.path.join(job.out, f'card_{i:02d}.png'))
        times.append(round(time.time() - t0, 2))
    return {'px': a.card_px, 'frames': a.card_frames, 'secondsPerFrame': times, 'first': times[0], 'meanRest': round(sum(times[1:]) / max(1, len(times) - 1), 2)}


job.step('cloth_settle', cloth)
job.step('eevee_cards', cards)
job.done()
