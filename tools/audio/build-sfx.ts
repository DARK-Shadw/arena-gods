/**
 * Build shipped SFX from audio-src/ (extracted packs) per src/data/sfx.ts:
 * trim leading/trailing silence, cap length with a fade, peak-normalise,
 * mono 44.1 kHz Vorbis. Writes public/audio/sfx/<pool>_<n>.ogg and
 * public/audio/sfx/manifest.json (duration + transient peak offset per file).
 * Also converts the music loop. Re-runnable; skips up-to-date outputs.
 *   npm run audio:build
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { MUSIC, POOLS } from '../../src/data/sfx';

const SRC = 'audio-src';
const OUT = 'public/audio';
mkdirSync(`${OUT}/sfx`, { recursive: true });
mkdirSync(`${OUT}/music`, { recursive: true });

const ff = (args: string[]) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...args]);
/** Run ffmpeg volumedetect and return max_volume (dB). */
function maxVolume(file: string): number {
  const res = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /max_volume:\s*(-?[\d.]+) dB/.exec(res.stderr ?? '');
  return m ? parseFloat(m[1]) : 0;
}

const manifest: Record<string, { file: string; dur: number; peak: number }[]> = {};
let total = 0;
for (const [pool, def] of Object.entries(POOLS)) {
  manifest[pool] = [];
  def.src.forEach((src, i) => {
    const inPath = `${SRC}/${src}`;
    if (!existsSync(inPath)) throw new Error(`missing source ${inPath}`);
    const out = `${OUT}/sfx/${pool}_${i}.ogg`;
    const max = def.maxDur ?? 1.5;
    if (!existsSync(out) || statSync(out).mtimeMs < statSync(inPath).mtimeMs) {
      const tmp = `${OUT}/sfx/_tmp.wav`;
      const trim = 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.005,areverse,silenceremove=start_periods=1:start_threshold=-55dB,areverse';
      ff(['-i', inPath, '-af', `${trim},atrim=0:${max},afade=t=out:st=${Math.max(0, max - 0.15)}:d=0.15`, '-ac', '1', '-ar', '44100', tmp]);
      const gain = -1.5 - maxVolume(tmp);
      ff(['-i', tmp, '-af', `volume=${gain.toFixed(2)}dB`, '-c:a', 'libvorbis', '-q:a', '4', out]);
    }
    manifest[pool].push({ file: `sfx/${pool}_${i}.ogg`, dur: 0, peak: 0 });
    total += statSync(out).size;
  });
}
// durations + transient peak offsets (python/numpy is faster at this)
const py = `
import json,sys,soundfile as sf,numpy as np
m=json.load(open(sys.argv[1]))
for pool in m.values():
  for f in pool:
    a,sr=sf.read('public/audio/'+f['file'],always_2d=True); a=np.abs(a.mean(1))
    f['dur']=round(len(a)/sr,3); f['peak']=round(int(np.argmax(a))/sr,3)
json.dump(m,open(sys.argv[1],'w'),indent=1)
`;
writeFileSync(`${OUT}/sfx/manifest.json`, JSON.stringify(manifest));
writeFileSync('audio-src/_peaks.py', py);
execFileSync('python', ['audio-src/_peaks.py', `${OUT}/sfx/manifest.json`]);

// music loop: stereo vorbis, modest quality
const mOut = `${OUT}/${MUSIC.out}`;
const mIn = `../Assets/sfx/${MUSIC.src}`;
if (!existsSync(mOut)) ff(['-i', mIn, '-c:a', 'libvorbis', '-q:a', '3', '-ar', '44100', mOut]);
total += statSync(mOut).size;
console.log(`[audio] ${Object.values(manifest).reduce((s, p) => s + p.length, 0)} sfx files + music, ${(total / 1e6).toFixed(2)} MB`);
