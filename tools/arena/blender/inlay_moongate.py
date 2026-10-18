"""Moon Gate inlay: the engraved ritual circle of ref-3 (arena art plan 3.1 / 5.7, milestone A2).

Spec (plan 3.1): engraved stone (not metal), 4 rings + a rune band, r 2.5-7 m, centred on the duel.
Pattern (all grooves, generated in Python as signed-distance primitives, deterministic from --seed):
  ring r 2.5 (8 cm) | rune band r 3.0-3.9 between two thin rings (4 cm), 40 angular runes (staves + branches)
  | 16 radial spokes r 3.95-5.55 | ring r 5.6 (6 cm) | 8 crescent moons at r 6.3 | double outer ring r 7.0 / 7.16
  | a thin centre ring r 0.9. Worn: depth varies, some strokes broken, chipped edges.
Blender (Cycles; GPU when --device ONEAPI finds the iGPU): the height field displaces a --grid^2 plane over the
16 m disc (the high), and NORMAL (OpenGL tangent) + AO are baked onto a flat 16 m plane (the low).

Textures (2048 over 16 m = 7.8 mm/px, plan 5.7), blended over the flagstones by src/render/arena/floor.ts:
  baseColor  albedo MULTIPLIER (sRGB-encoded linear factor): grime in the grooves, 1 elsewhere
  normal     baked OpenGL normal (flat outside the pattern)
  orm        R = baked AO, G = roughness hint (grooves rougher), B = GROOVE MASK (0..1; water collects there).
             For metal inlays (later themes) B is the metal mask; ThemeArt.floor.inlayStyle says which.
GLB carrier: KIT_inlay_moongate {id, role 'texset', kind 'inlay', sizeM, style 'engraved'} > TEXSET quad.
Run:  npm run arena:bake -- inlay_moongate
"""
import json
import math
import os
import sys

import bpy
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import abake  # noqa: E402


def extra(ap):
    ap.add_argument('--name', default='inlay_moongate')
    ap.add_argument('--size-m', type=float, default=16.0, help='square covered by the textures (m)')
    ap.add_argument('--px', type=int, default=2048)
    ap.add_argument('--grid', type=int, default=1280, help='displaced vertices per edge of the high')
    ap.add_argument('--ao-samples', type=int, default=96)
    ap.add_argument('--device', default='ONEAPI')
    ap.add_argument('--seed', type=int, default=3)
    ap.add_argument('--depth', type=float, default=0.012, help='nominal groove depth (m)')
    ap.add_argument('--preview', type=int, default=640)


job = abake.Job(extra, __doc__)
a = job.a
S = {}
N = a.px
SZ = a.size_m


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def fourier_noise(n, kmax, count, beta, seed):
    r = np.random.default_rng(seed)
    t = (np.arange(n, dtype=np.float32) + 0.5) / n
    x, y = np.meshgrid(t, t)
    acc = np.zeros((n, n), dtype=np.float32)
    for _ in range(count):
        kx, ky = r.integers(-kmax, kmax + 1, 2)
        if kx == 0 and ky == 0:
            continue
        acc += (1.0 / (math.hypot(kx, ky) ** beta)) * np.cos(2 * np.pi * (kx * x + ky * y) + r.uniform(0, 2 * np.pi)).astype(np.float32)
    acc -= acc.min()
    return acc / max(1e-6, acc.max())


def upsample(a2, n):
    m = a2.shape[0]
    t = (np.arange(n, dtype=np.float32) + 0.5) * m / n - 0.5
    i0 = np.clip(np.floor(t).astype(np.int64), 0, m - 1)
    f = np.clip(t - i0, 0, 1).astype(np.float32)
    i1 = np.clip(i0 + 1, 0, m - 1)
    rows = a2[i0] * (1 - f)[:, None] + a2[i1] * f[:, None]
    return rows[:, i0] * (1 - f)[None, :] + rows[:, i1] * f[None, :]


def to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def save_np(rgb, path, non_color=True, float_buffer=False, save=True):
    h, w = rgb.shape[:2]
    im = bpy.data.images.new(os.path.basename(path), w, h, alpha=False, float_buffer=float_buffer)
    if non_color:
        im.colorspace_settings.name = 'Non-Color'
    px = np.ones((h, w, 4), dtype=np.float32)
    px[..., :rgb.shape[2]] = rgb
    im.pixels.foreach_set(px.ravel())
    im.filepath_raw = path
    im.file_format = 'PNG'
    if save:
        im.save()
    return im


