"""A6 backdrop panorama renderer (arena art plan 5.6, milestone A6). Blender 5.0, bpy + numpy.

  blender -b --factory-startup -P tools/arena/blender/backdrop_pano.py -- --out tools/arena/_bake/<job> \
      --scene moongate --mode preview|layers|inset|cards [--device ONEAPI] [--w 8192] [--samples 128] [--quick]
  (normally through the runner: npm run arena:bake -- a6)

Modes (one Blender process each, so memory is freed between them):
  preview  EEVEE slice preview of the whole scene (EEVEE has no panoramic camera, A0): 8 perspective slices of 45 deg,
           1024 x 1365, pitched to the layers' latitude band, stitched side by side -> preview_slices.jpg. About 1-2 min.
  layers   Cycles equirectangular camera at the arena centre, 1.6 m high, 360 deg longitude, latitude LAT_MIN..LAT_MAX
           (the height / width ratio sets the band: lat range = 360 * h / w). One VIEW LAYER per panorama layer (near,
           mid, far): the other layers' collections are excluded, film transparent (alpha per layer). Passes per layer
           through the 5.0 compositor File Output: Image (RGBA PNG), Depth (EXR float), AOV 'aov' (RGB PNG: R emission,
           G water, B cloud). Depth is saved as <layer>_depth.npy (float32, row 0 = the top latitude), radial distance
           from the camera in metres (checked against marker objects with --markers). The far layer renders at
           --far-scale of the width (clouds are soft).
  inset    the HERO INSET: a perspective render of the near layer from the ref-3 concept camera (conceptCams.ts),
           4096 x 2048, RGBA, mapped in game by projective texturing onto the near layer.
  cards    EEVEE volumetric card sequences for the game's fog / shaft cards (plan 5.6, 6.3): a moon light shaft and a
           drifting fog bank, 32 frames each, looped (noise phase on a circle), 256 px frames -> 8 x 4 atlas PNG.
Outputs (tools/arena/_bake/<job>/): <layer>_color.png, <layer>_aov.png, <layer>_depth.npy, inset_color.png,
card_<name>.png, preview_slices.jpg, backdrop_src.json (camera, latitude band, layers, inset camera), result.json.
tools/arena/build_backdrop.mjs (+ backdrop_post.py) turns them into public/arena/backdrop/<id>/.
"""
import glob
import json
import math
import os
import sys
import time

import bpy
import numpy as np
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import abake  # noqa: E402

LAT_MIN = -12.0
PANO_Y = 1.6  # camera height (game y), plan 5.6
# ref-3 concept camera (src/render/arena/conceptCams.ts, CALIBRATED block): game coordinates
REF3 = {'pos': [-7.5, 1.0, -0.3], 'yaw': -17.37, 'pitch': 6.94, 'vfov': 44.7, 'w': 1793, 'h': 877}


def extra(ap):
    ap.add_argument('--scene', default='moongate')
    ap.add_argument('--mode', default='layers', choices=['preview', 'layers', 'inset', 'cards'])
    ap.add_argument('--device', default='CPU')
    ap.add_argument('--w', type=int, default=8192)
    ap.add_argument('--h', type=int, default=1368)
    ap.add_argument('--samples', type=int, default=128)
    ap.add_argument('--far-scale', type=float, default=0.5)
    ap.add_argument('--far-samples', type=int, default=64)
    ap.add_argument('--strips', type=int, default=1, help='render near / mid as N longitude strips (memory)')
    ap.add_argument('--layers', default='near,mid,far')
    ap.add_argument('--inset-w', type=int, default=4096)
    ap.add_argument('--inset-h', type=int, default=2048)
    ap.add_argument('--tile', type=int, default=1024)
    ap.add_argument('--quick', action='store_true', help='small sizes and few samples (pipeline test)')
    ap.add_argument('--markers', action='store_true', help='add azimuth / distance marker posts (mapping check)')
    ap.add_argument('--no-clouds', action='store_true')
    ap.add_argument('--card-px', type=int, default=256)
    ap.add_argument('--frames', type=int, default=32)


job = abake.Job(extra, __doc__)
a = job.a
if a.quick:
    a.w, a.h, a.samples, a.far_samples = 1024, 172, 16, 8
    a.inset_w, a.inset_h = 1024, 512
