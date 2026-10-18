// F3 probe (everyday combat FX): filmstrips of fixed fight moments and seek-replay checks on a built dist/.
// ONE headless browser, sequential, no dev server (serves dist/ through page.route).
//   node tools/shots/f3probe.cjs strips --out=<dir> [--dist=dist] [--label=after] [--q=2] [--gore=standard] [--moments=docs/milestones/F3/moments.txt]
//   node tools/shots/f3probe.cjs seek   [--dist=dist] [--q=2] [--json=<file>]
// moments.txt: one per line `label a b seed theme layout aseed event[:filter] t0 [cam]` where the moment is the first
// `event` at or after sim time t0 (filters: heavy, light, aldric, a=<id>); frames at +0.03 +0.12 +0.3 +0.7 +1.6 s.
const { chromium } = require('playwright-core');
const path = require('path'),
  fs = require('fs');
const args = process.argv.slice(2);
const MODE = args[0];
const opt = (k, d) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const DIST = path.resolve(opt('dist', path.resolve(__dirname, '../../dist')));
const LABEL = opt('label', 'after');
const Q = Number(opt('q', '2'));
const GORE = opt('gore', 'standard');
const OUT = path.resolve(opt('out', 'f3shots'));
const W = Number(opt('w', 1280)),
  H = Number(opt('h', 720));
const OFFS = opt('offs', '0.03,0.12,0.3,0.7,1.6').split(',').map(Number);
const exe = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.webp': 'image/webp', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml' };

function moments() {
  const f = opt('moments', path.resolve(__dirname, '../../docs/milestones/F3/moments.txt'));
  return fs
    .readFileSync(f, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const [label, a, b, seed, theme, layout, aseed, ev, t0, cam] = l.split(/\s+/);
      return { label, a, b, seed: +seed, theme, layout, aseed: +aseed, ev, t0: +t0, cam: cam ? cam.split(',').map(Number) : [3.4, 1.5, 1] };
    });
}

async function open(page, F, extra = '') {
  await page.goto(`http://arena.local/index.html?manual=1&auto=1&skip=1&a=${F.a}&b=${F.b}&seed=${F.seed}&theme=${F.theme}&layout=${F.layout}&aseed=${F.aseed}&q=${Q}&gore=${GORE}${extra}`);
  await page.waitForFunction(() => window.__arena && window.__arena.state === 'fight', null, { timeout: 120000 });
  // atlases load asynchronously: give them a moment (WebP decode)
  await page.waitForTimeout(1500);
}

