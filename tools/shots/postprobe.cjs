// Post / FX GPU cost probe (milestone F1). GPU timer queries (EXT_disjoint_timer_query_webgl2) around
// App.post.render(), plus per-pass timings (the F1 Post's own queries; for the pre-F1 EffectComposer the
// probe wraps each composer pass). Serves a built dist/ (no dev server). ONE headless browser, sequential.
//   node tools/shots/postprobe.cjs [--dist=dist] [--label=after] [--q=0,1,2] [--n=120] [--w=1920 --h=1080]
//        [--fights=0,1,2] [--stress=1] [--shots=<dir>] [--json=<file>] [--bench=0 (shots only)] [--extra=&msaa=4]
// Fixed fights, fixed sim time, fixed free camera (debugView), so A/B runs of two builds see the same frames.
// GPU ms are indicative only: thermal state and the Windows compositor move them by ~10-15 %.
const { chromium } = require('playwright-core');
const path = require('path'),
  fs = require('fs');
const args = process.argv.slice(2);
const opt = (k, d) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const DIST = path.resolve(opt('dist', path.resolve(__dirname, '../../dist')));
const LABEL = opt('label', path.basename(DIST));
const QS = opt('q', '2,1,0').split(',').map(Number);
const N = Number(opt('n', '120'));
const W = Number(opt('w', 1920)),
  H = Number(opt('h', 1080));
const STRESS = opt('stress', '1') === '1';
const SHOTS = opt('shots', '');
const JSON_OUT = opt('json', '');
const exe = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.webp': 'image/webp', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml' };
const FIGHTS = [
  { a: 'gorak', b: 'erika', seed: 4242, theme: 'colosseum', layout: 'oval', aseed: 7, t: 20, cam: [4.6, 1.9, 1] },
  { a: 'ozrel', b: 'maw', seed: 77, theme: 'forge', layout: 'pit', aseed: 3, t: 14, cam: [4.6, 1.9, -1] },
  { a: 'aldric', b: 'vex', seed: 1234, theme: 'glacier', layout: 'cross', aseed: 5, t: 16, cam: [4.6, 1.9, 1] },
  // look-only fights (screenshots of the remaining themes)
  { a: 'fenrik', b: 'aldric', seed: 51, theme: 'skytemple', layout: 'oval', aseed: 2, t: 12, cam: [4.6, 1.9, 1] },
  { a: 'vex', b: 'maw', seed: 52, theme: 'sakura', layout: 'oval', aseed: 2, t: 12, cam: [4.6, 1.9, 1] },
  { a: 'hollowjack', b: 'gorak', seed: 53, theme: 'moonlake', layout: 'oval', aseed: 2, t: 12, cam: [4.6, 1.9, 1] },
  { a: 'erika', b: 'ozrel', seed: 54, theme: 'desert', layout: 'oval', aseed: 2, t: 12, cam: [4.6, 1.9, 1] },
];
const BENCH = opt('bench', '1') === '1';
// --extra="&msaa=4": extra URL parameters (e.g. MSAA on the F1 scene target)
const EXTRA = opt('extra', '');
const pick = opt('fights', '0,1,2').split(',').map(Number);