LAT_MAX = LAT_MIN + 360.0 * a.h / a.w
scene_mod = __import__(f'backdrop_{a.scene}')


def bl(gx, gy, gz):
    return Vector((gx, -gz, gy))


def game_dir(yaw, pitch):
    y, p = math.radians(yaw), math.radians(pitch)
    return bl(math.cos(p) * math.cos(y), math.sin(p), math.cos(p) * math.sin(y))


def add_markers(coll):
    """thin emissive posts at known azimuths / distances (mapping and depth checks)"""
    m = scene_mod.mat_emit('marker', (0.2, 1.0, 0.2), 30.0, aov=(0, 0, 0))
    out = []
    for az, dist, h in ((0, 100, 40), (90, 100, 30), (-90, 100, 20), (180, 100, 10), (45, 50, 15)):
        d = scene_mod.az_dir(az)
        bpy.ops.mesh.primitive_cube_add(size=1, location=(d.x * dist, d.y * dist, h / 2))
        o = bpy.context.active_object
        o.scale = (1.0, 1.0, h)
        o.data.materials.append(m)
        for c in o.users_collection:
            c.objects.unlink(o)
        coll.objects.link(o)
        out.append({'az': az, 'dist': dist, 'h': h})
    return out


def build():
    sc = abake.reset()
    info = scene_mod.build({'seed': 3, 'quick': a.quick, 'clouds': not a.no_clouds})
    if a.markers:
        info['markers'] = add_markers(info['layers']['near'])
    job.info = info
    return {'objects': len(bpy.data.objects), 'fires': info.get('fires'), 'markers': info.get('markers')}


def cycles_setup(samples):
    sc = bpy.context.scene
    dev = abake.cycles_device(a.device, a.threads)
    sc.cycles.samples = samples
    sc.cycles.use_denoising = True
    try:
        sc.cycles.denoiser = 'OPENIMAGEDENOISE'
    except Exception:
        pass
    sc.cycles.tile_size = a.tile
    sc.cycles.max_bounces = 6
    sc.cycles.volume_bounces = 1
    sc.cycles.volume_step_rate = 4.0
    sc.render.film_transparent = True
    sc.view_settings.view_transform = 'Standard'
    sc.view_settings.look = 'None'
    sc.view_settings.exposure = 0.0
    return dev


def view_layers():
    """one view layer per panorama layer; other layers' collections excluded; lights everywhere"""
    sc = bpy.context.scene
    names = [n for n in ('near', 'mid', 'far')]
    base = sc.view_layers[0]
    base.name = names[0]
    for n in names[1:]:
        if n not in sc.view_layers:
            sc.view_layers.new(n)
    for vl in sc.view_layers:
        for lc in vl.layer_collection.children:
            lc.exclude = lc.name not in (f'L_{vl.name}', 'L_lights')
        vl.use_pass_z = True
        if 'aov' not in [x.name for x in vl.aovs]:
            ao = vl.aovs.add()
            ao.name = 'aov'
            ao.type = 'COLOR'
    return names


def comp_outputs(layer, prefix):
    """5.0 compositor: Render Layers(layer) -> three File Output nodes (PNG RGBA, EXR depth, PNG aov)"""
    sc = bpy.context.scene
    ng = bpy.data.node_groups.new(f'comp_{prefix}', 'CompositorNodeTree')
    sc.compositing_node_group = ng
    rl = ng.nodes.new('CompositorNodeRLayers')
    rl.layer = layer
    made = {}
    for item, fmt, mode, depth in (('Image', 'PNG', 'RGBA', '8'), ('Depth', 'OPEN_EXR', 'BW', '32'), ('aov', 'PNG', 'RGB', '8')):
        sock = rl.outputs.get(item)
        if sock is None:
            made[item] = 'missing'
            continue
        fo = ng.nodes.new('CompositorNodeOutputFile')
        fo.directory = job.out
        fo.file_name = f'{prefix}_{item}_'
        try:
            fo.format.media_type = 'IMAGE'
        except Exception:
            pass
        fo.format.file_format = fmt
        fo.format.color_mode = mode
        fo.format.color_depth = depth
        if fmt == 'OPEN_EXR':
            fo.format.exr_codec = 'ZIP'
        fo.file_output_items.clear()
        it = fo.file_output_items.new('FLOAT' if item == 'Depth' else 'RGBA', item)
        ng.links.new(sock, fo.inputs[it.name])
        made[item] = True
    try:
        go = ng.nodes.new('NodeGroupOutput')
        ng.interface.new_socket('Image', in_out='OUTPUT', socket_type='NodeSocketColor')
        ng.links.new(rl.outputs['Image'], go.inputs[0])
    except Exception as ex:
        abake.log('group output not wired:', ex)
    return made


