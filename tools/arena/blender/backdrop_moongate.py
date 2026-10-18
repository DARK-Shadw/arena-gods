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
  far   (> 600 m)   mountain silhouettes and STORM CLOUDS (Cycles volumes) lit from behind by the moon, a clear hole
                    around the moon itself
The moon disc is NOT rendered: sky.ts draws it behind the far layer (the moon sun lamp here only lights the scene).
It is a BLOCKOUT for A6's pipeline test. A8 builds the real scene from the kit (plan A8 row).

AOV `aov` (COLOR): R = emission to animate (fires, windows: flicker), G = water (waterfall flow), B = cloud (drift).
"""
import math
import random

import bmesh
import bpy
from mathutils import Euler, Vector

import abake

# ---------------------------------------------------------------------------- frame / colours (plan 3.1 Moon Gate)
MOON_AZ, MOON_EL = -1.7, 27.0
MOON_RGB = (0.85, 0.83, 1.0)            # #d8d4ff
STONE = (0.12, 0.12, 0.155)            # linear albedo, dark blue-grey (moonlit stone reads violet-grey)
STONE_FAR = (0.07, 0.072, 0.09)
FIRE_RGB = (1.0, 0.36, 0.09)
ARCH_X = 74.0                           # arch distance (plan: 70 m, 60 m tall)
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


# ---------------------------------------------------------------------------- scene parts

def build_arch(coll, stone, metal):
    """the ring arch at azimuth 0: pylons + ring + portal + crescent sigil (ref-3, plan 1.1)"""
    X = ARCH_X
    bm = bmesh.new()
    PY, PW, PD, PH = 12.0, 8.0, 7.0, 46.0     # pylon centre |Y|, width, depth, height
    for s in (-1, 1):
        y = s * PY
        box(bm, X, y, 6, PD + 4, PW + 4, 12, 0)                # stepped plinth
        box(bm, X, y, 13, PD + 2, PW + 2, 2.4, 0)
        box(bm, X, y, PH / 2, PD, PW, PH, 0, taper=0.08)        # shaft
        # recessed panel ribs
        for k in (-1, 1):
            box(bm, X - PD / 2 - 0.4, y + k * (PW / 2 - 0.9), 30, 0.8, 1.2, 30, 0)
        box(bm, X, y, PH + 1.2, PD + 1.6, PW + 1.6, 2.4, 0)     # capital
    # ring: square-section torus in the X = const plane, centre height RC
    RC, R, T = 43.0, 12.0, 5.0
    n = 56
    rings = []
    for i in range(n):
        th = 2 * math.pi * i / n
        cy, cz = R * math.cos(th), RC + R * math.sin(th)
        ny, nz = math.cos(th), math.sin(th)
        ring = []
        for dx, dr in ((-PD / 2, -T / 2), (PD / 2, -T / 2), (PD / 2, T / 2), (-PD / 2, T / 2)):
            ring.append(bm.verts.new((X + dx, cy + ny * dr, cz + nz * dr)))
        rings.append(ring)
    for i in range(n):
        A, B = rings[i], rings[(i + 1) % n]
        for k in range(4):
            bm.faces.new((A[k], A[(k + 1) % 4], B[(k + 1) % 4], B[k]))
    # crown spikes on the ring top
    for i in range(-3, 4):
        th = math.pi / 2 + i * 0.16
        cy, cz = (R + T / 2) * math.cos(th), RC + (R + T / 2) * math.sin(th)
        h = 4.5 - abs(i) * 0.9
        box(bm, X, cy, cz + h / 2, 2.2, 1.6, h, 0, rz=0, taper=0.9)
    # portal: lintel block between the pylons under the ring + arched opening sides
    box(bm, X, 0, 27.5, PD - 1.0, 2 * PY - PW, 3.0, 0)
    # portal arch under the lintel: a semicircular spandrel between the pylons (springing at 15 m), a moulded archivolt
    a_ = PY - PW / 2
    hx = (PD - 1.6) / 2
    segs = 20
    pts = [(a_ * math.cos(math.pi - math.pi * k / segs), 15.0 + a_ * 0.92 * math.sin(math.pi - math.pi * k / segs)) for k in range(segs + 1)]
    for (y0, z0), (y1, z1) in zip(pts, pts[1:]):
        for x in (-hx, hx):
            v = [bm.verts.new((X + x, y0, z0)), bm.verts.new((X + x, y1, z1)), bm.verts.new((X + x, y1, 26.0)), bm.verts.new((X + x, y0, 26.0))]
            bm.faces.new(v if x > 0 else list(reversed(v)))
        bm.faces.new([bm.verts.new((X - hx, y0, z0)), bm.verts.new((X + hx, y0, z0)), bm.verts.new((X + hx, y1, z1)), bm.verts.new((X - hx, y1, z1))])
        # archivolt ring (a raised band on the arena face)
        ym, zm = (y0 + y1) / 2, (z0 + z1) / 2
        box(bm, X - hx - 0.35, ym * 1.06, zm + 0.5, 0.7, abs(y1 - y0) + 0.5, 1.4, 0)
    arch = new_obj('ARCH', bm, [stone], coll)
    # crescent sigil: two curved blades hanging from the ring top
    bm = bmesh.new()
    for s in (-1, 1):
        prof = []
        for k in range(14):
            t = k / 13
            z = 52.5 - t * 17.0
            y = s * (1.2 + 2.6 * math.sin(t * math.pi * 0.9))
            w = 0.9 * (1 - t) + 0.12
            prof.append((y, z, w))
        verts = []
        for y, z, w in prof:
            verts.append([bm.verts.new((X - 1.4, y - w, z)), bm.verts.new((X - 1.4, y + w, z)), bm.verts.new((X - 0.8, y + w, z)), bm.verts.new((X - 0.8, y - w, z))])
        for A, B in zip(verts, verts[1:]):
            for k in range(4):
                bm.faces.new((A[k], A[(k + 1) % 4], B[(k + 1) % 4], B[k]))
        bm.faces.new(list(reversed(verts[0])))
        bm.faces.new(verts[-1])
        # barbs
        for k in (4, 8, 11):
            y, z, w = prof[k]
            box(bm, X - 1.1, y + s * (w + 0.8), z, 0.5, 1.8, 0.45, 0, rz=0)
    box(bm, X - 1.1, 0, 53.5, 0.8, 4.0, 1.2, 0)
    new_obj('SIGIL', bm, [metal], coll)
    return arch


def build_arcade(coll, stone, fire, rnd, lights):
    """three-storey ruined colosseum arcade around the arena (r ARCADE_R), gap at the arch, broken tops, rubble"""
    W, H, PIER, DEPTH, SPRING = 6.4, 12.0, 1.7, 3.2, 5.0
    meshes = {}
    for variant in ('s3', 's3b', 's2', 's2b', 's1', 'stub'):
        bm = bmesh.new()
        st = {'s3': 3, 's3b': 3, 's2': 2, 's2b': 2, 's1': 1, 'stub': 1}[variant]
        for s in range(st):
            last = s == st - 1
            keep = 1.0 if not last or not variant.endswith('b') else rnd.uniform(0.3, 0.7)
            if variant == 'stub':
                box(bm, 0, -W / 2, 3.5, DEPTH, PIER, 7.0, 0)
                continue
            arch_bay(bm, W, H, PIER, DEPTH, SPRING, z0=s * H, keep=keep, rnd=rnd)
        # back wall of the ground storey (dark corridor behind the openings)
        box(bm, 4.5, 0, H / 2, 0.8, W, H, 0)
        # broken pier stump on top of ruined bays
        if variant in ('s2b', 's3b', 's1'):
            box(bm, 0, -W / 2, st * H + 2.0, DEPTH * 0.9, PIER * 0.9, 4.0 * rnd.uniform(0.5, 1.0), 0, taper=0.3)
        meshes[variant] = new_obj(f'bay_{variant}', bm, [stone], coll)
        meshes[variant].hide_render = True  # template (instances below)
        meshes[variant].hide_viewport = True
    circ = 2 * math.pi * ARCADE_R
    n = int(circ / W)
    dth = 2 * math.pi / n
    # a ruin profile around the ring: tall near the arch (the concept frames the arch with full storeys), lower and
    # broken toward the back, with a few gaps
    for i in range(n):
        th = i * dth
        az = -math.degrees(th)  # Blender angle th (CCW from +X toward +Y) = game azimuth -th
        aza = abs(((az + 180) % 360) - 180)
        if aza < 13:
            continue  # the arch's pylons stand here
        u = rnd.random()
        if aza < 70:
            v = 's3' if u < 0.45 else 's3b'
        elif aza < 120:
            v = 's3b' if u < 0.4 else ('s2' if u < 0.7 else 's2b')
        else:
            v = 's2b' if u < 0.4 else ('s1' if u < 0.7 else ('stub' if u < 0.9 else None))
        if v is None:
            continue
        r = ARCADE_R + rnd.uniform(-0.3, 0.3)
        o = place(coll, meshes[v].data, (r * math.cos(th), r * math.sin(th), 0), th, f'bay{i}')
        o.hide_render = False
        # rubble at the foot of broken bays
        if v.endswith('b') or v in ('s1', 'stub'):
            bm = bmesh.new()
            for k in range(rnd.randint(3, 7)):
                s = rnd.uniform(0.8, 2.6)
                box(bm, rnd.uniform(-3, 1.5), rnd.uniform(-3, 3), s * 0.4, s, s * rnd.uniform(0.6, 1.4), s * 0.8, 0, rz=rnd.uniform(0, 3))
            ob = new_obj(f'rubble{i}', bm, [stone], coll)
            ob.location = (r * math.cos(th), r * math.sin(th), 0)
            ob.rotation_euler = (0, 0, th)
        # fires on the tiers (ref-3: small fires along the ruined tiers, mostly on the left of the hero view)
        left = -110 < az < -20 or 20 < az < 60
        if (left and rnd.random() < 0.28) or rnd.random() < 0.06:
            st = 3 if v.startswith('s3') else (2 if v.startswith('s2') else 1)
            lvl = rnd.randint(0, st - 1)
            z = lvl * H + 0.7 + (H if lvl < st - 1 else 0) * 0
            px, py = (r - 2.2) * math.cos(th), (r - 2.2) * math.sin(th)
            add_fire(coll, fire, (px, py, lvl * H + 0.05 + (0.7 if lvl else 0)), rnd, lights, size=rnd.uniform(0.9, 1.6))


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
    # cliff + waterfall behind the arena (azimuth 160, 300 m)
    d = az_dir(160)
    c = d * 300
    bm = bmesh.new()
    box(bm, c.x, c.y, 45, 50, 160, 90, 0, rz=math.atan2(d.y, d.x), taper=0.15)
    for k in range(8):
        box(bm, c.x + rnd.uniform(-30, 30), c.y + rnd.uniform(-70, 70), rnd.uniform(20, 70), 30, 30, rnd.uniform(30, 60), 0, rz=rnd.uniform(0, 3), taper=0.3)
    new_obj('CLIFF', bm, [stone], coll)
    bm = bmesh.new()
    f = Vector((-d.x, -d.y, 0)).normalized()
    side = Vector((-f.y, f.x, 0))
    for k, (off, wdt) in enumerate(((-28, 9), (6, 14), (34, 6))):
        base = c + f * 26.5 + side * off
        v = [bm.verts.new(base + side * (-wdt / 2) + Vector((0, 0, z))) for z in (0,)]
        v = [bm.verts.new(base + side * (-wdt / 2)), bm.verts.new(base + side * (wdt / 2)),
             bm.verts.new(base + side * (wdt / 2) + Vector((0, 0, 84))), bm.verts.new(base + side * (-wdt / 2) + Vector((0, 0, 84)))]
        bm.faces.new(v)
    new_obj('WATERFALL', bm, [water], coll)


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
    lights = []
    build_arch(colls['near'], stone, metal)
    build_arcade(colls['near'], stone, fire, rnd, lights)
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
