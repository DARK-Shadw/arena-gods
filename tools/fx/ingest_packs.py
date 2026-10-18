"""Ingest the owner's downloaded FX packs into public/fx/ through the same manifest + ledger.

  python -P tools/fx/ingest_packs.py                  # ingest whatever is present, report the rest
  python -P tools/fx/ingest_packs.py --wait           # keep polling (60 s) until every pack is present
  python -P tools/fx/ingest_packs.py --root D:/x/VFX  # other download folder

Archives are read in place with zipfile (nothing is extracted or executed).

EXPECTED LAYOUT (default root: <repo>/../Assets/VFX, i.e. C:\\Programming\\GameDev\\Research\\Assets\\VFX;
the folder name is matched case-insensitively, and Assets/ itself is also searched):

  kenney_particle-pack.zip                       Kenney Particle Pack (CC0)          -> fx_sprites
  sbs_-_noise_texture_pack_-_512x512.zip         Screaming Brain noise pack (CC0)    -> noise_a, noise_b
     (the 256 or 128 zip also works)
  unity/<Pack>-flipbooks.zip                     Unity Labs flipbooks (CC0), e.g.
     unity/Explosion00-flipbooks.zip, unity/Flame02-flipbooks.zip, unity/WispySmoke01-flipbooks.zip
                                                  -> unity_<pack>  (one flipbook atlas each)
  ambientcg/<AssetId>_1K-PNG.zip                 ambientCG decals (CC0), e.g. AsphaltDamage001_1K-PNG.zip
                                                  -> used by make_decals.py (crack / footprint cells)

Licence check: Kenney and SBS ship a License.txt that must say CC0; Unity Labs and ambientCG
have no licence file in the archive, so the licence verified in docs/fx-research.md ([V]) is
recorded. Anything else found in the folder is reported and NOT shipped.
"""
import argparse
import io
import os
import re
import sys
import time
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fxlib as L  # noqa: E402
import cv2  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

# ----------------------------------------------------------------------------- Kenney
# 64 masks: 4x4 cells (authored 256 px, shipped 192 px), one mask per channel (R, G, B, A) -> lossless WebP.
KENNEY_SPRITES = [
    'spark_01', 'spark_02', 'spark_03', 'spark_04', 'spark_05', 'spark_06', 'spark_07', 'flare_01',
    'light_01', 'light_02', 'light_03', 'star_01', 'star_02', 'star_03', 'star_04', 'star_05',
    'star_06', 'slash_01', 'slash_02', 'slash_03', 'slash_04', 'trace_01', 'trace_02', 'trace_03',
    'trace_04', 'trace_05', 'trace_06', 'trace_07', 'scratch_01', 'scorch_01', 'scorch_02', 'scorch_03',
    'circle_01', 'circle_02', 'circle_03', 'circle_04', 'circle_05', 'magic_01', 'magic_02', 'magic_03',
    'magic_04', 'magic_05', 'twirl_01', 'twirl_02', 'twirl_03', 'smoke_01', 'smoke_03', 'smoke_05',
    'smoke_07', 'flame_01', 'flame_02', 'flame_03', 'flame_04', 'flame_05', 'flame_06', 'fire_01',
    'fire_02', 'muzzle_01', 'muzzle_02', 'muzzle_03', 'dirt_01', 'dirt_02', 'dirt_03', 'symbol_01',
]
NOISE_PICK = {  # SBS category/number -> channel
    'noise_a': [('Perlin', 1), ('Voronoi', 1), ('Streak', 1), ('Swirl', 1)],
    'noise_b': [('Cracks', 1), ('Turbulence', 1), ('Melt', 1), ('Manifold', 1)],
}


def find_root(arg):
    if arg:
        return arg
    for name in os.listdir(L.ASSETS) if os.path.isdir(L.ASSETS) else []:
        if name.lower() == 'vfx':
            return os.path.join(L.ASSETS, name)
    return os.path.join(L.ASSETS, 'VFX')


