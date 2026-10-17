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
    maps: list of 'NORMAL' | 'AO' | 'ROUGHNESS' | 'EMIT' ...  Returns {map: {path, seconds}}."""
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
        high.select_set(True)
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

def export_glb(path, objects=None, extras=True):
    """glTF exporter, arena conventions: GLB, +Y up, modifiers applied, custom props as extras, no Draco
    (meshopt + KTX2 come later from gltf-transform, tools/arena/build_assets.mjs)."""
    if objects is not None:
        bpy.ops.object.select_all(action='DESELECT')
        for o in objects:
            o.select_set(True)
    kw = dict(filepath=path, export_format='GLB', export_yup=True, export_apply=True, export_extras=extras,
              use_selection=objects is not None, export_draco_mesh_compression_enable=False)
    bpy.ops.export_scene.gltf(**kw)
    return {'path': path, 'bytes': os.path.getsize(path)}


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
