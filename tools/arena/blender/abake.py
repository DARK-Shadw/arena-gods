"""Shared helpers for the arena Blender jobs (Blender 5.0, bpy). Arena art plan 5.1, milestone A0.

Extends tools/fx/blender/fxbake.py (args, peak RAM via GetProcessMemoryInfo, free-RAM guard) with:
  Job            per-run context: --out folder, step log with seconds + RAM (ram.log inside the job
                 folder, besides the runner's own 2 s sampling), result JSON (result.json)
  cycles_device  pick CPU / ONEAPI / ... and report what Cycles really sees
  bake_maps      selected-to-active bakes (normal, AO, ...) into images, saved as PNG / EXR
  export_glb     glTF exporter with the arena conventions (plan 4.2 / 5.8)
  pano_camera    Cycles equirectangular camera with latitude limits (plan 5.6)
  compositor_outputs  5.0 compositor API: compositing_node_group + File Output (directory/file_name/
                 file_output_items), for Depth / AOV passes
A1 adds:  load_cc0 (fetched CC0 sources from Assets/arena-src), load_image, tri_count, bounds, fit_bounds
                 (exact PROP_BASE radius / TOP height), uv_unwrap, bake_emit_inputs (PBR channels of the high
                 material as emission bakes), pack_orm (glTF ORM), empty (sockets / roots with extras)
Jobs are started by tools/arena/bake.py (one Blender process per job, RAM watchdog, resumable).
Run by hand:  blender -b --factory-startup -P tools/arena/blender/<job>.py -- --out tools/arena/_bake/<id>
"""
import argparse
import json
import math
import os
import sys
import time

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'fx', 'blender'))
import fxbake  # noqa: E402  (peak_ram_mb, free_ram_mb, wait_for_ram, G node builder)

peak_ram_mb = fxbake.peak_ram_mb
free_ram_mb = fxbake.free_ram_mb
wait_for_ram = fxbake.wait_for_ram


def log(*a):
    print('[abake]', *a, flush=True)


class Job:
    """One job run: args, timed steps, result.json."""

    def __init__(self, extra=None, desc=''):
        argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
        ap = argparse.ArgumentParser(description=desc)
        ap.add_argument('--out', required=True)
        ap.add_argument('--min-free-mb', type=int, default=1500, help='wait before a step while free RAM is below this')
        ap.add_argument('--threads', type=int, default=0, help='render threads (0 = auto)')
        if extra:
            extra(ap)
        self.a = ap.parse_args(argv)
        self.out = os.path.abspath(self.a.out)
        os.makedirs(self.out, exist_ok=True)
        self.t0 = time.time()
        self.steps = []
        self.result = {'blender': bpy.app.version_string, 'args': vars(self.a), 'steps': self.steps}
        self.ramlog = open(os.path.join(self.out, 'ram.log'), 'a', encoding='utf-8')
        log(f'Blender {bpy.app.version_string}, out {self.out}, free RAM {free_ram_mb():.0f} MB')

    def step(self, name, fn, *args, **kw):
        """Run fn, record seconds + process peak RAM + free RAM; a failure is recorded, not raised."""
        wait_for_ram(self.a.min_free_mb)
        t = time.time()
        rec = {'step': name}
        try:
            rec['value'] = fn(*args, **kw)
            rec['ok'] = True
        except Exception as ex:  # probes must report, not die
            import traceback
            rec['ok'] = False
            rec['error'] = f'{type(ex).__name__}: {ex}'
            traceback.print_exc()
        rec['seconds'] = round(time.time() - t, 2)
        rec['peakMB'] = round(peak_ram_mb())
        rec['freeMB'] = round(free_ram_mb())
        self.steps.append(rec)
        self.ramlog.write(f"{time.strftime('%H:%M:%S')}\t{name}\t{rec['seconds']}s\tpeak {rec['peakMB']} MB\tfree {rec['freeMB']} MB\n")
        self.ramlog.flush()
        v = rec.get('value')
        vs = json.dumps(v)[:300] if v is not None else ''
        log(f"step {name}: {'ok' if rec['ok'] else 'FAILED ' + rec['error']} in {rec['seconds']}s, peak {rec['peakMB']} MB, free {rec['freeMB']} MB {vs}")
        self.save()
        return rec.get('value')

    def save(self):
        self.result['seconds'] = round(time.time() - self.t0, 1)
        self.result['peakMB'] = round(peak_ram_mb())
        with open(os.path.join(self.out, 'result.json'), 'w', encoding='utf-8') as f:
            json.dump(self.result, f, indent=1, default=str)

    def done(self):
        self.save()
        log(f"DONE in {self.result['seconds']}s, peak RAM {self.result['peakMB']} MB")


