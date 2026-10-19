"""A6 test backdrop scene: the Moon Gate arch blockout (arena art plan 1.1 / 3.1 / 5.6, milestone A6).

Built for the panorama renderer (backdrop_pano.py), which imports this module and calls build(opts).
Blender Z up; game axes: game x = Blender X, game y = Blender Z, game z = -Blender Y. Azimuth 0 = game +x (behind the
east gate, the hero direction of the ref-3 preset), positive azimuth towards game +z (= Blender -Y).

Content, by panorama layer (the renderer gives each layer its own view layer; other layers are excluded):
  near  (40-150 m)  the giant RING ARCH at azimuth 0 (two pylons, a ring on top framing the moon, a portal arch below,
                    a hanging two-blade crescent sigil), a three-storey RUINED COLOSSEUM ARCADE wrapping around the arena
                    (r about 62 m, broken tops, missing bays, rubble), small fires on the tiers (emit AOV), a ground disc
  mid   (150-600 m) an outer ring of broken towers and spires with a few lit windows (emit AOV), low ruined walls, a
                    cliff with a WATERFALL behind the arena (azimuth 160: a test of the water AOV; the concept has none)
  far   (> 600 m)   mountain silhouettes (A8: rendered with --no-clouds; the A6 storm-cloud volumes stay available)
The moon disc is NOT rendered: sky.ts draws it behind the far layer (the moon sun lamp here only lights the scene).
A8 rescaled it for the ref-3 framing (see `build_arch`), added banners / swags / chains, two vista pillars, the
storey detail of the arcade, and dropped the test waterfall and the cloud volumes (the authored sky draws the storm).

AOV `aov` (COLOR): R = emission to animate (fires, windows: flicker), G = water (waterfall flow), B = cloud (drift).
"""
import math
import random

import bmesh
import bpy
from mathutils import Euler, Vector

import abake

# ---------------------------------------------------------------------------- frame / colours (plan 3.1 Moon Gate)
MOON_AZ, MOON_EL = 0.0, 26.0   # A8: centred in the ring arch as in ref-3 (A6: -1.7 / 27)
MOON_RGB = (0.85, 0.83, 1.0)            # #d8d4ff
STONE = (0.12, 0.12, 0.155)            # linear albedo, dark blue-grey (moonlit stone reads violet-grey)
STONE_FAR = (0.07, 0.072, 0.09)
FIRE_RGB = (1.0, 0.36, 0.09)
ARCH_X = 74.0                           # arch distance (A8: 74 m, ring top 43 m; see the rescale note below)
ARCADE_R = 62.0


def bl(gx, gy, gz):
    """game (x, y, z) -> Blender (X, Y, Z)"""
    return Vector((gx, -gz, gy))


def az_dir(az_deg, el_deg=0.0):
    a, e = math.radians(az_deg), math.radians(el_deg)
    return bl(math.cos(e) * math.cos(a), math.sin(e), math.cos(e) * math.sin(a))


# ---------------------------------------------------------------------------- materials

def _aov(nt, rgb):
    a = nt.nodes.new('ShaderNodeOutputAOV')
    a.aov_name = 'aov'
    c = nt.nodes.new('ShaderNodeRGB')
    c.outputs[0].default_value = (*rgb, 1)
    nt.links.new(c.outputs[0], a.inputs['Color'])
    return a


def mat_stone(name, rgb, cc=None, scale=3.0, macro=0.6, wet_base=True):
    """procedural stone for distant masonry: two-tone macro noise x CC0 scan luminance (box-projected), Voronoi joints,
    darker and wetter toward the ground, bump from the scan / noise"""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    N, L = nt.nodes, nt.links
    b = next(n for n in N if n.type == 'BSDF_PRINCIPLED')
    tc = N.new('ShaderNodeTexCoord')
    nz = N.new('ShaderNodeTexNoise')
    nz.inputs['Scale'].default_value = 0.08
    nz.inputs['Detail'].default_value = 6
    L.new(tc.outputs['Object'], nz.inputs['Vector'])
    ramp = N.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].position = 0.3
    ramp.color_ramp.elements[0].color = (rgb[0] * (1 - macro * 0.5), rgb[1] * (1 - macro * 0.5), rgb[2] * (1 - macro * 0.45), 1)
    ramp.color_ramp.elements[1].position = 0.75
    ramp.color_ramp.elements[1].color = (rgb[0] * (1 + macro * 0.5), rgb[1] * (1 + macro * 0.5), rgb[2] * (1 + macro * 0.5), 1)
    L.new(nz.outputs['Fac'], ramp.inputs['Fac'])
    col = ramp.outputs['Color']
    height = None
    if cc:
        mp = N.new('ShaderNodeMapping')
        mp.inputs['Scale'].default_value = (1 / scale,) * 3
        L.new(tc.outputs['Object'], mp.inputs['Vector'])
        t = N.new('ShaderNodeTexImage')
        t.image = abake.load_image(cc['diff'])
        t.projection = 'BOX'
        t.projection_blend = 0.3
        L.new(mp.outputs['Vector'], t.inputs['Vector'])
        bw = N.new('ShaderNodeRGBToBW')
        L.new(t.outputs['Color'], bw.inputs['Color'])
        mr = N.new('ShaderNodeMapRange')
        mr.inputs['From Max'].default_value = 0.12
        mr.inputs['To Min'].default_value = 0.6
        mr.inputs['To Max'].default_value = 1.4
        L.new(bw.outputs['Val'], mr.inputs['Value'])
        mul = N.new('ShaderNodeVectorMath')
        mul.operation = 'SCALE'
        L.new(col, mul.inputs[0])
        L.new(mr.outputs['Result'], mul.inputs['Scale'])
        col = mul.outputs['Vector']
        if 'disp' in cc:
            td = N.new('ShaderNodeTexImage')
            td.image = abake.load_image(cc['disp'], True)
            td.projection = 'BOX'
            td.projection_blend = 0.3
            L.new(mp.outputs['Vector'], td.inputs['Vector'])
            height = td.outputs['Color']
    # masonry joints: Voronoi distance to edge in object space (big blocks, 1.2 x 0.6 m)
    vm = N.new('ShaderNodeMapping')
    vm.inputs['Scale'].default_value = (0.8, 0.8, 1.6)
    L.new(tc.outputs['Object'], vm.inputs['Vector'])
    vo = N.new('ShaderNodeTexVoronoi')
    vo.feature = 'DISTANCE_TO_EDGE'
    vo.inputs['Scale'].default_value = 1.0
    L.new(vm.outputs['Vector'], vo.inputs['Vector'])
    jr = N.new('ShaderNodeMapRange')
    jr.inputs['From Min'].default_value = 0.0
    jr.inputs['From Max'].default_value = 0.06
    jr.inputs['To Min'].default_value = 0.35
    jr.inputs['To Max'].default_value = 1.0
    L.new(vo.outputs['Distance'], jr.inputs['Value'])
    mul2 = N.new('ShaderNodeVectorMath')
    mul2.operation = 'SCALE'
    L.new(col, mul2.inputs[0])
    L.new(jr.outputs['Result'], mul2.inputs['Scale'])
    col = mul2.outputs['Vector']
    if wet_base:
        # darker toward the ground (world Z < 4 m): soaked stone, soot
        sep = N.new('ShaderNodeSeparateXYZ')
        L.new(tc.outputs['Generated'], sep.inputs[0])
        geo = N.new('ShaderNodeNewGeometry')
        sz = N.new('ShaderNodeSeparateXYZ')
        L.new(geo.outputs['Position'], sz.inputs[0])
        wr = N.new('ShaderNodeMapRange')
        wr.inputs['From Min'].default_value = 0.0
        wr.inputs['From Max'].default_value = 5.0
        wr.inputs['To Min'].default_value = 0.55
        wr.inputs['To Max'].default_value = 1.0
        L.new(sz.outputs['Z'], wr.inputs['Value'])
        mul3 = N.new('ShaderNodeVectorMath')
        mul3.operation = 'SCALE'
        L.new(col, mul3.inputs[0])
        L.new(wr.outputs['Result'], mul3.inputs['Scale'])
        col = mul3.outputs['Vector']
    L.new(col, b.inputs['Base Color'])
    b.inputs['Roughness'].default_value = 0.82
    bump = N.new('ShaderNodeBump')
    bump.inputs['Distance'].default_value = 0.05
    bump.inputs['Strength'].default_value = 0.6
    if height is not None:
        L.new(height, bump.inputs['Height'])
    else:
        L.new(nz.outputs['Fac'], bump.inputs['Height'])
    L.new(bump.outputs['Normal'], b.inputs['Normal'])
    _aov(nt, (0, 0, 0))
    return m


