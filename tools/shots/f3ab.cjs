// F3 same-page A/B of FX costs that land in the SCENE pass (the FX light pool, floor decals) and in
// the FX pass, with GPU timer queries per post pass (Post.setProfiling). The frame is frozen (only
// post.render() is repeated), configurations are interleaved over several rounds, so thermal and clock
// drift hit every configuration alike. ONE headless browser; serves a built dist/.
//   node tools/shots/f3ab.cjs [--dist=dist] [--q=2] [--n=60] [--rounds=4] [--json=<file>]
const { chromium } = require('playwright-core');
const path = require('path'),
  fs = require('fs');
const args = process.argv.slice(2);
const opt = (k, d) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const DIST = path.resolve(opt('dist', path.resolve(__dirname, '../../dist')));
const Q = Number(opt('q', '2'));
const N = Number(opt('n', '60'));
const ROUNDS = Number(opt('rounds', '4'));
const exe = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.webp': 'image/webp', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml' };
const FIGHTS = [
  { a: 'gorak', b: 'vex', seed: 4242, theme: 'colosseum', layout: 'oval', aseed: 7, t: 40 },
  { a: 'aldric', b: 'vex', seed: 1234, theme: 'glacier', layout: 'cross', aseed: 5, t: 30 },
];
// lights: FX light-pool slots kept visible (pre-F3 had exactly one impact light); decals on/off; fxOn: FX layers on/off
const CONFIGS = [
  { name: 'F3 (3 lights, decals)', lights: 3, decals: true },
  { name: '1 light, decals', lights: 1, decals: true },
  { name: '3 lights, no decals', lights: 3, decals: false },
  { name: '1 light, no decals', lights: 1, decals: false },
];
(async () => {
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
  const out = { q: Q, n: N, rounds: ROUNDS, results: [] };
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
    await page.route('http://arena.local/**', (route) => {
      const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\//, '') || 'index.html';
      const p = path.join(DIST, rel);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) route.fulfill({ path: p, contentType: MIME[path.extname(p)] || 'application/octet-stream' });
      else route.fulfill({ status: 404, body: '' });
    });
    for (const F of FIGHTS) {
      await page.goto(`http://arena.local/index.html?manual=1&auto=1&skip=1&a=${F.a}&b=${F.b}&seed=${F.seed}&theme=${F.theme}&layout=${F.layout}&aseed=${F.aseed}&q=${Q}`);
      await page.waitForFunction(() => window.__arena && window.__arena.state === 'fight', null, { timeout: 120000 });
      await page.waitForTimeout(1500);
      await page.evaluate((t) => {
        const A = __arena;
        A.debugSeekFight(t);
        const f = A.playback.frameAt(A.playback.t).f;
        const mx = (f[0].x + f[1].x) / 2, mz = (f[0].z + f[1].z) / 2;
        A.debugView([mx + 3.2, 2.2, mz + 3.2], [mx, 0.6, mz], 50);
        // light every pool slot so their cost shows (as during a busy exchange)
        for (const L of A.vfx.lights.lights) (L.intensity = 4), L.position.set(mx, 1.2, mz);
      }, F.t);
      const acc = {};
      for (let r = 0; r < ROUNDS; r++) {
        for (const C of CONFIGS) {
          const res = await page.evaluate(
            async ([C, n]) => {
              const A = __arena;
              A.vfx.lights.setSlots(C.lights);
              for (const [i, L] of A.vfx.lights.lights.entries()) L.intensity = i < C.lights ? 4 : 0;
              A.vfx.decals.mesh.visible = C.decals;
              for (let k = 0; k < 10; k++) A.post.render(); // warm-up (a light-count change recompiles)
              A.post.setProfiling(true);
              for (let k = 0; k < n; k++) A.post.render();
              for (let k = 0; k < 120 && A.post.timer.pending.length; k++) await new Promise((r) => setTimeout(r, 16)), A.post.gpuTimes();
              const g = A.post.gpuTimes();
              A.post.setProfiling(false);
              return { scene: g.scene && g.scene.p50, fx: g.fx && g.fx.p50, decals: A.vfx.decals.count(1e9) };
            },
            [C, N],
          );
          (acc[C.name] ??= []).push(res);
        }
      }
      for (const [k, v] of Object.entries(acc)) {
        const med = (xs) => xs.filter((x) => x != null).sort((a, b) => a - b)[Math.floor(xs.length / 2)];
        const r = { fight: `${F.theme}:${F.a}-${F.b}@${F.t}`, config: k, scene: +med(v.map((x) => x.scene)).toFixed(3), fx: +med(v.map((x) => x.fx)).toFixed(3), decals: v[0].decals, rounds: v.map((x) => x.scene) };
        out.results.push(r);
        console.log(`${r.fight.padEnd(28)} ${k.padEnd(24)} scene p50 ${r.scene.toFixed(2)} ms  fx ${r.fx.toFixed(3)} ms  decals ${r.decals}  rounds ${r.rounds.map((x) => x.toFixed(2)).join(' ')}`);
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
