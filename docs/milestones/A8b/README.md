# A8b: independent ref-3 review of the Moon Gate, and fixes

Branch `anim-plan`, 2026-10-19. An independent reviewer (not A8) rendered fresh shots with the concept harness
(`node tools/shots/concept.cjs --refs=ref-3 --q=<0|1|2> --views=gate,tiers,overview,counter,flank`), looked at them next
to `docs/concept-art/ref-3.png` and fixed the biggest gaps in order of visual impact. `src/sim` is untouched.

## Step 1: ranked gap list (before, A8 `7d190a4`)

Shots: `before/q1/` (ref-3 preset + gate, tiers, overview, counter, flank views of seeded fights), `before/q2/`, `before/q0/`.
Ranked by what a viewer notices first:

1. **Floor reads as pale, clean lavender tiles.** It is the brightest large surface in the frame (ref-3: the darkest,
   near-black wet stone with glare only in the water). Cause: a broad moonlit specular sheen on the dry slab tops (direct
   moon key + planar reflection of the bright sky at roughness 0.7), plus a flat mid-grey baked albedo with thin even
   joints and small white puddle blotches that look like paint. No rubble / grit in the joints, stains barely visible.
2. **Fire reflections are straight orange bars** (5-10 per frame, uniform width, from the stair braziers to the bottom
   edge): the streak cards. In ref-3 the fire glints are broken by the wet stone and sit under the fires.
3. **Embers are large orange bokeh dots across the whole frame**, including the sky: reads as snow / dust, not sparks.
4. **The centre of the frame is a lit bronze portcullis in a flat wall** with a tripod brazier in front; the eye goes
   to it instead of the arch. Ref-3: one wide stair to the arch's portal (A7 decision: two flights + floor-level portal).
5. **Hanging hazards in the frame**: the fire cage (chandelier hazard) and the chain weight hang in the open air where
   ref-3 has sky. They are sim hazards of this seed (not dressing), so they stay; ref-3's preset seed shows them.
6. **Near-field swags** read as scalloped bunting (party decoration) with gold target sigils, not shredded rags;
   the near banners carry a round "target" sigil where ref-3 has a sharp glyph.
7. **Moon**: a flat white clipped disc; the ring arch reads as a tall horseshoe with a blocky bridge rather than
   ref-3's slim ring with the moon behind its crown.
8. **Left side plain**: tidy, flat-lit brick tiers and barrels; ref-3 has a huge near pillar with a banner, broken
   blocks, burning debris, chains.
9. **Props**: the terracotta urns and banded barrels are the most saturated non-fire objects (orange), off-palette.
10. **Backdrop stone** is clean blockout with a procedural shader (painterly carved stone in ref-3); arcade height and
    the sky between the ruins are right.
11. **Counter / tiers views**: away from the moon the sky is a flat navy with stars; the walls are clean bright brick.
12. **Tiers**: q2 (hero inset) and q1 look nearly the same in the ref-3 frame; q0 holds up (slightly softer stone,
    stronger streaks). No tier loses the likeness badly.
13. Haze colour and ground mist are close enough; overall brightness is fine except the floor (item 1).

Owner feedback carried in: floor darker, rougher, thicker broken slabs, deep joints, rubble, blood / soot, wet mostly in
puddles and cracks; keep the sky; dark overall with strong accents.