def mat_emit(name, rgb, strength, aov=(1, 0, 0)):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    b.inputs['Base Color'].default_value = (0.02, 0.02, 0.02, 1)
    b.inputs['Emission Color'].default_value = (*rgb, 1)
    b.inputs['Emission Strength'].default_value = strength
    _aov(nt, aov)
    return m


def mat_metal(name, rgb):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    b.inputs['Base Color'].default_value = (*rgb, 1)
    b.inputs['Metallic'].default_value = 0.9
    b.inputs['Roughness'].default_value = 0.42
    _aov(nt, (0, 0, 0))
    return m


def mat_water(name):
    """waterfall sheet: pale, glossy, a faint emission so it reads at night; AOV G = 1 (flow animated in game)"""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    N, L = nt.nodes, nt.links
    b = next(n for n in N if n.type == 'BSDF_PRINCIPLED')
    tc = N.new('ShaderNodeTexCoord')
    mp = N.new('ShaderNodeMapping')
    mp.inputs['Scale'].default_value = (0.6, 0.6, 0.04)
    L.new(tc.outputs['Object'], mp.inputs['Vector'])
    nz = N.new('ShaderNodeTexNoise')
    nz.inputs['Scale'].default_value = 6
    nz.inputs['Detail'].default_value = 8
    L.new(mp.outputs['Vector'], nz.inputs['Vector'])
    ramp = N.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].color = (0.18, 0.2, 0.3, 1)
    ramp.color_ramp.elements[1].color = (0.75, 0.78, 0.95, 1)
    L.new(nz.outputs['Fac'], ramp.inputs['Fac'])
    L.new(ramp.outputs['Color'], b.inputs['Base Color'])
    L.new(ramp.outputs['Color'], b.inputs['Emission Color'])
    b.inputs['Emission Strength'].default_value = 0.35
    b.inputs['Roughness'].default_value = 0.25
    _aov(nt, (0, 1, 0))
    return m


def mat_cloud(name, density=0.012, seed=0.0):
    """storm-cloud volume: noise density inside the object's bounds with a soft ellipsoid falloff (Generated coords),
    lavender-grey scattering with forward anisotropy so the moon-side edges glow"""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    N, L = nt.nodes, nt.links
    N.clear()
    out = N.new('ShaderNodeOutputMaterial')
    pv = N.new('ShaderNodeVolumePrincipled')
    pv.inputs['Color'].default_value = (0.62, 0.6, 0.78, 1)
    pv.inputs['Anisotropy'].default_value = 0.55
    tc = N.new('ShaderNodeTexCoord')
    # ellipsoid falloff from Generated (0..1 box) coords
    sub = N.new('ShaderNodeVectorMath')
    sub.operation = 'SUBTRACT'
    L.new(tc.outputs['Generated'], sub.inputs[0])
    sub.inputs[1].default_value = (0.5, 0.5, 0.5)
    ln = N.new('ShaderNodeVectorMath')
    ln.operation = 'LENGTH'
    L.new(sub.outputs['Vector'], ln.inputs[0])
    fall = N.new('ShaderNodeMapRange')
    fall.inputs['From Min'].default_value = 0.5
    fall.inputs['From Max'].default_value = 0.15
    L.new(ln.outputs['Value'], fall.inputs['Value'])
    nz = N.new('ShaderNodeTexNoise')
    nz.noise_dimensions = '4D'
    nz.inputs['W'].default_value = seed
    nz.inputs['Scale'].default_value = 3.2
    nz.inputs['Detail'].default_value = 7
    nz.inputs['Roughness'].default_value = 0.62
    L.new(tc.outputs['Generated'], nz.inputs['Vector'])
    sh = N.new('ShaderNodeMapRange')
    sh.inputs['From Min'].default_value = 0.42
    sh.inputs['From Max'].default_value = 0.72
    L.new(nz.outputs['Fac'], sh.inputs['Value'])
    mul = N.new('ShaderNodeMath')
    mul.operation = 'MULTIPLY'
    L.new(sh.outputs['Result'], mul.inputs[0])
    L.new(fall.outputs['Result'], mul.inputs[1])
    dens = N.new('ShaderNodeMath')
    dens.operation = 'MULTIPLY'
    L.new(mul.outputs[0], dens.inputs[0])
    dens.inputs[1].default_value = density
    L.new(dens.outputs[0], pv.inputs['Density'])
    L.new(pv.outputs[0], out.inputs['Volume'])
    return m


# ---------------------------------------------------------------------------- geometry helpers

def new_obj(name, bm, mats, coll):
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for mt in mats:
        me.materials.append(mt)
    o = bpy.data.objects.new(name, me)
    coll.objects.link(o)
    return o


def box(bm, cx, cy, cz, sx, sy, sz, mat=0, rz=0.0, taper=0.0):
    """box with optional top taper (fraction of the half sizes removed at the top), rotated about Z"""
    cr, sr = math.cos(rz), math.sin(rz)
    vs = []
    for k, z in enumerate((cz - sz / 2, cz + sz / 2)):
        t = 1 - taper * k
        for x, y in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            px, py = x * sx / 2 * t, y * sy / 2 * t
            vs.append(bm.verts.new((cx + px * cr - py * sr, cy + px * sr + py * cr, z)))
    idx = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    for f in idx:
        face = bm.faces.new([vs[i] for i in f])
        face.material_index = mat
    return vs


