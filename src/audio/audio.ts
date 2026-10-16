/**
 * Audio engine (WebAudio).
 *
 * Signal flow:
 *   sample/synth voices ─▶ [panner] ─▶ bus (sfx | voice | ui | ambience | music)
 *   sfx + ambience ─▶ slowmo low-pass ─▶ duck gain ─┐
 *   music ─▶ music low-pass ─▶ music duck ──────────┼─▶ master ─▶ compressor ─▶ limiter ─▶ out
 *   voice, ui ─────────────────────────────────────┘
 *
 * - Samples come from public/audio/sfx/manifest.json (built by
 *   `npm run audio:build` from the downloaded packs; see src/data/sfx.ts).
 *   Pools give random variation: no immediate repeats, pitch range, ±10% gain.
 * - Positional: stereo pan + distance attenuation relative to the camera.
 * - Slow-mo: low-pass + pitch-down on new samples during the killcam;
 *   hit-stop: brief duck.
 * - Music: looping boss-battle track whose level/filter follows the drama
 *   tension; quiet during entrances; ducked under voice lines.
 * - Synth (the original procedural sounds) remains as fallback and for the
 *   crowd bed, fire, roars and stingers that have no sample source.
 * - Volume settings (master/sfx/voice/music) persist in localStorage.
 */
import { POOLS } from '../data/sfx';

export interface SfxFile {
  file: string;
  dur: number;
  peak: number;
}
type Manifest = Record<string, SfxFile[]>;
export type Bus = 'sfx' | 'voice' | 'ui' | 'music' | 'ambience';

export interface PlayOpts {
  vol?: number;
  rate?: number;
  /** world position for pan/attenuation */
  pos?: { x: number; y?: number; z: number };
  /** seconds from now when the transient peak should be heard */
  at?: number;
  /** force a file index */
  idx?: number;
  bus?: Bus;
  /** skip the pre-transient part so the impact is heard immediately */
  hitNow?: boolean;
}