# ---------------------------------------------------------------------------- scene / render

def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    return bpy.context.scene


def cycles_device(kind='CPU', threads=0):
    """Set Cycles to `kind` ('CPU', 'ONEAPI', 'CUDA', 'OPTIX', 'HIP', 'METAL'). Returns what is used.
    Falls back to CPU (and says so) when no device of that kind exists."""
    s = bpy.context.scene
    s.render.engine = 'CYCLES'
    info = {'requested': kind, 'used': 'CPU', 'devices': []}
    if threads:
        s.render.threads_mode = 'FIXED'
        s.render.threads = threads
    if kind != 'CPU':
        prefs = bpy.context.preferences.addons['cycles'].preferences
        try:
            prefs.compute_device_type = kind
            prefs.refresh_devices()
            devs = [d for d in prefs.devices if d.type == kind]
            for d in prefs.devices:
                d.use = d.type == kind
                info['devices'].append({'name': d.name, 'type': d.type, 'use': d.use})
            if devs:
                s.cycles.device = 'GPU'
                info['used'] = kind
        except Exception as ex:
            info['error'] = str(ex)
    if info['used'] == 'CPU':
        s.cycles.device = 'CPU'
    return info


def list_cycles_devices():
    """All Cycles device types and devices visible to this process."""
    prefs = bpy.context.preferences.addons['cycles'].preferences
    out = {}
    for kind in ('CUDA', 'OPTIX', 'HIP', 'ONEAPI', 'METAL'):
        try:
            prefs.compute_device_type = kind
            prefs.refresh_devices()
            out[kind] = [{'name': d.name, 'type': d.type} for d in prefs.devices if d.type == kind]
        except Exception as ex:
            out[kind] = f'unavailable: {ex}'
    try:
        prefs.compute_device_type = 'NONE'
    except Exception:
        pass
    return out


def image_settings(fmt='PNG', depth='8', mode='RGBA', codec=None):
    """5.0: media_type must be set before file_format."""
    im = bpy.context.scene.render.image_settings
    try:
        im.media_type = 'MULTI_LAYER_IMAGE' if fmt == 'OPEN_EXR_MULTILAYER' else 'IMAGE'
    except Exception:
        pass
    im.file_format = fmt
    im.color_mode = mode
    im.color_depth = depth
    if codec and hasattr(im, 'exr_codec'):
        im.exr_codec = codec
    return im


def render_still(path):
    s = bpy.context.scene
    s.render.filepath = path
    bpy.ops.render.render(write_still=True)
    return path


# ---------------------------------------------------------------------------- bake

def new_image(name, px, float_buffer=False, color=(0.5, 0.5, 1.0, 1.0)):
    img = bpy.data.images.new(name, px, px, alpha=False, float_buffer=float_buffer)
    img.generated_color = color
    return img


def assign_bake_image(obj, img):
    """Give every material of `obj` an active Image Texture node holding `img` (the bake target)."""
    for slot in obj.material_slots:
        mat = slot.material
        nt = mat.node_tree
        n = nt.nodes.get('BAKE_TARGET') or nt.nodes.new('ShaderNodeTexImage')
        n.name = 'BAKE_TARGET'
        n.image = img
        nt.nodes.active = n