def find(root, pattern, sub=None):
    """Case-insensitive regex search in root (and root/sub, and Assets/)."""
    rx = re.compile(pattern, re.I)
    dirs = [root] + ([os.path.join(root, sub)] if sub else []) + [L.ASSETS]
    hits = []
    for d in dirs:
        if os.path.isdir(d):
            hits += [os.path.join(d, f) for f in sorted(os.listdir(d)) if rx.search(f)]
    return hits


def licence_text(z):
    for n in z.namelist():
        if os.path.basename(n).lower() in ('license.txt', 'licence.txt', 'license.md'):
            return z.read(n).decode('utf-8', 'replace')
    return ''


def check_cc0(z, label):
    t = licence_text(z)
    ok = ('cc0' in t.lower()) or ('creative commons zero' in t.lower()) or ('public domain' in t.lower())
    L.log(f'{label}: licence file says CC0 -> {"OK" if ok else "NOT FOUND (skipping)"}')
    return ok


def mask_from(png_bytes, px):
    im = Image.open(io.BytesIO(png_bytes)).convert('RGBA')
    a = np.asarray(im).astype(np.float32) / 255
    luma = 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]
    m = (a[..., 3] * luma)
    m = np.asarray(Image.fromarray((m * 255).astype(np.uint8)).resize((px, px), Image.LANCZOS)).astype(np.float32) / 255
    return m


def ingest_kenney(path):
    z = zipfile.ZipFile(path)
    if not check_cc0(z, 'Kenney Particle Pack'):
        return False
    px, cols = 256, 4
    names = {os.path.splitext(os.path.basename(n))[0]: n for n in z.namelist()
             if n.startswith('PNG (Transparent)/') and n.lower().endswith('.png') and '/Rotated/' not in n}
    atlas = np.zeros((cols * px, cols * px, 4), np.float32)
    index = {}
    for i, s in enumerate(KENNEY_SPRITES):
        if s not in names:
            L.log('  missing sprite', s)
            continue
        cell, ch = i % 16, i // 16
        r, c = divmod(cell, cols)
        atlas[r * px:(r + 1) * px, c * px:(c + 1) * px, ch] = mask_from(z.read(names[s]), px)
        index[s] = {'cell': cell, 'channel': 'RGBA'[ch], 'rect': [c / cols, r / cols, 1 / cols, 1 / cols]}
    big = L.to_u8(atlas)
    u8 = np.asarray(Image.fromarray(big, 'RGBA').resize((768, 768), Image.LANCZOS))   # 192-px cells (GPU budget)
    full = L.save_webp(u8, os.path.join(L.PUB, 'fx_sprites.webp'), lossless=True)
    L.save_png(u8, os.path.join(L.WORK, 'fx_sprites.png'))
    low = np.asarray(Image.fromarray(big, 'RGBA').resize((384, 384), Image.LANCZOS))
    lowb = L.save_webp(low, os.path.join(L.PUB, 'fx_sprites.low.webp'), lossless=True)
    L.save_png(low, os.path.join(L.WORK, 'fx_sprites.low.png'))
    m = L.load_manifest()
    m['atlases']['fx_sprites'] = {
        'type': 'sprites', 'channelPacked': True, 'colorSpace': 'linear', 'grid': [4, 4],
        'full': {'file': 'fx_sprites.webp', 'w': 768, 'h': 768, 'frame': 192, 'bytes': full},
        'low': {'file': 'fx_sprites.low.webp', 'w': 384, 'h': 384, 'frame': 96, 'bytes': lowb},
        'sprites': index, 'order': 'cell row-major from top-left; rect = [u, v_from_top, w, h]',
        'notes': 'Grey masks (alpha x luma) packed one per channel: sample, then dot with the channel '
                 'mask. Tint + HDR scale in the shader. Lossless WebP (lossy chroma would mix channels).',
        'source': {'type': 'pack', 'pack': 'Kenney Particle Pack 1.1', 'file': os.path.basename(path)},
    }
    L.save_manifest(m)
    L.ledger_set(['fx_sprites.webp', 'fx_sprites.low.webp'], 'Kenney Particle Pack 1.1 (kenney.nl), 64 sprites resampled and channel-packed',
                 'CC0 1.0 (License.txt in the pack)', 'https://kenney.nl/assets/particle-pack',
                 attribution='not required ("Credit (Kenney or www.kenney.nl) would be nice")')
    L.log(f'fx_sprites.webp {full / 1024:.0f} KB, low {lowb / 1024:.0f} KB ({len(index)} sprites)')
    return True


