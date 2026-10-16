// Headless screenshots + GPU frame timing of built arenas (no dev server needed:
// dist/ is served through Playwright request routing).
//
//   npm run build
//   node tools/shots/shots.cjs <outDir> <theme[:layout[:aseed]]> [...more] [--q=2] [--fight=20] [--bench] [--w=1280 --h=720] [--swiftshader]
//
// For every arena: a wide establishing view, a mid shot, a low dramatic angle,
// and (with --fight=t) a seek into the fight at sim time t with the director camera.
const { chromium } = require('playwright-core');
const path = require('path'),
  fs = require('fs');

const args = process.argv.slice(2);
const out = args[0];
const opt = (k, d) => {
  const a = args.find((x) => x.startsWith(`--${k}`));
  if (!a) return d;
  const v = a.split('=')[1];
  return v === undefined ? true : v;
};
const specs = args.slice(1).filter((a) => !a.startsWith('--'));
const W = Number(opt('w', 1280)),
  H = Number(opt('h', 720));
const Q = Number(opt('q', 2));
const fightT = opt('fight', null);
const bench = !!opt('bench', false);
const swift = !!opt('swiftshader', false);
const fighters = String(opt('pair', 'gorak:erika')).split(':');
const fseed = Number(opt('fseed', 4242));
const seq = opt('seq', null); // t0,count,stepSeconds
const skipViews = !!opt('noviews', false);
const follow = opt('follow', null);
const intro = opt('intro', null); // comma list of intro times (s) to capture // fighter index for a side-on tracking camera during --seq
const DIST = path.resolve(__dirname, '../../dist');
const exe = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.svg': 'image/svg+xml', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.png': 'image/png' };

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: swift ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const logs = [];
  page.on('console', (m) => {
    const t = m.text();
    if (/error|warn|\[arena\]/i.test(t)) logs.push(t);
  });
  page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));
  await page.route('http://arena.local/**', (route) => {
    let rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\//, '') || 'index.html';
    const p = path.join(DIST, rel);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) route.fulfill({ path: p, contentType: MIME[path.extname(p)] || 'application/octet-stream' });
    else route.fulfill({ status: 404, body: '' });
  });
  const results = [];
  for (const spec of specs) {
    const [theme, layout = 'pit', aseed = '7'] = spec.split(':');
    const url = `http://arena.local/index.html?manual=1&auto=1&skip=${intro ? 0 : 1}&a=${fighters[0]}&b=${fighters[1]}&seed=${fseed}&theme=${theme}&layout=${layout}&aseed=${aseed}&q=${Q}`;
    const t0 = Date.now();
    await page.goto(url);
    const tag = `${theme}_${layout}_${aseed}`;
    if (intro) {
      await page.waitForFunction(() => window.__arena && window.__arena.state === 'intro', null, { timeout: 120000 });
      let cur = 0;
      for (const t of String(intro).split(',').map(Number)) {
        const n = Math.max(0, Math.round((t - cur) * 30));
        await page.evaluate((n) => __arena.stepFrames(n, 1 / 30), n);
        cur = t;
        await page.screenshot({ path: path.join(out, `${tag}_intro_${String(t).replace('.', '_')}.png`) });
      }
      await page.evaluate(() => __arena.skip(true));
    }
    await page.waitForFunction(() => window.__arena && window.__arena.state === 'fight', null, { timeout: 120000 });
    const build = Date.now() - t0;
    const L = await page.evaluate(() => ({ rx: __arena.arena.layout.rx, rz: __arena.arena.layout.rz, sun: __arena.arena.theme.sky.sunDir.toArray() }));
    const R = Math.max(L.rx, L.rz);
    // views derived from the arena size; establishing view from the side opposite the sun
    const sa = Math.atan2(L.sun[2], L.sun[0]) + Math.PI * 0.8;
    const views = {
      wide: [[Math.cos(sa) * R * 1.55, R * 0.95, Math.sin(sa) * R * 1.55], [0, 0.5, 0], 55],
      mid: [[Math.cos(sa + 0.9) * R * 0.75, 3.2, Math.sin(sa + 0.9) * R * 0.75], [0, 1.4, 0], 52],
      low: [[Math.cos(sa - 1.2) * 4.5, 0.9, Math.sin(sa - 1.2) * 4.5], [Math.cos(sa - 1.2 + Math.PI) * R, 3.5, Math.sin(sa - 1.2 + Math.PI) * R], 60],
    };
    // warm up the frame so particles / env are settled
    await page.evaluate(() => __arena.stepFrames(30, 1 / 60));
    for (const [name, v] of skipViews ? [] : Object.entries(views)) {
      await page.evaluate((v) => __arena.debugView(v[0], v[1], v[2]), v);
      await page.evaluate(() => __arena.stepFrames(2, 1 / 60));
      await page.screenshot({ path: path.join(out, `${tag}_${name}.png`) });
    }
    let perf = null;
    if (bench) {
      await page.evaluate((v) => __arena.debugView(v[0], v[1], v[2]), views.mid);
      perf = await page.evaluate(() => __arena.bench(90));
    }
    if (fightT !== null) {
      await page.evaluate(() => {
        __arena.freeCam = false;
      });
      await page.evaluate((t) => __arena.debugSeekFight(Number(t)), fightT);
      await page.screenshot({ path: path.join(out, `${tag}_fight.png`) });
    }
    if (seq) {
      const [t0, n, st] = String(seq).split(',').map(Number);
      await page.evaluate(() => {
        __arena.freeCam = false;
      });
      await page.evaluate((t) => __arena.debugSeekFight(t), t0);
      for (let k = 0; k < n; k++) {
        if (follow !== null)
          await page.evaluate((i) => {
            const A = __arena.views[i].position,
              B = __arena.views[1 - i].position;
            const mx = (A.x + B.x) / 2,
              mz = (A.z + B.z) / 2;
            let ax = B.x - A.x,
              az = B.z - A.z;
            const l = Math.hypot(ax, az) || 1;
            ax /= l;
            az /= l;
            const d = Math.max(5, l * 0.9 + 3);
            // the side facing the arena centre
            const s = (-az * -mx + ax * -mz) >= 0 ? 1 : -1;
            __arena.debugView([mx - az * d * s, 2.2, mz + ax * d * s], [mx, 1.2, mz], 50);
          }, Number(follow));
        await page.screenshot({ path: path.join(out, `${tag}_seq${String(k).padStart(2, '0')}.png`) });
        await page.evaluate((st) => __arena.stepFrames(Math.max(1, Math.round(st * 60)), 1 / 60), st);
      }
    }
    results.push({ tag, buildMs: build, perf });
    console.log(JSON.stringify({ tag, buildMs: build, perf }));
  }
  if (logs.length) console.log('--- console\n' + logs.slice(0, 40).join('\n'));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
