"""dust_puff / dust_ring: one-shot ground dust, relightable (plan §4.1, method B).

  --kind puff : billowing puff from a point (footsteps, skids, small impacts)
  --kind ring : low expanding torus of dust (landings, knockdowns, heavy-hit shockwave),
                camera tilted 25 deg down so a camera-facing card reads as a ring on the floor

Three light passes like smoke_wisp; neutral grey albedo (tinted per theme at runtime).

  blender -b --factory-startup -P tools/fx/blender/bake_dust.py -- --kind puff --out tools/fx/_bake/dust_puff
  blender -b --factory-startup -P tools/fx/blender/bake_dust.py -- --kind ring --out tools/fx/_bake/dust_ring
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fxbake as fx  # noqa: E402

a = fx.parse_args(frames=36, px=256, samples=16,
                  extra=lambda ap: ap.add_argument('--kind', default='puff', choices=['puff', 'ring']))
fx.reset_scene()
DUR = 1.5                     # seconds the 36 frames cover (24 fps)
ring = a.kind == 'ring'
if ring:
    S = 4.4                   # domain width
    fx.setup_render(a, ortho_scale=S * 1.0, center=(0, 0, 0.55), elev_deg=25)
    dom = fx.domain_cube('dust', (S, S, 1.6), (0, 0, 0.8))
    half = (S / 2, S / 2, 0.8)
else:
    S = 2.0
    fx.setup_render(a, ortho_scale=S * 1.05, center=(0, 0, S * 0.45))
    dom = fx.domain_cube('dust', (S, S, S), (0, 0, S / 2))
    half = (S / 2, S / 2, S / 2)
lights = fx.three_light_rig(strength=3.5)
mat, g = fx.volume_material(dom, 'dust_mat')

o = g.coords('Object')
ox, oy, oz = g.split(o)
x = g.mul(ox, half[0])
y = g.mul(oy, half[1])
z = g.mul(g.add(oz, 1.0), half[2])             # 0 at the floor
rad = g.param('rad')                           # growth radius at this time
minor = g.param('minor')
rise = g.param('rise')
dissolve = g.param('dissolve')                 # 0..1, eats the volume from the thin parts
w = g.param('w')
dens_k = g.param('dens')
seed = float(a.seed) * 3.3

if ring:
    rxy = g.v('LENGTH', g.combine(x, y, 0.0))
    # distance to the torus core (major radius = rad, at height minor*0.6)
    d = g.v('LENGTH', g.combine(g.sub(rxy, rad), 0.0, g.sub(z, g.mul(minor, 0.55))))
    q = g.combine(x, y, g.sub(z, rise))
    nlow, _ = g.noise(q, g.add(w, seed + 9), scale=0.9, detail=2.0, rough=0.5)
    size = g.mul(minor, g.add(0.35, g.mul(g.smooth(0.35, 0.65, nlow), 1.3)))   # lumpy, broken ring
else:
    cz = g.add(g.mul(rad, 0.75), rise)
    d = g.v('LENGTH', g.combine(x, y, g.mul(g.sub(z, cz), 1.15)))
    size = rad
    q = g.combine(x, y, g.sub(z, rise))
n, _ = g.noise(g.v('SCALE', q, scale=1.0), g.add(w, seed), scale=3.4 if ring else 2.8, detail=6.0, rough=0.62)
n2, _ = g.noise(q, g.add(g.mul(w, 1.7), seed + 5), scale=6.5, detail=3.0, rough=0.5)
billow = g.add(g.mul(g.sub(n, 0.5), 1.6), g.mul(g.sub(n2, 0.5), 0.6))
shape = g.add(g.sub(size, d), g.mul(billow, g.mul(size, 1.9 if ring else 1.1)))
body = g.smooth(0.0, g.mul(size, 0.35), shape)
body = g.mul(body, g.smooth(dissolve, g.add(dissolve, 0.25), g.add(n, 0.2)))
floor = g.smooth(0.0, 0.05, z)
g.vol_out(density=g.mul(g.mul(body, floor), dens_k), color=(0.82, 0.82, 0.82, 1))


def ease_out(t, p=3.0):
    return 1 - (1 - t) ** p


def set_frame(i):
    t = i / (a.frames - 1)
    if ring:
        g.set('rad', 0.15 + 1.75 * ease_out(t, 3.5))
        g.set('minor', 0.12 + 0.38 * ease_out(t, 2.0))
        g.set('rise', 0.25 * t)
    else:
        g.set('rad', 0.12 + 0.62 * ease_out(t, 3.0))
        g.set('minor', 0.0)
        g.set('rise', 0.30 * t)
    g.set('dissolve', 0.15 + 0.75 * t ** 1.4)
    g.set('w', t * 1.1)
    g.set('dens', 9.0 * (1 - t) ** 0.8 + 0.5)


def only(name):
    def f():
        for k_, l_ in lights.items():
            l_.hide_render = (k_ != name)
    return f


fx.run(a, {
    'id': 'dust_ring' if ring else 'dust_puff', 'kind': 'lit3', 'loop': False, 'fps': a.frames / DUR,
    'blend': 'premultiplied', 'grid': [6, 6], 'mv': False, 'tint': True,
    'method': 'B procedural volume (expanding noise ' + ('torus' if ring else 'sphere') + '), 3 directional light passes',
    'pivot': [0.5, 0.18 if ring else 0.03], 'worldSize': [S, S],
    'cameraElevationDeg': 25 if ring else 0,
    'notes': 'R/G/B = luminance lit from screen right / top / left; A = coverage. Neutral grey: tint per theme.',
}, set_frame, passes={k_: only(k_) for k_ in lights})
