"""Regenerate public/fx/CREDITS.md from the ledger public/fx/credits.json.

  python -P tools/fx/write_credits.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fxlib as L  # noqa: E402

HEAD = """# FX asset credits and licences

Every file shipped in `public/fx/` is listed here with its source and licence. This file is
generated from `credits.json` by `tools/fx/write_credits.py`; `tools/fx/check_budget.mjs`
fails when a shipped image has no row. CC0 sources are credited even though they do not
require it.

## Sources

- **Kenney Particle Pack 1.1** by Kenney Vleugels (www.kenney.nl), CC0 1.0. Additional filter
  templates credited by the pack: Indigo Ray, Craig Nisbet, Zoltan Erdokovy, Heliagon, ThreeDee,
  Killst4r and Tim2501. https://kenney.nl/assets/particle-pack
- **Noise Texture Pack** by Screaming Brain Studios, CC0 1.0 ("credit is never required").
  https://opengameart.org/content/noise-texture-pack
- **Arena Gods own bakes and procedural textures** (`tools/fx/blender/*`, `tools/fx/make_decals.py`),
  released CC0 1.0 like the rest of the project's generated FX.

## Files

| File | Source | Licence | Attribution | URL |
|---|---|---|---|---|
"""


def main():
    with open(L.LEDGER, encoding='utf-8') as f:
        led = json.load(f)
    rows = []
    for fn, r in sorted(led.items()):
        rows.append(f"| `{fn}` | {r['source']} | {r['licence']} | {r['attribution']} | {r['url']} |")
    shipped = sorted(f for f in os.listdir(L.PUB) if f.endswith(('.webp', '.ktx2', '.png')))
    missing = [f for f in shipped if f not in led]
    txt = HEAD + '\n'.join(rows) + '\n'
    if missing:
        txt += '\n**Missing ledger rows (must be fixed before shipping):** ' + ', '.join(missing) + '\n'
    with open(os.path.join(L.PUB, 'CREDITS.md'), 'w', encoding='utf-8') as f:
        f.write(txt)
    L.log(f'CREDITS.md: {len(rows)} rows' + (f', MISSING {missing}' if missing else ''))


if __name__ == '__main__':
    main()