(async () => {
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
  const out = { mode: MODE, label: LABEL, dist: DIST, q: Q, gore: GORE, results: [] };
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
    page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && !/favicon|AudioContext/.test(m.text()) && console.log('console.' + m.type(), m.text().slice(0, 300)));
    await page.route('http://arena.local/**', (route) => {
      const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\//, '') || 'index.html';
      const p = path.join(DIST, rel);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) route.fulfill({ path: p, contentType: MIME[path.extname(p)] || 'application/octet-stream' });
      else route.fulfill({ status: 404, body: '' });
    });
    if (MODE === 'strips') {
      fs.mkdirSync(OUT, { recursive: true });
      for (const M of moments()) {
        await open(page, M);
        const info = await page.evaluate(
          ([ev, t0, cam]) => {
            const A = __arena;
            const [type, filt] = ev.split(':');
            const ok = (e) => {
              if (e.type !== type || e.t < t0) return false;
              if (!filt) return true;
              if (filt === 'heavy') return !!(e.data && e.data.heavy);
              if (filt === 'light') return !(e.data && e.data.heavy);
              if (filt.startsWith('a=')) return A.rec.ids[e.a] === filt.slice(2);
              if (filt.startsWith('m=')) return !!e.data && e.data.move === filt.slice(2);
              if (filt.startsWith('b=')) return e.b !== undefined && A.rec.ids[e.b] === filt.slice(2);
              return true;
            };
            const e = A.rec.events.find(ok);
            if (!e) return null;
            A.debugSeekFight(Math.max(0.05, e.t - 0.02));
            const f = A.playback.frameAt(A.playback.t).f;
            const mx = (f[0].x + f[1].x) / 2,
              mz = (f[0].z + f[1].z) / 2;
            let dx = f[1].x - f[0].x,
              dz = f[1].z - f[0].z;
            const l = Math.hypot(dx, dz) || 1;
            (dx /= l), (dz /= l);
            A.debugView([mx - dz * cam[0] * cam[2], cam[1], mz + dx * cam[0] * cam[2]], [mx, 1.0, mz], 50);
            return { t: e.t, type: e.type, data: e.data, a: A.rec.ids[e.a], b: e.b !== undefined ? A.rec.ids[e.b] : '' };
          },
          [M.ev, M.t0, M.cam],
        );
        if (!info) {
          console.log('no event for', M.label);
          continue;
        }
        const files = [];
        let simPrev = await page.evaluate(() => __arena.playback.t);
        for (const off of OFFS) {
          // step until the sim clock passes event time + offset (hit-stop and slow-mo slow the sim down)
          await page.evaluate(
            ([target]) => {
              const A = __arena;
              for (let k = 0; k < 600 && A.playback.t < target; k++) A.stepFrames(1, 1 / 60);
            },
            [info.t + off],
          );
          if (process.env.F3DBG) console.log('  +' + off, JSON.stringify(await page.evaluate(() => { const L = __arena.vfx.sprites.get('mask'); return { s: __arena.fxStats().sprites, t: __arena.vfx.clock.t, sim: __arena.playback.t, vis: L && L.mesh.visible, tex: L && !!L.mat.uniforms.uTex.value, d: L && Array.from(L.data.slice((L.cursor - 1) * 24, L.cursor * 24)).map((x) => +x.toFixed(3)), ld: L && L.lastDeath, cur: L && L.cursor, chest: __arena.views[1].chestWorld().toArray().map((x) => +x.toFixed(2)), lim: L && L.limit, hw: L && L.highWater }; })));
          if (off === OFFS[0]) info.live = await page.evaluate(([t0]) => [...new Set(__arena.fx.liveEffects().filter((e) => e.t0 >= t0 - 0.05).map((e) => e.id))], [info.t]);
          const f = path.join(OUT, `${M.label}_${LABEL}_${String(off).replace('.', 'p')}.png`);
          await page.screenshot({ path: f });
          files.push(f);
        }
        const st = await page.evaluate(() => __arena.fxStats());
        out.results.push({ label: M.label, event: info, files, stats: { sprites: st.sprites, decals: st.decals, wounds: st.wounds, ribbons: st.ribbons, ghosts: st.ghosts, lights: st.lights } });
        console.log(`${M.label.padEnd(18)} ${info.type} t=${info.t.toFixed(2)} ${info.a}->${info.b} ${JSON.stringify(info.data)} [${info.live}] decals ${st.decals} wounds ${st.wounds} sprites ${JSON.stringify(st.sprites)}`);
        void simPrev;
      }
    } else if (MODE === 'seek') {
      // A: two fresh ?t= loads at the same moment give the same FX state, floor and blood
      // B: a play-through from 0 to T at fixed steps gives the same floor decals and wounds as a seek to T
      const F = { a: 'gorak', b: 'vex', seed: 4242, theme: 'colosseum', layout: 'oval', aseed: 7 };
      const F2 = { a: 'aldric', b: 'fenrik', seed: 77, theme: 'forge', layout: 'pit', aseed: 3 };
      for (const fight of [F, F2]) {
        for (const T of [12, 24]) {
          const hashes = [];
          for (let k = 0; k < 2; k++) {
            await open(page, fight, `&t=${T}&pause=1`);
            hashes.push(await page.evaluate(() => ({ t: __arena.playback.t, state: __arena.fxStateHash(), list: __arena.fxHash(), decals: __arena.fxDecalHash(), blood: __arena.fxBloodHash(), stats: __arena.fxStats() })));
          }
          // play-through: from the start of the fight, fixed 1/60 steps until the sim clock reaches the
          // time the seek's warm-up ended at (hit-stop can leave it a little short of T)
          await open(page, fight);
          const play = await page.evaluate(
            ([T]) => {
              const A = __arena;
              for (let k = 0; k < 20000 && A.playback.t < T - 1e-6; k++) A.stepFrames(1, 1 / 60);
              return { t: A.playback.t, decals: A.fxDecalHash(T), blood: A.fxBloodHash(), stats: A.fxStats() };
            },
            [hashes[0].t],
          );
          const r = {
            fight: `${fight.a}-${fight.b}#${fight.seed}`,
            T,
            seekSame: hashes[0].state === hashes[1].state && hashes[0].decals === hashes[1].decals && hashes[0].blood === hashes[1].blood && hashes[0].list === hashes[1].list,
            seekVsPlayDecals: hashes[0].decals === play.decals,
            seekVsPlayBlood: hashes[0].blood === play.blood,
            seek: hashes[0].stats.seek,
            seekDecals: hashes[0].decals,
            playDecals: play.decals,
            playT: play.t,
            liveAfterSeek: hashes[0].stats.effects,
          };
          out.results.push(r);
          console.log(JSON.stringify(r));
        }
      }
    }
  } finally {
    await browser.close();
  }
  const J = opt('json', '');
  if (J) fs.writeFileSync(J, JSON.stringify(out, null, 1));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