# ---------------------------------------------------------------------------- the pattern

# rune templates in glyph space: u across (-1..1), v along the radius (-1..1); segments (u0, v0, u1, v1).
# Futhark-like: a stave plus branches. Hand-made shapes, then picked by the seed.
RUNES = [
    [(0, -1, 0, 1), (0, 1, 0.8, 0.45), (0, 0.4, 0.8, -0.1)],            # fehu-like
    [(0, -1, 0, 1), (0, 1, 0.75, 0.3), (0.75, 0.3, 0.75, -1)],          # uruz
    [(0, -1, 0, 1), (0, 0.55, 0.65, 0), (0.65, 0, 0, -0.55)],           # thurisaz
    [(0, -1, 0, 1), (0, 1, 0.7, 0.5), (0, 0.3, 0.7, -0.2)],             # ansuz
    [(-0.6, -1, -0.6, 1), (-0.6, 1, 0.6, 0.5), (0.6, 0.5, -0.6, 0), (-0.6, 0, 0.6, -1)],  # raido
    [(0.6, 1, -0.4, 0), (-0.4, 0, 0.6, -1)],                             # kaunan
    [(-0.7, 1, 0.7, -1), (0.7, 1, -0.7, -1)],                            # gebo
    [(-0.6, -1, -0.6, 1), (0.6, -1, 0.6, 1), (-0.6, 0.5, 0.6, 0.0)],    # haglaz
    [(0, -1, 0, 1), (-0.6, 0.3, 0.6, -0.3)],                             # naudiz
    [(0, -1, 0, 1)],                                                     # isaz
    [(0, -1, 0, 1), (-0.6, 0.2, 0, 0.6), (0, -0.6, 0.6, -0.2)],         # jera
    [(0, -1, 0, 1), (0, 1, 0.6, 0.6), (0, -1, -0.6, -0.6)],             # eihwaz
    [(-0.7, 1, -0.7, -1), (0.7, 1, 0.7, -1), (-0.7, 1, 0, 0.3), (0, 0.3, 0.7, 1)],  # perth-like
    [(0, -1, 0, 1), (0, 0.2, -0.7, 0.9), (0, 0.2, 0.7, 0.9)],           # algiz
    [(-0.5, 1, 0.5, 0.35), (0.5, 0.35, -0.5, -0.3), (-0.5, -0.3, 0.5, -1)],  # sowilo
    [(0, -1, 0, 1), (0, 1, -0.6, 0.45), (0, 1, 0.6, 0.45)],             # tiwaz
    [(-0.6, -1, -0.6, 1), (-0.6, 1, 0.6, 0.5), (0.6, 0.5, -0.6, 0), (-0.6, 0, 0.6, -0.5), (0.6, -0.5, -0.6, -1)],  # berkanan
    [(-0.7, -1, -0.7, 1), (0.7, -1, 0.7, 1), (-0.7, 1, 0.7, 0.2), (0.7, 1, -0.7, 0.2)],  # mannaz
    [(0, 1, -0.6, 0.0), (-0.6, 0.0, 0.6, -0.7), (0, 1, 0.6, 0.0), (0.6, 0.0, -0.6, -0.7)],  # ingwaz-ish
    [(-0.7, 1, 0.7, -1), (0.7, 1, -0.7, -1), (-0.7, 1, -0.7, -1), (0.7, 1, 0.7, -1)],  # dagaz
]


