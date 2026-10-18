"""splash / blood_spray: metaball-particle liquids (plan §4.1: "metaball particles, no fluid sim").

Particles are analytic (ballistic, seeded), so every frame is a pure function of the frame
index. Each particle is an ellipsoid metaball element stretched along its velocity
(a cheap stand-in for motion blur); neighbouring elements merge into sheets and threads.

  --kind splash : water crown + central jet + droplets (36 frames, 6x6), neutral white-blue,
                  tint per surface at runtime (water, mud)
  --kind blood  : arterial spray to screen-right + droplets (16 frames, 4x4), dark red

  blender -b --factory-startup -P tools/fx/blender/bake_liquid.py -- --kind splash --out tools/fx/_bake/splash
  blender -b --factory-startup -P tools/fx/blender/bake_liquid.py -- --kind blood  --out tools/fx/_bake/blood_spray
"""
import math
import os
import random
import sys

import bpy
from mathutils import Quaternion, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fxbake as fx  # noqa: E402

a = fx.parse_args(frames=36, px=256, samples=16,
                  extra=lambda ap: ap.add_argument('--kind', default='splash', choices=['splash', 'blood']))
blood = a.kind == 'blood'
if blood and a.frames == 36:
    a.frames = 16
DUR = 0.45 if blood else 0.9
GRAV = 9.8
fx.reset_scene()

if blood:
    S = 1.4
    fx.setup_render(a, ortho_scale=S, center=(0.1, 0, 0.0))
    origin = Vector((-0.55, 0, 0.15))
else:
    S = 1.7
    fx.setup_render(a, ortho_scale=S, center=(0, 0, S * 0.45), elev_deg=12)
    origin = Vector((0, 0, 0))

# lights: key from top-left, rim from behind, dim ambient world (for glossy reflections)
fx.sun('key', (35, 0, -40), 3.0)
fx.sun('rim', (-60, 0, 160), 2.0)
bpy.context.scene.world.color = (0.18, 0.18, 0.2)

mb = bpy.data.metaballs.new('liquid')
mb.resolution = 0.03
mb.render_resolution = 0.006 if blood else 0.01
mb.threshold = 0.6
obj = bpy.data.objects.new('liquid', mb)
bpy.context.scene.collection.objects.link(obj)

mat = bpy.data.materials.new('liquid_mat')
try:
    mat.use_nodes = True
except Exception:
    pass
bsdf = mat.node_tree.nodes.get('Principled BSDF')
if blood:
    bsdf.inputs['Base Color'].default_value = (0.20, 0.004, 0.008, 1)
    bsdf.inputs['Roughness'].default_value = 0.18
else:
    bsdf.inputs['Base Color'].default_value = (0.72, 0.78, 0.84, 1)
    bsdf.inputs['Roughness'].default_value = 0.06
    bsdf.inputs['Alpha'].default_value = 0.82
mb.materials.append(mat)

rng = random.Random(a.seed * 1009 + (7 if blood else 3))
parts = []   # (p0, v0, r0, t_emit, life)
if blood:
    d0 = Vector((1.0, 0, 0.35)).normalized()
    for i in range(150):                      # arterial stream: emitted over the first 0.12 s
        te = rng.uniform(0, 0.12)
        spread = Vector((rng.gauss(0, 0.12), rng.gauss(0, 0.05), rng.gauss(0, 0.12)))
        v = (d0 + spread).normalized() * rng.uniform(3.2, 5.0)
        parts.append((origin.copy(), v, rng.uniform(0.014, 0.03), te, 1.0))
    for i in range(90):                       # droplets: wider cone, smaller
        spread = Vector((rng.gauss(0, 0.35), rng.gauss(0, 0.15), rng.gauss(0, 0.35)))
        v = (d0 + spread).normalized() * rng.uniform(1.5, 5.5)
        parts.append((origin.copy(), v, rng.uniform(0.006, 0.016), rng.uniform(0, 0.06), 1.0))
else:
    for i in range(220):                      # crown sheet
        th = 2 * math.pi * (i + rng.uniform(-0.3, 0.3)) / 220
        out = rng.uniform(0.6, 1.0)
        up = rng.uniform(3.0, 4.0)
        p0 = Vector((math.cos(th) * 0.10, math.sin(th) * 0.10, 0.0))
        v = Vector((math.cos(th) * out, math.sin(th) * out, up))
        parts.append((p0, v, rng.uniform(0.035, 0.05), rng.uniform(0, 0.04), 1.0))
    for i in range(14):                       # central jet (Worthington column), a bit later
        v = Vector((rng.gauss(0, 0.15), rng.gauss(0, 0.15), rng.uniform(2.6, 3.8)))
        parts.append((Vector((0, 0, 0)), v, rng.uniform(0.05, 0.075) * (1 - i / 20), 0.08 + i * 0.012, 1.0))
    for i in range(60):                       # droplets thrown off the crown rim
        th = rng.uniform(0, 2 * math.pi)
        out = rng.uniform(1.2, 2.4)
        v = Vector((math.cos(th) * out, math.sin(th) * out, rng.uniform(2.2, 3.6)))
        parts.append((Vector((math.cos(th) * 0.12, math.sin(th) * 0.12, 0.0)), v,
                      rng.uniform(0.012, 0.025), rng.uniform(0.05, 0.15), 1.0))

elems = []
for _ in parts:
    e = mb.elements.new(type='ELLIPSOID')
    elems.append(e)


def set_frame(i):
    t = 0.03 + i / (a.frames - 1) * DUR
    for (p0, v0, r0, te, _), e in zip(parts, elems):
        age = t - te
        if age < 0:
            e.radius = 0.0001
            e.co = (0, 0, -50)
            continue
        drag = 0.6 if blood else 0.25
        k = (1 - math.exp(-drag * age)) / drag            # closed-form linear drag
        p = p0 + v0 * k + Vector((0, 0, -0.5 * GRAV * age * age))
        v = v0 * math.exp(-drag * age) + Vector((0, 0, -GRAV * age))
        shrink = max(0.0, 1.0 - (age / (DUR * (1.2 if blood else 1.0))) ** 2)
        floor = (p.z < -0.02) if not blood else (p.z < origin.z - 0.9)
        r = r0 * shrink * (0.0 if floor else 1.0)
        e.radius = max(r, 0.0001) * (1.6 if blood else 2.1)
        e.co = p
        sp = v.length
        stretch = 1.0 + min(4.0 if blood else 2.5, sp * (0.4 if blood else 0.12))
        e.size_x, e.size_y, e.size_z = stretch, 1.0, 1.0
        e.rotation = Vector((1, 0, 0)).rotation_difference(v.normalized()) if sp > 1e-4 else Quaternion()


fx.run(a, {
    'id': 'blood_spray' if blood else 'splash', 'kind': 'lit-fixed', 'loop': False,
    'fps': a.frames / DUR, 'blend': 'premultiplied', 'grid': [4, 4] if blood else [6, 6],
    'mv': False, 'tint': not blood,
    'method': 'metaball particles (analytic ballistic + drag, velocity-stretched ellipsoids)',
    'pivot': [(-0.55 - (0.1 - S / 2)) / S, (0.15 + S / 2) / S] if blood else [0.5, (0 - (S * 0.45 - S / 2)) / S], 'worldSize': [S, S],
    'notes': ('Dark red, wet highlights; spray travels to screen +X: orient the card along the cut.'
              if blood else 'Neutral white-blue water; tint for mud/blood-water.'),
}, set_frame)