def ingest_sbs(path):
    z = zipfile.ZipFile(path)
    if not check_cc0(z, 'Screaming Brain noise pack'):
        return False
    pngs = [n for n in z.namelist() if n.lower().endswith('.png')]
    m = L.load_manifest()
    files = []
    for tex, picks in NOISE_PICK.items():
        chans, names = [], {}
        for ci, (cat, num) in enumerate(picks):
            rx = re.compile(rf'(^|/){cat}/{cat} {num} - ', re.I)
            hit = next((n for n in pngs if rx.search(n)), None)
            if not hit:
                raise SystemExit(f'SBS: {cat} {num} not found')
            g = Image.open(io.BytesIO(z.read(hit))).convert('L').resize((256, 256), Image.LANCZOS)
            chans.append(np.asarray(g))
            names['RGBA'[ci]] = f'{cat} {num}'
        u8 = np.stack(chans, -1)
        size = L.save_webp(u8, os.path.join(L.PUB, f'{tex}.webp'), lossless=True)
        L.save_png(u8, os.path.join(L.WORK, f'{tex}.png'))
        m['atlases'][tex] = {
            'type': 'noise', 'channelPacked': True, 'colorSpace': 'linear', 'tileable': True,
            'full': {'file': f'{tex}.webp', 'w': 256, 'h': 256, 'bytes': size}, 'channels': names,
            'notes': 'Tileable grey noise, one per channel (RepeatWrapping). Downscaled 512 -> 256.',
            'source': {'type': 'pack', 'pack': 'Screaming Brain Studios Noise Texture Pack', 'file': os.path.basename(path)},
        }
        files.append(f'{tex}.webp')
        L.log(f'{tex}.webp {size / 1024:.0f} KB {names}')
    L.save_manifest(m)
    L.ledger_set(files, 'Screaming Brain Studios, Noise Texture Pack (opengameart.org), 8 textures downscaled and channel-packed',
                 'CC0 1.0 (License.txt in the pack)', 'https://opengameart.org/content/noise-texture-pack',
                 attribution='never required')
    return True