def pattern():
    """height field (m, <= 0) of the engravings + the groove mask"""
    c = ((np.arange(N, dtype=np.float32) + 0.5) / N - 0.5) * SZ
    X, Y = np.meshgrid(c, c)  # row 0 = bottom (Blender), Y = Blender +y = three -z
    R = np.hypot(X, Y)
    A = np.arctan2(Y, X)
    depth = np.zeros((N, N), dtype=np.float32)  # groove depth (positive)
    px = SZ / N
    chip = (upsample(fourier_noise(512, 60, 120, 0.4, a.seed + 1), N) - 0.5) * 0.012  # edge chipping (m)
    wear = 0.6 + 0.4 * upsample(fourier_noise(256, 10, 40, 0.8, a.seed + 2), N)
    breaks = smoothstep(0.12, 0.22, upsample(fourier_noise(256, 14, 60, 0.7, a.seed + 4), N))

    def groove(dist, w, d):
        """V groove with a flat-ish bottom: dist = distance to the centre line (m)"""
        t = np.clip((dist + chip) / (w * 0.5), 0, 1)
        prof = smoothstep(1.0, 0.45, t)
        np.maximum(depth, d * prof, out=depth)

    D = a.depth
    for r0, w, d in [(0.9, 0.04, 0.6), (2.5, 0.08, 1.0), (3.0, 0.04, 0.8), (3.9, 0.04, 0.8), (5.6, 0.06, 1.0), (7.0, 0.10, 1.0), (7.16, 0.035, 0.7)]:
        groove(np.abs(R - r0), w, D * d)
    # 16 radial spokes between the band and the r 5.6 ring (polar distance to the spoke line)
    band = (R > 3.95) & (R < 5.55)
    for k in range(16):
        ang = k * math.pi / 8 + math.pi / 16
        dx, dy = math.cos(ang), math.sin(ang)
        along = X * dx + Y * dy
        perp = np.abs(-X * dy + Y * dx)
        dist = np.where(band & (along > 0), perp, 9.0)
        groove(dist, 0.035, D * 0.7)
    # runes in the band: local glyph frames, segments evaluated in a window around each glyph
    rr = np.random.default_rng(a.seed)
    n_r = 40
    rc = 3.45
    gh, gw = 0.30, 0.17  # half height (radial), half width (tangential) in m
    win = int(0.45 / px) + 2
    for k in range(n_r):
        ang = 2 * math.pi * k / n_r
        cx, cy = rc * math.cos(ang), rc * math.sin(ang)
        er = (math.cos(ang), math.sin(ang))
        et = (-math.sin(ang), math.cos(ang))
        ci = int((cy / SZ + 0.5) * N)
        cj = int((cx / SZ + 0.5) * N)
        i0, i1, j0, j1 = max(0, ci - win), min(N, ci + win), max(0, cj - win), min(N, cj + win)
        x = X[i0:i1, j0:j1] - cx
        y = Y[i0:i1, j0:j1] - cy
        u = (x * et[0] + y * et[1]) / gw
        v = (x * er[0] + y * er[1]) / gh
        dmin = np.full(u.shape, 9.0, dtype=np.float32)
        for (u0, v0, u1, v1) in RUNES[int(rr.integers(0, len(RUNES)))]:
            # segment distance in metres (glyph space is anisotropic: scale back)
            ax, ay = u0 * gw, v0 * gh
            bx, by = u1 * gw, v1 * gh
            px_, py_ = u * gw, v * gh
            vx, vy = bx - ax, by - ay
            L2 = max(1e-9, vx * vx + vy * vy)
            t = np.clip(((px_ - ax) * vx + (py_ - ay) * vy) / L2, 0, 1)
            dmin = np.minimum(dmin, np.hypot(px_ - ax - t * vx, py_ - ay - t * vy))
        sub = depth[i0:i1, j0:j1]
        t = np.clip((dmin + chip[i0:i1, j0:j1]) / 0.0175, 0, 1)
        np.maximum(sub, D * 0.75 * smoothstep(1.0, 0.45, t), out=sub)
    # 8 crescent moons at r 6.3 (outline grooves of disc(c1, 0.32) minus disc(c2, 0.27)), shallow fill
    for k in range(8):
        ang = 2 * math.pi * k / 8
        cx, cy = 6.3 * math.cos(ang), 6.3 * math.sin(ang)
        ox, oy = 0.13 * math.cos(ang + math.pi / 2), 0.13 * math.sin(ang + math.pi / 2)
        d1 = np.hypot(X - cx, Y - cy) - 0.32
        d2 = np.hypot(X - cx - ox, Y - cy - oy) - 0.27
        sdf = np.maximum(d1, -d2)
        groove(np.abs(sdf), 0.035, D * 0.8)
        np.maximum(depth, np.where(sdf < 0, D * 0.25, 0).astype(np.float32), out=depth)
        # a small dot beside each crescent
        groove(np.hypot(X - 6.3 * math.cos(ang + 0.19), Y - 6.3 * math.sin(ang + 0.19)), 0.07, D * 0.6)
    depth *= wear * breaks
    S['depth'] = depth.astype(np.float32)
    S['mask'] = np.clip(depth / (D * 0.5), 0, 1).astype(np.float32)
    return {'grooveShare': float((S['mask'] > 0.5).mean()), 'maxDepthM': float(depth.max())}