const PAGE = () => {
  const A = window.__arena;
  const gl = A.renderer.getContext();
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const pending = [];
  const results = { total: [] };
  const px = new Uint8Array(4);
  const poll = () => {
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i];
      if (!gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) continue;
      if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) (results[p.k] = results[p.k] || []).push(gl.getQueryParameter(p.q, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(p.q);
      pending.splice(i, 1);
    }
  };
  const timed = (k, fn) => {
    if (!ext) return fn();
    const q = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    try {
      return fn();
    } finally {
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      pending.push({ q, k });
    }
  };
  const origRender = A.post.render.bind(A.post);
  let mode = 'total';
  A.post.render = () => (mode === 'total' ? timed('total', origRender) : origRender());
  // pre-F1 build: wrap each EffectComposer pass
  const composer = A.post.composer;
  if (composer) {
    for (const [i, p] of composer.passes.entries()) {
      const name = `${i}:${p.constructor.name}`;
      const r = p.render.bind(p);
      p.render = (...a) => (mode === 'passes' && p.enabled ? timed(name, () => r(...a)) : r(...a));
    }
  }
  const stats = (xs) => {
    if (!xs || !xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return { avg: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(3), p50: +s[Math.floor(s.length / 2)].toFixed(3), p95: +s[Math.floor(s.length * 0.95)].toFixed(3), n: s.length };
  };
  window.__pp = {
    hasTimer: !!ext,
    async run(n, m, stress) {
      mode = m;
      for (const k of Object.keys(results)) results[k] = [];
      const cpu = [];
      if (m === 'passes' && A.post.setProfiling) A.post.setProfiling(true);
      for (let i = 0; i < n; i++) {
        if (stress && i % 8 === 0) {
          A.fx.spawn('explosion.keg', { x: 0.6, y: 0.6, z: 0.3 }, { seed: 1000 + i });
          A.fx.spawn('impact.default.heavy', { x: -0.4, y: 1.2, z: 0 }, { seed: 2000 + i });
          if (i % 32 === 0) A.fx.spawn('kill.plain', { x: 0, y: 1.2, z: 0.5 }, { seed: 3000 + i });
          // F3 everyday combat on top (ids unknown to a pre-F3 build spawn nothing)
          for (const [k, id] of ['impact.cut.metal', 'impact.heavy', 'shock.heavy', 'blood.cut', 'block.sparks', 'parry.flash', 'knockdown.dust'].entries()) A.fx.spawn(id, { x: -0.2 + k * 0.1, y: 1.2, z: 0.2 }, { seed: 4000 + i * 8 + k });
        }
        const t0 = performance.now();
        A.tick(1 / 60);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        cpu.push(performance.now() - t0);
        poll();
      }
      for (let k = 0; k < 60 && pending.length; k++) {
        await new Promise((r) => setTimeout(r, 16));
        poll();
      }
      let passes = {};
      if (m === 'passes') {
        // query results only become available after returning to the event loop
        if (A.post.timer) for (let k = 0; k < 120 && A.post.timer.pending.length; k++) await new Promise((r) => setTimeout(r, 16)), A.post.gpuTimes();
        if (A.post.gpuTimes) { passes = A.post.gpuTimes(); if (!Object.keys(passes).length) console.log('[probe] no pass timings', JSON.stringify({ en: A.post.timer && A.post.timer.enabled, pend: A.post.timer && A.post.timer.pending.length, keys: A.post.timer && Object.keys(A.post.timer.samples) })); }
        else for (const k of Object.keys(results)) if (k !== 'total') passes[k] = stats(results[k]);
        if (A.post.setProfiling) A.post.setProfiling(false);
      }
      const fs = A.fx.stats();
      return { frame: stats(cpu), gpu: stats(results.total), passes, calls: A.renderer.info.render.calls, fxCpu: fs.cpu, fxLive: { particles: fs.particles, sprites: fs.sprites, decals: fs.decals } };
    },
  };
};

