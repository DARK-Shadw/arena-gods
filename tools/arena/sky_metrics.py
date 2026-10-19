"""A7c sky metrics: the concept's sky vs a game render, inside the spec's sky boxes (pure-sky rectangles of the concept,
tools/arena/sky/<id>.json palette.boxes, in concept pixels).

  python tools/arena/sky_metrics.py --spec tools/arena/sky/moongate.json --game <render.png> [--game <other.png> ...]

Per image (resized to the concept size):
  S1 colour   Delta E (CIE76) between the median Lab of the boxes (concept vs game)        lower is better
  S2 texture  std of L* inside each box, averaged (cloud detail; the concept is the target)  ratio game / concept
  S3 glow     mean L* of the box nearest the moon / mean L* of the other boxes            ratio game / concept
  S4 range    L* p5 .. p95 over all boxes                                                   (info)
The game render should be a sky-only frame (concept.cjs writes game/<ref>_q<n>_skyonly.png) to judge the sky itself,
or the full frame to judge what the player sees (architecture covers part of the boxes there).
"""
import argparse
import json
import os

import numpy as np
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))


def lab(rgb):
    c = rgb / 255.0
    c = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    M = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
    xyz = c @ M.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)


def stats(img, boxes, moon_box):
    L = lab(np.asarray(img, np.float64))
    per = [L[y0:y1, x0:x1].reshape(-1, 3) for x0, y0, x1, y1 in boxes]
    allp = np.concatenate(per)
    med = np.median(allp, 0)
    tex = float(np.mean([p[:, 0].std() for p in per]))
    near = per[moon_box][:, 0].mean()
    far = np.concatenate([p for i, p in enumerate(per) if i != moon_box])[:, 0].mean()
    return {'medLab': [round(float(v), 1) for v in med], 'texture': round(tex, 2), 'glow': round(float(near / max(far, 1e-3)), 2), 'range': [round(float(np.percentile(allp[:, 0], 5)), 1), round(float(np.percentile(allp[:, 0], 95)), 1)]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--spec', default=os.path.join(ROOT, 'tools', 'arena', 'sky', 'moongate.json'))
    ap.add_argument('--game', action='append', required=True)
    ap.add_argument('--json', default=None)
    a = ap.parse_args()
    spec = json.load(open(a.spec))
    P = spec['palette']
    ref = Image.open(os.path.join(ROOT, P['ref'])).convert('RGB')
    boxes = P['boxes']
    mx, my = spec.get('metrics', {}).get('moonPx', [ref.size[0] * 0.69, ref.size[1] * 0.07])
    moon_box = int(np.argmin([((x0 + x1) / 2 - mx) ** 2 + ((y0 + y1) / 2 - my) ** 2 for x0, y0, x1, y1 in boxes]))
    R = stats(ref, boxes, moon_box)
    out = {'concept': R, 'games': {}}
    print(f'concept  medLab {R["medLab"]}  texture {R["texture"]}  glow {R["glow"]}  L* p5..p95 {R["range"]}')
    for g in a.game:
        im = Image.open(g).convert('RGB').resize(ref.size, Image.LANCZOS)
        S = stats(im, boxes, moon_box)
        dE = float(np.linalg.norm(np.array(S['medLab']) - np.array(R['medLab'])))
        S.update(S1_dE=round(dE, 1), S2_texture_ratio=round(S['texture'] / R['texture'], 2), S3_glow_ratio=round(S['glow'] / R['glow'], 2))
        out['games'][g] = S
        print(f'{os.path.basename(g):28s} S1 dE {S["S1_dE"]:5.1f}  S2 texture {S["texture"]:5.2f} (x{S["S2_texture_ratio"]})  S3 glow {S["glow"]:4.2f} (x{S["S3_glow_ratio"]})  medLab {S["medLab"]}  L* {S["range"]}')
    if a.json:
        json.dump(out, open(a.json, 'w'), indent=1)


if __name__ == '__main__':
    main()