def build_high():
    abake.reset()
    S['dev'] = abake.cycles_device(a.device, a.threads)
    rng = a.depth * 1.6
    hval = 1 - np.clip(S['depth'] / rng, 0, 1)
    him = save_np(np.repeat(hval[..., None], 3, -1), os.path.join(job.out, 'h.png'), float_buffer=True, save=False)
    tex = bpy.data.textures.new('h', 'IMAGE')
    tex.image = him
    tex.extension = 'EXTEND'
    bpy.ops.mesh.primitive_grid_add(x_subdivisions=a.grid, y_subdivisions=a.grid, size=SZ)
    hi = bpy.context.active_object
    hi.name = 'high'
    me = hi.data
    co = np.empty(len(me.vertices) * 3, dtype=np.float32)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    vi = np.empty(len(me.loops), dtype=np.int64)
    me.loops.foreach_get('vertex_index', vi)
    me.uv_layers.active.data.foreach_set('uv', ((co[vi, :2] / SZ) + 0.5).astype(np.float32).ravel())
    d = hi.modifiers.new('disp', 'DISPLACE')
    d.texture = tex
    d.texture_coords = 'UV'
    d.mid_level = 1.0
    d.strength = rng
    hi.data.materials.append(bpy.data.materials.new('hi'))
    bpy.ops.mesh.primitive_plane_add(size=SZ)
    lo = bpy.context.active_object
    lo.name = 'low'
    mat = bpy.data.materials.new('bake')
    mat.use_nodes = True
    lo.data.materials.append(mat)
    S['hi'], S['lo'] = hi, lo
    return {'highTris': abake.tri_count(hi), 'device': S['dev']}


def bake():
    s = bpy.context.scene
    s.render.bake.max_ray_distance = a.depth * 6
    r = abake.bake_maps(S['lo'], S['hi'], ['NORMAL', 'AO'], a.px, job.out, samples=a.ao_samples, extrusion=a.depth * 3, margin=0, prefix=a.name)
    S['bakes'] = r
    return r


def compose():
    def load(p):
        im = bpy.data.images.load(p, check_existing=False)
        im.colorspace_settings.name = 'Non-Color'
        px = np.empty(N * N * 4, dtype=np.float32)
        im.pixels.foreach_get(px)
        bpy.data.images.remove(im)
        return px.reshape(N, N, 4)
    ao = np.clip(load(S['bakes']['AO']['path'])[..., 0], 0, 1)
    nrm = load(S['bakes']['NORMAL']['path'])[..., :3]
    m = S['mask']
    grime = 1 - 0.42 * m * (0.8 + 0.2 * upsample(fourier_noise(128, 12, 30, 0.8, a.seed + 8), N))
    mult = grime * (0.6 + 0.4 * ao)
    out = {'baseColor': f'{a.name}_basecolor.png', 'normal': f'{a.name}_normal.png', 'orm': f'{a.name}_orm.png'}
    save_np(np.repeat(to_srgb(mult)[..., None], 3, -1), os.path.join(job.out, out['baseColor']), non_color=False)
    # outside the disc the baked normal is flat already; renormalise
    n = nrm * 2 - 1
    n /= np.maximum(1e-6, np.linalg.norm(n, axis=-1, keepdims=True))
    save_np(n * 0.5 + 0.5, os.path.join(job.out, out['normal']))
    save_np(np.stack([ao, 0.55 + 0.35 * m, m], -1), os.path.join(job.out, out['orm']))
    S['maps'] = out
    return {**out, 'aoMeanInGrooves': float(ao[m > 0.5].mean()) if (m > 0.5).any() else None}