def arch_bay(bm, W, H, pier, depth, spring, mat=0, z0=0.0, keep=1.0, rnd=None, segs=10):
    """one arcade bay storey in the local frame (wall along Y, depth along X, centred on Y = 0): the pier on the -Y
    edge and the arched spandrel up to the storey top; `keep` < 1 removes the spandrel's upper part on one side
    (broken), a jagged top"""
    box(bm, 0, -W / 2, z0 + H / 2, depth, pier, H, mat)
    a = W / 2 - pier / 2
    hx = depth / 2
    if keep <= 0:
        return
    top = z0 + H
    pts = []
    for k in range(segs + 1):
        th = math.pi - math.pi * k / segs
        pts.append((a * math.cos(th), z0 + spring + a * math.sin(th)))
    n_keep = max(1, int(round(segs * keep)))
    for k in range(n_keep):
        (y0, za), (y1, zb) = pts[k], pts[k + 1]
        t0 = top - (rnd.uniform(0, 1.6) if (rnd and keep < 1 and k > n_keep - 3) else 0)
        for x in (-hx, hx):
            v = [bm.verts.new((x, y0, za)), bm.verts.new((x, y1, zb)), bm.verts.new((x, y1, t0)), bm.verts.new((x, y0, t0))]
            f = bm.faces.new(v if x > 0 else list(reversed(v)))
            f.material_index = mat
        # intrados strip
        v = [bm.verts.new((-hx, y0, za)), bm.verts.new((hx, y0, za)), bm.verts.new((hx, y1, zb)), bm.verts.new((-hx, y1, zb))]
        f = bm.faces.new(v)
        f.material_index = mat
        # top strip
        v = [bm.verts.new((-hx, y0, t0)), bm.verts.new((-hx, y1, t0)), bm.verts.new((hx, y1, t0)), bm.verts.new((hx, y0, t0))]
        f = bm.faces.new(v)
        f.material_index = mat
    # cornice (slab overhanging on both faces)
    if keep >= 1:
        box(bm, 0, 0, top + 0.35, depth + 0.9, W, 0.7, mat)


def place(coll, mesh, loc, rz, name):
    o = bpy.data.objects.new(name, mesh)
    o.location = loc
    o.rotation_euler = (0, 0, rz)
    coll.objects.link(o)
    return o


# ---------------------------------------------------------------------------- cloth (banners / swags)

def mat_banner(name, rgb=(0.3, 0.012, 0.024), shred=1.0, seed=0.0):
    """tattered crimson cloth (ref-3 #8a1a2a): UV u across, v down the hang (0 = top). Alpha cuts vertical shreds that
    grow toward the bottom and ragged side edges; a thin dull-gold band near the top; no emission (AOV 0)"""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    N, L = nt.nodes, nt.links
    b = next(n for n in N if n.type == 'BSDF_PRINCIPLED')
    uv = N.new('ShaderNodeUVMap')
    sep = N.new('ShaderNodeSeparateXYZ')
    L.new(uv.outputs['UV'], sep.inputs[0])
    # shred noise: stretched along the hang (vertical strips)
    mp = N.new('ShaderNodeMapping')
    mp.inputs['Scale'].default_value = (18.0 * shred, 1.6, 1.0)
    mp.inputs['Location'].default_value = (seed, seed * 0.37, 0)
    L.new(uv.outputs['UV'], mp.inputs['Vector'])
    nz = N.new('ShaderNodeTexNoise')
    nz.inputs['Scale'].default_value = 1.0
    nz.inputs['Detail'].default_value = 5
    nz.inputs['Roughness'].default_value = 0.65
    L.new(mp.outputs['Vector'], nz.inputs['Vector'])
    # holes: blotchy noise (burns / tears)
    mh = N.new('ShaderNodeMapping')
    mh.inputs['Scale'].default_value = (5.0, 3.0, 1.0)
    mh.inputs['Location'].default_value = (seed * 1.7, 0, 0)
    L.new(uv.outputs['UV'], mh.inputs['Vector'])
    nh = N.new('ShaderNodeTexNoise')
    nh.inputs['Scale'].default_value = 1.0
    nh.inputs['Detail'].default_value = 3
    L.new(mh.outputs['Vector'], nh.inputs['Vector'])
    # threshold rises with v: v^1.6 * 1.05
    pw = N.new('ShaderNodeMath')
    pw.operation = 'POWER'
    L.new(sep.outputs['Y'], pw.inputs[0])
    pw.inputs[1].default_value = 2.2
    th = N.new('ShaderNodeMath')
    th.operation = 'MULTIPLY_ADD'
    L.new(pw.outputs[0], th.inputs[0])
    th.inputs[1].default_value = 0.55 * shred
    th.inputs[2].default_value = 0.12
    # side edges: |u - 0.5| near 0.5 -> threshold up
    su = N.new('ShaderNodeMath')
    su.operation = 'SUBTRACT'
    L.new(sep.outputs['X'], su.inputs[0])
    su.inputs[1].default_value = 0.5
    ab = N.new('ShaderNodeMath')
    ab.operation = 'ABSOLUTE'
    L.new(su.outputs[0], ab.inputs[0])
    ed = N.new('ShaderNodeMapRange')
    ed.inputs['From Min'].default_value = 0.38
    ed.inputs['From Max'].default_value = 0.5
    ed.inputs['To Min'].default_value = 0.0
    ed.inputs['To Max'].default_value = 0.35
    L.new(ab.outputs[0], ed.inputs['Value'])
    t2 = N.new('ShaderNodeMath')
    t2.operation = 'ADD'
    L.new(th.outputs[0], t2.inputs[0])
    L.new(ed.outputs['Result'], t2.inputs[1])
    # holes add to the threshold where the blotch noise is high (below the top band)
    hr = N.new('ShaderNodeMapRange')
    hr.inputs['From Min'].default_value = 0.6
    hr.inputs['From Max'].default_value = 0.72
    hr.inputs['To Max'].default_value = 0.45
    L.new(nh.outputs['Fac'], hr.inputs['Value'])
    hv = N.new('ShaderNodeMath')
    hv.operation = 'MULTIPLY'
    L.new(hr.outputs['Result'], hv.inputs[0])
    L.new(sep.outputs['Y'], hv.inputs[1])
    t3 = N.new('ShaderNodeMath')
    t3.operation = 'ADD'
    L.new(t2.outputs[0], t3.inputs[0])
    L.new(hv.outputs[0], t3.inputs[1])
    gt = N.new('ShaderNodeMath')
    gt.operation = 'GREATER_THAN'
    L.new(nz.outputs['Fac'], gt.inputs[0])
    L.new(t3.outputs[0], gt.inputs[1])
    # colour: crimson with darker burnt edges near the cut threshold, a gold band at v 0.05..0.08
    burn = N.new('ShaderNodeMath')
    burn.operation = 'SUBTRACT'
    L.new(nz.outputs['Fac'], burn.inputs[0])
    L.new(t3.outputs[0], burn.inputs[1])
    br = N.new('ShaderNodeMapRange')
    br.inputs['From Min'].default_value = 0.0
    br.inputs['From Max'].default_value = 0.08
    br.inputs['To Min'].default_value = 0.35
    br.inputs['To Max'].default_value = 1.0
    L.new(burn.outputs[0], br.inputs['Value'])
    col = N.new('ShaderNodeVectorMath')
    col.operation = 'SCALE'
    col.inputs[0].default_value = rgb
    L.new(br.outputs['Result'], col.inputs['Scale'])
    band = N.new('ShaderNodeMapRange')
    band.interpolation_type = 'SMOOTHSTEP'
    L.new(sep.outputs['Y'], band.inputs['Value'])
    band.inputs['From Min'].default_value = 0.035
    band.inputs['From Max'].default_value = 0.045
    band2 = N.new('ShaderNodeMapRange')
    band2.interpolation_type = 'SMOOTHSTEP'
    L.new(sep.outputs['Y'], band2.inputs['Value'])
    band2.inputs['From Min'].default_value = 0.075
    band2.inputs['From Max'].default_value = 0.065
    bm_ = N.new('ShaderNodeMath')
    bm_.operation = 'MULTIPLY'
    L.new(band.outputs['Result'], bm_.inputs[0])
    L.new(band2.outputs['Result'], bm_.inputs[1])
    mix = N.new('ShaderNodeMix')
    mix.data_type = 'RGBA'
    L.new(bm_.outputs[0], mix.inputs['Factor'])
    L.new(col.outputs['Vector'], mix.inputs['A'])
    mix.inputs['B'].default_value = (0.22, 0.13, 0.03, 1)
    L.new(mix.outputs['Result'], b.inputs['Base Color'])
    L.new(gt.outputs[0], b.inputs['Alpha'])
    b.inputs['Roughness'].default_value = 0.85
    try:
        b.inputs['Sheen Weight'].default_value = 0.4
        b.inputs['Sheen Tint'].default_value = (1.0, 0.6, 0.6, 1)
    except Exception:
        pass
    _aov(nt, (0, 0, 0))
    return m


