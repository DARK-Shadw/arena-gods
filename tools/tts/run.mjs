// npm run tts:gen [-- --subset first]
// 1) export dialogue lines -> jobs.json  2) OmniVoice generation (cached by hash)  3) ffmpeg post-processing
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const PY = process.env.TTS_PYTHON ?? 'C:/Programming/FunBuilds/FunnyGuyInPc/tts-lab/envs/omnivoice/Scripts/python.exe';
const run = (cmd, a) => execFileSync(cmd, a, { stdio: 'inherit', shell: process.platform === 'win32' && cmd === 'npx' });
run('npx', ['tsx', 'tools/tts/export-lines.ts', ...args]);
// one python process per fighter: the iGPU (XPU) runs out of device memory if one process does everything
const fighters = [...new Set(JSON.parse(readFileSync('audio-src/tts/jobs.json', 'utf8')).map((j) => j.fighter))];
for (const f of fighters) {
  try {
    execFileSync(PY, ['-u', 'tools/tts/gen_omnivoice.py'], { stdio: 'inherit', env: { ...process.env, TTS_FIGHTER: f } });
  } catch (e) {
    console.error(`[tts] generation for ${f} failed (${e.status}); continuing`);
  }
}
run('node', ['tools/tts/post.mjs']);