def bake_maps(low, high, maps, px, out_dir, samples=64, extrusion=0.03, margin=8, prefix='bake'):
    """Selected-to-active Cycles bakes from `high` onto `low` (needs UVs on low).
    maps: list of 'NORMAL' | 'AO' | 'ROUGHNESS' | 'EMIT' ...  `high` may be a list (several sources).
    Returns {map: {path, seconds}}."""
    s = bpy.context.scene
    s.render.engine = 'CYCLES'
    s.cycles.samples = samples
    bk = s.render.bake
    bk.use_selected_to_active = True
    bk.cage_extrusion = extrusion
    bk.margin = margin
    bk.normal_space = 'TANGENT'
    bk.normal_r, bk.normal_g, bk.normal_b = 'POS_X', 'POS_Y', 'POS_Z'  # OpenGL (+Y) = three.js
    out = {}
    for m in maps:
        t = time.time()
        img = new_image(f'{prefix}_{m.lower()}', px, float_buffer=False, color=(0.5, 0.5, 1.0, 1.0) if m == 'NORMAL' else (1, 1, 1, 1))
        if m == 'NORMAL':
            img.colorspace_settings.name = 'Non-Color'
        assign_bake_image(low, img)
        bpy.ops.object.select_all(action='DESELECT')
        for h in (high if isinstance(high, (list, tuple)) else [high]):
            h.select_set(True)
        low.select_set(True)
        bpy.context.view_layer.objects.active = low
        bpy.ops.object.bake(type=m)
        p = os.path.join(out_dir, f'{prefix}_{m.lower()}.png')
        img.filepath_raw = p
        img.file_format = 'PNG'
        img.save()
        out[m] = {'path': p, 'seconds': round(time.time() - t, 2)}
    return out


# ---------------------------------------------------------------------------- export

def export_glb(path, objects=None, extras=True, images='NONE'):
    """glTF exporter, arena conventions: GLB, +Y up, modifiers applied, custom props as extras, no Draco
    (meshopt + KTX2 come later from gltf-transform, tools/arena/build_assets.mjs).
    images: 'NONE' (A1 default for kit assets: build_assets.mjs attaches the baked PNG sets per material
    from asset.json, so textures are encoded exactly once), 'AUTO' / 'WEBP' to let Blender embed them."""
    if objects is not None:
        bpy.ops.object.select_all(action='DESELECT')
        for o in objects:
            o.select_set(True)
    kw = dict(filepath=path, export_format='GLB', export_yup=True, export_apply=True, export_extras=extras,
              use_selection=objects is not None, export_draco_mesh_compression_enable=False,
              export_image_format=images)
    try:
        bpy.ops.export_scene.gltf(**kw)
    except TypeError:  # older exporters without 'NONE'
        kw['export_image_format'] = 'AUTO'
        bpy.ops.export_scene.gltf(**kw)
    return {'path': path, 'bytes': os.path.getsize(path)}


# ---------------------------------------------------------------------------- A1: CC0 sources, kit assets

ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
CC0_SRC = os.path.abspath(os.environ.get('ARENA_SRC') or os.path.join(ROOT, '..', 'Assets', 'arena-src'))


def load_cc0(cid, need=()):
    """A fetched CC0 source ('polyhaven/metal_plate_02') -> {'meta': meta.json, 'dir': ..., '<map>': abs path}.
    Files come from tools/arena/fetch_cc0.mjs (Assets/arena-src/<source>/<id>/, outside git). Raises with the
    fetch command when the source (or one of the `need` maps) is missing, so a job fails loudly, not silently."""
    d = os.path.join(CC0_SRC, *cid.split('/'))
    mp = os.path.join(d, 'meta.json')
    if not os.path.exists(mp):
        raise FileNotFoundError(f'CC0 source {cid} not on disk ({d}); run: node tools/arena/fetch_cc0.mjs {cid.replace("/", ":", 1)}')
    meta = json.load(open(mp, encoding='utf-8'))
    out = {'meta': meta, 'dir': d}
    for k, f in meta.get('files', {}).items():
        out[k] = os.path.join(d, f)
    miss = [k for k in need if k not in out or not os.path.exists(out[k])]
    if miss:
        raise FileNotFoundError(f'CC0 source {cid}: maps {miss} missing; re-run fetch_cc0.mjs with --maps=' + ','.join(need))
    return out


def load_image(path, non_color=False):
    img = bpy.data.images.load(path, check_existing=True)
    if non_color:
        img.colorspace_settings.name = 'Non-Color'
    return img


def tri_count(obj):
    """triangles of the evaluated object (modifiers applied)"""
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    me = ev.to_mesh()
    me.calc_loop_triangles()
    n = len(me.loop_triangles)
    ev.to_mesh_clear()
    return n


def bounds(objs):
    """world-space bounds of mesh objects: max horizontal radius from the Z axis, z min / max (Blender Z up)."""
    import mathutils  # noqa: F401
    r = 0.0
    zmin, zmax = 1e9, -1e9
    for o in objs:
        mw = o.matrix_world
        for v in o.data.vertices:
            p = mw @ v.co
            r = max(r, math.hypot(p.x, p.y))
            zmin, zmax = min(zmin, p.z), max(zmax, p.z)
    return {'radius': r, 'zmin': zmin, 'zmax': zmax}


