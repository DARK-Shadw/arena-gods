"""Calibrate the concept camera presets (arena art plan 3.3, milestone A0).

    python -I tools/arena/calibrate.py [--write] [--measured docs/milestones/A0/concept/info.json]

Reads the by-eye annotations in tools/arena/concept_targets.json and the preset rows between
CALIBRATED-BEGIN / CALIBRATED-END in src/render/arena/conceptCams.ts, then for every preset:
  1. vFOV from the hFOV estimate and the image aspect,
  2. pitch from the horizon line          pitch = atan((y_h - 0.5) * 2 * tan(vfov / 2)),
  3. yaw so the azimuth-0 landmark (at its plan distance, eye height) lands on the annotated x,
  4. camera height from the opponent used as a ruler (feet + head on screen, assumed height hB),
  5. B mark = the feet ray cast onto the floor; A mark = the feet ray (when visible) or the head ray
     cast onto the plane at A's head height (the game fighter's measured height when --measured
     is given, so the game head lands where the concept head is).
Camera x / z stay as in the plan (behind the west start mark). Roll is kept from the preset.
Prints the rows; --write replaces the block in conceptCams.ts.
Projection maths = conceptBasis() in conceptCams.ts (keep them in sync).
"""
import argparse
import json
import math
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
TS = os.path.join(ROOT, 'src', 'render', 'arena', 'conceptCams.ts')
TARGETS = os.path.join(ROOT, 'tools', 'arena', 'concept_targets.json')
D = math.pi / 180
WALL_OFF = 1.0   # visual boundary sits about 1 m outside the sim ellipse (dressClassic alongEllipse offsets 0.76-1.15)
A_HEAD_MIN_Y = 0.12  # foreground fighter's head kept at least this far below the frame top
SHOULDER = 0.6   # assumed shoulder span of the foreground fighter incl. armour (m)


def basis(yaw, pitch, roll):
    y, p, r = yaw * D, pitch * D, roll * D
    f = (math.cos(p) * math.cos(y), math.sin(p), math.cos(p) * math.sin(y))
    # right = f x up(0,1,0) = (-f.z, 0, f.x)
    rt = (-f[2], 0.0, f[0])
    n = math.hypot(rt[0], rt[2])
    rt = (rt[0] / n, 0.0, rt[2] / n)
    up = cross(rt, f)
    r2 = tuple(rt[i] * math.cos(r) + up[i] * math.sin(r) for i in range(3))
    u2 = tuple(up[i] * math.cos(r) - rt[i] * math.sin(r) for i in range(3))
    return f, r2, u2


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


class Cam:
    def __init__(self, pos, yaw, pitch, roll, vfov, aspect):
        self.pos, self.yaw, self.pitch, self.roll, self.vfov, self.aspect = list(pos), yaw, pitch, roll, vfov, aspect
        self.f, self.r, self.u = basis(yaw, pitch, roll)
        self.ty = math.tan(vfov * D / 2)
        self.tx = self.ty * aspect

    def project(self, P):
        d = [P[i] - self.pos[i] for i in range(3)]
        z = dot(d, self.f)
        if z <= 1e-6:
            return 0.5, -10.0
        return 0.5 + dot(d, self.r) / (z * self.tx) / 2, 0.5 - dot(d, self.u) / (z * self.ty) / 2

    def ray(self, sx, sy):
        nx, ny = (sx - 0.5) * 2 * self.tx, (0.5 - sy) * 2 * self.ty
        return [self.f[i] + self.r[i] * nx + self.u[i] * ny for i in range(3)]

    def hit_plane(self, sx, sy, h):
        d = self.ray(sx, sy)
        if abs(d[1]) < 1e-9:
            return None
        t = (h - self.pos[1]) / d[1]
        if t <= 0:
            return None
        return [self.pos[i] + d[i] * t for i in range(3)]


def bisect(fn, lo, hi, target, it=80):
    a, b = lo, hi
    fa = fn(a) - target
    for _ in range(it):
        m = (a + b) / 2
        fm = fn(m) - target
        if (fm < 0) == (fa < 0):
            a, fa = m, fm
        else:
            b = m
    return (a + b) / 2


def js_to_json(row):
    s = re.sub(r"'([^']*)'", r'"\1"', row)
    s = re.sub(r'([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:', r'\1"\2":', s)
    return json.loads(s)


