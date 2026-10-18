"""fire_loop: seamless brazier / torch flame (plan §4.1, method B: procedural volume).

Animated 4D-noise Principled Volume on a domain box, rendered with EEVEE.
The loop is made seamless in DENSITY space (not by an image crossfade): two noise
samples, N(p, t) and N(p, t - T), are blended by phase, so frame 0 == frame N exactly
and no ghosting appears. Contrast lost by averaging is restored per frame.

  blender -b --factory-startup -P tools/fx/blender/bake_fire_loop.py -- --out tools/fx/_bake/fire_loop
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fxbake as fx  # noqa: E402

a = fx.parse_args(frames=64, px=256, samples=16)
fx.reset_scene()
H = 2.0           # flame height (m, bake units)
W = 1.1           # domain width
T = 2.0           # loop period (s) -> 64 frames at 32 fps
RISE = 1.35       # upward feature speed (m/s)
EVOLVE = 0.55     # noise evolution per second

fx.setup_render(a, ortho_scale=H * 1.12, center=(0, 0, H * 0.5))
dom = fx.domain_cube('fire', (W, W, H), (0, 0, H / 2))
mat, g = fx.volume_material(dom, 'fire_mat')

o = g.coords('Object')
ox, oy, oz = g.split(o)
x = g.mul(ox, W / 2)
y = g.mul(oy, W / 2)
z = g.mul(g.add(oz, 1.0), H / 2)            # 0..H
zn = g.div(z, H)                            # 0..1

tA = g.param('tA')                          # phase * T
tB = g.param('tB')                          # tA - T
wA = g.param('wA')
wB = g.param('wB')
mixA = g.param('mix')                       # blend weight of sample B
k = g.param('k')                            # contrast restore
seed = float(a.seed) * 13.1


def sample(t, w, scale, detail):
    q = g.combine(x, y, g.sub(z, g.mul(t, RISE)))
    f, _ = g.noise(q, g.add(w, seed), scale=scale, detail=detail, rough=0.66)
    return f


nA = sample(tA, wA, 3.0, 6.0)
nB = sample(tB, wB, 3.0, 6.0)
n = g.add(g.mul(nA, g.sub(1.0, mixA)), g.mul(nB, mixA))
n = g.add(0.5, g.mul(g.sub(n, 0.5), k))     # 0..1, mean 0.5
# second, larger scale noise for sway (same loop trick)
sA = sample(tA, g.mul(wA, 0.6), 0.9, 2.0)
sB = sample(tB, g.mul(wB, 0.6), 0.9, 2.0)
sw = g.add(g.mul(sA, g.sub(1.0, mixA)), g.mul(sB, mixA))
sw = g.mul(g.sub(g.add(0.5, g.mul(g.sub(sw, 0.5), k)), 0.5), g.mul(zn, 0.55))   # lateral offset grows with height

# teardrop profile radius R(z): rounded base, widest near 15% height, tapering into tongues
R = g.mul(0.44, g.pow(g.sub(1.0, zn), 0.9))
R = g.mul(R, g.pow(g.smooth(0.0, 0.16, zn), 0.5))
r = g.v('LENGTH', g.combine(g.sub(x, sw), y, 0.0))
turb = g.add(0.30, g.mul(zn, 1.3))          # noise fac has a small spread: amplify, more at the top
shape = g.add(g.sub(R, r), g.mul(g.sub(n, 0.5), turb))
flame = g.smooth(-0.005, 0.05, shape)
depth = g.smooth(0.0, 0.17, shape)          # how deep inside the flame body (hotter inside)
heat = g.mul(depth, g.sub(1.0, g.mul(zn, 0.7)))
col = g.ramp(heat, [
    (0.00, (0.45, 0.03, 0.00, 1)),
    (0.35, (1.00, 0.16, 0.01, 1)),
    (0.70, (1.00, 0.36, 0.04, 1)),
    (1.00, (1.00, 0.66, 0.24, 1)),
])
# dim red skin everywhere inside the flame + a steep hot core (HDR, normalised by pack_atlas)
emit = g.add(g.mul(flame, 0.35), g.mul(g.pow(heat, 2.5), 7.0))
g.vol_out(density=g.mul(flame, 0.9), color=(0.02, 0.02, 0.02, 1), emit_color=col, emit_strength=emit)


def set_frame(i):
    ph = i / a.frames
    ta = ph * T
    g.set('tA', ta)
    g.set('tB', ta - T)
    g.set('wA', ta * EVOLVE)
    g.set('wB', (ta - T) * EVOLVE)
    m, kk = fx.loop_mix(ph)
    g.set('mix', m)
    g.set('k', kk)


fx.run(a, {
    'id': 'fire_loop', 'kind': 'emissive', 'loop': True, 'fps': a.frames / T,
    'blend': 'premultiplied', 'grid': [8, 8], 'mv': True, 'tint': False,
    'method': 'B procedural volume (4D noise, density-space loop)',
    'pivot': [0.5, 0.05], 'worldSize': [H * 1.12, H * 1.12],
    'notes': 'RGB = premultiplied emission colour (core ~1.0, runtime applies HDR scale 8-30); A = occlusion.',
}, set_frame)
