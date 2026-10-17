# FX asset credits and licences

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
| `blood_spray.low.webp` | Blender bake: tools/fx/blender (metaball particles (analytic ballistic + drag, velocity-stretched ellipsoids)) | CC0 1.0 (own work, Arena Gods) | not required | tools/fx/blender |
| `blood_spray.webp` | Blender bake: tools/fx/blender (metaball particles (analytic ballistic + drag, velocity-stretched ellipsoids)) | CC0 1.0 (own work, Arena Gods) | not required | tools/fx/blender |
| `decals.low.webp` | procedural (tools/fx/make_decals.py); crack cells from Screaming Brain noise pack: sbs_-_noise_texture_pack_-_512x512.zip | CC0 1.0 (own work; SBS / ambientCG sources are CC0) | not required | tools/fx/make_decals.py; https://opengameart.org/content/noise-texture-pack |
| `decals.webp` | procedural (tools/fx/make_decals.py); crack cells from Screaming Brain noise pack: sbs_-_noise_texture_pack_-_512x512.zip | CC0 1.0 (own work; SBS / ambientCG sources are CC0) | not required | tools/fx/make_decals.py; https://opengameart.org/content/noise-texture-pack |
| `decals_nrm.webp` | procedural (tools/fx/make_decals.py); crack cells from Screaming Brain noise pack: sbs_-_noise_texture_pack_-_512x512.zip | CC0 1.0 (own work; SBS / ambientCG sources are CC0) | not required | tools/fx/make_decals.py; https://opengameart.org/content/noise-texture-pack |
| `dust_puff.low.webp` | Blender bake: tools/fx/blender (B procedural volume (expanding noise sphere), 3 directional light passes) | CC0 1.0 (own work, Arena Gods) | not required | tools/fx/blender |
| `dust_puff.webp` | Blender bake: tools/fx/blender (B procedural volume (expanding noise sphere), 3 directional light passes) | CC0 1.0 (own work, Arena Gods) | not required | tools/fx/blender |
| `dust_ring.low.webp` | Blender bake: tools/fx/blender (B procedural volume (expanding noise torus), 3 directional light passes) | CC0 1.0 (own work, Arena Gods) | not required | tools/fx/blender |
| `dust_ring.webp` | Blender bake: tools/fx/blender (B procedural volume (expanding noise torus), 3 directional light passes) | CC0 1.0 (own work, Arena Gods) | not required | tools/fx/blender |
| `embers.low.webp` | Blender bake: tools/fx/blender (emissive icospheres on periodic analytic paths, EEVEE motion blur) | CC0 1.0 (own work, Arena Gods) | not required | tools/fx/blender |
| `embers.webp` | Blender bake: tools/fx/blender (emissive icospheres on periodic analytic paths, EEVEE motion blur) | CC0 1.0 (own work, Arena Gods) | not required | tools/fx/blender |
| `energy_swirl.low.webp` | Blender bake: tools/fx/blender (B procedural volume (rotating 3D noise, exact loop)) | CC0 1.0 (own work, Arena Gods) | not required | tools/fx/blender |
| `energy_swirl.webp` | Blender bake: tools/fx/blender (B procedural volume (rotating 3D noise, exact loop)) | CC0 1.0 (own work, Arena Gods) | not required | tools/fx/blender |
| `explosion.low.webp` | Blender bake: tools/fx/blender (B procedural volume (expanding noise fireball, heat -> smoke)) | CC0 1.0 (own work, Arena Gods) | not required | tools/fx/blender |
| `explosion.webp` | Blender bake: tools/fx/blender (B procedural volume (expanding noise fireball, heat -> smoke)) | CC0 1.0 (own work, Arena Gods) | not required | tools/fx/blender |
| `fire_burst.low.webp` | Blender bake: tools/fx/blender (B procedural volume (expanding noise fireball, heat -> smoke)) | CC0 1.0 (own work, Arena Gods) | not required | tools/fx/blender |
| `fire_burst.webp` | Blender bake: tools/fx/blender (B procedural volume (expanding noise fireball, heat -> smoke)) | CC0 1.0 (own work, Arena Gods) | not required | tools/fx/blender |
| `fire_loop.low.webp` | Blender bake: tools/fx/blender (B procedural volume (4D noise, density-space loop)) | CC0 1.0 (own work, Arena Gods) | not required | tools/fx/blender |
| `fire_loop.mv.webp` | Blender bake: tools/fx/blender (B procedural volume (4D noise, density-space loop)) | CC0 1.0 (own work, Arena Gods) | not required | tools/fx/blender |
| `fire_loop.webp` | Blender bake: tools/fx/blender (B procedural volume (4D noise, density-space loop)) | CC0 1.0 (own work, Arena Gods) | not required | tools/fx/blender |
| `fx_sprites.low.webp` | Kenney Particle Pack 1.1 (kenney.nl), 64 sprites resampled and channel-packed | CC0 1.0 (License.txt in the pack) | not required ("Credit (Kenney or www.kenney.nl) would be nice") | https://kenney.nl/assets/particle-pack |
| `fx_sprites.webp` | Kenney Particle Pack 1.1 (kenney.nl), 64 sprites resampled and channel-packed | CC0 1.0 (License.txt in the pack) | not required ("Credit (Kenney or www.kenney.nl) would be nice") | https://kenney.nl/assets/particle-pack |
| `noise_a.webp` | Screaming Brain Studios, Noise Texture Pack (opengameart.org), 8 textures downscaled and channel-packed | CC0 1.0 (License.txt in the pack) | never required | https://opengameart.org/content/noise-texture-pack |
| `noise_b.webp` | Screaming Brain Studios, Noise Texture Pack (opengameart.org), 8 textures downscaled and channel-packed | CC0 1.0 (License.txt in the pack) | never required | https://opengameart.org/content/noise-texture-pack |
| `smoke_wisp.low.webp` | Blender bake: tools/fx/blender (B procedural volume (4D noise, density-space loop), 3 directional light passes) | CC0 1.0 (own work, Arena Gods) | not required | tools/fx/blender |
| `smoke_wisp.mv.webp` | Blender bake: tools/fx/blender (B procedural volume (4D noise, density-space loop), 3 directional light passes) | CC0 1.0 (own work, Arena Gods) | not required | tools/fx/blender |
| `smoke_wisp.webp` | Blender bake: tools/fx/blender (B procedural volume (4D noise, density-space loop), 3 directional light passes) | CC0 1.0 (own work, Arena Gods) | not required | tools/fx/blender |
| `splash.low.webp` | Blender bake: tools/fx/blender (metaball particles (analytic ballistic + drag, velocity-stretched ellipsoids)) | CC0 1.0 (own work, Arena Gods) | not required | tools/fx/blender |
| `splash.webp` | Blender bake: tools/fx/blender (metaball particles (analytic ballistic + drag, velocity-stretched ellipsoids)) | CC0 1.0 (own work, Arena Gods) | not required | tools/fx/blender |
| `unity_candlesmoke01.low.webp` | Unity Labs free VFX image sequences & flipbooks: CandleSmoke01 (CandleSmoke01_20x4.tga), resampled + premultiplied | CC0 1.0 (Unity blog page: "we release some of these sequences under CC0 license"; docs/fx-research.md [V]) | not required | https://unity.com/blog/engine-platform/free-vfx-image-sequences-flipbooks |
| `unity_candlesmoke01.webp` | Unity Labs free VFX image sequences & flipbooks: CandleSmoke01 (CandleSmoke01_20x4.tga), resampled + premultiplied | CC0 1.0 (Unity blog page: "we release some of these sequences under CC0 license"; docs/fx-research.md [V]) | not required | https://unity.com/blog/engine-platform/free-vfx-image-sequences-flipbooks |
| `unity_cloud01.low.webp` | Unity Labs free VFX image sequences & flipbooks: Cloud01 (Cloud01_8x8.tga), resampled + premultiplied | CC0 1.0 (Unity blog page: "we release some of these sequences under CC0 license"; docs/fx-research.md [V]) | not required | https://unity.com/blog/engine-platform/free-vfx-image-sequences-flipbooks |
| `unity_cloud01.webp` | Unity Labs free VFX image sequences & flipbooks: Cloud01 (Cloud01_8x8.tga), resampled + premultiplied | CC0 1.0 (Unity blog page: "we release some of these sequences under CC0 license"; docs/fx-research.md [V]) | not required | https://unity.com/blog/engine-platform/free-vfx-image-sequences-flipbooks |
| `unity_explosion00.low.webp` | Unity Labs free VFX image sequences & flipbooks: Explosion00 (Explosion00_5x5.tga), resampled + premultiplied | CC0 1.0 (Unity blog page: "we release some of these sequences under CC0 license"; docs/fx-research.md [V]) | not required | https://unity.com/blog/engine-platform/free-vfx-image-sequences-flipbooks |
| `unity_explosion00.webp` | Unity Labs free VFX image sequences & flipbooks: Explosion00 (Explosion00_5x5.tga), resampled + premultiplied | CC0 1.0 (Unity blog page: "we release some of these sequences under CC0 license"; docs/fx-research.md [V]) | not required | https://unity.com/blog/engine-platform/free-vfx-image-sequences-flipbooks |
| `unity_explosion01_nofire.low.webp` | Unity Labs free VFX image sequences & flipbooks: Explosion01-nofire (Explosion01-nofire_5x5.tga), resampled + premultiplied | CC0 1.0 (Unity blog page: "we release some of these sequences under CC0 license"; docs/fx-research.md [V]) | not required | https://unity.com/blog/engine-platform/free-vfx-image-sequences-flipbooks |
| `unity_explosion01_nofire.webp` | Unity Labs free VFX image sequences & flipbooks: Explosion01-nofire (Explosion01-nofire_5x5.tga), resampled + premultiplied | CC0 1.0 (Unity blog page: "we release some of these sequences under CC0 license"; docs/fx-research.md [V]) | not required | https://unity.com/blog/engine-platform/free-vfx-image-sequences-flipbooks |
| `unity_fireball01.low.webp` | Unity Labs free VFX image sequences & flipbooks: FireBall01 (FireBall01_8x8.tga), resampled + premultiplied | CC0 1.0 (Unity blog page: "we release some of these sequences under CC0 license"; docs/fx-research.md [V]) | not required | https://unity.com/blog/engine-platform/free-vfx-image-sequences-flipbooks |
| `unity_fireball01.webp` | Unity Labs free VFX image sequences & flipbooks: FireBall01 (FireBall01_8x8.tga), resampled + premultiplied | CC0 1.0 (Unity blog page: "we release some of these sequences under CC0 license"; docs/fx-research.md [V]) | not required | https://unity.com/blog/engine-platform/free-vfx-image-sequences-flipbooks |
| `unity_flame02.low.webp` | Unity Labs free VFX image sequences & flipbooks: Flame02 (Flame02_16x4.tga), resampled + premultiplied | CC0 1.0 (Unity blog page: "we release some of these sequences under CC0 license"; docs/fx-research.md [V]) | not required | https://unity.com/blog/engine-platform/free-vfx-image-sequences-flipbooks |
| `unity_flame02.webp` | Unity Labs free VFX image sequences & flipbooks: Flame02 (Flame02_16x4.tga), resampled + premultiplied | CC0 1.0 (Unity blog page: "we release some of these sequences under CC0 license"; docs/fx-research.md [V]) | not required | https://unity.com/blog/engine-platform/free-vfx-image-sequences-flipbooks |
| `unity_flame03.low.webp` | Unity Labs free VFX image sequences & flipbooks: Flame03 (Flame03_16x4.tga), resampled + premultiplied | CC0 1.0 (Unity blog page: "we release some of these sequences under CC0 license"; docs/fx-research.md [V]) | not required | https://unity.com/blog/engine-platform/free-vfx-image-sequences-flipbooks |
| `unity_flame03.webp` | Unity Labs free VFX image sequences & flipbooks: Flame03 (Flame03_16x4.tga), resampled + premultiplied | CC0 1.0 (Unity blog page: "we release some of these sequences under CC0 license"; docs/fx-research.md [V]) | not required | https://unity.com/blog/engine-platform/free-vfx-image-sequences-flipbooks |
| `unity_smallflame01.low.webp` | Unity Labs free VFX image sequences & flipbooks: SmallFlame01 (SmallFlame01_16x4.tga), resampled + premultiplied | CC0 1.0 (Unity blog page: "we release some of these sequences under CC0 license"; docs/fx-research.md [V]) | not required | https://unity.com/blog/engine-platform/free-vfx-image-sequences-flipbooks |
| `unity_smallflame01.webp` | Unity Labs free VFX image sequences & flipbooks: SmallFlame01 (SmallFlame01_16x4.tga), resampled + premultiplied | CC0 1.0 (Unity blog page: "we release some of these sequences under CC0 license"; docs/fx-research.md [V]) | not required | https://unity.com/blog/engine-platform/free-vfx-image-sequences-flipbooks |
| `unity_wispysmoke01.low.webp` | Unity Labs free VFX image sequences & flipbooks: WispySmoke01 (WispySmoke01_8x8.tga), resampled + premultiplied | CC0 1.0 (Unity blog page: "we release some of these sequences under CC0 license"; docs/fx-research.md [V]) | not required | https://unity.com/blog/engine-platform/free-vfx-image-sequences-flipbooks |
| `unity_wispysmoke01.webp` | Unity Labs free VFX image sequences & flipbooks: WispySmoke01 (WispySmoke01_8x8.tga), resampled + premultiplied | CC0 1.0 (Unity blog page: "we release some of these sequences under CC0 license"; docs/fx-research.md [V]) | not required | https://unity.com/blog/engine-platform/free-vfx-image-sequences-flipbooks |