(async () => {
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
  const out = { label: LABEL, dist: DIST, w: W, h: H, n: N, runs: [] };
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
    page.on('console', (m) => m.text().startsWith('[probe]') && console.log(m.text()));
    await page.route('http://arena.local/**', (route) => {
      const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\//, '') || 'index.html';
      const p = path.join(DIST, rel);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) route.fulfill({ path: p, contentType: MIME[path.extname(p)] || 'application/octet-stream' });
      else route.fulfill({ status: 404, body: '' });
    });
    for (const fi of pick) {
      const F = FIGHTS[fi];
      for (const q of QS) {
        await page.goto(`http://arena.local/index.html?manual=1&auto=1&skip=1&a=${F.a}&b=${F.b}&seed=${F.seed}&theme=${F.theme}&layout=${F.layout}&aseed=${F.aseed}&q=${q}${EXTRA}`);
        await page.waitForFunction(() => window.__arena && window.__arena.state === 'fight', null, { timeout: 120000 });
        await page.evaluate(PAGE);
        // fixed camera: side-on to the fighters' line at the seek time (dist, height, side)
        await page.evaluate(([t, cam]) => {
          __arena.debugSeekFight(t);
          const f = __arena.playback.frameAt(__arena.playback.t).f;
          const mx = (f[0].x + f[1].x) / 2, mz = (f[0].z + f[1].z) / 2;
          let dx = f[1].x - f[0].x, dz = f[1].z - f[0].z;
          const l = Math.hypot(dx, dz) || 1;
          (dx /= l), (dz /= l);
          __arena.debugView([mx - dz * cam[0] * cam[2], cam[1], mz + dx * cam[0] * cam[2]], [mx, 1.05, mz], 50);
        }, [F.t, F.cam]);
        if (SHOTS) {
          fs.mkdirSync(SHOTS, { recursive: true });
          await page.evaluate(() => __arena.stepFrames(1, 1 / 60));
          await page.screenshot({ path: path.join(SHOTS, `${F.theme}_q${q}_${LABEL}.png`) });
        }
        if (SHOTS) {
          // FX moment on the same fixed camera: fresh explosion + heavy hit, 0.12 s in
          await page.evaluate(() => {
            const f = __arena.playback.frameAt(__arena.playback.t).f;
            const c = __arena.camera.position;
            const mx = (f[0].x + f[1].x) / 2, mz = (f[0].z + f[1].z) / 2;
            const ax = mx - c.x, az = mz - c.z, al = Math.hypot(ax, az) || 1;
            __arena.fx.spawn('explosion.keg', { x: mx + (ax / al) * 2.5, y: 0.6, z: mz + (az / al) * 2.5 }, { seed: 77 });
            __arena.fx.spawn('impact.default.heavy', { x: (f[0].x + f[1].x) / 2, y: 1.2, z: (f[0].z + f[1].z) / 2 }, { seed: 78 });
            __arena.fx.spawn('dodge.dust', { x: f[0].x, y: 0, z: f[0].z }, { seed: 79 });
            __arena.stepFrames(7, 1 / 60);
          });
          await page.screenshot({ path: path.join(SHOTS, `${F.theme}_q${q}_${LABEL}_fx.png`) });
        }
        if (!BENCH) continue;
        await page.evaluate(() => __pp.run(30, 'total', false)); // warm-up (shader compiles)
        const base = await page.evaluate((n) => __pp.run(n, 'total', false), N);
        const passes = await page.evaluate((n) => __pp.run(n, 'passes', false), N);
        const stress = STRESS ? await page.evaluate((n) => __pp.run(n, 'total', true), N) : null;
        const r = { fight: `${F.theme}:${F.a}-${F.b}`, q, timer: await page.evaluate(() => __pp.hasTimer), base, stress, passes: passes.passes };
        out.runs.push(r);
        const g = (x) => (x ? `${x.avg.toFixed(2)} (p95 ${x.p95.toFixed(2)})` : 'n/a');
        console.log(`${LABEL.padEnd(8)} ${r.fight.padEnd(28)} q${q}  gpu ${g(base.gpu)}  frame ${g(base.frame)}  calls ${base.calls}  fxcpu ${base.fxCpu.frameMs}+${base.fxCpu.updateMs}${stress ? `  | stress gpu ${g(stress.gpu)} frame ${g(stress.frame)} fxcpu ${stress.fxCpu.frameMs}+${stress.fxCpu.updateMs}` : ''}`);
        console.log('         passes ' + Object.entries(passes.passes).map(([k, v]) => `${k} ${v ? v.avg.toFixed(2) : '-'}`).join('  '));
      }
    }
  } finally {
    await browser.close();
  }
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 1));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
