/**
 * Public FX API (see docs/fx-api.md). Import from here, not from the files.
 */
export { FxDirector, createFxDirector, type FxWorld, type FxStats, type SpawnCtx, type FxFrameInput } from './fxDirector';
export { VFX } from './legacyVfx';
export { DEFS, RESOLVE, CONTINUOUS, ON_ACTIVE, defDuration, type FxDef, type FxLayer, type FxOp, type Anchor } from './fxDefs';
export { fxSettings, goreLevel, setGoreLevel, TIER_CAPS, type GoreLevel, type FxQuality } from './fxSettings';
export { FxRng, hash1, hashN, hashStr, spawnSeed } from './fxRng';
export { FxClock } from './fxClock';
export { GpuParticles, PARTICLE_WORLD_SCALE } from './particles';
export { fxProfiler } from './profiler';