def newest(pattern):
    fs = sorted(glob.glob(os.path.join(job.out, pattern)), key=os.path.getmtime)
    return fs[-1] if fs else None


def exr_to_np(path):
    img = bpy.data.images.load(path)
    w, h = img.size
    px = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(px)
    bpy.data.images.remove(img)
    return px.reshape(h, w, 4)[::-1, :, 0].copy()  # top row first


def render_layer(name, w, h, samples, strips=1):
    """render one panorama layer; `strips` > 1 renders it as vertical strips of 360 / strips deg longitude (smaller
    render buffers and OIDN images: the GPU job's peak RAM drops with the strip size); strip k covers azimuth
    -180 + k * 360 / strips .. (seams at -135 / -45 / 45 / 135 for 4 strips: the hero direction stays inside one).
    Colour / AOV strips are saved as <layer>_s<k>_color.png / _aov.png (backdrop_post.py stitches them); depth is
    stitched here into <layer>_depth.npy."""
    sc = bpy.context.scene
    for vl in sc.view_layers:
        vl.use = vl.name == name
    sw = w // strips
    sc.render.resolution_x, sc.render.resolution_y = sw, h
    sc.render.resolution_percentage = 100
    sc.cycles.samples = samples
    for f in glob.glob(os.path.join(job.out, f'L{name}_*')) + glob.glob(os.path.join(job.out, f'{name}_s*_*.png')) + glob.glob(os.path.join(job.out, f'{name}_color.png')) + glob.glob(os.path.join(job.out, f'{name}_aov.png')):
        os.remove(f)
    made = comp_outputs(name, f'L{name}')
    abake.image_settings('PNG', '8', 'RGBA')
    cam = sc.camera.data
    t = time.time()
    deps, strip_secs = [], []
    for k in range(strips):
        lo = -math.pi + 2 * math.pi * k / strips
        cam.longitude_min, cam.longitude_max = lo, lo + 2 * math.pi / strips
        ts = time.time()
        bpy.ops.render.render(write_still=False)
        strip_secs.append(round(time.time() - ts, 1))
        col = newest(f'L{name}_Image_*.png')
        aov = newest(f'L{name}_aov_*.png')
        dep = newest(f'L{name}_Depth_*.exr')
        tag = f'{name}_s{k}' if strips > 1 else name
        if col:
            os.replace(col, os.path.join(job.out, f'{tag}_color.png'))
        if aov:
            os.replace(aov, os.path.join(job.out, f'{tag}_aov.png'))
        if dep:
            deps.append(exr_to_np(dep))
            os.remove(dep)
        abake.log(f'{name} strip {k + 1}/{strips}: {strip_secs[-1]} s, peak {abake.peak_ram_mb():.0f} MB, free {abake.free_ram_mb():.0f} MB')
    cam.longitude_min, cam.longitude_max = -math.pi, math.pi
    secs = time.time() - t
    res = {'seconds': round(secs, 1), 'stripSeconds': strip_secs, 'strips': strips, 'size': [w, h], 'samples': samples, 'outputs': made}
    if deps:
        d = np.concatenate(deps, axis=1)
        np.save(os.path.join(job.out, f'{name}_depth.npy'), d)
        valid = d[d < 1e8]
        res['depth'] = {'valid': round(float(valid.size) / d.size, 3), 'min': round(float(valid.min()), 2) if valid.size else None,
                        'p50': round(float(np.median(valid)), 2) if valid.size else None, 'max': round(float(valid.max()), 2) if valid.size else None}
        if a.markers and name == 'near':
            res['markerCheck'] = marker_check(d, w, h)
    res['files'] = sorted(f for f in os.listdir(job.out) if f.startswith(name + '_'))
    return res