def cloth_strip(bm, uvl, pts_top, drop, segs_v=6, sway=0.0, mat=0, rnd=None):
    """a hanging cloth: pts_top = [(Vector top point)] along its width; each column hangs `drop` metres (scalar or
    per-point list) straight down with an optional sideways belly. UV u along the top line, v down (0 = top)."""
    n = len(pts_top)
    drops = drop if isinstance(drop, (list, tuple)) else [drop] * n
    grid = []
    for i, p in enumerate(pts_top):
        col = []
        for j in range(segs_v + 1):
            t = j / segs_v
            off = Vector((0, 0, -drops[i] * t))
            if sway:
                off += Vector((sway * math.sin(t * math.pi) * (rnd.uniform(0.6, 1.0) if rnd else 1.0), 0, 0))
            col.append(bm.verts.new(p + off))
        grid.append(col)
    for i in range(n - 1):
        for j in range(segs_v):
            f = bm.faces.new((grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]))
            f.material_index = mat
            for lp in f.loops:
                ii = i if lp.vert in (grid[i][j], grid[i][j + 1]) else i + 1
                jj = j if lp.vert in (grid[i][j], grid[i + 1][j]) else j + 1
                lp[uvl].uv = (ii / (n - 1), jj / segs_v)
    return grid


def banner(coll, mat, top, facing, w, h, rnd, name='banner'):
    """a long vertical banner hanging from `top` (Vector), its face toward `facing` (unit Vector, horizontal)"""
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new('UVMap')
    side = Vector((-facing.y, facing.x, 0)).normalized()
    pts = [top + side * (w * (k / 6 - 0.5)) + facing * 0.02 * math.sin(k * 1.3) for k in range(7)]
    cloth_strip(bm, uvl, pts, h, segs_v=8, rnd=rnd)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mat)
    o = bpy.data.objects.new(name, me)
    coll.objects.link(o)
    return o


def swag(coll, mat, p0, p1, sag, drop, rnd, name='swag'):
    """a shredded cloth swag hanging between two points (catenary-like top line, rags below)"""
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new('UVMap')
    n = 14
    pts, drops = [], []
    for k in range(n + 1):
        t = k / n
        p = p0.lerp(p1, t) + Vector((0, 0, -sag * 4 * t * (1 - t)))
        pts.append(p)
        drops.append(drop * (0.55 + 0.45 * math.sin(t * math.pi)) * rnd.uniform(0.8, 1.15))
    cloth_strip(bm, uvl, pts, drops, segs_v=5, rnd=rnd)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mat)
    o = bpy.data.objects.new(name, me)
    coll.objects.link(o)
    return o


def chain_line(bm, p0, p1, sag, link=0.9, mat=0):
    """a heavy chain as alternating flat boxes along a sagging line (silhouette only at backdrop distance)"""
    L_ = (p1 - p0).length
    n = max(2, int(L_ / link))
    prev = None
    for k in range(n + 1):
        t = k / n
        p = p0.lerp(p1, t) + Vector((0, 0, -sag * 4 * t * (1 - t)))
        if prev is not None:
            d = p - prev
            mid = (p + prev) / 2
            rz = math.atan2(d.y, d.x)
            ln = d.length
            ry = -math.atan2(d.z, math.hypot(d.x, d.y))
            vs = []
            sx, sy, sz = ln * 0.62, 0.12 if k % 2 else 0.42, 0.42 if k % 2 else 0.12
            for zz in (-sz / 2, sz / 2):
                for xx, yy in ((-sx / 2, -sy / 2), (sx / 2, -sy / 2), (sx / 2, sy / 2), (-sx / 2, sy / 2)):
                    v = Vector((xx, yy, zz))
                    v.rotate(Euler((0, ry, rz)))
                    vs.append(bm.verts.new(mid + v))
            for f in [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]:
                bm.faces.new([vs[i] for i in f]).material_index = mat
        prev = p


# ---------------------------------------------------------------------------- scene parts
# A8 RESCALE for the ref-3 framing (A6 README, A8 brief): from the ref-3 camera (game (-7.5, 1, -0.3), pitch 6.9,
# vFOV 44.7) ref-3 puts the ring-arch top at about 28 deg elevation, the ring centre at about 22 deg, the lintel between
# the pylons at about 17 deg, the arcade tops at 16-20 deg and the pylon feet at about 1.5 deg. At 81.5 m from that
# camera (arch at x 74) this gives: ring centre 33.5 m, ring centreline radius 8.2 m (+ 2.8 m section: outer 9.6),
# pylons at +-7.6 m (6.2 m wide), lintel top 26.5 m, portal crown 22.5 m; arcade storeys 7.4 m (3 storeys = 22 m at
# r 62 m: about 17 deg; the A6 README's 8.5 m put the arcade above ref-3's by-eye skyline in the game frame).

RC, RR, RT, RD = 33.5, 8.2, 2.8, 5.0          # ring centre height, centreline radius, radial section, depth (X)
PY, PW0, PW1, PD = 7.6, 6.2, 5.2, 6.5        # pylon centre |Y|, width at the foot / at the ring, depth (X)


