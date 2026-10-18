"""Stick-figure filmstrips of clips from poses.json (written by analyze.ts).

    python tools/anim/filmstrip.py <poses.json> <outDir> [filterSubstring] [perSheet]

One row per clip: 8 evenly spaced poses, drawn from the side (x = forward z, y = up)
with a thin top view under each, so strikes / reaches / falls are readable at a glance.
"""
import json, os, sys
from PIL import Image, ImageDraw

J = ['Hips', 'Spine2', 'Neck', 'Head', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand',
     'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot', 'LeftToeBase', 'RightToeBase']
I = {n: i for i, n in enumerate(J)}
BONES = [('Hips', 'Spine2'), ('Spine2', 'Neck'), ('Neck', 'Head'),
         ('Neck', 'LeftArm'), ('LeftArm', 'LeftForeArm'), ('LeftForeArm', 'LeftHand'),
         ('Neck', 'RightArm'), ('RightArm', 'RightForeArm'), ('RightForeArm', 'RightHand'),
         ('Hips', 'LeftUpLeg'), ('LeftUpLeg', 'LeftLeg'), ('LeftLeg', 'LeftFoot'), ('LeftFoot', 'LeftToeBase'),
         ('Hips', 'RightUpLeg'), ('RightUpLeg', 'RightLeg'), ('RightLeg', 'RightFoot'), ('RightFoot', 'RightToeBase')]
LEFT = {'LeftArm', 'LeftForeArm', 'LeftHand', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase'}

def main():
    poses = json.load(open(sys.argv[1]))
    out = sys.argv[2]
    flt = sys.argv[3] if len(sys.argv) > 3 else ''
    per = int(sys.argv[4]) if len(sys.argv) > 4 else 12
    os.makedirs(out, exist_ok=True)
    keys = sorted(k for k in poses if flt.lower() in k.lower())
    W, H, S = 110, 150, 60  # cell size, px per metre
    for si in range(0, len(keys), per):
        chunk = keys[si:si + per]
        img = Image.new('RGB', (230 + 8 * W, len(chunk) * H), (250, 250, 247))
        d = ImageDraw.Draw(img)
        for r, k in enumerate(chunk):
            fr = poses[k]
            y0 = r * H
            d.line([(0, y0), (img.width, y0)], fill=(200, 200, 200))
            d.text((4, y0 + 4), k.replace('/', '/\n', 1)[:70], fill=(20, 20, 20))
            for c, fi in enumerate([round(i * 15 / 7) for i in range(8)]):
                p = fr[fi]
                cx = 230 + c * W + W // 2
                gy = y0 + H - 22
                d.line([(cx - 45, gy), (cx + 45, gy)], fill=(180, 180, 180))
                hz = p[I['Hips']][2]
                def pt(n):
                    q = p[I[n]]
                    return (cx + (q[2] - hz) * S, gy - q[1] * S)
                for a, b in BONES:
                    col = (40, 110, 220) if b in LEFT else (220, 60, 40)
                    if a in ('Hips', 'Spine2', 'Neck') and b in ('Spine2', 'Neck', 'Head'):
                        col = (30, 30, 30)
                    d.line([pt(a), pt(b)], fill=col, width=2)
                hx, hy = pt('Head')
                d.ellipse([hx - 5, hy - 5, hx + 5, hy + 5], outline=(30, 30, 30))
                # absolute root displacement marker
                d.text((cx - 40, gy + 4), f"{hz:+.1f}m", fill=(120, 120, 120))
        img.save(os.path.join(out, f'sheet_{flt.replace("/", "_") or "all"}_{si // per:02d}.png'))
    print('sheets:', (len(keys) + per - 1) // per, 'clips:', len(keys))

main()