# Unity Labs flipbooks: what ships and how big (decided 2026-10-17 after inspecting every pack).
# set 'core' = loaded at session start (counts against the 48 MB GPU budget), 'alt' = shipped but
# loaded on demand (FX Lab comparisons, rare effects), None = not shipped (reason given).
# maxSide = longest atlas side after resampling; worldH = card height in metres; fps are guesses
# (Unity does not state them): judge in the FX Lab.
UNITY = {
    'Flame02':                {'set': 'core', 'maxSide': 1024, 'role': 'brazier / large fire (E01, E06, E08)', 'worldH': 1.5, 'fps': 30, 'kind': 'emissive'},
    'Flame03':                {'set': 'core', 'maxSide': 1024, 'role': 'torch / small fire, burning status (ST1)', 'worldH': 0.9, 'fps': 30, 'kind': 'emissive'},
    'SmallFlame01':           {'set': 'alt', 'maxSide': 1024, 'role': 'candle / lantern flame', 'worldH': 0.5, 'fps': 30, 'kind': 'emissive'},
    'CandleSmoke01':          {'set': 'core', 'maxSide': 1024, 'role': 'thin smoke above candles, torches, embers', 'worldH': 1.2, 'fps': 30, 'kind': 'smoke'},
    'Cloud01':                {'set': 'core', 'maxSide': 512, 'role': 'fog card (E03)', 'worldH': 4.0, 'fps': 10, 'kind': 'smoke'},
    'Explosion00':            {'set': 'core', 'maxSide': 768, 'role': 'keg explosion fireball + smoke (E07)', 'worldH': 4.0, 'fps': 16, 'kind': 'emissive+smoke'},
    'Explosion01-nofire':     {'set': 'core', 'maxSide': 768, 'role': 'smoke / dust plume burst (C06e, E14, slams)', 'worldH': 3.0, 'fps': 16, 'kind': 'smoke'},
    'FireBall01':             {'set': 'core', 'maxSide': 512, 'role': 'fireball core / fire burst (ranged fire, pyre)', 'worldH': 1.2, 'fps': 30, 'kind': 'emissive'},
    'WispySmoke01':           {'set': 'core', 'maxSide': 768, 'role': 'rising smoke (brazier wisp, aftermath)', 'worldH': 2.5, 'fps': 24, 'kind': 'smoke'},
    'Explosion01':            {'set': None, 'why': 'near-duplicate of Explosion00'},
    'Explosion01-light-nofire': {'set': None, 'why': 'near-duplicate of Explosion01-nofire'},
    'Explosion02':            {'set': None, 'why': 'near-duplicate of Explosion00'},
    'Explosion02HD':          {'set': None, 'why': '2048^2 source (16.8 MB TGA): at the WebP-only budget it would be downsized to the 1024^2 of Explosion02; revisit with KTX2'},
    'FireBall02':             {'set': None, 'why': 'variant of FireBall01'},
    'FireBall03':             {'set': None, 'why': 'variant of FireBall01'},
    'Flame03-hollow':         {'set': None, 'why': 'variant of Flame03 (RGB only, 2048x1024)'},
    'SmallFlame01-mini':      {'set': None, 'why': 'variant of SmallFlame01'},
    'SmallFlame01-smaller':   {'set': None, 'why': 'variant of SmallFlame01'},
    'Cloud02':                {'set': None, 'why': 'variant of Cloud01'},
    'WispySmoke02':           {'set': None, 'why': 'variant of WispySmoke01'},
    'WispySmoke03':           {'set': None, 'why': 'variant of WispySmoke01'},
    'WispySmoke03b':          {'set': None, 'why': 'variant of WispySmoke01'},
}
UNITY_URL = 'https://unity.com/blog/engine-platform/free-vfx-image-sequences-flipbooks'


def loop_score(cells):
    """diff(last -> first) / mean diff(n -> n+1); below ~1.6 the sequence wraps seamlessly."""
    d = [float(np.abs(cells[i + 1] - cells[i]).mean()) for i in range(len(cells) - 1)]
    return float(np.abs(cells[0] - cells[-1]).mean()) / max(1e-6, float(np.mean(d)))


