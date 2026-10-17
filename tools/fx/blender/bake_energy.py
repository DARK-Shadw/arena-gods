"""energy_swirl: magic gather / aura loop (plan §4.1, for F8; method B, emission noise).

A swirling plasma ring around a hot core. The noise is sampled in coordinates rotated by
exactly one turn per loop (plus a counter-rotating layer at two turns), so the loop is exact
without any crossfade. Rendered in neutral white: the school colour is applied at runtime
(manifest tint: true).

  blender -b --factory-startup -P tools/fx/blender/bake_energy.py -- --out tools/fx/_bake/energy_swirl
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fxbake as fx  # noqa: E402

a = fx.parse_args(frames=64, px=256, samples=16)
fx.reset_scene()
S = 2.0
T = 2.0
fx.setup_render(a, ortho_scale=S * 0.8, center=(0, 0, 0), elev_deg=20)
dom = fx.domain_cube('energy', (S, S, S * 0.6), (0, 0, 0))
mat, g = fx.volume_material(dom, 'energy_mat')
o = g.coords('Object')
ox, oy, oz = g.split(o)
p = g.combine(g.mul(ox, S / 2), g.mul(oy, S / 2), g.mul(oz, S * 0.3))
x, y, z = g.split(p)
r = g.v('LENGTH', g.combine(x, y, 0.0))
ang1 = g.param('ang1')
ang2 = g.param('ang2')


def rot(vec, angle):
    n = g.node('ShaderNodeVectorRotate', rotation_type='Z_AXIS')
    g._in(n.inputs['Vector'], vec)
    g._in(n.inputs['Angle'], angle)
    return n.outputs['Vector']


twist = g.mul(r, 2.2)                                   # static spiral twist with radius
q1 = rot(p, g.add(ang1, twist))
q2 = rot(p, g.sub(ang2, g.mul(twist, 0.6)))
n1, _ = g.noise(q1, 0.0, scale=2.4, detail=6.0, rough=0.6, dims='3D', distortion=0.4)
n2, _ = g.noise(q2, 0.0, scale=4.5, detail=3.0, rough=0.5, dims='3D')
# a swirling ring at radius 0.6, flattened vertically, plus a small hot core
ring = g.v('LENGTH', g.combine(g.sub(r, 0.58), g.mul(z, 1.6), 0.0))
band = g.sub(0.14, ring)
# ridged noise -> thin plasma filaments inside the swirling band
ridge = g.pow(g.clamp01(g.sub(1.0, g.mul(g.m('ABSOLUTE', g.sub(n1, 0.5)), 16.0))), 3.0)
ridge2 = g.pow(g.clamp01(g.sub(1.0, g.mul(g.m('ABSOLUTE', g.sub(n2, 0.5)), 8.0))), 3.0)
strands = g.mul(g.add(ridge, g.mul(ridge2, 0.5)), g.smooth(-0.05, 0.12, band))
core = g.smooth(0.22, 0.0, g.v('LENGTH', p))
emit = g.add(g.mul(strands, 10.0), g.mul(g.pow(core, 2.0), 8.0))
g.vol_out(density=g.mul(g.add(strands, core), 0.25), color=(0, 0, 0, 1), emit_color=(1, 1, 1, 1),
          emit_strength=emit)


def set_frame(i):
    ph = i / a.frames
    g.set('ang1', -2 * math.pi * ph)
    g.set('ang2', 4 * math.pi * ph)


fx.run(a, {
    'id': 'energy_swirl', 'kind': 'emissive', 'loop': True, 'fps': a.frames / T,
    'blend': 'premultiplied', 'grid': [8, 8], 'mv': False, 'tint': True,
    'method': 'B procedural volume (rotating 3D noise, exact loop)',
    'pivot': [0.5, 0.5], 'worldSize': [S * 0.8, S * 0.8], 'cameraElevationDeg': 20,
    'notes': 'Neutral white emission: multiply by the school colour (HDR core 8-30).',
}, set_frame)