def fit_bounds(objs, radius, height):
    """Make a set of mesh objects match the sim's prop contract EXACTLY (plan 4.3: PROP_BASE radius, TOP
    height, origin at the base centre): transforms are applied, then the mesh data is moved so z min = 0
    and scaled so the max horizontal radius = `radius` and the top = `height`. Returns before / after."""
    import mathutils
    for o in objs:
        o.data.transform(o.matrix_world)
        o.matrix_world = mathutils.Matrix.Identity(4)
    b0 = bounds(objs)
    sxy = radius / b0['radius']
    sz = height / (b0['zmax'] - b0['zmin'])
    M = mathutils.Matrix.Diagonal((sxy, sxy, sz, 1.0)) @ mathutils.Matrix.Translation((0, 0, -b0['zmin']))
    for o in objs:
        o.data.transform(M)
        o.data.update()
    b1 = bounds(objs)
    return {'before': {k: round(v, 5) for k, v in b0.items()}, 'after': {k: round(v, 6) for k, v in b1.items()}, 'scaleXY': round(sxy, 5), 'scaleZ': round(sz, 5)}


def uv_unwrap(obj, px=1024, angle=66, margin_px=8):
    """Smart UV Project + Pack Islands (5.0 shape_method CONCAVE), margin in pixels at `px`."""
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(angle), island_margin=margin_px / px)
    try:
        bpy.ops.uv.pack_islands(margin=margin_px / px, shape_method='CONCAVE', rotate=True)
    except Exception:
        bpy.ops.uv.pack_islands(margin=margin_px / px)
    bpy.ops.object.mode_set(mode='OBJECT')