def build_arch(coll, stone, metal, cloth, rnd):
    """the ring arch at azimuth 0 (ref-3): stepped podium, two tall pylons, a horseshoe ring on top framing the moon, a
    lintel bridge with a portal arch below, a hanging two-blade crescent sigil, crimson banners on the pylons"""
    X = ARCH_X
    bm = bmesh.new()
    # podium (the stair in ref-3 climbs to it; hidden behind the near-field dais from the arena)
    box(bm, X, 0, 1.4, PD + 10, 2 * (PY + PW0) + 8, 2.8, 0)
    box(bm, X, 0, 3.4, PD + 5, 2 * (PY + PW0) + 3, 1.2, 0)
    for s in (-1, 1):
        y = s * PY
        # stepped plinth + shaft (taper PW0 -> PW1), edge ribs, horizontal bands, a recessed panel on the front face
        box(bm, X, y, 5.5, PD + 2.2, PW0 + 2.2, 3.0, 0)
        box(bm, X, y, 7.6, PD + 1.2, PW0 + 1.2, 1.2, 0)
        box(bm, X, y, 8.2 + (RC - 8.2) / 2, PD, (PW0 + PW1) / 2, RC - 8.2, 0, taper=1 - PW1 / PW0)
        for k in (-1, 1):
            box(bm, X - PD / 2 - 0.35, y + k * ((PW0 + PW1) / 4 - 0.6), 8.2 + (RC - 8.2) / 2, 0.7, 1.0, RC - 8.2, 0)
        for zb in (14.0, 20.5, 27.0):
            w = PW0 + (PW1 - PW0) * (zb - 8.2) / (RC - 8.2)
            box(bm, X, y, zb, PD + 0.9, w + 0.9, 0.9, 0)
        # broken chunks knocked out of the outer edge (silhouette damage)
        for k in range(3):
            zc = rnd.uniform(11, 30)
            box(bm, X - PD / 2 + rnd.uniform(0.2, 1.0), y + s * ((PW0 + PW1) / 4 + 0.2), zc, 1.6, 1.2, rnd.uniform(0.8, 2.0), 0, rz=rnd.uniform(-0.3, 0.3))
    # the ring: upper half of a rectangular-section torus (theta 0..pi) + short legs down into the pylons
    n = 44
    rings = []
    for i in range(n + 1):
        th = math.pi * i / n
        cy, cz = RR * math.cos(th), RC + RR * math.sin(th)
        ny, nz = math.cos(th), math.sin(th)
        ring = []
        for dx, dr in ((-RD / 2, -RT / 2), (RD / 2, -RT / 2), (RD / 2, RT / 2), (-RD / 2, RT / 2)):
            ring.append(bm.verts.new((X + dx, cy + ny * dr, cz + nz * dr)))
        rings.append(ring)
    for i in range(n):
        A, B = rings[i], rings[i + 1]
        for k in range(4):
            bm.faces.new((A[k], A[(k + 1) % 4], B[(k + 1) % 4], B[k]))
    # outer moulding on the arena face of the ring, and a raised inner lip
    for i in range(0, n, 1):
        th0, th1 = math.pi * i / n, math.pi * (i + 1) / n
        thm = (th0 + th1) / 2
        for rad, sec, dz in ((RR + RT / 2 + 0.25, 0.6, 1.0), (RR - RT / 2 - 0.15, 0.4, 0.6)):
            cy, cz = rad * math.cos(thm), RC + rad * math.sin(thm)
            seg = rad * (th1 - th0) + 0.05
            vs = []
            t = Vector((0, -math.sin(thm), math.cos(thm)))
            nr = Vector((0, math.cos(thm), math.sin(thm)))
            c = Vector((X - RD / 2 - dz / 2 + 0.3, cy, cz))
            # simple box oriented along the tangent
            for xx in (-dz / 2, dz / 2):
                for a_, b_ in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                    vs.append(bm.verts.new(c + Vector((xx, 0, 0)) + t * (a_ * seg / 2) + nr * (b_ * sec / 2)))
            for f in [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]:
                bm.faces.new([vs[q] for q in f])
    # crown: a low keystone at the ring top
    box(bm, X, 0, RC + RR + RT / 2 + 0.4, RD + 0.6, 2.6, 1.2, 0, taper=0.15)
    # lintel bridge between the pylons + portal arch (springing 18 m, crown 22.5 m) + archivolt
    inner = PY - (PW0 + PW1) / 4
    box(bm, X, 0, 25.25, PD - 1.0, 2 * inner + 0.4, 2.5, 0)
    box(bm, X - 0.3, 0, 26.75, PD - 0.2, 2 * inner + 1.4, 0.5, 0)   # cornice
    a_ = inner
    hx = (PD - 1.6) / 2
    segs = 18
    pts = [(a_ * math.cos(math.pi - math.pi * k / segs), 18.0 + a_ * 1.0 * math.sin(math.pi - math.pi * k / segs)) for k in range(segs + 1)]
    for (y0, z0), (y1, z1) in zip(pts, pts[1:]):
        for x in (-hx, hx):
            v = [bm.verts.new((X + x, y0, z0)), bm.verts.new((X + x, y1, z1)), bm.verts.new((X + x, y1, 24.0)), bm.verts.new((X + x, y0, 24.0))]
            bm.faces.new(v if x > 0 else list(reversed(v)))
        bm.faces.new([bm.verts.new((X - hx, y0, z0)), bm.verts.new((X + hx, y0, z0)), bm.verts.new((X + hx, y1, z1)), bm.verts.new((X - hx, y1, z1))])
        ym, zm = (y0 + y1) / 2, (z0 + z1) / 2
        box(bm, X - hx - 0.3, ym * 1.08, zm + 0.45 * (1 if abs(ym) < a_ * 0.9 else 0), 0.6, abs(y1 - y0) + 0.5, 1.0, 0)
    arch = new_obj('ARCH', bm, [stone], coll)
    # crescent sigil: two curved blades hanging in front of the ring top, points down (ref-3)
    bm = bmesh.new()
    xs = X - RD / 2 - 1.6
    for s in (-1, 1):
        prof = []
        for k in range(18):
            t = k / 17
            z = RC + RR + RT / 2 + 2.6 - t * 15.0
            y = s * (0.35 + 1.5 * math.sin(t * math.pi * 0.85)) + s * 0.4 * t
            w = 0.75 * (1 - t) ** 0.7 + 0.08
            prof.append((y, z, w))
        verts = []
        for y, z, w in prof:
            verts.append([bm.verts.new((xs - 0.3, y - w, z)), bm.verts.new((xs - 0.3, y + w, z)), bm.verts.new((xs + 0.3, y + w, z)), bm.verts.new((xs + 0.3, y - w, z))])
        for A, B in zip(verts, verts[1:]):
            for k in range(4):
                bm.faces.new((A[k], A[(k + 1) % 4], B[(k + 1) % 4], B[k]))
        bm.faces.new(list(reversed(verts[0])))
        bm.faces.new(verts[-1])
        for k in (3, 7, 11):
            y, z, w = prof[k]
            box(bm, xs, y + s * (w + 0.7), z - 0.4, 0.4, 1.6, 0.35, 0, rz=0)
    new_obj('SIGIL', bm, [metal], coll)
    # crimson banners on the pylons' arena faces (ref-3: long red cloths on both pylons) + swags from the pylons
    for s in (-1, 1):
        top = bl(X - PD / 2 - 0.9, 30.5, -s * PY)
        banner(coll, cloth, top, Vector((-1, 0, 0)), 3.4, 17.0, rnd, f'pylon_banner{s}')
    return arch


