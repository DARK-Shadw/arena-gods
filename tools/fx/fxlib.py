"""Shared helpers for the FX atlas pipeline (pack_atlas, ingest_packs, make_decals, contact_sheets).

Run every tool with `python -P` (isolated mode); each tool inserts this folder into sys.path
itself. Only Pillow, numpy and opencv-python are needed.

Conventions (also documented in docs/fx-pipeline.md):
- Atlases are row-major with frame 0 at the TOP-LEFT cell.
- Colour data is stored PREMULTIPLIED by alpha and sRGB-encoded (load with SRGBColorSpace);
  alpha is linear coverage. Mask / data textures (sprites, noise, mv, normals) are linear.
- public/fx/atlas.json is the manifest; public/fx/credits.json is the licence ledger that
  CREDITS.md is generated from. Every shipped file must have a ledger row.
"""
import json
import os
import shutil
import subprocess
import sys

os.environ.setdefault('OPENCV_IO_ENABLE_OPENEXR', '1')
import cv2  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
BAKE = os.path.join(ROOT, 'tools', 'fx', '_bake')
WORK = os.path.join(ROOT, 'tools', 'fx', '_work')
PUB = os.path.join(ROOT, 'public', 'fx')
MANIFEST = os.path.join(PUB, 'atlas.json')
LEDGER = os.path.join(PUB, 'credits.json')
ASSETS = os.path.abspath(os.path.join(ROOT, '..', 'Assets'))


def ensure_dirs():
    for d in (WORK, PUB):
        os.makedirs(d, exist_ok=True)


# ----------------------------------------------------------------------------- io
def read_exr(path):
    """-> float32 (H, W, 4) RGBA linear premultiplied."""
    im = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if im is None:
        raise IOError('cannot read ' + path)
    im = im.astype(np.float32)
    if im.shape[2] == 3:
        im = np.concatenate([im, np.ones_like(im[..., :1])], 2)
    return im[..., [2, 1, 0, 3]]


def srgb_encode(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055)


def srgb_decode(x):
    return np.where(x <= 0.04045, x / 12.92, np.power((x + 0.055) / 1.055, 2.4))


def to_u8(x):
    return (np.clip(x, 0, 1) * 255 + 0.5).astype(np.uint8)


def resize(img, px):
    """Area resample (correct for premultiplied data)."""
    if img.shape[0] == px and img.shape[1] == px:
        return img
    return cv2.resize(img, (px, px), interpolation=cv2.INTER_AREA)


def save_webp(arr_u8, path, lossless=False, quality=86):
    mode = 'RGBA' if arr_u8.shape[2] == 4 else 'RGB'
    im = Image.fromarray(arr_u8, mode)
    if lossless:
        im.save(path, 'WEBP', lossless=True, quality=100, method=6, exact=True)
    else:
        # exact=True: keep RGB under alpha=0. The data is premultiplied, so colour where
        # alpha is 0 is real additive glow; libwebp would otherwise overwrite it.
        im.save(path, 'WEBP', quality=quality, alpha_quality=92, method=6, exact=True)
    return os.path.getsize(path)


def save_png(arr_u8, path):
    mode = 'RGBA' if arr_u8.shape[2] == 4 else 'RGB'
    Image.fromarray(arr_u8, mode).save(path, optimize=True)


def grid_pack(frames, cols, rows):
    """frames: list of (px, px, C) arrays -> (rows*px, cols*px, C); frame 0 top-left, row-major."""
    px = frames[0].shape[0]
    c = frames[0].shape[2]
    out = np.zeros((rows * px, cols * px, c), frames[0].dtype)
    for i, f in enumerate(frames):
        r, k = divmod(i, cols)
        out[r * px:(r + 1) * px, k * px:(k + 1) * px] = f
    return out


def edge_fade(px, frac=0.035):
    """Soft border mask so cells never bleed hard edges into neighbours under mipmapping."""
    t = np.linspace(0, 1, px)
    e = np.clip(np.minimum(t, 1 - t) / frac, 0, 1)
    e = e * e * (3 - 2 * e)
    return np.minimum.outer(e, e).astype(np.float32)


# ----------------------------------------------------------------------------- manifest/ledger
def _load(path, default):
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    return default


def load_manifest():
    return _load(MANIFEST, {'version': 1, 'format': 'webp', 'atlases': {}})


def save_manifest(m):
    m['atlases'] = dict(sorted(m['atlases'].items()))
    with open(MANIFEST, 'w', encoding='utf-8') as f:
        json.dump(m, f, indent=1)


def ledger_set(files, source, licence, url, attribution='not required', notes=''):
    """Record the source/licence of shipped files (paths relative to public/fx)."""
    led = _load(LEDGER, {})
    for fn in files:
        led[fn] = {'source': source, 'licence': licence, 'url': url,
                   'attribution': attribution, 'notes': notes}
    with open(LEDGER, 'w', encoding='utf-8') as f:
        json.dump(dict(sorted(led.items())), f, indent=1)


def toktx_path():
    return shutil.which('toktx')


def log(*a):
    print('[fx]', *a, flush=True)
