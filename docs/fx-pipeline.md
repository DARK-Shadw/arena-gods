# FX asset pipeline (F2)

How the flipbook atlases, sprites, noise and decals in `public/fx/` are made, what the files
contain, and how the runtime must read them. Plan: `docs/fx-plan.md` §4. Milestone report:
`docs/milestones/F2/README.md`.

## 1. Commands (run from `arena/`)

Run one heavy job at a time (the owner's PC has had low-memory kills). Blender bakes never run
next to the dev server plus a headless browser.

```bash
bash tools/fx/bake_all.sh                    # every Blender bake, ONE AT A TIME (skips finished ones; FORCE=1 redoes)
python -P tools/fx/pack_atlas.py             # EXR frames -> public/fx/<id>.webp, .low.webp, .mv.webp + atlas.json
python -P tools/fx/ingest_packs.py           # Kenney sprites, SBS noise, Unity flipbooks (when downloaded)
python -P tools/fx/make_decals.py            # decal atlas (procedural + SBS cracks / ambientCG when present)
node tools/fx/encode_ktx2.mjs                # KTX2 if `toktx` is installed, else records "WebP only"
python -P tools/fx/write_credits.py          # public/fx/CREDITS.md from the ledger
node tools/fx/check_budget.mjs               # download <= 6 MB, GPU <= 48 MB high / 24 MB low, ledger complete
python -P tools/fx/contact_sheets.py         # docs/milestones/F2/sheets/<id>.jpg
```

One bake by hand:

```bash
"/c/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \
  -P tools/fx/blender/bake_fire_loop.py -- --out tools/fx/_bake/fire_loop [--dry-run] [--preview 4] [--engine cycles] [--px 256]
```

`python -P` (safe path) is used instead of the plan's `python -I`: `-P` keeps the script folder
and cwd off `sys.path`, which is the protection that matters next to downloaded data; `-I` also
hides the user site-packages, where opencv is installed on the owner's PC. Archives are read in
place with `zipfile`; nothing downloaded is extracted or executed.

## 2. Blender bakes (`tools/fx/blender/`)

`fxbake.py` is the shared helper. Every script:
1. parses its args after `--`,
2. builds its scene from an empty factory file,
3. runs a **dry run** (API checks, one frame) and prints the peak RAM it measured,
4. renders each frame, checking free system RAM first (pauses below 1.5 GB, aborts after 5 min),
5. writes linear, premultiplied, half-float EXR frames and `bake.json`.

Frames are a pure function of the frame index, so a bake is reproducible from its seed (`--seed`, default 7).

| Script | Atlas ids | Method |
|---|---|---|
| `bake_fire_loop.py` | `fire_loop` | B: 4D-noise Principled Volume; seamless loop made in density space (two noise samples N(t), N(t-T) blended by phase, contrast restored) |
| `bake_fireball.py --kind burst/explosion` | `fire_burst`, `explosion` | B: expanding noise fireball whose heat decays into smoke. A (Mantaflow) is behind `--method mantaflow` |
| `bake_smoke_wisp.py` | `smoke_wisp` | B with 3 directional light passes |
| `bake_dust.py --kind puff/ring` | `dust_puff`, `dust_ring` | B with 3 light passes; the ring is rendered with the camera 25° down |
| `bake_liquid.py --kind splash/blood` | `splash`, `blood_spray` | analytic metaball particles (velocity-stretched ellipsoids) |
| `bake_embers.py` | `embers` | emissive spheres on periodic paths, EEVEE motion blur |
| `bake_energy.py` | `energy_swirl` | B: ridged noise rotated exactly one turn per loop |

**Mantaflow in Blender 5.0.1 (checked by the dry run):**
- The `FLUID` modifier and `bpy.ops.fluid.bake_all()` work headless; a 3-frame bake at resolution 24 takes under 1 s.
- `bpy.ops.object.quick_smoke()` does **not** work in background mode. It creates the domain but gives the emitter no Fluid modifier ("Only one modifier of this type is allowed"). The script therefore builds the domain and flow by hand.
- The untuned Mantaflow plume reads as a thin column rather than a keg blast, so the default for `explosion` is B. A is kept for a future hero version.

**Engine:** EEVEE (`BLENDER_EEVEE`, volumetric tile size 1) is the default. It takes about 1 s per frame after a 3–10 s shader compile and peaks at about 1.4 GB RAM. `--engine cycles` gives crisper volumes but is slower (about 11–17 s per 256-px frame, ~0.45 GB RAM) and noisy below 64 samples.

## 3. Shipped files and formats

All atlases are **row-major with frame 0 in the top-left cell**. WebP files are loaded with `flipY = true`, so the shader's cell v is `rows - 1 - row` (see `tools/fxlab/fxAtlas.ts`).

| Kind | RGB | A | Colour space |
|---|---|---|---|
| `emissive` (fire_loop, embers, energy_swirl) | premultiplied emission | coverage / occlusion | sRGB |
| `emissive+smoke` (fire_burst, explosion) | premultiplied emission + dark smoke lit by a fixed top-left key | coverage | sRGB |
| `lit3` (smoke_wisp, dust_puff, dust_ring) | R/G/B = luminance lit from screen right / top / left, each 35° toward the camera | coverage | sRGB-encoded data |
| `lit-fixed` (splash, blood_spray) | premultiplied lit colour (key top-left + rim) | coverage | sRGB |
| `fx_sprites` | 64 grey masks, one per channel of 16 cells | (4th mask) | linear, lossless |
| `noise_a`, `noise_b` | 4 tileable noises each (one per channel) | | linear, lossless |
| `decals` | premultiplied colour, 4×4 cells | coverage | sRGB |
| `decals_nrm` | R,G = tangent normal xy (+y up), B = roughness | wetness | linear, lossless |
| `<id>.mv.webp` | R,G = flow from frame n to n+1 in UV units of one cell: `mv = (rg*2-1) * mv.scale` | (opaque) | linear, lossless, half the frame size |

- **Premultiplied everywhere.** Blend with `ONE, ONE_MINUS_SRC_ALPHA`. Colour with alpha 0 is additive glow; that is why the WebP encoder runs with `exact=True`, without which libwebp rewrites RGB under transparent pixels.
- **HDR.** Each sequence is normalised so its 99.9th percentile is 1.0. `hdrScale` in the manifest records the bake radiance; the runtime applies the plan's HDR scale (cores 8–30, bodies 1.5–4).
- **Tiers.** `full` = 128-px frames (8×8 → 1024²), `low` = 64-px frames. Exceptions: embers and splash use 96 px; sprites and decals are authored at 256 px and shipped at 192. Unity packs are resampled to a longest side of 512–1024, set per pack.
- **Sets.** `set: 'core'` atlases are loaded at session start and count against the GPU budget. `set: 'alt'` atlases are shipped but loaded on demand. `check_budget.mjs` adds the largest alt atlas as the worst case. The plan's 256-px frames (2048²) only fit the 48 MB GPU budget as KTX2 (1 B/px). With WebP-only, each 2048² atlas would cost 21 MB of VRAM. `pack_atlas.py --hires` makes 256-px frames once KTX2 is available.
- **lit3 shading** (reference: `fxAtlas.ts`). With `L` the key-light direction in view space:
  - `w = (max(L.x,0), max(L.y,0), max(-L.x,0)) + 0.45*max(L.z,0)`
  - `lum = dot(rgb, w) / max(0.6, sum(w))`
  - `colour = lum*keyColour + ambient*alpha`, multiplied by the tint.
- **Motion vectors** are shipped for `fire_loop` and `smoke_wisp`. They come from OpenCV Farneback optical flow on the packed frames, because volumes have no Blender vector pass. Sampling: `c0 = tex(uv0 - mv0*k)`, `c1 = tex(uv1 + mv1*(1-k))`, `mix(c0, c1, k)`.

## 4. Manifest (`public/fx/atlas.json`)

`{version, format: 'webp'|'ktx2', ktx2: {available, reason}, atlases: {id: entry}}`.

**A flipbook entry has:**
- `type: 'flipbook'`, `kind`, `grid: [cols, rows]`, `frames`, `fps`, `loop`;
- `blend: 'premultiplied'`, `tint` (true means neutral grey, colour it at runtime), `colorSpace`, `premultiplied`, `hdrScale`;
- `pivot: [u, v from bottom]` (the emitter origin inside the frame) and `worldSize: [w, h]` in metres at bake scale;
- `full` / `low` / `mv`: `{file, w, h, frame, bytes, ktx2?}`;
- `source` (method, Blender version, peak RAM, bake seconds, command).

**Other entries:**
- **Sprites:** `sprites: {name: {cell, channel, rect}}`.
- **Decals:** `cells: {name: {cell, rect, tint, source}}` and `data`.
- **Noise:** `channels`.

## 5. Licences

`public/fx/credits.json` is the ledger: one row per shipped file with source, licence, URL and attribution. `public/fx/CREDITS.md` is generated from it. `check_budget.mjs` fails when an image in `public/fx` has no ledger row.

**Accepted sources:**

| Source | Licence |
|---|---|
| own bakes and procedural textures | CC0 |
| Kenney Particle Pack | CC0 (`License.txt` checked by the ingest) |
| Screaming Brain Studios noise | CC0 (`License.txt` checked by the ingest) |
| Unity Labs flipbooks | CC0 (verified page, `fx-research.md`) |
| ambientCG | CC0 |

CGHEVEN (custom licence) is **not** ingested until the owner says yes (plan §6 Q3).

## 6. Pack folder layout (owner downloads)

Searched in order: `Assets\VFX\` (or `--root`), `Assets\VFX\unity\`, `Assets\fx\`, then `Assets\`. Case does not matter.

```
Assets\VFX\kenney_particle-pack.zip                 -> fx_sprites (64 masks)
Assets\VFX\sbs_-_noise_texture_pack_-_512x512.zip   -> noise_a, noise_b, decal crack sources (the 128 zip is ignored)
Assets\fx\<Pack>-flipbooks.zip  (22 Unity Labs packs) -> unity_<pack>, per the UNITY table in ingest_packs.py
```

**Unity Labs zip layout (inspected 2026-10-17).** Each zip holds `<Pack>_<C>x<R>.tga` and the same sheet as a linear `.exr`. Fire packs also carry a `-temperature` EXR, which is not used yet.

| Property | Values found |
|---|---|
| Grids | 5x5, 8x8, 16x4, 20x4 |
| Cell size | not always square or whole pixels: CandleSmoke01 is 51.2 x 128 px; the flames are 128 x 256 |
| Alpha | straight (SmallFlame01-smaller is premultiplied); the FireBall packs and Flame03-hollow are RGB on black (additive) |

`manifest.packs` records the grid, frame size, alpha mode, wrap-test score and ship decision for every pack. `python -P tools/fx/ingest_packs.py --only unity:<Pack>` ingests one pack. `--ship-all` ships every pack, at the cost of the budget.

ambientCG decals are not used (the owner found only road markings). Decals are procedural (`make_decals.py`). The ambientCG code path stays: it picks up `Assets\VFX\ambientcg\*_1K-PNG.zip` if one is ever added.

After any ingest, run `make_decals.py`, `write_credits.py`, `check_budget.mjs` and `contact_sheets.py`. `--wait` polls every 60 s until the packs appear.