def ingest_unity(path, ship_all=False):
    """Unity Labs <Pack>-flipbooks.zip -> unity_<pack> atlas (one pack at a time, memory-light).
    Layout found: <Pack>_<C>x<R>.tga (8-bit sRGB, straight alpha; FireBall packs are RGB only)
    + the same as a linear .exr, and for some packs a '-temperature' EXR (not used yet)."""
    pack = re.sub(r'-flipbooks?\.zip$', '', os.path.basename(path), flags=re.I)
    aid = 'unity_' + re.sub(r'[^a-z0-9]+', '_', pack.lower()).strip('_')
    cfg = dict(UNITY.get(pack, {'set': None, 'why': 'unknown pack (not in the UNITY table)'}))
    if ship_all and not cfg.get('set'):
        cfg.update({'set': 'alt', 'maxSide': 1024, 'role': 'variant', 'worldH': 2.0, 'fps': 30,
                    'kind': 'smoke' if ('Smoke' in pack or 'Cloud' in pack) else 'emissive+smoke'})
    z = zipfile.ZipFile(path)
    tga = [n for n in z.namelist() if re.search(r'_(\d+)x(\d+)\.(tga|png)$', n, re.I) and 'temperature' not in n.lower()]
    if not tga:
        L.log(f'{pack}: no <name>_CxR.tga in the zip; contents: {z.namelist()[:10]}')
        return False
    name = tga[0]
    cols, rows = map(int, re.search(r'_(\d+)x(\d+)\.', name).groups())
    im = Image.open(io.BytesIO(z.read(name)))
    mode = im.mode
    W, H = im.size
    a = np.asarray(im.convert('RGBA')).astype(np.float32) / 255
    del im
    has_alpha = mode == 'RGBA'
    premul_src = has_alpha and float((a[..., :3].max(-1) > a[..., 3] + 3 / 255).mean()) < 0.001
    inv = {'zip': os.path.basename(path), 'file': name, 'size': [W, H], 'grid': [cols, rows],
           'srcFrame': [round(W / cols, 2), round(H / rows, 2)], 'frames': cols * rows,
           'alpha': ('premultiplied' if premul_src else 'straight') if has_alpha else 'none (RGB, additive on black)',
           'zipBytes': os.path.getsize(path), 'set': cfg.get('set'), 'why': cfg.get('why', ''), 'role': cfg.get('role', '')}
    lin = L.srgb_decode(a[..., :3])
    al = a[..., 3:] if has_alpha else np.zeros_like(a[..., :1])
    prem = lin if (premul_src or not has_alpha) else lin * al
    del a, lin
    scale = min(1.0, cfg.get('maxSide', 1024) / max(W, H))
    cw, chh = max(16, int(W / cols * scale)), max(16, int(H / rows * scale))
    data = np.concatenate([prem, al], -1).astype(np.float32)
    del prem, al
    data = cv2.resize(data, (cw * cols, chh * rows), interpolation=cv2.INTER_AREA)
    cells = [data[r * chh:(r + 1) * chh, c * cw:(c + 1) * cw] for r in range(rows) for c in range(cols)]
    ls = loop_score(cells)
    inv.update({'shipFrame': [cw, chh], 'loopScore': round(ls, 2)})
    m = L.load_manifest()
    m.setdefault('packs', {})[pack] = inv
    if not cfg.get('set'):
        L.save_manifest(m)
        prev = L.to_u8(np.concatenate([L.srgb_encode(data[..., :3]), np.clip(data[..., 3:], 0, 1)], -1))
        L.save_png(prev, os.path.join(L.WORK, f'{aid}.preview.png'))
        L.log(f'{pack}: {cols}x{rows} of {W / cols:.1f}x{H / rows:.1f} px, {inv["alpha"]} alpha, loop {ls:.2f} -> NOT shipped ({cfg.get("why")})')
        return True
    kind = cfg['kind']
    loop = ls < 1.6 and kind != 'emissive+smoke' and 'Explosion' not in pack
    entry = {
        'type': 'flipbook', 'kind': 'emissive' if kind == 'emissive' else ('lit-fixed' if kind == 'smoke' else kind),
        'grid': [cols, rows], 'frames': cols * rows, 'fps': cfg['fps'], 'loop': loop,
        'blend': 'additive' if not has_alpha else 'premultiplied', 'tint': kind == 'smoke',
        'colorSpace': 'srgb', 'premultiplied': True, 'hdrScale': 1.0, 'set': cfg['set'], 'role': cfg['role'],
        'pivot': [0.5, 0.05] if ('Flame' in pack or 'Smoke' in pack) else [0.5, 0.5],
        'worldSize': [round(cfg['worldH'] * cw / chh, 3), cfg['worldH']], 'order': 'row-major, frame 0 top-left',
        'notes': (f'Unity Labs {pack} ({name}, {W}x{H}, {cols}x{rows} of {W / cols:g}x{H / rows:g} px, {inv["alpha"]} alpha). '
                  f'fps is a guess; loop from the wrap test (score {ls:.2f}).'
                  + (' RGB only: A = 0, pure additive.' if not has_alpha else '')),
        'source': {'type': 'pack', 'pack': f'Unity Labs VFX flipbooks: {pack}', 'file': os.path.basename(path), 'srcSize': [W, H]},
    }
    files = []
    for tier, div in (('full', 1), ('low', 2)):
        tw, th = cw // div, chh // div
        atl = np.zeros((th * rows, tw * cols, 4), np.uint8)
        for i, c_ in enumerate(cells):
            x = c_ if div == 1 else cv2.resize(c_, (tw, th), interpolation=cv2.INTER_AREA)
            r, k = divmod(i, cols)
            atl[r * th:(r + 1) * th, k * tw:(k + 1) * tw] = L.to_u8(np.concatenate([L.srgb_encode(x[..., :3]), np.clip(x[..., 3:], 0, 1)], -1))
        fn = f'{aid}{"" if tier == "full" else ".low"}.webp'
        size = L.save_webp(atl, os.path.join(L.PUB, fn))
        L.save_png(atl, os.path.join(L.WORK, fn.replace('.webp', '.png')))
        entry[tier] = {'file': fn, 'w': atl.shape[1], 'h': atl.shape[0], 'frame': max(tw, th), 'frameW': tw, 'frameH': th, 'bytes': size}
        files.append(fn)
    m['atlases'][aid] = entry
    L.save_manifest(m)
    L.ledger_set(files, f'Unity Labs free VFX image sequences & flipbooks: {pack} ({name}), resampled + premultiplied',
                 'CC0 1.0 (Unity blog page: "we release some of these sequences under CC0 license"; docs/fx-research.md [V])', UNITY_URL)
    L.log(f'{aid}: {cols}x{rows} of {W / cols:.1f}x{H / rows:.1f}px -> {cw}x{chh}px, {inv["alpha"]} alpha, loop {ls:.2f}, '
          f'{entry["full"]["bytes"] / 1024:.0f} KB + low {entry["low"]["bytes"] / 1024:.0f} KB ({cfg["set"]})')
    return True


