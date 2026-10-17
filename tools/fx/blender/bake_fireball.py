"""fire_burst / explosion: one-shot fireballs that turn into dark smoke (plan §4.1).

  --kind burst      fire_burst: short flare-up / fireball impact (36 frames, 6x6), method B
  --kind explosion  explosion: powder keg (64 frames, 8x8). --method auto tries
                    METHOD A (Mantaflow Quick Smoke) first: a dry run checks the 5.0 API by
                    baking 3 frames at resolution 24; on any failure it falls back to
                    METHOD B (procedural volume). --method procedural forces B.

Output is premultiplied emission + smoke (smoke lit by one fixed key from the top-left,
so it is NOT relightable like smoke_wisp; recorded in bake.json as kind 'emissive+smoke').

  blender -b --factory-startup -P tools/fx/blender/bake_fireball.py -- --kind burst --out tools/fx/_bake/fire_burst
  blender -b --factory-startup -P tools/fx/blender/bake_fireball.py -- --kind explosion --out tools/fx/_bake/explosion
"""
import os
import sys
import time

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fxbake as fx  # noqa: E402

a = fx.parse_args(frames=36, px=256, samples=16,
                  extra=lambda ap: ap.add_argument('--kind', default='burst', choices=['burst', 'explosion']))
big = a.kind == 'explosion'
if big and a.frames == 36:
    a.frames = 64
DUR = 2.6 if big else 1.2
S = 4.0 if big else 2.0            # frame width in bake units


# --------------------------------------------------------------------------- method A
def mantaflow_scene(res, end_frame, cache):
    fx.reset_scene()
    s = bpy.context.scene
    bpy.ops.mesh.primitive_ico_sphere_add(radius=0.28, subdivisions=3, location=(0, 0, 0.35))
    em = bpy.context.active_object
    # Blender 5.0.1 note: in background mode bpy.ops.object.quick_smoke() only creates the
    # domain (the emitter gets no Fluid modifier: "Only one modifier of this type is allowed"),
    # so the flow and domain are set up by hand with the same settings Quick Smoke uses.
    bpy.ops.mesh.primitive_cube_add(size=2.0)
    dom = bpy.context.active_object
    dom.name = 'Smoke Domain'
    dm = dom.modifiers.new('Fluid', 'FLUID')
    dm.fluid_type = 'DOMAIN'
    d = dm.domain_settings
    d.domain_type = 'GAS'
    fm = em.modifiers.new('Fluid', 'FLUID')
    fm.fluid_type = 'FLOW'
    dom.location = (0, 0, S * 0.5 - 0.05)
    dom.scale = (S / 2, S / 2, S / 2)
    # domain material: density -> smoke, flame -> emission (what Quick Smoke builds)
    mat, g = fx.volume_material(dom, 'manta_mat')
    dens = g.node('ShaderNodeAttribute', attribute_name='density').outputs['Fac']
    flame = g.node('ShaderNodeAttribute', attribute_name='flame').outputs['Fac']
    col = g.ramp(g.clamp01(g.mul(flame, 1.2)), [
        (0.00, (0.30, 0.02, 0.00, 1)), (0.35, (1.00, 0.18, 0.01, 1)),
        (0.70, (1.00, 0.42, 0.06, 1)), (1.00, (1.00, 0.80, 0.45, 1))])
    g.vol_out(density=g.mul(dens, 6.0), color=(0.10, 0.09, 0.085, 1), emit_color=col,
              emit_strength=g.mul(g.pow(flame, 2.0), 12.0))
    d.resolution_max = res
    d.cache_directory = cache
    d.cache_frame_start = 1
    d.cache_frame_end = end_frame
    d.cache_type = 'ALL'
    d.use_adaptive_domain = False
    d.vorticity = 0.25
    d.burning_rate = 0.6
    d.flame_smoke = 1.6
    d.alpha = 1.0                    # smoke buoyancy (density)
    d.beta = 1.6                     # heat buoyancy
    f = em.modifiers['Fluid'].flow_settings
    f.flow_type = 'BOTH'
    f.flow_behavior = 'INFLOW'
    f.fuel_amount = 2.5
    f.temperature = 3.0
    f.use_initial_velocity = True
    f.velocity_normal = 6.0
    f.surface_distance = 1.0
    em.hide_render = True
    # emit for the first 5 frames only
    for fr, amt in ((1, 2.5), (5, 2.5), (6, 0.0)):
        f.fuel_amount = amt
        f.density = 1.0 if amt else 0.0
        f.temperature = 3.0 if amt else 0.0
        for prop in ('fuel_amount', 'density', 'temperature'):
            f.keyframe_insert(prop, frame=fr)
    with bpy.context.temp_override(scene=s, object=dom, active_object=dom,
                                   selected_objects=[dom], selected_editable_objects=[dom]):
        bpy.ops.fluid.bake_all()
    return dom


def try_mantaflow():
    """Dry run for method A: Quick Smoke + a 3-frame bake at res 24. Returns (ok, reason)."""
    t0 = time.time()
    cache = os.path.join(a.out, 'cache_dry')
    try:
        if 'FLUID' not in [e.identifier for e in bpy.types.Modifier.bl_rna.properties['type'].enum_items]:
            return False, 'FLUID modifier missing'
        dom = mantaflow_scene(24, 3, cache)
        bpy.context.scene.frame_set(3)
        files = sum(len(fs) for _, _, fs in os.walk(cache))
        if files == 0:
            return False, 'bake produced no cache files'
        fx.log(f'Mantaflow dry bake ok ({files} cache files, {time.time() - t0:.1f}s, peak RAM {fx.peak_ram_mb():.0f} MB)')
        return True, 'ok'
    except Exception as ex:  # API changed or op failed in background mode
        return False, f'{type(ex).__name__}: {ex}'