def fmt(v):
    if isinstance(v, float):
        s = f'{v:.2f}'.rstrip('0').rstrip('.')
        return s if s not in ('-0', '') else '0'
    return str(v)


def to_js(p):
    def mark(m):
        return 'null' if m is None else f"{{ id: '{m['id']}', x: {fmt(m['x'])}, z: {fmt(m['z'])} }}"
    pos = ', '.join(fmt(x) for x in p['pos'])
    stand = f", standIn: '{p['standIn']}'" if p.get('standIn') else ''
    return (f"  {{ id: '{p['id']}', image: '{p['image']}', w: {p['w']}, h: {p['h']}, theme: '{p['theme']}'{stand}, layout: '{p['layout']}', "
            f"aseed: {p['aseed']}, seed: {p['seed']}, vfov: {fmt(p['vfov'])}, pos: [{pos}], yaw: {fmt(p['yaw'])}, pitch: {fmt(p['pitch'])}, "
            f"roll: {fmt(p['roll'])}, a: {mark(p['a'])}, b: {mark(p['b'])}, landmarkDist: {p['landmarkDist']} }},")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--write', action='store_true')
    ap.add_argument('--measured', help='info.json from tools/shots/concept.cjs (game fighter heights)')
    a = ap.parse_args()
    T = json.load(open(TARGETS, encoding='utf-8'))
    src = open(TS, encoding='utf-8').read()
    m = re.search(r'// CALIBRATED-BEGIN\n(.*?)// CALIBRATED-END', src, re.S)
    rows = [js_to_json(l.strip().rstrip(',')) for l in m.group(1).splitlines() if l.strip().startswith('{')]
    heights = {}
    if a.measured:
        for info in json.load(open(a.measured, encoding='utf-8')):
            for f in info.get('fighters') or []:
                if f:
                    heights[f['id']] = max(heights.get(f['id'], 0), f['topY'])
    out = []
    report = []
    # pre-A2b semi-axes times ARENA_SCALE (src/sim/arenaGen.ts, A2b: arenas grew)
    gen = open(os.path.join(ROOT, 'src', 'sim', 'arenaGen.ts'), encoding='utf-8').read()
    sc = float(re.search(r'export const ARENA_SCALE = ([0-9.]+);', gen).group(1))
    RXZ = {k: (v[0] * sc, v[1] * sc) for k, v in {'pit': (12.3, 12.3), 'oval': (14.5, 10.5), 'gauntlet': (15.5, 7.8), 'split': (12.6, 12.6), 'cross': (12.3, 12.3)}.items()}
    for p in rows:
        t = T[p['id']]
        w, h = t['size']
        aspect = w / h
        vfov = 2 * math.atan(math.tan(t['hfov'] * D / 2) / aspect) / D
        roll = p['roll']
        x0, z0 = p['pos'][0], p['pos'][2]
        L = p['landmarkDist']
        rx, rz = RXZ[p['layout']]
        rx, rz = rx + WALL_OFF, rz + WALL_OFF
        B = t.get('B')
        st = {'h': t.get('camH', p['pos'][1]), 'pitch': 0.0, 'yaw': p['yaw']}

        def cam(hh, pitch, yaw):
            return Cam([x0, hh, z0], yaw, pitch, roll, vfov, aspect)

        def edge_v(hh, pitch, yaw):
            c = cam(hh, pitch, yaw)
            d = c.ray(t['edge'][0], 0.5)
            az = math.atan2(d[2], d[0])
            ca, sa = math.cos(az), math.sin(az)
            # ((x0 + s ca) / rx)^2 + ((z0 + s sa) / rz)^2 = 1
            A2 = (ca / rx) ** 2 + (sa / rz) ** 2
            B2 = 2 * (x0 * ca / rx ** 2 + z0 * sa / rz ** 2)
            C2 = (x0 / rx) ** 2 + (z0 / rz) ** 2 - 1
            s_ = (-B2 + math.sqrt(B2 * B2 - 4 * A2 * C2)) / (2 * A2)
            return c.project([x0 + s_ * ca, 0.0, z0 + s_ * sa])[1]

        def ruler_pitch(hh, yaw):
            def head_v(pitch):
                c = cam(hh, pitch, yaw)
                P = c.hit_plane(B['foot'][0], B['foot'][1], 0.0)
                if P is None:
                    return -1.0
                return c.project([P[0], B['hB'], P[2]])[1]
            ty = math.tan(vfov * D / 2)
            pmax = math.atan((B['foot'][1] - 0.5) * 2 * ty) / D - 0.5
            return bisect(head_v, -12, pmax, B['head'][1])

        for _ in range(6):
            if B:
                def resid(hh):
                    pt = ruler_pitch(hh, st['yaw'])
                    return edge_v(hh, pt, st['yaw'])
                st['h'] = bisect(resid, 0.35, 3.5, t['edge'][1])
                st['pitch'] = ruler_pitch(st['h'], st['yaw'])
            else:
                st['pitch'] = bisect(lambda pt: edge_v(st['h'], pt, st['yaw']), -25, 35, t['edge'][1])
            st['yaw'] = bisect(lambda y: cam(st['h'], st['pitch'], y).project([L, st['h'], 0])[0], 70, -70, t['landmark']['x'])
        camh, pitch, yaw = st['h'], st['pitch'], st['yaw']
        c = cam(camh, pitch, yaw)
        bm = None
        if B:
            P = c.hit_plane(B['foot'][0], B['foot'][1], 0.0)
            bm = {'id': p['b']['id'], 'x': P[0], 'z': P[2]}
        A = t['A']
        if A.get('foot'):
            P = c.hit_plane(A['foot'][0], A['foot'][1], 0.0)
        else:
            # the concept's foreground fighter is drawn hunched and huge: an upright game fighter at the
            # shoulder-width distance pokes out of the frame top, so back it off until its head is at
            # A_HEAD_MIN_Y (whole fighter in frame, still the over-the-shoulder silhouette)
            hA0 = heights.get(p['a']['id'], 1.85)
            d = c.ray(A['head'][0], 0.75)
            d = [d[0], 0.0, d[2]]
            n = math.hypot(d[0], d[2])
            d = [d[0] / n, 0.0, d[2] / n]
            dist0 = SHOULDER / (A['shoulderW'] * 2 * c.tx)
            head_at = lambda k: c.project([c.pos[0] + d[0] * k, hA0, c.pos[2] + d[2] * k])[1]
            dist = dist0 if head_at(dist0) >= A_HEAD_MIN_Y else bisect(head_at, dist0, 12.0, A_HEAD_MIN_Y)
            P = [c.pos[0] + d[0] * dist, 0.0, c.pos[2] + d[2] * dist]
        am = {'id': p['a']['id'], 'x': P[0], 'z': P[2]}
        hA = heights.get(p['a']['id'], 1.85)
        aHeadV = c.project([am['x'], hA, am['z']])[1]
        horizonV = c.project([x0 + 1e5 * math.cos(yaw * D), camh, z0 + 1e5 * math.sin(yaw * D)])[1]
        q = dict(p, vfov=vfov, pos=[x0, camh, z0], yaw=yaw, pitch=pitch, roll=roll, a=am, b=bm)
        out.append(q)
        dAB = math.hypot(bm['x'] - am['x'], bm['z'] - am['z']) if bm else float('nan')
        dB = math.hypot(bm['x'] - x0, bm['z'] - z0) if bm else float('nan')
        dA = math.hypot(am['x'] - x0, am['z'] - z0)
        report.append(f"{p['id']:6s} vfov {vfov:5.1f} pitch {pitch:+5.1f} yaw {yaw:+6.1f} camH {camh:4.2f} horizon y {horizonV:.3f} (eye guess {t['horizonEye']:.2f})"
                      f"  A@{dA:4.1f} m (game head y {aHeadV:.2f} vs concept {A['head'][1]:.2f})  B@{dB:4.1f} m  A-B {dAB:4.1f} m")
    print('\n'.join(report))
    block = '// CALIBRATED-BEGIN\nexport const CONCEPT_PRESETS: ConceptPreset[] = [\n' + '\n'.join(to_js(q) for q in out) + '\n];\n'
    print(block)
    if a.write:
        src2 = src[:m.start()] + block + src[m.end() - len('// CALIBRATED-END'):]
        open(TS, 'w', encoding='utf-8', newline='').write(src2)
        print('written', TS)


if __name__ == '__main__':
    sys.exit(main())
