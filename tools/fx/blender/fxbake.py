"""Shared helpers for the headless FX flipbook bakes (Blender 5.0, bpy).

Every bake script in this folder:
  1. parses its args after `--` (see parse_args),
  2. builds its scene from an empty factory file (no .blend files are kept),
  3. runs a DRY RUN first: API checks (Mantaflow where used) + one rendered frame,
     and prints the peak RAM measured for the process,
  4. renders frames one by one into  <out>/frames[/L0|L1|L2]/f_0000.exr (linear, premultiplied),
     checking free system RAM before every frame (waits, then aborts, when low),
  5. writes <out>/bake.json, which tools/fx/pack_atlas.py reads.

Run (one Blender at a time on the owner's PC):
  blender -b --factory-startup -P tools/fx/blender/bake_fire_loop.py -- --out tools/fx/_bake/fire_loop
  add --dry-run to stop after the dry run, --preview N to render only N evenly spaced frames.
"""
import argparse
import ctypes
import json
import math
import os
import sys
import time

import bpy

BLENDER_VERSION = bpy.app.version_string


# ---------------------------------------------------------------------------
# args, memory
# ---------------------------------------------------------------------------

def parse_args(frames, px=256, samples=16, extra=None):
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True, help='bake output folder (tools/fx/_bake/<id>)')
    ap.add_argument('--px', type=int, default=px, help='frame size in pixels (square)')
    ap.add_argument('--frames', type=int, default=frames)
    ap.add_argument('--dry-run', action='store_true', help='API check + 1 frame, then exit')
    ap.add_argument('--preview', type=int, default=0, help='render only N evenly spaced frames')
    ap.add_argument('--method', default='auto', choices=['auto', 'mantaflow', 'procedural'])
    ap.add_argument('--engine', default='eevee', choices=['eevee', 'cycles'])
    ap.add_argument('--samples', type=int, default=samples)
    ap.add_argument('--seed', type=int, default=7)
    ap.add_argument('--min-free-mb', type=int, default=1500, help='pause rendering below this free RAM')
    if extra:
        extra(ap)
    a = ap.parse_args(argv)
    a.out = os.path.abspath(a.out)
    os.makedirs(a.out, exist_ok=True)
    return a


if sys.platform == 'win32':
    class _PMC(ctypes.Structure):
        _fields_ = [('cb', ctypes.c_ulong), ('PageFaultCount', ctypes.c_ulong),
                    ('PeakWorkingSetSize', ctypes.c_size_t), ('WorkingSetSize', ctypes.c_size_t),
                    ('QuotaPeakPagedPoolUsage', ctypes.c_size_t), ('QuotaPagedPoolUsage', ctypes.c_size_t),
                    ('QuotaPeakNonPagedPoolUsage', ctypes.c_size_t), ('QuotaNonPagedPoolUsage', ctypes.c_size_t),
                    ('PagefileUsage', ctypes.c_size_t), ('PeakPagefileUsage', ctypes.c_size_t)]

    class _MSX(ctypes.Structure):
        _fields_ = [('dwLength', ctypes.c_ulong), ('dwMemoryLoad', ctypes.c_ulong),
                    ('ullTotalPhys', ctypes.c_ulonglong), ('ullAvailPhys', ctypes.c_ulonglong),
                    ('ullTotalPageFile', ctypes.c_ulonglong), ('ullAvailPageFile', ctypes.c_ulonglong),
                    ('ullTotalVirtual', ctypes.c_ulonglong), ('ullAvailVirtual', ctypes.c_ulonglong),
                    ('ullAvailExtendedVirtual', ctypes.c_ulonglong)]


def peak_ram_mb():
    """Peak working set of this Blender process, in MB."""
    try:
        if sys.platform == 'win32':
            k32 = ctypes.WinDLL('kernel32')
            psapi = ctypes.WinDLL('psapi')
            k32.GetCurrentProcess.restype = ctypes.c_void_p
            psapi.GetProcessMemoryInfo.argtypes = [ctypes.c_void_p, ctypes.POINTER(_PMC), ctypes.c_ulong]
            c = _PMC()
            c.cb = ctypes.sizeof(_PMC)
            psapi.GetProcessMemoryInfo(k32.GetCurrentProcess(), ctypes.byref(c), c.cb)
            return c.PeakWorkingSetSize / 2**20
        import resource
        return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    except Exception:
        return -1.0


def free_ram_mb():
    try:
        if sys.platform == 'win32':
            m = _MSX()
            m.dwLength = ctypes.sizeof(_MSX)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
            return m.ullAvailPhys / 2**20
        return os.sysconf('SC_AVPHYS_PAGES') * os.sysconf('SC_PAGE_SIZE') / 2**20
    except Exception:
        return 1e9