export interface Settings {
  master: number;
  sfx: number;
  voice: number;
  music: number;
}
const SETTINGS_KEY = 'arena.audio.v1';

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private buses = {} as Record<Bus, GainNode>;
  private sfxDuck!: GainNode;
  private musicDuck!: GainNode;
  private slowLP!: BiquadFilterNode;
  private musicLP!: BiquadFilterNode;
  private musicGain!: GainNode;
  private crowdGain!: GainNode;
  private crowdFilters: BiquadFilterNode[] = [];
  private noise!: AudioBuffer;
  private buffers = new Map<string, AudioBuffer>();
  private manifest: Manifest = {};
  private lastIdx: Record<string, number> = {};
  private musicSrc: AudioBufferSourceNode | null = null;
  private musicBuf: AudioBuffer | null = null;
  private listener = { x: 0, z: 0, rx: 1, rz: 0 };
  private slowmo = 1;
  private voiceActive = 0;
  tension = 0.2;
  musicOn = false;
  musicMode: 'off' | 'intro' | 'fight' | 'victory' = 'off';
  muted = false;
  /** play counters per pool (used by automated tests) */
  stats: Record<string, number> = {};
  settings: Settings = { master: 0.85, sfx: 0.9, voice: 1, music: 0.55 };
  loaded = false;

  constructor() {
    try {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
      if (s) this.settings = { ...this.settings, ...s };
    } catch {
      /* storage blocked */
    }
  }

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    // master chain: glue compressor -> brickwall-ish limiter
    this.master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 3;
    comp.attack.value = 0.01;
    comp.release.value = 0.2;
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -2;
    lim.knee.value = 0;
    lim.ratio.value = 20;
    lim.attack.value = 0.001;
    lim.release.value = 0.08;
    this.master.connect(comp).connect(lim).connect(ctx.destination);
    // buses
    for (const b of ['sfx', 'voice', 'ui', 'music', 'ambience'] as Bus[]) this.buses[b] = ctx.createGain();
    this.slowLP = ctx.createBiquadFilter();
    this.slowLP.type = 'lowpass';
    this.slowLP.frequency.value = 20000;
    this.sfxDuck = ctx.createGain();
    this.buses.sfx.connect(this.slowLP);
    this.buses.ambience.connect(this.slowLP);
    this.slowLP.connect(this.sfxDuck).connect(this.master);
    this.buses.voice.connect(this.master);
    this.buses.ui.connect(this.master);
    this.musicLP = ctx.createBiquadFilter();
    this.musicLP.type = 'lowpass';
    this.musicLP.frequency.value = 900;
    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = 0;
    this.musicDuck = ctx.createGain();
    this.buses.music.connect(this.musicLP).connect(this.musicGain).connect(this.musicDuck).connect(this.master);
    this.applySettings();
    // noise buffer for synth
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.buildCrowd();
    void this.loadAll();
  }

  // ---------------------------------------------------------------- settings
  setSetting(k: keyof Settings, v: number) {
    this.settings[k] = Math.max(0, Math.min(1, v));
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      /* ignore */
    }
    this.applySettings();
  }
  private applySettings() {
    if (!this.ctx) return;
    const s = this.settings;
    this.master.gain.value = this.muted ? 0 : s.master;
    this.buses.sfx.gain.value = s.sfx;
    this.buses.ambience.gain.value = s.sfx * 0.9;
    this.buses.ui.gain.value = Math.max(s.sfx, s.voice) * 0.9;
    this.buses.voice.gain.value = s.voice;
    this.buses.music.gain.value = s.music;
  }
  setMuted(m: boolean) {
    this.muted = m;
    this.applySettings();
  }

  // ---------------------------------------------------------------- loading
  private async fetchBuffer(url: string): Promise<AudioBuffer | null> {
    if (!this.ctx) return null;
    if (this.buffers.has(url)) return this.buffers.get(url)!;
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      const b = await this.ctx.decodeAudioData(await r.arrayBuffer());
      this.buffers.set(url, b);
      return b;
    } catch (e) {
      console.warn('[audio] failed to load', url, e);
      return null;
    }
  }
  private async loadAll() {
    const base = `${import.meta.env.BASE_URL}audio/`;
    try {
      this.manifest = await (await fetch(`${base}sfx/manifest.json`)).json();
    } catch (e) {
      console.warn('[audio] no sfx manifest, synth fallback only', e);
      return;
    }
    const all = Object.values(this.manifest).flat();
    await Promise.all(all.map((f) => this.fetchBuffer(base + f.file)));
    this.loaded = true;
    this.musicBuf = await this.fetchBuffer(`${base}music/boss_battle.ogg`);
    if (this.musicOn) this.startMusic();
  }
  /** Already-decoded buffer for a file under public/audio/, if any. */
  getBuffer(file: string): AudioBuffer | undefined {
    return this.buffers.get(`${import.meta.env.BASE_URL}audio/${file}`);
  }
  /** Load a voice file (cached). */
  loadVoice(file: string) {
    return this.fetchBuffer(`${import.meta.env.BASE_URL}audio/${file}`);
  }

  // ---------------------------------------------------------------- spatial
  setListener(x: number, z: number, rightX: number, rightZ: number) {
    const l = Math.hypot(rightX, rightZ) || 1;
    this.listener = { x, z, rx: rightX / l, rz: rightZ / l };
  }
  private spatial(pos?: PlayOpts['pos']) {
    if (!pos) return { pan: 0, att: 1 };
    const dx = pos.x - this.listener.x,
      dz = pos.z - this.listener.z;
    const dist = Math.hypot(dx, dz) || 1;
    const pan = Math.max(-0.85, Math.min(0.85, (dx * this.listener.rx + dz * this.listener.rz) / dist));
    const att = Math.max(0.35, Math.min(1, 5 / dist));
    return { pan, att };
  }

  /** Slow-mo amount (1 = normal, 0.1 = deep slow-mo). */
  setSlowmo(scale: number) {
    if (!this.ctx) return;
    this.slowmo = scale;
    const t = this.ctx.currentTime;
    const f = scale >= 0.95 ? 20000 : 600 + scale * 6000;
    this.slowLP.frequency.setTargetAtTime(f, t, 0.08);
  }
  /** Brief duck for hit-stop / big impacts. */
  hitDuck(amount = 0.5, dur = 0.12) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.musicDuck.gain.cancelScheduledValues(t);
    this.musicDuck.gain.setValueAtTime(this.voiceActive > 0 ? 0.35 : 1 - amount, t);
    this.musicDuck.gain.setTargetAtTime(this.voiceActive > 0 ? 0.35 : 1, t + dur, 0.15);
  }

  // ---------------------------------------------------------------- samples
  has(pool: string) {
    return this.loaded && !!this.manifest[pool]?.length;
  }

  /** Play a random file from a pool. Returns true if a sample played. */
  play(pool: string, o: PlayOpts = {}): boolean {
    this.stats[pool] = (this.stats[pool] ?? 0) + 1;
    if (!this.ctx || !this.has(pool)) return false;
    const files = this.manifest[pool];
    const def = POOLS[pool];
    let idx = o.idx ?? Math.floor(Math.random() * files.length);
    if (o.idx === undefined && files.length > 1 && idx === this.lastIdx[pool]) idx = (idx + 1 + Math.floor(Math.random() * (files.length - 1))) % files.length;
    this.lastIdx[pool] = idx;
    const f = files[idx];
    const buf = this.buffers.get(`${import.meta.env.BASE_URL}audio/${f.file}`);
    if (!buf) return false;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const rate = (def.pitch[0] + Math.random() * (def.pitch[1] - def.pitch[0])) * (o.rate ?? 1) * (this.slowmo < 0.9 ? 0.55 + this.slowmo * 0.45 : 1);
    src.playbackRate.value = rate;
    const { pan, att } = this.spatial(o.pos);
    const g = ctx.createGain();
    g.gain.value = def.vol * (o.vol ?? 1) * att * (0.9 + Math.random() * 0.2);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    const bus = o.bus ?? def.bus ?? 'sfx';
    src.connect(g).connect(p).connect(this.buses[bus]);
    const peak = f.peak / rate;
    if (o.hitNow) src.start(ctx.currentTime, Math.max(0, f.peak - 0.01));
    else src.start(ctx.currentTime + Math.max(0, (o.at ?? 0) - peak));
    return true;
  }

  /** Play a decoded voice buffer; returns its duration. Ducks music/sfx. */
  playVoice(buf: AudioBuffer, pos?: PlayOpts['pos'], vol = 1, onEnd?: () => void): () => void {
    if (!this.ctx) return () => {};
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = vol;
    const p = ctx.createStereoPanner();
    p.pan.value = this.spatial(pos).pan * 0.5;
    src.connect(g).connect(p).connect(this.buses.voice);
    src.start();
    this.voiceActive++;
    const t = ctx.currentTime;
    this.musicDuck.gain.setTargetAtTime(0.35, t, 0.05);
    this.sfxDuck.gain.setTargetAtTime(0.7, t, 0.05);
    let stopped = false;
    src.onended = () => {
      if (stopped) return;
      stopped = true;
      this.voiceActive = Math.max(0, this.voiceActive - 1);
      if (this.voiceActive === 0 && this.ctx) {
        this.musicDuck.gain.setTargetAtTime(1, this.ctx.currentTime, 0.25);
        this.sfxDuck.gain.setTargetAtTime(1, this.ctx.currentTime, 0.2);
      }
      onEnd?.();
    };
    return () => {
      try {
        g.gain.setTargetAtTime(0, ctx.currentTime, 0.04);
        src.stop(ctx.currentTime + 0.15);
      } catch {
        /* already stopped */
      }
    };
  }

  // ---------------------------------------------------------------- music
  setMusic(on: boolean, mode: 'intro' | 'fight' | 'victory' = 'fight') {
    this.musicOn = on;
    this.musicMode = on ? mode : 'off';
    if (!this.ctx) return;
    if (on) this.startMusic();
    const t = this.ctx.currentTime;
    const target = !on ? 0 : mode === 'intro' ? 0.25 : mode === 'victory' ? 0.6 : 0.5;
    this.musicGain.gain.setTargetAtTime(target, t, on ? 1.2 : 0.8);
  }
  private startMusic() {
    if (!this.ctx || !this.musicBuf || this.musicSrc) return;
    const s = this.ctx.createBufferSource();
    s.buffer = this.musicBuf;
    s.loop = true;
    s.connect(this.buses.music);
    s.start();
    this.musicSrc = s;
  }
  /** Momentary intensity bump (drama events). */
  musicSwell(amount = 0.3) {
    this.tension = Math.min(1, this.tension + amount);
  }

  private get now() {
    return this.ctx!.currentTime;
  }

  /** Call every frame. */
  update(tension: number) {
    if (!this.ctx) return;
    this.tension += (tension - this.tension) * 0.03;
    const ten = this.tension;
    const t = this.now;
    const mode = this.musicMode;
    const cut = mode === 'intro' ? 700 : mode === 'victory' ? 6000 : 1200 + ten * ten * 16000;
    this.musicLP.frequency.setTargetAtTime(this.slowmo < 0.9 ? 500 : cut, t, 0.3);
    if (mode === 'fight') this.musicGain.gain.setTargetAtTime(0.32 + ten * 0.45, t, 0.6);
    // crowd chatter: slowly wander band levels
    for (const f of this.crowdFilters) {
      if (Math.random() < 0.02) f.Q.setTargetAtTime(0.6 + Math.random() * 1.6, t, 0.4);
    }
  }

  // ---------------------------------------------------------------- crowd (synth)
  private buildCrowd() {
    const ctx = this.ctx!;
    this.crowdGain = ctx.createGain();
    this.crowdGain.gain.value = 0.05;
    this.crowdGain.connect(this.buses.ambience);
    // several formant-ish bands with independent slow modulation = murmuring crowd
    for (const [f, q, lfo] of [[350, 1.2, 0.23], [650, 1.5, 0.31], [1100, 1.8, 0.17], [2400, 2.2, 0.41]] as const) {
      const s = ctx.createBufferSource();
      s.buffer = this.noise;
      s.loop = true;
      s.playbackRate.value = 0.7 + Math.random() * 0.6;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f;
      bp.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0.5;
      const o = ctx.createOscillator();
      o.frequency.value = lfo;
      const og = ctx.createGain();
      og.gain.value = 0.35;
      o.connect(og).connect(g.gain);
      o.start();
      s.connect(bp).connect(g).connect(this.crowdGain);
      s.start(0, Math.random() * 1.5);
      this.crowdFilters.push(bp);
    }
  }
  setCrowd(excitement: number) {
    if (!this.ctx) return;
    this.crowdGain.gain.setTargetAtTime(0.025 + excitement * 0.09, this.now, 0.5);
  }
  /** Crowd cheer: a swell of voice-band noise plus scattered shouts. */
  cheer(amount = 1) {
    if (!this.ctx) return;
    const t = this.now;
    this.noiseBurst(t, 1.8 * amount, 'bandpass', 900, 0.9, 0.16 * amount, this.buses.ambience, 1300, 0.35);
    this.noiseBurst(t + 0.05, 1.5 * amount, 'bandpass', 2200, 1.4, 0.07 * amount, this.buses.ambience, 2600, 0.35);
    for (let i = 0; i < 6 * amount; i++) {
      const tt = t + Math.random() * 0.9;
      this.tone(tt, 'sawtooth', 180 + Math.random() * 260, 150 + Math.random() * 200, 0.25 + Math.random() * 0.25, 0.012 * amount, this.buses.ambience, 0.05);
    }
  }
  gasp() {
    if (!this.ctx) return;
    this.noiseBurst(this.now, 0.7, 'bandpass', 1400, 1.5, 0.12, this.buses.ambience, 700, 0.15);
  }

  // ---------------------------------------------------------------- synth primitives
  private env(g: GainNode, t: number, a: number, peak: number, decay: number) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + decay);
  }
  private noiseBurst(t: number, dur: number, type: BiquadFilterType, freq: number, q: number, peak: number, dest: AudioNode = this.buses.sfx, freqEnd?: number, attack = 0.005) {
    const ctx = this.ctx!;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    s.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    this.env(g, t, attack, peak, dur);
    s.connect(f).connect(g).connect(dest);
    s.start(t, Math.random() * 1.5);
    s.stop(t + dur + attack + 0.1);
  }
  private tone(t: number, type: OscillatorType, f0: number, f1: number, dur: number, peak: number, dest: AudioNode = this.buses.sfx, attack = 0.005) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = ctx.createGain();
    this.env(g, t, attack, peak, dur);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + attack + 0.05);
  }
  /** Low sub boom (layer under big impacts / the kill). */
  boom(strength = 1) {
    if (!this.ctx) return;
    const t = this.now;
    this.tone(t, 'sine', 90, 28, 1.2 * strength, 0.9 * strength);
    this.noiseBurst(t, 0.9 * strength, 'lowpass', 220, 0.7, 0.5 * strength);
  }

  // ---------------------------------------------------------------- legacy API (sample first, synth fallback)
  hit(heavy: boolean) {
    if (!this.ctx) return;
    if (this.play(heavy ? 'hit_heavy' : 'hit_blade', { hitNow: true })) {
      if (heavy) this.play('body_thud', { hitNow: true });
      return;
    }
    const t = this.now;
    this.tone(t, 'sine', heavy ? 140 : 190, 38, heavy ? 0.35 : 0.18, heavy ? 0.9 : 0.5);
    this.noiseBurst(t, heavy ? 0.22 : 0.1, 'bandpass', heavy ? 900 : 1500, 0.9, heavy ? 0.8 : 0.45);
  }
  clang(parry = false) {
    if (!this.ctx) return;
    if (this.play(parry ? 'parry' : 'clang', { hitNow: true, bus: 'ui' })) return;
    const t = this.now;
    for (const [f, a] of [[523, 0.25], [1231, 0.18], [1867, 0.12], [2713, 0.08]] as const) this.tone(t, 'sine', f, f * 0.995, parry ? 0.9 : 0.5, a);
  }
  whoosh(big = false) {
    if (!this.ctx) return;
    if (this.play(big ? 'whoosh_heavy' : 'whoosh_light')) return;
    this.noiseBurst(this.now, big ? 0.4 : 0.22, 'bandpass', big ? 300 : 500, 1.5, big ? 0.35 : 0.2, this.buses.sfx, big ? 1400 : 2200);
  }
  thud() {
    if (!this.ctx) return;
    if (this.play('body_thud', { hitNow: true })) return;
    const t = this.now;
    this.tone(t, 'sine', 90, 30, 0.45, 0.9);
    this.noiseBurst(t, 0.4, 'lowpass', 300, 0.8, 0.6);
  }
  crash() {
    if (!this.ctx) return;
    if (this.play('wood_break', { hitNow: true })) {
      this.play('wall_slam', { hitNow: true, vol: 0.7 });
      this.boom(0.6);
      return;
    }
    const t = this.now;
    this.tone(t, 'sine', 70, 25, 0.8, 1.0);
    this.noiseBurst(t, 0.9, 'lowpass', 900, 0.5, 0.9);
  }
  fire(big = false) {
    if (!this.ctx) return;
    const t = this.now;
    this.noiseBurst(t, big ? 1.2 : 0.5, 'lowpass', big ? 1800 : 1200, 0.5, big ? 0.5 : 0.3, this.buses.sfx, 300, 0.04);
    this.noiseBurst(t, big ? 1.0 : 0.4, 'highpass', 3000, 0.5, big ? 0.08 : 0.05, this.buses.sfx, 6000, 0.02);
  }
  /** Roar: creature samples pitched down + a synthesized growl body. */
  roar(pitch = 1, dur = 1.3) {
    if (!this.ctx) return;
    this.play('creature_roar', { rate: Math.max(0.5, Math.min(1.4, pitch * 0.9)), vol: 0.9 });
    const ctx = this.ctx;
    const t = this.now;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(95 * pitch, t);
    o.frequency.linearRampToValueAtTime(120 * pitch, t + dur * 0.3);
    o.frequency.linearRampToValueAtTime(70 * pitch, t + dur);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 500 * pitch;
    bp.Q.value = 2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.12);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(bp).connect(g).connect(this.buses.sfx);
    o.start(t);
    o.stop(t + dur + 0.1);
  }
  drum(accent = 1, when = 0) {
    if (!this.ctx) return;
    const t = this.now + when;
    this.tone(t, 'sine', 110, 42, 0.6, 0.9 * accent, this.buses.ui);
    this.noiseBurst(t, 0.08, 'bandpass', 1800, 1, 0.25 * accent, this.buses.ui);
  }
  /** Brass-ish chord stinger + shimmer. */
  stinger(kind: 'intro' | 'fight' | 'victory' | 'dread' = 'intro') {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = this.now;
    const chords: Record<string, number[]> = {
      intro: [73.4, 110, 146.8, 174.6, 220],
      fight: [98, 146.8, 196, 233.1, 293.7],
      victory: [110, 164.8, 220, 277.2, 329.6],
      dread: [61.7, 92.5, 123.5, 130.8, 185],
    };
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(400, t);
    lp.frequency.exponentialRampToValueAtTime(2600, t + 0.25);
    lp.frequency.exponentialRampToValueAtTime(600, t + 2.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.6);
    lp.connect(g).connect(this.buses.ui);
    for (const f of chords[kind])
      for (const det of [-8, 8]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.detune.value = det;
        o.connect(lp);
        o.start(t);
        o.stop(t + 2.7);
      }
    this.drum(1.2);
    this.play('ring', { bus: 'ui', vol: kind === 'dread' ? 0.6 : 0.9, rate: kind === 'dread' ? 0.7 : 1 });
  }
}

export const audio = new AudioEngine();