def marker_check(d, w, h):
    """where each marker post lands in the panorama (column -> azimuth under the assumed mapping) and its depth"""
    out = []
    for m in job.info.get('markers', []):
        # measured mapping: u = 0.5 + az / 360
        row = int((LAT_MAX - 2.0) / (LAT_MAX - LAT_MIN) * h)  # 2 deg above the horizon (posts are >= 10 m high)
        row = min(h - 1, max(0, row))
        line = d[row]
        hits = np.where(np.abs(line - m['dist']) < m['dist'] * 0.03)[0]
        cols = [int(c) for c in hits]
        out.append({'az': m['az'], 'dist': m['dist'], 'cols': [cols[0], cols[-1]] if cols else None,
                    'u': round((cols[0] + cols[-1]) / 2 / w, 4) if cols else None,
                    'depthAtHit': round(float(line[(cols[0] + cols[-1]) // 2]), 2) if cols else None})
    return out


def do_layers():
    dev = cycles_setup(a.samples)
    names = view_layers()
    want = a.layers.split(',')
    out = {'device': dev, 'layers': {}}
    for n in names:
        if n not in want:
            continue
        sc = 1.0 if n != 'far' else a.far_scale
        w, h = int(a.w * sc) // 4 * 4, int(a.h * sc) // 4 * 4
        out['layers'][n] = job.step(f'render_{n}', render_layer, n, w, h, a.samples if n != 'far' else a.far_samples, a.strips if n != 'far' else 1)
    return out


def camera_from_game(pos, yaw, pitch, vfov, w, h, name='inset'):
    cd = bpy.data.cameras.new(name)
    cd.sensor_fit = 'VERTICAL'
    cd.angle_y = math.radians(vfov)
    cd.clip_start = 0.5
    cd.clip_end = 5000
    cam = bpy.data.objects.new(name, cd)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = bl(*pos)
    f = game_dir(yaw, pitch)
    cam.rotation_euler = f.to_track_quat('-Z', 'Y').to_euler()
    bpy.context.scene.camera = cam
    return cam


def do_inset():
    """near layer from the ref-3 concept camera, wider than the concept frame (2:1, vertical FOV for its full width)"""
    sc = bpy.context.scene
    dev = cycles_setup(a.samples)
    view_layers()
    hf = 2 * math.degrees(math.atan(math.tan(math.radians(REF3['vfov'] / 2)) * REF3['w'] / REF3['h']))
    aspect = a.inset_w / a.inset_h
    vfov = 2 * math.degrees(math.atan(math.tan(math.radians(hf / 2 + 1.0)) / aspect))
    camera_from_game(REF3['pos'], REF3['yaw'], REF3['pitch'], vfov, a.inset_w, a.inset_h)
    for vl in sc.view_layers:
        vl.use = vl.name == 'near'
    sc.render.resolution_x, sc.render.resolution_y = a.inset_w, a.inset_h
    sc.render.resolution_percentage = 100
    for f in glob.glob(os.path.join(job.out, 'Linset_*')):
        os.remove(f)
    comp_outputs('near', 'Linset')
    t = time.time()
    bpy.ops.render.render(write_still=False)
    col = newest('Linset_Image_*.png')
    if col:
        os.replace(col, os.path.join(job.out, 'inset_color.png'))
    for f in glob.glob(os.path.join(job.out, 'Linset_*')):
        os.remove(f)
    return {'device': dev, 'seconds': round(time.time() - t, 1), 'camera': {'pos': REF3['pos'], 'yaw': REF3['yaw'], 'pitch': REF3['pitch'], 'vfov': round(vfov, 3), 'aspect': aspect},
            'size': [a.inset_w, a.inset_h]}


def do_preview():
    """EEVEE perspective slices (no panoramic camera in EEVEE): 8 x 45 deg, stitched"""
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE'
    sc.eevee.taa_render_samples = 32 if not a.quick else 8
    try:
        sc.eevee.volumetric_end = 2500
        sc.eevee.volumetric_tile_size = '8'
    except Exception as ex:
        abake.log('eevee volume settings:', ex)
    sc.render.film_transparent = False
    sc.view_settings.view_transform = 'Standard'
    vl = sc.view_layers[0]
    for lc in vl.layer_collection.children:
        lc.exclude = False
    sw, sh = (1024, 1365) if not a.quick else (256, 341)
    sc.render.resolution_x, sc.render.resolution_y = sw, sh
    sc.render.resolution_percentage = 100
    abake.image_settings('PNG', '8', 'RGB')
    vfov = 2 * math.degrees(math.atan(math.tan(math.radians(22.5)) * sh / sw))
    mid = (LAT_MIN + LAT_MAX) / 2
    paths, times = [], []
    for i in range(8):
        az = -i * 45.0  # slice 0 centred on azimuth 0
        camera_from_game([0, PANO_Y, 0], az, mid, vfov, sw, sh, f'slice{i}')
        p = os.path.join(job.out, f'_slice{i}.png')
        t = time.time()
        abake.render_still(p)
        times.append(round(time.time() - t, 1))
        paths.append(p)
    # stitch (numpy via Blender images), left to right = increasing azimuth to the left ... keep simple: as rendered
    imgs = []
    for p in paths:
        im = bpy.data.images.load(p)
        px = np.empty(sw * sh * 4, np.float32)
        im.pixels.foreach_get(px)
        imgs.append(px.reshape(sh, sw, 4))
        bpy.data.images.remove(im)
    # slice i looks at azimuth -45 i; laid out left to right with increasing azimuth (a camera's screen right is +az)
    order = [4, 3, 2, 1, 0, 7, 6, 5]  # az -180, -135, -90, -45, 0, +45, +90, +135 (screen right = +az)
    strip = np.concatenate([imgs[k] for k in order], axis=1)
    out = bpy.data.images.new('strip', strip.shape[1], strip.shape[0], alpha=False)
    out.pixels.foreach_set(strip.ravel())
    out.filepath_raw = os.path.join(job.out, 'preview_slices.png')
    out.file_format = 'PNG'
    out.save()
    for p in paths:
        os.remove(p)
    return {'sliceSeconds': times, 'slice': [sw, sh], 'vfov': round(vfov, 2), 'pitch': round(mid, 2), 'order_az': [-180, -135, -90, -45, 0, 45, 90, 135]}


def do_cards():
    """EEVEE volumetric card sequences: 'shaft' (a moon light shaft through haze, seen from the side) and 'fogbank'
    (a drifting ground-fog bank), each 32 frames looped (4D noise W on a circle) -> 8 x 4 atlas, alpha from the
    volume's coverage (rendered white-on-black emission + absorption so the game can tint it)"""
    res = {}
    for kind in ('shaft', 'fogbank'):
        abake.reset()
        sc = bpy.context.scene
        sc.render.engine = 'BLENDER_EEVEE'
        sc.eevee.taa_render_samples = 16
        try:
            sc.eevee.volumetric_tile_size = '2'
            sc.eevee.volumetric_samples = 64
            sc.eevee.volumetric_end = 50
        except Exception:
            pass
        sc.render.film_transparent = True
        sc.view_settings.view_transform = 'Standard'
        px = a.card_px if not a.quick else 64
        sc.render.resolution_x = sc.render.resolution_y = px
        w = bpy.data.worlds.new('w')
        w.use_nodes = True
        w.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.0
        sc.world = w
        # camera looking along +Y at a 10 x 10 m frame
        cd = bpy.data.cameras.new('c')
        cd.type = 'ORTHO'
        cd.ortho_scale = 10
        cam = bpy.data.objects.new('c', cd)
        sc.collection.objects.link(cam)
        cam.location = (0, -20, 5)
        cam.rotation_euler = (math.radians(90), 0, 0)
        sc.camera = cam
        bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 5))
        vol = bpy.context.active_object
        vol.scale = (10, 4, 10)
        m = bpy.data.materials.new('v')
        m.use_nodes = True
        nt = m.node_tree
        N, L = nt.nodes, nt.links
        N.clear()
        out = N.new('ShaderNodeOutputMaterial')
        em = N.new('ShaderNodeEmission')
        em.inputs['Color'].default_value = (1, 1, 1, 1)
        ab = N.new('ShaderNodeVolumeAbsorption')
        ab.inputs['Color'].default_value = (0, 0, 0, 1)
        add = N.new('ShaderNodeAddShader')
        L.new(em.outputs[0], add.inputs[0])
        L.new(ab.outputs[0], add.inputs[1])
        L.new(add.outputs[0], out.inputs['Volume'])
        tc = N.new('ShaderNodeTexCoord')
        sep = N.new('ShaderNodeSeparateXYZ')
        L.new(tc.outputs['Generated'], sep.inputs[0])
        nz = N.new('ShaderNodeTexNoise')
        nz.noise_dimensions = '4D'
        nz.inputs['Detail'].default_value = 6
        nz.inputs['Roughness'].default_value = 0.6
        mp = N.new('ShaderNodeMapping')
        L.new(tc.outputs['Generated'], mp.inputs['Vector'])
        L.new(mp.outputs['Vector'], nz.inputs['Vector'])
        shape = N.new('ShaderNodeMath')
        if kind == 'shaft':
            # a vertical beam: gaussian across x, fading at both ends, streaky noise stretched along the beam
            mp.inputs['Scale'].default_value = (3.0, 3.0, 0.6)
            nz.inputs['Scale'].default_value = 4.0
            cx = N.new('ShaderNodeMath')
            cx.operation = 'SUBTRACT'
            L.new(sep.outputs['X'], cx.inputs[0])
            cx.inputs[1].default_value = 0.5
            g = N.new('ShaderNodeMath')
            g.operation = 'MULTIPLY'
            L.new(cx.outputs[0], g.inputs[0])
            L.new(cx.outputs[0], g.inputs[1])
            g2 = N.new('ShaderNodeMath')
            g2.operation = 'MULTIPLY'
            L.new(g.outputs[0], g2.inputs[0])
            g2.inputs[1].default_value = -40.0
            ex = N.new('ShaderNodeMath')
            ex.operation = 'EXPONENT'
            L.new(g2.outputs[0], ex.inputs[0])
            ends = N.new('ShaderNodeMapRange')
            ends.interpolation_type = 'SMOOTHSTEP'
            ends.inputs['From Min'].default_value = 0.0
            ends.inputs['From Max'].default_value = 0.25
            L.new(sep.outputs['Z'], ends.inputs['Value'])
            ends2 = N.new('ShaderNodeMapRange')
            ends2.interpolation_type = 'SMOOTHSTEP'
            ends2.inputs['From Min'].default_value = 1.0
            ends2.inputs['From Max'].default_value = 0.7
            L.new(sep.outputs['Z'], ends2.inputs['Value'])
            m1 = N.new('ShaderNodeMath')
            m1.operation = 'MULTIPLY'
            L.new(ex.outputs[0], m1.inputs[0])
            L.new(ends.outputs['Result'], m1.inputs[1])
            m2 = N.new('ShaderNodeMath')
            m2.operation = 'MULTIPLY'
            L.new(m1.outputs[0], m2.inputs[0])
            L.new(ends2.outputs['Result'], m2.inputs[1])
            base = m2.outputs[0]
        else:
            # a fog bank: dense at the bottom, ragged top edge, soft sides
            mp.inputs['Scale'].default_value = (1.6, 1.6, 2.2)
            nz.inputs['Scale'].default_value = 3.0
            top = N.new('ShaderNodeMapRange')
            top.interpolation_type = 'SMOOTHSTEP'
            top.inputs['From Min'].default_value = 0.75
            top.inputs['From Max'].default_value = 0.1
            L.new(sep.outputs['Z'], top.inputs['Value'])
            sx = N.new('ShaderNodeMath')
            sx.operation = 'PINGPONG'
            L.new(sep.outputs['X'], sx.inputs[0])
            sx.inputs[1].default_value = 0.5
            side = N.new('ShaderNodeMapRange')
            side.interpolation_type = 'SMOOTHSTEP'
            side.inputs['From Min'].default_value = 0.0
            side.inputs['From Max'].default_value = 0.25
            L.new(sx.outputs[0], side.inputs['Value'])
            m1 = N.new('ShaderNodeMath')
            m1.operation = 'MULTIPLY'
            L.new(top.outputs['Result'], m1.inputs[0])
            L.new(side.outputs['Result'], m1.inputs[1])
            base = m1.outputs[0]
        nshape = N.new('ShaderNodeMapRange')
        nshape.inputs['From Min'].default_value = 0.35
        nshape.inputs['From Max'].default_value = 0.75
        L.new(nz.outputs['Fac'], nshape.inputs['Value'])
        dens = N.new('ShaderNodeMath')
        dens.operation = 'MULTIPLY'
        L.new(base, dens.inputs[0])
        L.new(nshape.outputs['Result'], dens.inputs[1])
        dk = N.new('ShaderNodeMath')
        dk.operation = 'MULTIPLY'
        L.new(dens.outputs[0], dk.inputs[0])
        dk.inputs[1].default_value = 0.35 if kind == 'shaft' else 0.6
        L.new(dk.outputs[0], em.inputs['Strength'])
        L.new(dk.outputs[0], ab.inputs['Density'])
        vol.data.materials.append(m)
        frames = []
        n = a.frames if not a.quick else 4
        t0 = time.time()
        for f in range(n):
            ph = 2 * math.pi * f / n
            # loop: noise W walks a circle via the mapping location (x drift for the fog bank, z drift for the shaft)
            r = 0.35
            if kind == 'shaft':
                mp.inputs['Location'].default_value = (0, 0, -f / n * 0.6)
                nz.inputs['W'].default_value = r * math.cos(ph)
            else:
                mp.inputs['Location'].default_value = (r * math.cos(ph), r * math.sin(ph), 0)
                nz.inputs['W'].default_value = 0.3 * math.sin(ph)
            p = os.path.join(job.out, f'_card_{kind}_{f:02d}.png')
            abake.image_settings('PNG', '8', 'RGBA')
            abake.render_still(p)
            frames.append(p)
        # atlas 8 x 4 (or fewer frames in quick mode)
        cols = 8 if n >= 8 else n
        rows = (n + cols - 1) // cols
        atlas = np.zeros((rows * px, cols * px, 4), np.float32)
        for f, p in enumerate(frames):
            im = bpy.data.images.load(p)
            arr = np.empty(px * px * 4, np.float32)
            im.pixels.foreach_get(arr)
            bpy.data.images.remove(im)
            arr = arr.reshape(px, px, 4)[::-1]
            r_, c_ = divmod(f, cols)
            atlas[r_ * px:(r_ + 1) * px, c_ * px:(c_ + 1) * px] = arr
            os.remove(p)
        img = bpy.data.images.new('atlas', atlas.shape[1], atlas.shape[0], alpha=True)
        img.pixels.foreach_set(atlas[::-1].ravel())
        img.filepath_raw = os.path.join(job.out, f'card_{kind}.png')
        img.file_format = 'PNG'
        img.save()
        res[kind] = {'frames': n, 'px': px, 'grid': [cols, rows], 'seconds': round(time.time() - t0, 1), 'meanAlpha': round(float(atlas[..., 3].mean()), 3)}
    return res


def write_src(extra=None):
    p = os.path.join(job.out, 'backdrop_src.json')
    src = json.load(open(p, encoding='utf-8')) if os.path.exists(p) else {}
    src.update({'scene': a.scene, 'latMin': LAT_MIN, 'latMax': round(LAT_MAX, 4), 'origin': [0, PANO_Y, 0],
                'mapping': 'equirect: u = 0.5 + az / 360 (az in degrees, game convention: 0 = +x, positive toward +z = screen right; measured with marker posts in backdrop_quick); v = 0 at latMax (row 0); depth = radial distance from origin (m)'})
    if extra:
        src.update(extra)
    json.dump(src, open(p, 'w', encoding='utf-8'), indent=1)


if a.mode != 'cards':
    job.step('build_scene', build)
if a.mode == 'layers':
    abake.pano_camera(lat_min=LAT_MIN, lat_max=LAT_MAX, height=PANO_Y)
    r = do_layers()
    write_src({'layers': {k: {'size': v['size'] if v else None, 'depth': v.get('depth') if v else None, 'range': job.info['ranges'][k]} for k, v in r['layers'].items()},
               'device': r['device'].get('used')})
    job.result['layers'] = r
elif a.mode == 'inset':
    r = job.step('inset', do_inset)
    write_src({'inset': r})
elif a.mode == 'preview':
    job.step('preview', do_preview)
elif a.mode == 'cards':
    job.step('cards', do_cards)
job.done()
