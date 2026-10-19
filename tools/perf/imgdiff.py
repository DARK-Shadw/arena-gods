"""A21: compare two render folders image by image (same file names): PSNR, mean / max abs difference, share of pixels
that moved by more than 8 / 24 levels (of 255), and optionally a diff heat image.
    python -I tools/perf/imgdiff.py <dirA> <dirB> [--glob=*_q1.png] [--heat=<outdir>]
"""
import sys, glob, os
import numpy as np
from PIL import Image

args = [a for a in sys.argv[1:] if not a.startswith('--')]
opts = dict(a[2:].split('=', 1) for a in sys.argv[1:] if a.startswith('--'))
A, B = args[0], args[1]
pat = opts.get('glob', '*.png')
heat = opts.get('heat')
if heat:
    os.makedirs(heat, exist_ok=True)
rows = []
for pa in sorted(glob.glob(os.path.join(A, pat))):
    name = os.path.basename(pa)
    if 'sky' in name:
        continue
    pb = os.path.join(B, name)
    if not os.path.exists(pb):
        continue
    a = np.asarray(Image.open(pa).convert('RGB')).astype(np.float32)
    b = np.asarray(Image.open(pb).convert('RGB')).astype(np.float32)
    if a.shape != b.shape:
        print(name, 'size differs', a.shape, b.shape)
        continue
    d = np.abs(a - b)
    mse = float((d ** 2).mean())
    psnr = 99.0 if mse == 0 else 10 * np.log10(255 ** 2 / mse)
    dm = d.max(axis=2)
    rows.append((name, psnr, float(d.mean()), float(d.max()), float((dm > 8).mean() * 100), float((dm > 24).mean() * 100)))
    if heat:
        h = np.clip(dm * 4, 0, 255).astype(np.uint8)
        Image.fromarray(h).save(os.path.join(heat, name.replace('.png', '_diff.png')))
print(f"{'image':34} {'PSNR':>6} {'mean':>6} {'max':>5} {'>8 %':>6} {'>24 %':>6}")
for r in rows:
    print(f"{r[0]:34} {r[1]:6.1f} {r[2]:6.2f} {r[3]:5.0f} {r[4]:6.2f} {r[5]:6.3f}")