def unity_zips(root):
    out = []
    for d in (os.path.join(root, 'unity'), root, os.path.join(L.ASSETS, 'fx'), L.ASSETS):
        if os.path.isdir(d):
            out += [os.path.join(d, f) for f in sorted(os.listdir(d)) if re.search(r'-flipbooks?\.zip$', f, re.I)]
    seen, uniq = set(), []
    for p in out:
        k = os.path.normcase(os.path.realpath(p))
        if k not in seen:
            seen.add(k)
            uniq.append(p)
    return uniq


def run_once(root, only=None, ship_all=False):
    status = {}
    if only in (None, 'kenney'):
        k = find(root, r'^kenney_particle-?pack.*\.zip$')
        status['kenney'] = bool(k) and ingest_kenney(k[0])
    if only in (None, 'sbs'):
        s = find(root, r'^sbs.*noise.*(512|256|128).*\.zip$')
        s.sort(key=lambda p: ('512' not in p, '256' not in p))       # prefer the biggest source
        status['sbs_noise'] = bool(s) and ingest_sbs(s[0])
    if only is None or only == 'unity' or only.startswith('unity:'):
        u = unity_zips(root)
        if only and only.startswith('unity:'):
            u = [p for p in u if os.path.basename(p).lower().startswith(only[6:].lower() + '-flipbook')]
        ok = True
        for p in u:                       # one pack at a time: loaded, resampled, written, freed
            ok = ingest_unity(p, ship_all) and ok
        status['unity'] = bool(u) and ok
    L.log('status:', ', '.join(f'{k_}={"yes" if v else "MISSING"}' for k_, v in status.items()))
    return status


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root')
    ap.add_argument('--wait', action='store_true', help='poll every 60 s until all packs are present')
    ap.add_argument('--only', help='kenney | sbs | unity | unity:<Pack>')
    ap.add_argument('--ship-all', action='store_true', help='ship every Unity pack (ignores the UNITY table)')
    a = ap.parse_args()
    L.ensure_dirs()
    root = find_root(a.root)
    L.log('pack root:', root)
    while True:
        st = run_once(root, a.only, a.ship_all)
        if not a.wait or all(st.values()):
            break
        L.log('waiting for:', [k for k, v in st.items() if not v], '(polling every 60 s; Ctrl+C to stop)')
        time.sleep(60)

if __name__ == '__main__':
    main()
