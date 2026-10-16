// Post-process raw TTS wavs into shipped voice files:
//   per-character ffmpeg FX chain, silence trim, loudness normalise, mono ogg.
// Writes public/audio/voice/<fighter>/<id>.ogg and public/audio/voice/manifest.json
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const jobs = JSON.parse(readFileSync('audio-src/tts/jobs.json', 'utf8'));
const manPath = 'public/audio/voice/manifest.json';
const manifest = existsSync(manPath) ? JSON.parse(readFileSync(manPath, 'utf8')) : {};
let made = 0, missing = 0;
for (const j of jobs) {
  const raw = `audio-src/tts/raw/${j.hash}.wav`;
  if (!existsSync(raw)) { missing++; continue; }
  const dir = `public/audio/voice/${j.fighter}`;
  mkdirSync(dir, { recursive: true });
  const out = `${dir}/${j.id}.ogg`;
  const key = j.hash + ':' + j.fx;
  if (manifest[j.id]?.key === key && existsSync(out)) continue;
  const trim = 'silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse';
  const af = `${trim},${j.fx},loudnorm=I=-16:TP=-1.5:LRA=11,apad=pad_dur=0.25`;
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', raw, '-af', af, '-ac', '1', '-ar', '32000', '-c:a', 'libvorbis', '-q:a', '3', out]);
  const dur = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString());
  manifest[j.id] = { file: `voice/${j.fighter}/${j.id}.ogg`, dur: +dur.toFixed(2), text: j.text, key };
  made++;
}
writeFileSync(manPath, JSON.stringify(manifest, null, 1));
console.log(`[tts] post-processed ${made} lines (${missing} raw files missing), manifest has ${Object.keys(manifest).length}`);
