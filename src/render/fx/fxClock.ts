/**
 * FX time. Effects are evaluated at `t` (seconds); they never read the wall clock.
 *
 * - In a fight `t` advances by the FX dt that main.ts already computes
 *   (sim dt, with a small floor so hit-stop "breathes" instead of freezing).
 * - `light` is a second clock that advances by real dt: the impact light keeps
 *   fading during hit-stop so a frozen frame does not bloom white.
 * - `seek(t)` sets both clocks, e.g. to the sim time of a `?t=` jump.
 * Both clocks advance only through `advance()`, so fixed-dt stepping
 * (stepFrames / debugSeekFight / the FX Lab) is exactly reproducible.
 */
export class FxClock {
  t = 0;
  light = 0;
  advance(dt: number, realDt = dt) {
    this.t += Math.max(0, dt);
    this.light += Math.max(0, realDt);
  }
  seek(t: number) {
    this.t = t;
    this.light = t;
  }
}