def wait_for_ram(min_free_mb):
    """Memory guard: the owner's PC has had low-memory kills. Wait (up to 5 min) when RAM is low."""
    for i in range(60):
        f = free_ram_mb()
        if f >= min_free_mb:
            return
        print(f'[fxbake] free RAM {f:.0f} MB < {min_free_mb} MB, waiting 5 s ({i + 1}/60)', flush=True)
        time.sleep(5)
    raise SystemExit('[fxbake] ABORT: free RAM stayed low for 5 minutes')


def log(*a):
    print('[fxbake]', *a, flush=True)


# ---------------------------------------------------------------------------
# scene
# ---------------------------------------------------------------------------

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    return bpy.context.scene


def setup_render(a, ortho_scale, center=(0, 0, 0), elev_deg=0.0, dist=12.0, transparent=True):
    """Square orthographic camera looking along +Y (front view), optionally tilted down by elev_deg."""
    s = bpy.context.scene
    if a.engine == 'cycles':
        s.render.engine = 'CYCLES'
        s.cycles.samples = a.samples
        s.cycles.use_denoising = False
        s.cycles.volume_step_rate = 1.0
        s.cycles.volume_max_steps = 256
        s.cycles.seed = a.seed
    else:
        s.render.engine = 'BLENDER_EEVEE'
        e = s.eevee
        e.taa_render_samples = a.samples
        e.volumetric_tile_size = '1'
        e.volumetric_samples = 96
        e.volumetric_sample_distribution = 0.5
        e.use_volumetric_shadows = True
        e.volumetric_shadow_samples = 24
        e.volumetric_start = max(0.1, dist - ortho_scale)
        e.volumetric_end = dist + ortho_scale
        try:
            e.use_volume_custom_range = True
        except Exception:
            pass
    s.render.resolution_x = a.px
    s.render.resolution_y = a.px
    s.render.resolution_percentage = 100
    s.render.film_transparent = transparent
    # Linear, premultiplied, half-float EXR: keeps HDR emission and avoids the
    # un-premultiply clipping a straight-alpha PNG would apply to faint glow.
    s.render.image_settings.file_format = 'OPEN_EXR'
    s.render.image_settings.color_mode = 'RGBA'
    s.render.image_settings.color_depth = '16'
    s.render.image_settings.exr_codec = 'ZIP'
    try:
        s.view_settings.view_transform = 'Standard'
        s.view_settings.look = 'None'
    except Exception as ex:
        log('view transform not set:', ex)
    s.view_settings.exposure = 0.0
    s.view_settings.gamma = 1.0
    # black world: no ambient (the runtime adds the theme ambient itself)
    w = bpy.data.worlds.new('fxworld')
    w.color = (0, 0, 0)
    s.world = w

    cam_data = bpy.data.cameras.new('cam')
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = ortho_scale
    cam_data.clip_start = 0.05
    cam_data.clip_end = dist * 3
    cam = bpy.data.objects.new('cam', cam_data)
    s.collection.objects.link(cam)
    el = math.radians(elev_deg)
    cx, cy, cz = center
    cam.location = (cx, cy - dist * math.cos(el), cz + dist * math.sin(el))
    cam.rotation_euler = (math.radians(90) - el, 0, 0)
    s.camera = cam
    return cam


def sun(name, direction_deg, strength=3.0, color=(1, 1, 1), angle_deg=8.0):
    """Sun light. direction_deg = (rx, ry, rz) Euler degrees."""
    d = bpy.data.lights.new(name, 'SUN')
    d.energy = strength
    d.color = color
    d.angle = math.radians(angle_deg)
    o = bpy.data.objects.new(name, d)
    o.rotation_euler = tuple(math.radians(v) for v in direction_deg)
    bpy.context.scene.collection.objects.link(o)
    return o


# Three directional passes used by every lit (smoke / dust) atlas:
# R = key from screen RIGHT, G = key from screen TOP, B = key from screen LEFT,
# each tilted 35 deg toward the camera. pack_atlas stores them in R, G, B; the runtime
# shader reconstructs lighting as dot(rgb, weights(lightDirInCardSpace)).
LIGHT_RIGS = {
    'L0': (55, 0, 90 + 35),    # from +X (right), leaning toward camera (-Y)
    'L1': (35, 0, 0),          # from +Z (top), leaning toward camera
    'L2': (55, 0, -90 - 35),   # from -X (left)
}


def three_light_rig(strength=4.0):
    lights = {}
    for k, rot in LIGHT_RIGS.items():
        lights[k] = sun('sun_' + k, rot, strength)
    return lights


def domain_cube(name, size, loc):
    """Unit cube mesh scaled to `size` (full extents) at `loc`; object coords stay -1..1."""
    bpy.ops.mesh.primitive_cube_add(size=2.0, location=loc)
    o = bpy.context.active_object
    o.name = name
    o.scale = (size[0] / 2, size[1] / 2, size[2] / 2)
    return o