method = 'procedural'
# auto = procedural: the Mantaflow path works in 5.0.1 (API verified by the dry run) but the
# untuned plume reads as a thin column, not a keg blast. --method mantaflow to use it.
if big and a.method == 'mantaflow':
    ok, why = try_mantaflow()
    fx.log('METHOD A (Mantaflow) dry run:', 'OK' if ok else 'FAILED - ' + why)
    if ok:
        method = 'mantaflow'
    elif a.method == 'mantaflow':
        raise SystemExit('Mantaflow forced but unavailable: ' + why)

if method == 'mantaflow':
    res = 48 if (a.dry_run or a.preview) else 96
    FRAME0 = 2
    dom = mantaflow_scene(res, a.frames + FRAME0 + 1, os.path.join(a.out, 'cache'))
    fx.setup_render(a, ortho_scale=S, center=(0, 0, S * 0.5 - 0.05))
    fx.sun('key', (40, 0, -35), 2.5)
    s = bpy.context.scene

    def set_frame(i):
        s.frame_set(FRAME0 + i)
    meta_method = f'A Mantaflow gas (fire+smoke), domain res {res}, EEVEE'
else:
    # --------------------------------------------------------------------------- method B
    fx.reset_scene()
    fx.setup_render(a, ortho_scale=S, center=(0, 0, S * 0.5 - 0.05))
    fx.sun('key', (40, 0, -35), 2.0)
    dom = fx.domain_cube('fireball', (S, S, S), (0, 0, S / 2 - 0.05))
    mat, g = fx.volume_material(dom, 'fireball_mat')
    o = g.coords('Object')
    ox, oy, oz = g.split(o)
    x = g.mul(ox, S / 2)
    y = g.mul(oy, S / 2)
    z = g.add(g.mul(oz, S / 2), S / 2)
    rad, cz, w, hot, smoke, dis, fade = (g.param(n) for n in ('rad', 'cz', 'w', 'hot', 'smoke', 'dis', 'fade'))
    seed = float(a.seed) * 5.1
    q = g.combine(x, y, g.sub(z, cz))
    d = g.v('LENGTH', g.combine(x, y, g.mul(g.sub(z, cz), 0.9)))
    n, _ = g.noise(q, g.add(w, seed), scale=2.6 / S * 2, detail=7.0, rough=0.62)
    n2, _ = g.noise(q, g.add(g.mul(w, 1.6), seed + 3), scale=7.0 / S * 2, detail=3.0, rough=0.5)
    billow = g.add(g.mul(g.sub(n, 0.5), 1.8), g.mul(g.sub(n2, 0.5), 0.7))
    shape = g.add(g.sub(rad, d), g.mul(billow, rad))
    body = g.smooth(0.0, g.mul(rad, 0.25), shape)
    body = g.mul(body, g.smooth(dis, g.add(dis, 0.2), g.add(n, 0.25)))
    depth = g.smooth(0.0, g.mul(rad, 0.35), shape)            # deep inside = hot core
    heat = g.clamp01(g.mul(g.pow(depth, 0.8), hot))
    col = g.ramp(heat, [
        (0.00, (0.30, 0.02, 0.00, 1)),
        (0.35, (1.00, 0.18, 0.01, 1)),
        (0.70, (1.00, 0.42, 0.06, 1)),
        (1.00, (1.00, 0.80, 0.45, 1)),
    ])
    emit = g.mul(g.mul(g.pow(heat, 1.8), 16.0), fade)
    dens = g.mul(g.mul(body, g.add(g.mul(smoke, 7.0), 0.5)), fade)
    g.vol_out(density=dens, color=(0.06, 0.055, 0.05, 1), emit_color=col, emit_strength=emit)

    def eo(t, p):
        return 1 - (1 - t) ** p

    def set_frame(i):
        t = i / (a.frames - 1)
        R = (1.1 if big else 0.62)
        g.set('rad', 0.3 * R + 0.7 * R * eo(min(1.0, t * 1.4), 4.0) + 0.25 * R * t)
        g.set('cz', (0.55 if big else 0.4) * R + (1.1 if big else 0.5) * t ** 1.3)
        g.set('w', t * 1.4)
        g.set('hot', 1.4 * (1 - t) ** (2.0 if big else 1.6))
        g.set('fade', 1.0 - max(0.0, (t - 0.6) / 0.4) ** 1.5)   # thin out over the last 40%, ends empty
        g.set('smoke', min(1.0, 1.6 * t ** 1.2) * (1 - t) ** 0.5)
        g.set('dis', 0.05 + 0.85 * t ** 2.2)
    meta_method = 'B procedural volume (expanding noise fireball, heat -> smoke)'

fx.run(a, {
    'id': 'explosion' if big else 'fire_burst', 'kind': 'emissive+smoke', 'loop': False,
    'fps': a.frames / DUR, 'blend': 'premultiplied', 'grid': [8, 8] if big else [6, 6],
    'mv': False, 'tint': False, 'method': meta_method,
    'pivot': [0.5, 0.03], 'worldSize': [S, S],
    'notes': 'RGB = premultiplied emission + dark smoke lit by a fixed top-left key; A = occlusion.',
}, set_frame)
