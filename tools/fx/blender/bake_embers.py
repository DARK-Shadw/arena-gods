"""embers: seamless loop of a cluster of rising, drifting embers (above braziers, burning
fighters, pyre). The catalog's per-ember E02 effect is GPU particles; this flipbook is the
cheap far-distance / low-tier stand-in and the brazier "ember column" card.

Each ember is an emissive icosphere on an analytic, periodic path (age = frac(phase + offset)),
so frame N wraps exactly to frame 0. Positions are keyframed so EEVEE motion blur draws streaks.

  blender -b --factory-startup -P tools/fx/blender/bake_embers.py -- --out tools/fx/_bake/embers
"""
import math
import os
import random
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fxbake as fx  # noqa: E402

a = fx.parse_args(frames=36, px=256, samples=16)
fx.reset_scene()
T = 1.5
H = 1.8
fx.setup_render(a, ortho_scale=H, center=(0, 0, H / 2))
s = bpy.context.scene
s.render.use_motion_blur = True
s.render.motion_blur_shutter = 0.6
s.frame_start = 0
s.frame_end = a.frames

mat = bpy.data.materials.new('ember')
try:
    mat.use_nodes = True
except Exception:
    pass
nt = mat.node_tree
nt.nodes.clear()
em = nt.nodes.new('ShaderNodeEmission')
info = nt.nodes.new('ShaderNodeObjectInfo')
ramp = nt.nodes.new('ShaderNodeValToRGB')
ramp.color_ramp.elements[0].color = (1.0, 0.18, 0.02, 1)
ramp.color_ramp.elements[1].color = (1.0, 0.62, 0.22, 1)
nt.links.new(info.outputs['Random'], ramp.inputs['Fac'])
nt.links.new(ramp.outputs['Color'], em.inputs['Color'])
em.inputs['Strength'].default_value = 6.0
out = nt.nodes.new('ShaderNodeOutputMaterial')
nt.links.new(em.outputs[0], out.inputs['Surface'])

bpy.ops.mesh.primitive_ico_sphere_add(radius=1.0, subdivisions=1)
proto = bpy.context.active_object
proto.data.materials.append(mat)
proto.hide_render = True

rng = random.Random(a.seed * 31 + 1)
embers = []
for i in range(46):
    o = proto.copy()
    o.hide_render = False
    s.collection.objects.link(o)
    embers.append((o, dict(
        off=rng.random(), x0=rng.gauss(0, 0.13), y0=rng.gauss(0, 0.13),
        rise=rng.uniform(0.75, 1.15) * H / T, amp=rng.uniform(0.04, 0.16),
        f=rng.choice([1, 2]), ph=rng.uniform(0, 2 * math.pi), r=rng.uniform(0.008, 0.02),
        fl=rng.uniform(5, 13))))


def state(e, i):
    u = (i / a.frames + e['off']) % 1.0
    age = u * T
    z = 0.05 + age * e['rise'] * (1 - 0.25 * u)
    sway = e['amp'] * (0.3 + u)
    x = e['x0'] * (1 + u) + sway * math.sin(2 * math.pi * e['f'] * (i / a.frames) + e['ph'])
    y = e['y0'] * (1 + u)
    glow = math.sin(math.pi * u) ** 1.5 * (0.75 + 0.25 * math.sin(e['fl'] * age * 6.283 + e['ph']))
    return (x, y, z), e['r'] * max(glow, 0.0)


# keyframe every frame (0..N inclusive) so motion blur sees the motion
bpy.context.preferences.edit.keyframe_new_interpolation_type = 'LINEAR'
for o, e in embers:
    for i in range(a.frames + 1):
        p, r = state(e, i)
        o.location = p
        o.scale = (max(r, 1e-5),) * 3
        o.keyframe_insert('location', frame=i)
        o.keyframe_insert('scale', frame=i)
    for fc in (o.animation_data.action.fcurves if hasattr(o.animation_data.action, 'fcurves') else []):
        for kp in fc.keyframe_points:
            kp.interpolation = 'LINEAR'


def set_frame(i):
    s.frame_set(i)


fx.run(a, {
    'id': 'embers', 'kind': 'emissive', 'loop': True, 'fps': a.frames / T,
    'blend': 'premultiplied', 'grid': [6, 6], 'mv': False, 'tint': False,
    'method': 'emissive icospheres on periodic analytic paths, EEVEE motion blur',
    'pivot': [0.5, 0.03], 'worldSize': [H, H],
    'notes': 'Additive (A ~ 0). Use as a column card above fires; single embers are GPU particles.',
}, set_frame)