# ---------------------------------------------------------------------------
# tiny node-graph builder (keeps the procedural shaders readable)
# ---------------------------------------------------------------------------

class G:
    def __init__(self, mat):
        self.nt = mat.node_tree
        self.nt.nodes.clear()
        self.params = {}
        self._x = 0

    def node(self, t, **props):
        n = self.nt.nodes.new(t)
        n.location = (self._x, 0)
        self._x += 40
        for k, v in props.items():
            setattr(n, k, v)
        return n

    def _in(self, sock, v):
        if isinstance(v, (int, float)):
            sock.default_value = v
        elif isinstance(v, (tuple, list)):
            sock.default_value = v
        else:
            self.nt.links.new(v, sock)

    def param(self, name, v=0.0):
        n = self.node('ShaderNodeValue')
        n.outputs[0].default_value = v
        self.params[name] = n
        return n.outputs[0]

    def set(self, name, v):
        self.params[name].outputs[0].default_value = v

    def m(self, op, a, b=0.0, c=0.0, clamp=False):
        n = self.node('ShaderNodeMath', operation=op, use_clamp=clamp)
        self._in(n.inputs[0], a)
        self._in(n.inputs[1], b)
        if len(n.inputs) > 2:
            self._in(n.inputs[2], c)
        return n.outputs[0]

    # sugar
    def add(self, a, b): return self.m('ADD', a, b)
    def sub(self, a, b): return self.m('SUBTRACT', a, b)
    def mul(self, a, b): return self.m('MULTIPLY', a, b)
    def div(self, a, b): return self.m('DIVIDE', a, b)
    def pow(self, a, b): return self.m('POWER', a, b)
    def clamp01(self, a): return self.m('MULTIPLY', a, 1.0, clamp=True)
    def smooth(self, e0, e1, x):
        n = self.node('ShaderNodeMapRange', interpolation_type='SMOOTHSTEP')
        self._in(n.inputs['Value'], x)
        self._in(n.inputs['From Min'], e0)
        self._in(n.inputs['From Max'], e1)
        return n.outputs['Result']
    def remap(self, x, a0, a1, b0, b1, clamp=True):
        n = self.node('ShaderNodeMapRange', clamp=clamp)
        self._in(n.inputs['Value'], x)
        self._in(n.inputs['From Min'], a0)
        self._in(n.inputs['From Max'], a1)
        self._in(n.inputs['To Min'], b0)
        self._in(n.inputs['To Max'], b1)
        return n.outputs['Result']

    def v(self, op, a, b=None, scale=None):
        n = self.node('ShaderNodeVectorMath', operation=op)
        self._in(n.inputs[0], a)
        if b is not None:
            self._in(n.inputs[1], b)
        if scale is not None:
            self._in(n.inputs['Scale'], scale)
        return n.outputs['Value'] if op in ('LENGTH', 'DOT_PRODUCT', 'DISTANCE') else n.outputs['Vector']

    def combine(self, x, y, z):
        n = self.node('ShaderNodeCombineXYZ')
        self._in(n.inputs[0], x)
        self._in(n.inputs[1], y)
        self._in(n.inputs[2], z)
        return n.outputs[0]

    def split(self, vec):
        n = self.node('ShaderNodeSeparateXYZ')
        self._in(n.inputs[0], vec)
        return n.outputs[0], n.outputs[1], n.outputs[2]

    def coords(self, space='Object'):
        n = self.node('ShaderNodeTexCoord')
        return n.outputs[space]

    def noise(self, vec, w=0.0, scale=1.0, detail=4.0, rough=0.55, dims='4D', ntype='FBM', distortion=0.0):
        n = self.node('ShaderNodeTexNoise', noise_dimensions=dims)
        try:
            n.noise_type = ntype
        except Exception:
            pass
        self._in(n.inputs['Vector'], vec)
        if dims in ('1D', '4D'):
            self._in(n.inputs['W'], w)
        self._in(n.inputs['Scale'], scale)
        self._in(n.inputs['Detail'], detail)
        self._in(n.inputs['Roughness'], rough)
        self._in(n.inputs['Distortion'], distortion)
        return n.outputs['Fac'], n.outputs['Color']

    def voronoi(self, vec, w=0.0, scale=1.0, feature='F1', dims='4D'):
        n = self.node('ShaderNodeTexVoronoi', voronoi_dimensions=dims, feature=feature)
        self._in(n.inputs['Vector'], vec)
        if dims in ('1D', '4D'):
            self._in(n.inputs['W'], w)
        self._in(n.inputs['Scale'], scale)
        return n.outputs['Distance']

    def ramp(self, fac, stops):
        """stops: [(pos, (r,g,b,a)), ...]"""
        n = self.node('ShaderNodeValToRGB')
        cr = n.color_ramp
        cr.interpolation = 'B_SPLINE' if len(stops) > 2 else 'LINEAR'
        while len(cr.elements) < len(stops):
            cr.elements.new(0.5)
        for el, (p, c) in zip(cr.elements, stops):
            el.position = p
            el.color = c
        self._in(n.inputs['Fac'], fac)
        return n.outputs['Color']

    def vol_out(self, density, color=(1, 1, 1, 1), emit_color=None, emit_strength=0.0, absorption=None):
        pv = self.node('ShaderNodeVolumePrincipled')
        self._in(pv.inputs['Density'], density)
        self._in(pv.inputs['Color'], color)
        if absorption is not None:
            self._in(pv.inputs['Absorption Color'], absorption)
        if emit_color is not None:
            self._in(pv.inputs['Emission Color'], emit_color)
        self._in(pv.inputs['Emission Strength'], emit_strength)
        out = self.node('ShaderNodeOutputMaterial')
        self.nt.links.new(pv.outputs[0], out.inputs['Volume'])
        return pv


