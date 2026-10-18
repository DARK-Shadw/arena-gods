"""Tile screenshots into a contact sheet.
   python tools/shots/tile.py <outPng> <cols> <img1> <img2> ... [--labels a,b,c] [--scale 0.5]
"""
import sys
from PIL import Image, ImageDraw

args = sys.argv[1:]
out = args[0]
cols = int(args[1])
labels = None
scale = 0.5
files = []
i = 2
while i < len(args):
    if args[i] == '--labels':
        labels = args[i + 1].split('|')
        i += 2
    elif args[i] == '--scale':
        scale = float(args[i + 1])
        i += 2
    else:
        files.append(args[i])
        i += 1
ims = [Image.open(f).convert('RGB') for f in files]
w, h = ims[0].size
w2, h2 = int(w * scale), int(h * scale)
rows = (len(ims) + cols - 1) // cols
sheet = Image.new('RGB', (cols * w2, rows * h2), (16, 16, 18))
d = ImageDraw.Draw(sheet)
for k, im in enumerate(ims):
    x, y = (k % cols) * w2, (k // cols) * h2
    sheet.paste(im.resize((w2, h2)), (x, y))
    if labels and k < len(labels):
        d.rectangle([x, y, x + 8 + 7 * len(labels[k]), y + 16], fill=(0, 0, 0))
        d.text((x + 4, y + 2), labels[k], fill=(240, 220, 160))
sheet.save(out)
print('wrote', out, sheet.size)