def bake_emit_inputs(low, highs, inputs, px, out_dir, prefix, samples=4, extrusion=0.03, margin=8):
    """Bake Principled BSDF inputs of the HIGH objects' materials ('Base Color', 'Roughness', 'Metallic', ...)
    onto `low` through an emission rewire (a DIFFUSE colour pass is black on metals, so PBR channels are
    baked as emission). Returns {input: {path, seconds}}. Colour is saved sRGB, the rest Non-Color."""
    s = bpy.context.scene
    s.render.engine = 'CYCLES'
    s.cycles.samples = samples
    bk = s.render.bake
    bk.use_selected_to_active = True
    bk.cage_extrusion = extrusion
    bk.margin = margin
    out = {}
    for name in inputs:
        t = time.time()
        saved = []
        for h in highs:
            for slot in h.material_slots:
                nt = slot.material.node_tree
                bsdf = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
                mo = next((n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL'), None)
                if bsdf is None or mo is None:
                    continue
                em = nt.nodes.new('ShaderNodeEmission')
                src = bsdf.inputs[name]
                if src.is_linked:
                    nt.links.new(src.links[0].from_socket, em.inputs['Color'])
                else:
                    v = src.default_value
                    em.inputs['Color'].default_value = (v, v, v, 1.0) if isinstance(v, float) else tuple(v)
                old = mo.inputs['Surface'].links[0].from_socket if mo.inputs['Surface'].is_linked else None
                nt.links.new(em.outputs['Emission'], mo.inputs['Surface'])
                saved.append((nt, em, old, mo))
        key = name.lower().replace(' ', '')
        img = new_image(f'{prefix}_{key}', px, color=(0, 0, 0, 1))
        if name != 'Base Color':
            img.colorspace_settings.name = 'Non-Color'
        assign_bake_image(low, img)
        bpy.ops.object.select_all(action='DESELECT')
        for h in highs:
            h.select_set(True)
        low.select_set(True)
        bpy.context.view_layer.objects.active = low
        bpy.ops.object.bake(type='EMIT')
        for nt, em, old, mo in saved:
            if old is not None:
                nt.links.new(old, mo.inputs['Surface'])
            nt.nodes.remove(em)
        p = os.path.join(out_dir, f'{prefix}_{key}.png')
        img.filepath_raw = p
        img.file_format = 'PNG'
        img.save()
        out[name] = {'path': p, 'seconds': round(time.time() - t, 2)}
    return out


def pack_orm(ao, rough, metal, out_path):
    """glTF ORM texture from three single-channel PNGs (R = occlusion, G = roughness, B = metalness),
    numpy inside Blender (no Pillow there). Inputs are read as Non-Color."""
    import numpy as np
    chans = []
    size = None
    for p in (ao, rough, metal):
        im = bpy.data.images.load(p, check_existing=False)
        im.colorspace_settings.name = 'Non-Color'
        w, h = im.size
        size = size or (w, h)
        if (w, h) != size:
            im.scale(*size)
        a = np.empty(size[0] * size[1] * 4, dtype=np.float32)
        im.pixels.foreach_get(a)
        chans.append(a.reshape(-1, 4)[:, 0])
        bpy.data.images.remove(im)
    out = bpy.data.images.new('orm', size[0], size[1], alpha=False)
    out.colorspace_settings.name = 'Non-Color'
    px = np.ones((size[0] * size[1], 4), dtype=np.float32)
    px[:, 0], px[:, 1], px[:, 2] = chans
    out.pixels.foreach_set(px.ravel())
    out.filepath_raw = out_path
    out.file_format = 'PNG'
    out.save()
    return out_path


def empty(name, loc=(0, 0, 0), parent=None, **props):
    """An Empty exported as a glTF node; keyword args become custom props (-> glTF extras)."""
    e = bpy.data.objects.new(name, None)
    e.empty_display_size = 0.1
    bpy.context.scene.collection.objects.link(e)
    e.location = loc
    if parent is not None:
        e.parent = parent
    for k, v in props.items():
        e[k] = v
    return e


# ---------------------------------------------------------------------------- panorama

def pano_camera(name='pano', lat_min=-12, lat_max=60, height=1.6):
    """Equirectangular Cycles camera at the arena centre (plan 5.6), 360 deg longitude, latitude limits.
    Blender 4.x/5.0: panorama settings live on the camera data (panorama_type, latitude_min/max, ...)."""
    cd = bpy.data.cameras.new(name)
    cd.type = 'PANO'
    cd.panorama_type = 'EQUIRECTANGULAR'
    cd.latitude_min = math.radians(lat_min)
    cd.latitude_max = math.radians(lat_max)
    cd.longitude_min = -math.pi
    cd.longitude_max = math.pi
    cd.clip_start = 0.1
    cd.clip_end = 5000
    cam = bpy.data.objects.new(name, cd)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = (0, 0, height)
    # Blender camera looks down -Z: rotate to look along +X (Blender), horizon level
    cam.rotation_euler = (math.radians(90), 0, math.radians(-90))
    bpy.context.scene.camera = cam
    return cam


def compositor_outputs(directory, file_name, passes, fmt='OPEN_EXR_MULTILAYER'):
    """5.0 compositor: scene.compositing_node_group (node group 'CompositorNodeTree'), Render Layers ->
    one File Output node with one item per pass name in `passes` (e.g. ['Image', 'Depth', 'AO_water']).
    Returns the sockets that were linked and the ones missing."""
    s = bpy.context.scene
    ng = bpy.data.node_groups.new('arena_comp', 'CompositorNodeTree')
    s.compositing_node_group = ng
    rl = ng.nodes.new('CompositorNodeRLayers')
    fo = ng.nodes.new('CompositorNodeOutputFile')
    fo.directory = directory
    fo.file_name = file_name
    try:
        fo.format.media_type = 'MULTI_LAYER_IMAGE' if fmt == 'OPEN_EXR_MULTILAYER' else 'IMAGE'
    except Exception:
        pass
    fo.format.file_format = fmt
    if hasattr(fo.format, 'color_depth'):
        fo.format.color_depth = '16' if fmt.startswith('OPEN_EXR') else '8'
    fo.file_output_items.clear()
    linked, missing = [], []
    for p in passes:
        sock = rl.outputs.get(p)
        if sock is None:
            missing.append(p)
            continue
        item = fo.file_output_items.new('FLOAT' if p == 'Depth' else 'RGBA', p)
        ng.links.new(sock, fo.inputs[item.name])
        linked.append(p)
    # group output so the compositor also produces the regular render result
    try:
        go = ng.nodes.new('NodeGroupOutput')
        ng.interface.new_socket('Image', in_out='OUTPUT', socket_type='NodeSocketColor')
        ng.links.new(rl.outputs['Image'], go.inputs[0])
    except Exception as ex:
        log('group output not wired:', ex)
    return {'linked': linked, 'missing': missing, 'rlOutputs': [o.name for o in rl.outputs]}
