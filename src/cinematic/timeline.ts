/**
 * Minimal reusable cutscene timeline. A Timeline is a list of clips on named
 * tracks (camera, actor, light, text, audio, vfx...). Each clip gets
 * enter / update(k) / exit callbacks; zero-length clips are one-shot cues.
 * Seeking forward fires skipped cues in order so state stays consistent.
 */
export interface Clip {
  track: string;
  start: number;
  dur: number;
  enter?: () => void;
  /** k = 0..1 progress, lt = local seconds, dt = frame delta */
  update?: (k: number, lt: number, dt: number) => void;
  exit?: () => void;
  /** internal */
  _state?: 0 | 1 | 2;
}

export class Timeline {
  clips: Clip[] = [];
  t = 0;
  duration = 0;
  onEnd?: () => void;
  private ended = false;

  add(c: Clip): this {
    c._state = 0;
    this.clips.push(c);
    this.duration = Math.max(this.duration, c.start + c.dur);
    return this;
  }

  /** One-shot cue. */
  cue(track: string, t: number, fn: () => void): this {
    return this.add({ track, start: t, dur: 0, enter: fn });
  }

  /** Continuous clip. */
  span(track: string, start: number, dur: number, update: (k: number, lt: number, dt: number) => void, enter?: () => void, exit?: () => void): this {
    return this.add({ track, start, dur, update, enter, exit });
  }

  get done() {
    return this.ended;
  }

  update(dt: number) {
    if (this.ended) return;
    this.t += dt;
    // stable order: by start time
    for (const c of this.clips) {
      if (c._state === 2) continue;
      if (this.t < c.start) continue;
      if (c._state === 0) {
        c._state = 1;
        c.enter?.();
      }
      const lt = this.t - c.start;
      if (c.dur <= 0 || lt >= c.dur) {
        c.update?.(1, c.dur, dt);
        c.exit?.();
        c._state = 2;
      } else {
        c.update?.(lt / c.dur, lt, dt);
      }
    }
    if (this.t >= this.duration && !this.ended) {
      this.ended = true;
      this.onEnd?.();
    }
  }

  /** Jump to the end, firing all remaining cues (used for skipping). */
  finish() {
    if (this.ended) return;
    this.clips.sort((a, b) => a.start - b.start);
    this.update(this.duration - this.t + 0.001);
  }
}

export const Ease = {
  linear: (t: number) => t,
  inOut: (t: number) => t * t * (3 - 2 * t),
  out: (t: number) => 1 - (1 - t) * (1 - t),
  in: (t: number) => t * t,
  outBack: (t: number) => {
    const c1 = 1.70158,
      c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
};
export type EaseName = keyof typeof Ease;