def build_vista_pillars(coll, stone, iron, cloth, rnd):
    """two tall square pillars flanking the vista at r 38 m, azimuth +-24 (ref-3: the pillar behind the creature and
    the tall one at the right edge), long banners on their arena faces, heavy chains swagging to the arch pylons"""
    bm = bmesh.new()
    ch = bmesh.new()
    for s, h in ((-1, 22.0), (1, 25.0)):
        d = az_dir(24 * s)
        c = d * 38.0
        rz = math.atan2(d.y, d.x)
        box(bm, c.x, c.y, 0.9, 4.4, 4.4, 1.8, 0, rz=rz)
        box(bm, c.x, c.y, 2.2, 3.8, 3.8, 0.8, 0, rz=rz)
        box(bm, c.x, c.y, 2.6 + (h - 4.2) / 2, 3.0, 3.0, h - 4.2, 0, rz=rz, taper=0.04)
        box(bm, c.x, c.y, h - 1.0, 3.7, 3.7, 0.9, 0, rz=rz)
        box(bm, c.x, c.y, h - 0.2, 3.3, 3.3, 0.8, 0, rz=rz, taper=0.1)
        # broken blocks on the top
        for k in range(3):
            box(bm, c.x + rnd.uniform(-0.8, 0.8), c.y + rnd.uniform(-0.8, 0.8), h + 0.5 + rnd.uniform(0, 0.8), rnd.uniform(0.8, 1.6), rnd.uniform(0.8, 1.6), rnd.uniform(0.6, 1.4), 0, rz=rnd.uniform(0, 3))
        f = Vector((-d.x, -d.y, 0)).normalized()
        banner(coll, cloth, c + f * 1.65 + Vector((0, 0, h - 2.2)), f, 2.6, 13.0, rnd, f'vista_banner{s}')
        # short heavy chains hanging from the capital (ref-3's pillars carry chains; no long span across the sky: it
        # filled the skyline between the pillars and the arch)
        for k in (-1, 1):
            side = Vector((-f.y, f.x, 0)) * (1.3 * k)
            q0 = c + f * 1.9 + side + Vector((0, 0, h - 1.3))
            chain_line(ch, q0, q0 + Vector((0, 0, -5.5 - k * 1.2)) + f * 0.01, 0.0, link=1.0)
    new_obj('VISTA_PILLARS', bm, [stone], coll)
    new_obj('VISTA_CHAINS', ch, [iron], coll)


def build_arcade(coll, stone, fire, cloth, rnd, lights):
    """three-storey ruined colosseum arcade around the arena (r ARCADE_R, storeys 8.5 m), gap at the arch, broken tops,
    pilasters + storey cornices, rubble, banners and shredded swags near the arch, small tier fires"""
    W, H, PIER, DEPTH, SPRING = 5.2, 7.4, 1.35, 3.0, 3.0  # A8: 7.4 m storeys (22 m arcade: ref-3's skyline at about 18 deg)
    meshes = {}
    for variant in ('s3', 's3b', 's2', 's2b', 's1', 'stub'):
        bm = bmesh.new()
        st = {'s3': 3, 's3b': 3, 's2': 2, 's2b': 2, 's1': 1, 'stub': 1}[variant]
        for s in range(st):
            last = s == st - 1
            keep = 1.0 if not last or not variant.endswith('b') else rnd.uniform(0.3, 0.7)
            if variant == 'stub':
                box(bm, 0, -W / 2, 3.0, DEPTH, PIER, 6.0, 0)
                continue
            arch_bay(bm, W, H, PIER, DEPTH, SPRING, z0=s * H, keep=keep, rnd=rnd)
            # pilaster on the pier's arena face + impost block at the springing
            box(bm, -DEPTH / 2 - 0.18, -W / 2, s * H + H / 2, 0.36, PIER * 0.62, H - 0.4, 0)
            box(bm, -DEPTH / 2 - 0.1, -W / 2, s * H + SPRING, 0.5, PIER + 0.3, 0.35, 0)
        # back wall of the ground storey (dark corridor behind the openings)
        box(bm, 4.2, 0, H / 2, 0.8, W, H, 0)
        # broken pier stumps / jagged blocks on top of ruined bays
        if variant in ('s2b', 's3b', 's1'):
            for k in range(rnd.randint(1, 3)):
                box(bm, rnd.uniform(-0.6, 0.6), -W / 2 + rnd.uniform(-0.4, 1.4), st * H + rnd.uniform(0.6, 2.4), DEPTH * rnd.uniform(0.5, 0.9), PIER * rnd.uniform(0.6, 1.0), rnd.uniform(1.2, 3.6), 0, rz=rnd.uniform(-0.2, 0.2), taper=rnd.uniform(0.1, 0.5))
        meshes[variant] = new_obj(f'bay_{variant}', bm, [stone], coll)
        meshes[variant].hide_render = True  # template (instances below)
        meshes[variant].hide_viewport = True
    circ = 2 * math.pi * ARCADE_R
    n = int(circ / W)
    dth = 2 * math.pi / n
    tops = {}
    for i in range(n):
        th = i * dth
        az = -math.degrees(th)  # Blender angle th (CCW from +X toward +Y) = game azimuth -th
        aza = abs(((az + 180) % 360) - 180)
        if aza < 12.5:
            continue  # the arch's pylons stand here
        u = rnd.random()
        if aza < 75:
            v = 's3' if u < 0.4 else 's3b'
        elif aza < 125:
            v = 's3b' if u < 0.35 else ('s2' if u < 0.65 else 's2b')
        else:
            v = 's2b' if u < 0.4 else ('s1' if u < 0.7 else ('stub' if u < 0.9 else None))
        if v is None:
            continue
        r = ARCADE_R + rnd.uniform(-0.3, 0.3)
        o = place(coll, meshes[v].data, (r * math.cos(th), r * math.sin(th), 0), th, f'bay{i}')
        o.hide_render = False
        st = 3 if v.startswith('s3') else (2 if v.startswith('s2') else 1)
        tops[i] = (th, r, st * H if not v.endswith('b') else (st - 1) * H + H * 0.75, v)
        # rubble at the foot of broken bays
        if v.endswith('b') or v in ('s1', 'stub'):
            bm = bmesh.new()
            for k in range(rnd.randint(4, 9)):
                s = rnd.uniform(0.6, 2.4)
                box(bm, rnd.uniform(-3.5, 1.5), rnd.uniform(-3, 3), s * 0.35, s, s * rnd.uniform(0.6, 1.4), s * 0.7, 0, rz=rnd.uniform(0, 3), taper=rnd.uniform(0, 0.4))
            ob = new_obj(f'rubble{i}', bm, [stone], coll)
            ob.location = (r * math.cos(th), r * math.sin(th), 0)
            ob.rotation_euler = (0, 0, th)
        # fires on the tiers (ref-3: many small fires along the ruined tiers, mostly on the left of the hero view)
        left = -120 < az < -15 or 15 < az < 70
        if (left and rnd.random() < 0.42) or rnd.random() < 0.08:
            lvl = rnd.randint(0, st - 1)
            px, py = (r - 2.0) * math.cos(th), (r - 2.0) * math.sin(th)
            add_fire(coll, fire, (px, py, lvl * H + 0.05 + (0.5 if lvl else 0)), rnd, lights, size=rnd.uniform(0.8, 1.5))
        # long banners on some bays near the vista (ref-3: crimson cloths hanging down the arcade)
        if aza < 85 and v in ('s3', 's3b') and rnd.random() < 0.3:
            rr = r - DEPTH / 2 - 0.5
            yb = -W / 2 + PIER / 2 + 0.2
            p = Vector((rr * math.cos(th) - yb * math.sin(th), rr * math.sin(th) + yb * math.cos(th), 2 * H + H * 0.92))
            banner(coll, cloth, p, Vector((-math.cos(th), -math.sin(th), 0)), 2.2, rnd.uniform(9, 14), rnd, f'arc_banner{i}')
    # shredded swags between neighbouring tall bays near the vista, and from each pylon to the first arcade bay
    keys = sorted(tops)
    for a_i, b_i in zip(keys, keys[1:]):
        tha, ra, za, va = tops[a_i]
        thb, rb, zb, vb = tops[b_i]
        azm = abs(((-math.degrees((tha + thb) / 2) + 180) % 360) - 180)
        if b_i - a_i != 1 or a_i % 2 or azm > 70 or rnd.random() < 0.3:
            continue
        rr = ARCADE_R - DEPTH / 2 - 0.4
        p0 = Vector((rr * math.cos(tha - dth / 2), rr * math.sin(tha - dth / 2), min(za, zb) - 0.4))
        p1 = Vector((rr * math.cos(thb + dth / 2), rr * math.sin(thb + dth / 2), min(za, zb) - 0.4))
        swag(coll, cloth, p0, p1, rnd.uniform(1.0, 2.2), rnd.uniform(2.0, 4.0), rnd, f'swag{a_i}')
    for s in (-1, 1):
        # nearest bay top beside the arch on this side
        cand = [k for k in keys if abs(((-math.degrees(tops[k][0]) + 180) % 360) - 180) < 22 and (math.sin(tops[k][0]) * s) > 0]
        if not cand:
            continue
        k = min(cand, key=lambda q: abs(math.sin(tops[q][0])))
        th, r, z, _ = tops[k]
        rr = ARCADE_R - DEPTH / 2 - 0.4
        p0 = Vector((ARCH_X - PD / 2 - 0.5, s * (PY + PW1 / 2), 23.5))
        p1 = Vector((rr * math.cos(th), rr * math.sin(th), z - 0.6))
        swag(coll, cloth, p0, p1, 3.5, 3.5, rnd, f'pylon_swag{s}')