def export():
    abake.reset()
    mname = f'floor_{a.name}'
    mat = bpy.data.materials.new(mname)
    mat.use_nodes = True
    bpy.ops.mesh.primitive_plane_add(size=1.0)
    q = bpy.context.active_object
    q.name = 'TEXSET'
    q.data.materials.append(mat)
    root = abake.empty(f'KIT_{a.name}', id=f'floor/{a.name}', role='texset', kind='inlay', sizeM=SZ, style='engraved')
    q.parent = root
    glb = abake.export_glb(os.path.join(job.out, f'{a.name}_raw.glb'), objects=[root, q])
    asset = {
        'id': f'floor/{a.name}', 'glb': os.path.basename(glb['path']), 'role': 'texset', 'kind': 'inlay',
        'texset': {'sizeM': SZ, 'px': a.px, 'style': 'engraved', 'channels': {'baseColor': 'albedo multiplier', 'orm': 'R occlusion, G roughness hint, B groove mask'}},
        'lods': {'LOD0': {'materials': [mname]}, 'LOD1': {'materials': [mname], 'ownTextures': False}},
        'materials': {mname: {**S['maps'], 'metallicFactor': 0.0, 'roughnessFactor': 1.0}},
        'sources': [],
        'job': os.path.basename(job.out),
    }
    with open(os.path.join(job.out, 'asset.json'), 'w', encoding='utf-8') as f:
        json.dump(asset, f, indent=1)
    return {'glb': glb}


def preview():
    """Cycles still: the displaced high under a grazing moon, for the README"""
    if not a.preview:
        return 'skipped'
    abake.reset()
    dev = abake.cycles_device(a.device, a.threads)
    s = bpy.context.scene
    s.cycles.samples = 32
    s.render.resolution_x = a.preview * 2
    s.render.resolution_y = a.preview
    rng = a.depth * 1.6
    hval = 1 - np.clip(S['depth'] / rng, 0, 1)
    him = save_np(np.repeat(hval[..., None], 3, -1), os.path.join(job.out, 'h.png'), float_buffer=True, save=False)
    tex = bpy.data.textures.new('h', 'IMAGE')
    tex.image = him
    tex.extension = 'EXTEND'
    bpy.ops.mesh.primitive_grid_add(x_subdivisions=900, y_subdivisions=900, size=SZ)
    hi = bpy.context.active_object
    me = hi.data
    co = np.empty(len(me.vertices) * 3, dtype=np.float32)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    vi = np.empty(len(me.loops), dtype=np.int64)
    me.loops.foreach_get('vertex_index', vi)
    me.uv_layers.active.data.foreach_set('uv', ((co[vi, :2] / SZ) + 0.5).astype(np.float32).ravel())
    d = hi.modifiers.new('disp', 'DISPLACE')
    d.texture = tex
    d.texture_coords = 'UV'
    d.mid_level = 1.0
    d.strength = rng
    mat = bpy.data.materials.new('stone')
    mat.use_nodes = True
    b = next(n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    b.inputs['Base Color'].default_value = (0.09, 0.1, 0.12, 1)
    b.inputs['Roughness'].default_value = 0.25
    hi.data.materials.append(mat)
    w = bpy.data.worlds.new('w')
    s.world = w
    w.use_nodes = True
    w.node_tree.nodes['Background'].inputs['Color'].default_value = (0.03, 0.035, 0.08, 1)
    sd = bpy.data.lights.new('moon', 'SUN')
    sd.energy = 2.0
    sd.color = (0.8, 0.82, 1.0)
    so = bpy.data.objects.new('moon', sd)
    s.collection.objects.link(so)
    so.rotation_euler = (math.radians(-70), 0, math.radians(20))
    cd = bpy.data.cameras.new('cam')
    cd.lens = 24
    cam = bpy.data.objects.new('cam', cd)
    s.collection.objects.link(cam)
    cam.location = (0, -10.5, 2.2)
    cam.rotation_euler = (math.radians(77), 0, 0)
    s.camera = cam
    abake.image_settings('PNG', '8', 'RGB')
    s.view_settings.view_transform = 'AgX'
    return {'path': abake.render_still(os.path.join(job.out, f'{a.name}_preview.png')), 'device': dev.get('used')}


job.step('pattern', pattern)
job.step('build_high', build_high)
job.step('bake', bake)
job.step('compose', compose)
job.step('export', export)
job.step('preview', preview)
fails = [r['step'] for r in job.steps if not r['ok']]
job.result['failed'] = fails
job.done()
if fails:
    sys.exit(1)
