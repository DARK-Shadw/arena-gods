"""Contact sheets of the SHIPPED atlases (decoded from public/fx/*.webp, so compression shows).

  python -P tools/fx/contact_sheets.py [ids...]   -> docs/milestones/F2/sheets/<id>.jpg

Each flipbook sheet: 8 evenly spaced frames, top row over a dark-arena background, bottom
row over a warm torchlit-stone background. lit3 atlases are relit with a key from the
upper left plus ambient (what the runtime shader does); tintable atlases get a sample tint.
Static atlases (sprites, decals, noise) are shown whole over a mid-grey checker.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fxlib as L  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

OUT = os.path.join(L.ROOT, 'docs', 'milestones', 'F2', 'sheets')
TINTS = {'dust_puff': (0.62, 0.55, 0.46), 'dust_ring': (0.62, 0.55, 0.46), 'smoke_wisp': (0.55, 0.53, 0.52),
         'splash': (0.75, 0.85, 0.95), 'energy_swirl': (0.45, 0.65, 1.6)}
BGS = {'dark arena': (0.010, 0.011, 0.016), 'torchlight': (0.20, 0.11, 0.05)}
KEY = {'dark arena': (0.55, 0.62, 0.80), 'torchlight': (1.25, 0.80, 0.45)}


def load(fn):
    a = np.asarray(Image.open(os.path.join(L.PUB, fn)).convert('RGBA')).astype(np.float32) / 255
    return np.concatenate([L.srgb_decode(a[..., :3]), a[..., 3:]], -1)


def bg_img(px, col):
    y = np.linspace(1.15, 0.7, px)[:, None, None]
    return np.ones((px, px * 2, 3), np.float32) * np.array(col, np.float32) * y


def shade(cell, e, bgname, aid):
    rgb, a = cell[..., :3], cell[..., 3:]
    if e['kind'] == 'lit3':
        w = np.array([0.15, 0.55, 0.55], np.float32)          # key from upper left
        lum = (rgb * w).sum(-1, keepdims=True) * 0.9
        amb = 0.12 * a
        rgb = (lum * np.array(KEY[bgname]) + amb * np.array(KEY[bgname]) * 0.6)
    else:
        rgb = rgb * (1.6 if e['kind'].startswith('emissive') else 1.0)
    if e.get('tint'):
        rgb = rgb * np.array(TINTS.get(aid, (1, 1, 1)), np.float32)
    return rgb, a


def flipbook_sheet(aid, e):
    atlas = load(e['full']['file'])
    cols, rows = e['grid']
    fw = e['full'].get('frameW', e['full']['frame'])
    fh = e['full'].get('frameH', e['full']['frame'])
    n = e['frames']
    pick = [int(round(i * (n - 1) / 7)) for i in range(8)]
    rows_out = []
    for bgname, col in BGS.items():
        row = []
        for i in pick:
            r, k = divmod(i, cols)
            cell = atlas[r * fh:(r + 1) * fh, k * fw:(k + 1) * fw]
            rgb, a = shade(cell, e, bgname, aid)
            out = bg_img(fh, col)[:, :fw] * (1 - a) + rgb
            if fh < 128:
                out = np.asarray(Image.fromarray(L.to_u8(out)).resize((fw * 128 // fh, 128), Image.LANCZOS)).astype(np.float32) / 255
            out = out / (1 + out * 0.25)                         # gentle tonemap so cores do not clip flat
            row.append(L.to_u8(L.srgb_encode(out)))
        rows_out.append(np.concatenate(row, 1))
    return np.concatenate(rows_out, 0)


def static_sheet(e):
    atlas = load(e['full']['file'])
    h, w = atlas.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    chk = np.where(((yy // 32) + (xx // 32)) % 2 == 0, 0.20, 0.28)[..., None].astype(np.float32)
    if e.get('channelPacked'):
        # show the four channels side by side, white on checker
        tiles = [chk * (1 - atlas[..., c:c + 1]) + atlas[..., c:c + 1] for c in range(4)]
        img = np.repeat(np.concatenate(tiles, 1), 3, 2)
    elif e.get('premultiplied'):
        img = chk * (1 - atlas[..., 3:]) + atlas[..., :3]
    else:
        img = atlas[..., :3]
    img = L.to_u8(L.srgb_encode(img))
    if img.shape[1] > 2048:
        s = 2048 / img.shape[1]
        img = np.asarray(Image.fromarray(img).resize((2048, int(img.shape[0] * s)), Image.LANCZOS))
    return img


def unshipped_sheet(m):
    """One strip per Unity pack that was inspected but not shipped (from tools/fx/_work previews)."""
    rows = []
    for pack, inv in sorted(m.get('packs', {}).items()):
        if inv.get('set'):
            continue
        aid = 'unity_' + ''.join(ch if ch.isalnum() else '_' for ch in pack.lower()).strip('_')
        p = os.path.join(L.WORK, f'{aid}.preview.png')
        if not os.path.exists(p):
            continue
        a = np.asarray(Image.open(p).convert('RGBA')).astype(np.float32) / 255
        cols, rws = inv['grid']
        fw, fh = inv['shipFrame']
        n = cols * rws
        cells = []
        for i in [int(round(k * (n - 1) / 7)) for k in range(8)]:
            r, k = divmod(i, cols)
            c = a[r * fh:(r + 1) * fh, k * fw:(k + 1) * fw]
            lin = np.concatenate([L.srgb_decode(c[..., :3]), c[..., 3:]], -1)
            out = bg_img(fh, BGS['dark arena'])[:, :fw] * (1 - lin[..., 3:]) + lin[..., :3] * 1.6
            img = Image.fromarray(L.to_u8(L.srgb_encode(out / (1 + out * 0.25)))).resize((96 * fw // fh, 96), Image.LANCZOS)
            cells.append(np.asarray(img))
        strip = np.concatenate(cells, 1)
        lab = Image.new('RGB', (strip.shape[1], 16), (0, 0, 0))
        from PIL import ImageDraw
        ImageDraw.Draw(lab).text((4, 2), f"{pack}: NOT shipped ({inv.get('why', '')})"[:150], fill=(220, 220, 220))
        rows.append(np.concatenate([np.asarray(lab), strip], 0))
    if rows:
        W = max(r.shape[1] for r in rows)
        rows = [np.pad(r, ((0, 0), (0, W - r.shape[1]), (0, 0))) for r in rows]
        Image.fromarray(np.concatenate(rows, 0)).save(os.path.join(OUT, 'unity_not_shipped.jpg'), quality=82)
        L.log('sheet unity_not_shipped.jpg', len(rows), 'packs')


def main():
    os.makedirs(OUT, exist_ok=True)
    m = L.load_manifest()
    if sys.argv[1:] == ['--unshipped']:
        return unshipped_sheet(m)
    ids = sys.argv[1:] or list(m['atlases'])
    for aid in ids:
        e = m['atlases'][aid]
        img = flipbook_sheet(aid, e) if e['type'] == 'flipbook' else static_sheet(e)
        p = os.path.join(OUT, f'{aid}.jpg')
        Image.fromarray(img).save(p, quality=86)
        L.log('sheet', os.path.relpath(p, L.ROOT), img.shape[1], 'x', img.shape[0])


if __name__ == '__main__':
    main()
