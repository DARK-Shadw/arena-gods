/**
 * DIALOGUE MANAGER: nemesis-style voiced barks + subtitles.
 *
 * - Lines come from src/data/dialogue.ts; audio from public/audio/voice/
 *   (pre-rendered offline by `npm run tts:gen`). Missing audio degrades to
 *   subtitles only.
 * - Line choice uses its own seeded RNG (match seed), consumed only in
 *   response to deterministic sim events, so a replay of a seed speaks the
 *   same lines. Nothing here feeds back into the sim.
 * - One voice at a time: priority-based interrupts, per-fighter cooldowns,
 *   per-situation chances; music/sfx are ducked while a line plays.
 */
import { Rng, hashSeed } from '../sim/rng';
import { DIALOGUE, RIVALRIES, type Situation } from '../data/dialogue';
import { audio } from './audio';

export interface VoiceEntry {
  file: string;
  dur: number;
  text: string;
}
export interface PickedLine {
  id: string;
  text: string;
  dur: number;
  speaker: number;
}

export interface SubtitleSink {
  subtitle(name: string, text: string, color: string, dur: number): void;
}

let manifestP: Promise<Record<string, VoiceEntry>> | null = null;
export function loadVoiceManifest(): Promise<Record<string, VoiceEntry>> {
  if (!manifestP)
    manifestP = fetch(`${import.meta.env.BASE_URL}audio/voice/manifest.json`)
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}));
  return manifestP;
}

const PRIORITY: Record<string, number> = {
  entrance: 5, faceoff: 5, victory: 4, defeat: 4, kill: 4, ultimate: 3, nearDeath: 2, comeback: 2, taunt: 1, hurt: 1,
};

export class DialogueManager {
  ids: [string, string];
  names: [string, string];
  private rng: Rng;
  private man: Record<string, VoiceEntry> = {};
  private used = new Set<string>();
  private speaking: { pri: number; until: number; stop: () => void; speaker: number } | null = null;
  private lastSpoke = [-99, -99];
  private queue: { line: PickedLine; pri: number; at: number }[] = [];
  private t = 0;
  posOf: (i: number) => { x: number; z: number } = () => ({ x: 0, z: 0 });
  /** Count of lines started (for automated tests). */
  spoken: string[] = [];

  constructor(ids: [string, string], names: [string, string], seed: number, private ui: SubtitleSink) {
    this.ids = ids;
    this.names = names;
    this.rng = new Rng(hashSeed(`dialogue:${seed}:${ids[0]}:${ids[1]}`));
  }

  /** Fetch the manifest and decode this match's voice files. */
  async preload() {
    this.man = await loadVoiceManifest();
    const files = Object.entries(this.man)
      .filter(([id]) => id.startsWith(this.ids[0] + '.') || id.startsWith(this.ids[1] + '.'))
      .map(([, v]) => v.file);
    await Promise.all(files.map((f) => audio.loadVoice(f)));
  }

  get busy() {
    return !!this.speaking && this.t < this.speaking.until;
  }

  private estimate(text: string) {
    return 0.6 + text.split(/\s+/).length / 2.6;
  }

  /** Choose a line for a fighter (seeded, avoids repeats). */
  pick(speaker: number, situation: Situation | `vs_${string}`): PickedLine | null {
    const id = this.ids[speaker];
    const d = DIALOGUE[id];
    if (!d) return null;
    const arr = situation.startsWith('vs_') ? d.vs?.[situation.slice(3)] : d.lines[situation as Situation];
    if (!arr?.length) return null;
    const ids = arr.map((_, i) => `${id}.${situation}.${i}`);
    const fresh = ids.filter((x) => !this.used.has(x));
    const pool = fresh.length ? fresh : ids;
    const lineId = pool[Math.floor(this.rng.next() * pool.length)];
    this.used.add(lineId);
    const n = Number(lineId.split('.').pop());
    const text = arr[n];
    return { id: lineId, text, dur: this.man[lineId]?.dur ?? this.estimate(text), speaker };
  }

  /** Face-off exchange: rivalry lines if this pair has history, else generic. */
  banter(): [PickedLine | null, PickedLine | null] {
    const [a, b] = this.ids;
    const rival = RIVALRIES.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
    if (rival) return [this.pick(0, `vs_${b}`), this.pick(1, `vs_${a}`)];
    return [this.pick(0, 'faceoff'), this.pick(1, 'faceoff')];
  }

  /** Speak a picked line now (used by cutscene timelines). */
  play(line: PickedLine | null, pri = 5) {
    if (!line) return;
    this.speaking?.stop();
    const id = this.ids[line.speaker];
    const persona = DIALOGUE[id]?.persona;
    const entry = this.man[line.id];
    let stop = () => {};
    if (entry) {
      const buf = audio.getBuffer(entry.file);
      if (buf) stop = audio.playVoice(buf, this.posOf(line.speaker), 1);
      else void audio.loadVoice(entry.file); // not decoded yet: subtitle only this time
    }
    this.ui.subtitle(this.names[line.speaker], line.text, persona?.color ?? '#fff', line.dur + 0.4);
    this.speaking = { pri, until: this.t + line.dur, stop, speaker: line.speaker };
    this.lastSpoke[line.speaker] = this.t;
    this.spoken.push(line.id);
  }

  /**
   * Request a bark from gameplay. `chance` is rolled on the seeded RNG.
   * Returns true if the line will be spoken (now or queued).
   */
  say(speaker: number, situation: Situation, chance = 1, queue = false): boolean {
    const pri = PRIORITY[situation] ?? 1;
    // roll first so RNG consumption doesn't depend on timing
    const roll = this.rng.next();
    if (roll > chance) return false;
    if (pri <= 2 && this.t - this.lastSpoke[speaker] < (pri === 1 ? 6 : 3)) return false;
    const line = this.pick(speaker, situation);
    if (!line) return false;
    if (this.busy) {
      if (pri > this.speaking!.pri) {
        this.play(line, pri);
        return true;
      }
      if (queue) {
        this.queue.push({ line, pri, at: this.speaking!.until + 0.25 });
        return true;
      }
      return false;
    }
    this.play(line, pri);
    return true;
  }

  update(dt: number) {
    this.t += dt;
    if (!this.busy && this.queue.length) {
      const q = this.queue[0];
      if (this.t >= q.at) {
        this.queue.shift();
        this.play(q.line, q.pri);
      }
    }
  }

  stopAll() {
    this.speaking?.stop();
    this.speaking = null;
    this.queue = [];
  }
}