def add_fire(coll, fire, loc, rnd, lights, size=1.2):
    """a small fire: a few emissive flame cones (AOV R) + a warm point light"""
    bm = bmesh.new()
    for k in range(3):
        h = size * rnd.uniform(0.9, 1.6)
        ox, oy = rnd.uniform(-0.4, 0.4) * size, rnd.uniform(-0.4, 0.4) * size
        box(bm, ox, oy, h / 2, 0.5 * size, 0.5 * size, h, 0, rz=rnd.uniform(0, 3), taper=0.95)
    o = new_obj('fire', bm, [fire], coll)
    o.location = loc
    L = bpy.data.lights.new('fireL', 'POINT')
    L.energy = 700 * size
    L.color = FIRE_RGB
    L.shadow_soft_size = 0.6
    lo = bpy.data.objects.new('fireL', L)
    lo.location = (loc[0], loc[1], loc[2] + size * 1.2)
    coll.objects.link(lo)
    lights.append(lo)


def build_mid(coll, stone, win, water, rnd):
    """outer ruins 150-600 m: broken towers / spires, low walls, lit windows, a cliff + waterfall at azimuth 160"""
    bm = bmesh.new()
    wins = bmesh.new()
    for i in range(46):
        az = rnd.uniform(-180, 180)
        if abs(az) < 9:
            continue
        r = rnd.uniform(170, 420)
        d = az_dir(az)
        cx, cy = d.x * r, d.y * r
        h = rnd.uniform(25, 75) * (1.3 if abs(az) < 40 else 1.0)
        w = rnd.uniform(7, 16)
        rz = rnd.uniform(0, 3)
        box(bm, cx, cy, h / 2, w, w * rnd.uniform(0.7, 1.2), h, 0, rz=rz, taper=rnd.uniform(0.05, 0.25))
        if rnd.random() < 0.45:  # spire
            sh = rnd.uniform(12, 30)
            box(bm, cx, cy, h + sh / 2, w * 0.7, w * 0.7, sh, 0, rz=rz, taper=0.97)
        elif rnd.random() < 0.6:  # broken top chunks
            for k in range(3):
                box(bm, cx + rnd.uniform(-w, w) * 0.3, cy + rnd.uniform(-w, w) * 0.3, h + rnd.uniform(0, 4), w * 0.4, w * 0.3, rnd.uniform(2, 7), 0, rz=rnd.uniform(0, 3))
        # windows: small emissive slits facing the arena
        if rnd.random() < 0.5:
            for k in range(rnd.randint(1, 4)):
                z = rnd.uniform(0.3, 0.85) * h
                f = Vector((-d.x, -d.y, 0)).normalized()
                px, py = cx + f.x * (w * 0.5 + 0.2), cy + f.y * (w * 0.5 + 0.2)
                box(wins, px, py, z, 0.4, 1.4, 3.2, 0, rz=math.atan2(f.y, f.x))
    # low ruined curtain walls between some towers
    for i in range(30):
        az = rnd.uniform(-180, 180)
        r = rnd.uniform(150, 260)
        d = az_dir(az)
        L = rnd.uniform(20, 45)
        box(bm, d.x * r, d.y * r, 4, 4, L, rnd.uniform(6, 14), 0, rz=math.atan2(d.y, d.x))
    new_obj('MID_RUINS', bm, [stone], coll)
    new_obj('MID_WINDOWS', wins, [win], coll)
    # ground (mid ring 120-700 m)
    bm = bmesh.new()
    n = 64
    for i in range(n):
        a0, a1 = 2 * math.pi * i / n, 2 * math.pi * (i + 1) / n
        v = [bm.verts.new((r * math.cos(a), r * math.sin(a), -0.5)) for r, a in ((140, a0), (700, a0), (700, a1), (140, a1))]
        bm.faces.new(v)
    new_obj('MID_GROUND', bm, [stone], coll)
    # A8: the A6 test cliff + waterfall (azimuth 160) is gone: ref-3 has none (A6 decision 8)
    void_water = water  # noqa: F841 (kept for the AOV G path of other themes)


