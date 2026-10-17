"""smoke_wisp: rising, curling smoke loop, relightable (plan §4.1, method B).

Rendered three times per frame, once per directional light (LIGHT_RIGS in fxbake.py):
pack_atlas stores the three luminances in R, G, B and the coverage in A. The runtime
reconstructs lighting from the key direction + theme ambient (see docs/fx-pipeline.md).
Seamless loop in density space (same trick as fire_loop).

  blender -b --factory-startup -P tools/fx/blender/bake_smoke_wisp.py -- --out tools/fx/_bake/smoke_wisp
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fxbake as fx  # noqa: E402

a = fx.parse_args(frames=64, px=256, samples=16)
fx.reset_scene()
H = 2.4
W = 1.6
T = 2.67          # 64 frames at 24 fps
RISE = 0.75
EVOLVE = 0.35

fx.setup_render(a, ortho_scale=H * 1.04, center=(0, 0, H * 0.5))
lights = fx.three_light_rig(strength=3.5)
dom = fx.domain_cube('smoke', (W, W, H), (0, 0, H / 2))
mat, g = fx.volume_material(dom, 'smoke_mat')

o = g.coords('Object')
ox, oy, oz = g.split(o)
x = g.mul(ox, W / 2)
y = g.mul(oy, W / 2)
z = g.mul(g.add(oz, 1.0), H / 2)
zn = g.div(z, H)
tA, tB, wA, wB, mixA, k = (g.param(n) for n in ('tA', 'tB', 'wA', 'wB', 'mix', 'k'))
seed = float(a.seed) * 7.7


def sample(t, w, scale, detail, rough=0.6):
    q = g.combine(x, y, g.sub(z, g.mul(t, RISE)))
    f, _ = g.noise(q, g.add(w, seed), scale=scale, detail=detail, rough=rough)
    return f


def looped(fa, fb):
    n = g.add(g.mul(fa, g.sub(1.0, mixA)), g.mul(fb, mixA))
    return g.add(0.5, g.mul(g.sub(n, 0.5), k))


n = looped(sample(tA, wA, 2.6, 7.0), sample(tB, wB, 2.6, 7.0))
s1 = looped(sample(tA, g.mul(wA, 0.5), 0.8, 2.0), sample(tB, g.mul(wB, 0.5), 0.8, 2.0))
# the column bends more the higher it rises
sway = g.mul(g.sub(s1, 0.5), g.mul(zn, 2.4))
R = g.add(0.06, g.mul(zn, 0.55))                       # widens as it rises
r = g.v('LENGTH', g.combine(g.sub(x, sway), y, 0.0))
turb = g.add(0.12, g.mul(zn, 1.6))
shape = g.add(g.sub(R, r), g.mul(g.sub(n, 0.5), turb))
body = g.smooth(-0.02, 0.10, shape)
fade = g.mul(g.smooth(0.0, 0.08, zn), g.mul(g.pow(g.sub(1.0, zn), 1.6), g.smooth(0.98, 0.55, zn)))   # thin out towards the top
dens = g.mul(g.mul(body, fade), 2.6)
g.vol_out(density=dens, color=(0.86, 0.86, 0.86, 1))


def set_frame(i):
    ph = i / a.frames
    ta = ph * T
    g.set('tA', ta); g.set('tB', ta - T)
    g.set('wA', ta * EVOLVE); g.set('wB', (ta - T) * EVOLVE)
    m, kk = fx.loop_mix(ph)
    g.set('mix', m); g.set('k', kk)


def only(name):
    def f():
        for k_, l_ in lights.items():
            l_.hide_render = (k_ != name)
    return f


fx.run(a, {
    'id': 'smoke_wisp', 'kind': 'lit3', 'loop': True, 'fps': a.frames / T,
    'blend': 'premultiplied', 'grid': [8, 8], 'mv': True, 'tint': True,
    'method': 'B procedural volume (4D noise, density-space loop), 3 directional light passes',
    'pivot': [0.5, 0.02], 'worldSize': [H * 1.04, H * 1.04],
    'notes': 'R/G/B = luminance lit from screen right / top / left (35 deg toward camera); A = coverage.',
}, set_frame, passes={k_: only(k_) for k_ in lights})
