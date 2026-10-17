/**
 * FX CPU profiler (dev counters). The time source is injected by the game
 * (`fxProfiler.now` is set to the browser high-resolution timer in main.ts) so that nothing in
 * src/render/fx reads the wall clock itself; with the default source every
 * timing is 0 and the profiler costs nothing.
 *
 * GPU timer queries per layer and the overdraw estimate are F1 / F3 work.
 */
type Slot = 'frame' | 'update';

export const fxProfiler = {
  now: (() => 0) as () => number,
  /** exponential moving average (ms) and running max per slot */
  avg: { frame: 0, update: 0 } as Record<Slot, number>,
  max: { frame: 0, update: 0 } as Record<Slot, number>,
  samples: { frame: 0, update: 0 } as Record<Slot, number>,
  begin(): number {
    return this.now();
  },
  end(slot: Slot, t0: number) {
    const ms = this.now() - t0;
    this.samples[slot]++;
    this.avg[slot] += (ms - this.avg[slot]) * (this.samples[slot] < 20 ? 1 / this.samples[slot] : 0.05);
    if (ms > this.max[slot]) this.max[slot] = ms;
  },
  reset() {
    for (const k of ['frame', 'update'] as Slot[]) (this.avg[k] = 0), (this.max[k] = 0), (this.samples[k] = 0);
  },
};