def build_far(coll, dark, rnd, clouds=True, quick=False):
    """mountain silhouettes 900-1500 m and storm-cloud volumes around the moon"""
    bm = bmesh.new()
    for i in range(36):
        az = i * 10 + rnd.uniform(-4, 4)
        r = rnd.uniform(900, 1400)
        d = az_dir(az)
        h = rnd.uniform(90, 260) * (0.55 if abs(((az + 180) % 360) - 180) < 25 else 1.0)
        w = rnd.uniform(200, 420)
        box(bm, d.x * r, d.y * r, h / 2 - 20, w * 0.6, w, h + 40, 0, rz=math.atan2(d.y, d.x) + rnd.uniform(-0.3, 0.3), taper=0.85)
    new_obj('MOUNTAINS', bm, [dark], coll)
    if not clouds:
        return
    # storm clouds: flattened noise volumes on a ring at 900-1300 m, heights 120-650 m; a clear hole at the moon
    md = az_dir(MOON_AZ, MOON_EL)
    k = 0
    for i in range(34 if not quick else 8):
        az = rnd.uniform(-75, 75) if i < 14 else rnd.uniform(-180, 180)
        el = rnd.uniform(5, 30)
        dirv = az_dir(az, el)
        if dirv.angle(md) < math.radians(6.5):
            continue
        r = rnd.uniform(950, 1300)
        p = dirv * r
        bpy.ops.mesh.primitive_cube_add(size=1, location=(p.x, p.y, max(120, p.z)))
        o = bpy.context.active_object
        o.name = f'cloud{k}'
        o.scale = (rnd.uniform(350, 650), rnd.uniform(700, 1300), rnd.uniform(110, 260))
        o.rotation_euler = (0, 0, math.atan2(dirv.y, dirv.x) + math.pi / 2 + rnd.uniform(-0.4, 0.4))
        o.data.materials.append(mat_cloud(f'cloudM{k}', density=rnd.uniform(0.012, 0.024), seed=rnd.uniform(0, 50)))
        for c in o.users_collection:
            c.objects.unlink(o)
        coll.objects.link(o)
        k += 1


def build_world(strength=1.0):
    """gradient night sky (approximates the colosseum's kit look in sky.ts: zenith #0a0d26, horizon #363866) for the
    ambient light; film is transparent, so the sky itself comes from sky.ts in game"""
    w = bpy.data.worlds.new('night')
    w.use_nodes = True
    nt = w.node_tree
    N, L = nt.nodes, nt.links
    bg = N.get('Background')
    tc = N.new('ShaderNodeTexCoord')
    sep = N.new('ShaderNodeSeparateXYZ')
    L.new(tc.outputs['Generated'], sep.inputs[0])
    ramp = N.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].position = 0.5
    ramp.color_ramp.elements[0].color = (0.036, 0.04, 0.13, 1)
    ramp.color_ramp.elements[1].position = 1.0
    ramp.color_ramp.elements[1].color = (0.003, 0.004, 0.02, 1)
    L.new(sep.outputs['Z'], ramp.inputs['Fac'])
    L.new(ramp.outputs['Color'], bg.inputs['Color'])
    bg.inputs['Strength'].default_value = strength
    bpy.context.scene.world = w


def build_moon(coll, energy=3.2):
    sun = bpy.data.lights.new('moon', 'SUN')
    sun.energy = energy
    sun.color = MOON_RGB
    sun.angle = math.radians(1.5)
    o = bpy.data.objects.new('moon', sun)
    d = az_dir(MOON_AZ, MOON_EL)
    o.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
    coll.objects.link(o)
    # a faint warm fill from the arena (the braziers light the inner faces of the arcade a little)
    fill = bpy.data.lights.new('arenaGlow', 'POINT')
    fill.energy = 3.0e3
    fill.color = (1.0, 0.45, 0.2)
    fill.shadow_soft_size = 12
    fo = bpy.data.objects.new('arenaGlow', fill)
    fo.location = (0, 0, 8)
    coll.objects.link(fo)
    return o


def build(opts):
    """Build the scene. Returns {'layers': {name: collection}, 'lights': collection, 'inset': camera spec, ...}."""
    rnd = random.Random(opts.get('seed', 3))
    quick = opts.get('quick', False)
    sc = bpy.context.scene
    colls = {}
    for name in ('near', 'mid', 'far', 'lights'):
        c = bpy.data.collections.new(f'L_{name}')
        sc.collection.children.link(c)
        colls[name] = c
    cc = None
    try:
        cc = abake.load_cc0('polyhaven/lichen_rock', need=('diff',))
    except Exception as ex:
        abake.log('lichen_rock scan unavailable, procedural stone only:', ex)
    stone = mat_stone('stone_near', STONE, cc, scale=2.5)
    stone_mid = mat_stone('stone_mid', STONE_FAR, cc, scale=6.0, macro=0.4)
    dark = mat_stone('stone_far', (0.035, 0.036, 0.05), None, macro=0.3, wet_base=False)
    fire = mat_emit('fire', FIRE_RGB, 1.7)
    win = mat_emit('window', (1.0, 0.42, 0.14), 1.4)
    metal = mat_metal('sigil_iron', (0.05, 0.045, 0.05))
    water = mat_water('water')
    cloth = mat_banner('banner_crimson')
    lights = []
    build_arch(colls['near'], stone, metal, cloth, rnd)
    build_arcade(colls['near'], stone, fire, cloth, rnd, lights)
    build_vista_pillars(colls['near'], stone, metal, cloth, rnd)
    # near ground disc 34-140 m (under the arcade; the arena itself covers the inside)
    bm = bmesh.new()
    n = 96
    for i in range(n):
        a0, a1 = 2 * math.pi * i / n, 2 * math.pi * (i + 1) / n
        v = [bm.verts.new((r * math.cos(a), r * math.sin(a), -0.05)) for r, a in ((34, a0), (140, a0), (140, a1), (34, a1))]
        bm.faces.new(v)
    new_obj('NEAR_GROUND', bm, [stone], colls['near'])
    build_mid(colls['mid'], stone_mid, win, water, rnd)
    build_far(colls['far'], dark, rnd, clouds=opts.get('clouds', True), quick=quick)
    build_world(opts.get('world', 1.7))
    build_moon(colls['lights'], opts.get('moon', 3.2))
    # fire lights belong to the near layer's collection already; keep them in the lights collection too so they
    # light the mid layer's nearest ruins (visible to every view layer)
    for lo in lights:
        for c in list(lo.users_collection):
            c.objects.unlink(lo)
        colls['lights'].objects.link(lo)
    return {
        'layers': {k: colls[k] for k in ('near', 'mid', 'far')},
        'lights': colls['lights'],
        'ranges': {'near': [34, 160], 'mid': [140, 700], 'far': [600, 1600]},
        'fires': len(lights),
    }