def volume_material(obj, name):
    mat = bpy.data.materials.new(name)
    try:
        mat.use_nodes = True
    except Exception:
        pass
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    return mat, G(mat)


def loop_mix(phase):
    """Weights for the density-space loop crossfade: N(t) (1-a) + N(t-T) a, a = phase.
    Returns (a, contrast) where contrast restores the variance lost by averaging two noises."""
    a = phase
    k = 1.0 / math.sqrt((1 - a) ** 2 + a ** 2)
    return a, k


# ---------------------------------------------------------------------------
# rendering loop
# ---------------------------------------------------------------------------

def frame_indices(a):
    n = a.frames
    if a.dry_run:
        return [n // 2]
    if a.preview > 0:
        return sorted(set(int(round(i * (n - 1) / max(1, a.preview - 1))) for i in range(a.preview)))
    return list(range(n))


def render_to(path):
    s = bpy.context.scene
    s.render.filepath = path
    bpy.ops.render.render(write_still=True)


def run(a, meta, set_frame, passes=None, dry_check=None):
    """Drive the bake.
    set_frame(i): put the scene into frame i (0-based) — must be a pure function of i.
    passes: None for one pass, or {pass_name: callable_enabling_that_pass}.
    dry_check(): optional API check run before the dry-run frame (raise to fail)."""
    t0 = time.time()
    log(f'Blender {BLENDER_VERSION}; effect {meta["id"]}; {a.frames} frames @ {a.px}px; engine {a.engine}')
    if dry_check:
        dry_check()
    # ---- dry run: always one frame first
    wait_for_ram(a.min_free_mb)
    i = a.frames // 2
    set_frame(i)
    dry_dir = os.path.join(a.out, 'dry')
    os.makedirs(dry_dir, exist_ok=True)
    for pname, enable in (passes or {'': None}).items():
        if enable:
            enable()
        render_to(os.path.join(dry_dir, f'dry{("_" + pname) if pname else ""}.exr'))
    dt = time.time() - t0
    log(f'DRY RUN ok: frame {i} rendered in {dt:.1f}s, peak RAM {peak_ram_mb():.0f} MB, free RAM {free_ram_mb():.0f} MB')
    if a.dry_run:
        return
    frames_dir = os.path.join(a.out, 'frames')
    idx = frame_indices(a)
    t1 = time.time()
    for n, i in enumerate(idx):
        wait_for_ram(a.min_free_mb)
        set_frame(i)
        for pname, enable in (passes or {'': None}).items():
            if enable:
                enable()
            d = os.path.join(frames_dir, pname) if pname else frames_dir
            os.makedirs(d, exist_ok=True)
            render_to(os.path.join(d, f'f_{i:04d}.exr'))
        if n % 8 == 0 or n == len(idx) - 1:
            el = time.time() - t1
            log(f'frame {i} ({n + 1}/{len(idx)}) {el:.0f}s elapsed, peak RAM {peak_ram_mb():.0f} MB')
    meta = dict(meta)
    meta.update({
        'frames': a.frames, 'px': a.px, 'engine': a.engine, 'samples': a.samples,
        'blender': BLENDER_VERSION, 'seed': a.seed, 'preview': a.preview,
        'passes': [p for p in (passes or {})] or None,
        'peakRamMB': round(peak_ram_mb()), 'bakeSeconds': round(time.time() - t0),
        'command': ' '.join(sys.argv[sys.argv.index('-P'):] if '-P' in sys.argv else sys.argv),
    })
    with open(os.path.join(a.out, 'bake.json'), 'w') as f:
        json.dump(meta, f, indent=2)
    log(f'DONE {meta["id"]}: {len(idx)} frames in {time.time() - t0:.0f}s, peak RAM {meta["peakRamMB"]} MB')
