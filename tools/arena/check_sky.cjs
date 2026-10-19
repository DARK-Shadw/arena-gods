// A7c authored-sky checker: GPU cost (F1 / A6 method), texture info, drift, lightning from match time, per tier.
//   npm run build && node tools/arena/check_sky.cjs [--q=2,1,0] [--n=240] [--rounds=16] [--out=docs/milestones/A7c/check]
// ONE headless Chromium on dist/ (no dev server); never together with a Blender job.
//   isolated   after each normal frame the sky mesh is drawn again ALONE into the post's scene target with that frame's
//              depth buffer bound (the walls still reject it), inside one timer query: the sky's own GPU time, for the
//              authored sky (uSky 1) and, in the same page, the same mesh with uSky 0 (gradient + moon only), on a view
//              where the sky fills most of the screen (worst case) and on the ref-3 camera
//   ab         interleaved blocks uSky 1 / 0, scene-pass timer (Post's per-pass timers): the paired difference
//   drift      two frames 10 s apart on the sky view: mean absolute pixel change (clouds move, nothing jumps)
//   lightning  the fight seeked to a strike time (match time 40.0 s, the first scheduled strike), twice: flash level and
//              scene.environmentIntensity vs its base (the probe pulse), and the same values both times (deterministic)
const { chromium } = require('playwright-core');
const path = require('path'),
  fs = require('fs');
const ROOT = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
const opt = (k, d) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const DIST = path.resolve(opt('dist', path.join(ROOT, 'dist')));
const OUT = path.resolve(opt('out', path.join(ROOT, 'docs/milestones/A7c/check')));
const QS = opt('q', '2,1,0').split(',').map(Number);
const N = Number(opt('n', '240'));
const ROUNDS = Number(opt('rounds', '16'));
const W = 1920,
  H = 1080;
const exe = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.webp': 'image/webp', '.ktx2': 'image/ktx2', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml', '.bin': 'application/octet-stream', '.wasm': 'application/wasm' };

const PAGE = () => {
  const A = window.__arena;
  const gl = A.renderer.getContext();
  const px = new Uint8Array(4);
  const sky = () => A.arena.sky;
  const U = () => sky().material.uniforms;
  const flush = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  window.__sk = {
    info() {
      const t = U().uSkyTex.value;
      return { on: U().uSky.value, tex: t ? { name: t.name, w: t.image?.width ?? t.mipmaps?.[0]?.width, h: t.image?.height ?? t.mipmaps?.[0]?.height, mips: t.mipmaps?.length ?? 0, compressed: !!t.isCompressedTexture, format: t.format } : null, storm: U().uStorm.value, look: !!A.arena.skyLook };
    },
    view(p, look, fov) {
      A.debugView(p, look, fov);
    },
    step(n, dt) {
      A.stepFrames(n, dt);
    },
    async isolated(n, skyOn) {
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      if (!ext) return null;
      const R = A.renderer;
      const s = sky();
      const parent = s.parent;
      const prevOn = U().uSky.value;
      U().uSky.value = skyOn;
      const tmp = new (A.scene.constructor)();
      const pend = [];
      const out = [];
      for (let i = 0; i < n; i++) {
        A.tick(1 / 60);
        tmp.add(s);
        const prevAuto = R.autoClear;
        R.autoClear = false;
        R.setRenderTarget(A.post.sceneRT);
        const q = gl.createQuery();
        gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
        R.render(tmp, A.camera);
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        pend.push(q);
        R.setRenderTarget(null);
        R.autoClear = prevAuto;
        parent.add(s);
        flush();
      }
      for (let k = 0; k < 120 && pend.length; k++) {
        for (let j = pend.length - 1; j >= 0; j--) {
          if (!gl.getQueryParameter(pend[j], gl.QUERY_RESULT_AVAILABLE)) continue;
          if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) out.push(gl.getQueryParameter(pend[j], gl.QUERY_RESULT) / 1e6);
          gl.deleteQuery(pend[j]);
          pend.splice(j, 1);
        }
        if (pend.length) await new Promise((r) => setTimeout(r, 16));
      }
      U().uSky.value = prevOn;
      const v = out.sort((a, c) => a - c);
      return { n: v.length, avg: +(v.reduce((a, c) => a + c, 0) / v.length).toFixed(3), p50: +v[v.length >> 1].toFixed(3), p95: +v[Math.floor(v.length * 0.95)].toFixed(3) };
    },
    async ab(n, rounds) {
      const res = { on: [], off: [] };
      const prevOn = U().uSky.value;
      for (let r = 0; r < rounds * 2; r++) {
        const on = r % 2 === 0;
        U().uSky.value = on ? 1 : 0;
        for (let i = 0; i < 6; i++) A.tick(1 / 60), flush();
        A.post.setProfiling(true);
        for (let i = 0; i < n; i++) A.tick(1 / 60), flush();
        for (let k = 0; k < 120 && A.post.timer && A.post.timer.pending && A.post.timer.pending.length; k++) await new Promise((r) => setTimeout(r, 16)), A.post.gpuTimes();
        const t = A.post.gpuTimes();
        A.post.setProfiling(false);
        res[on ? 'on' : 'off'].push({ scene: t.scene?.avg ?? null, total: Object.values(t).reduce((s, x) => s + x.avg, 0) });
      }
      U().uSky.value = prevOn;
      return res;
    },
    lightning(t) {
      A.debugSeekFight(t);
      A.stepFrames(1, 1 / 60);
      return { t, flash: +A.arena.flash.toFixed(4), env: +A.scene.environmentIntensity.toFixed(4), skyFlash: +U().uSkyFlash.value.w.toFixed(4) };
    },
  };
};

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[s.length >> 1] : null;
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
  const report = { w: W, h: H, n: N, rounds: ROUNDS, runs: [] };
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('crash', () => errors.push('PAGE CRASH'));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.route('http://arena.local/**', (route) => {
      const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\//, '') || 'index.html';
      const p = path.join(DIST, rel);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) route.fulfill({ path: p, contentType: MIME[path.extname(p)] || 'application/octet-stream' });
      else route.fulfill({ status: 404, body: '' });
    });
    for (const q of QS) {
      await page.goto(`http://arena.local/index.html?manual=1&auto=1&skip=1&a=gorak&b=erika&seed=4242&theme=colosseum&layout=pit&aseed=7&q=${q}`);
      await page.waitForFunction(() => window.__arena && window.__arena.state === 'fight', null, { timeout: 180000 });
      await page.evaluate(PAGE);
      const run = { q, info: await page.evaluate(() => __sk.info()) };
      console.log(`q${q} sky`, JSON.stringify(run.info));
      // lightning from match time (twice: deterministic), before pausing
      // the first scheduled strikes (flashEvery 34 s): 39.99 s, 86.41 s (tools: lightningAt); pick one inside this fight
      const dur = await page.evaluate(() => __arena.playback.duration);
      const st = [40.12, 86.55, 108.08].find((t) => t < dur - 0.5);
      run.duration = dur;
      run.lightning = st ? [await page.evaluate((t) => __sk.lightning(t), st), await page.evaluate(() => __sk.lightning(30.0)), await page.evaluate((t) => __sk.lightning(t), st)] : `fight only ${dur} s`;
      console.log(`q${q} lightning`, JSON.stringify(run.lightning));
      await page.evaluate(() => {
        __arena.debugSeekFight(2);
        __arena.paused = true;
      });
      // sky-heavy view: from the arena centre, looking at the moon over the arch (sky fills most of the frame)
      const views = { skyView: [[0, 6, 0], [100, 60, -3], 50], ref3: [[-7.5, 1.0, -0.3], [74, 25, -26], 45] };
      run.isolated = {};
      for (const [k, [p, l, f]] of Object.entries(views)) {
        await page.evaluate(([p, l, f]) => __sk.view(p, l, f), [p, l, f]);
        await page.evaluate(() => __sk.step(10, 1 / 60));
        // alternate in chunks (the iGPU clock drifts over a run)
        const ons = [], offs = [];
        for (let c = 0; c < 8; c++) {
          ons.push(await page.evaluate((n) => __sk.isolated(n, 1), N / 8));
          offs.push(await page.evaluate((n) => __sk.isolated(n, 0), N / 8));
        }
        const agg = (L) => ({ avg: +(L.reduce((a, x) => a + x.avg, 0) / L.length).toFixed(3), p50: +median(L.map((x) => x.p50)).toFixed(3) });
        const on = agg(ons), off = agg(offs);
        on.pairedP50 = +median(ons.map((x, i) => x.p50 - offs[i].p50)).toFixed(3);
        run.isolated[k] = { on, off };
        console.log(`q${q} ${k} isolated sky GPU ms: authored ${JSON.stringify(on)}  plain ${JSON.stringify(off)}`);
        if (k === 'skyView') {
          const a = path.join(OUT, `drift_q${q}_a.png`),
            b = path.join(OUT, `drift_q${q}_b.png`);
          await page.evaluate(() => __sk.step(2, 1 / 60)); // (the last isolated block rendered with uSky 0)
          await page.screenshot({ path: a });
          await page.evaluate(() => __sk.step(600, 1 / 60));
          await page.screenshot({ path: b });
          run.drift = { a: path.relative(ROOT, a), b: path.relative(ROOT, b) };
        }
      }
      await page.evaluate(([p, l, f]) => __sk.view(p, l, f), views.ref3);
      const ab = await page.evaluate(([n, r]) => __sk.ab(n, r), [30, ROUNDS]);
      const d = ab.on.map((x, i) => (x.scene ?? 0) - (ab.off[i]?.scene ?? 0));
      run.ab = { sceneOn: median(ab.on.map((x) => x.scene)), sceneOff: median(ab.off.map((x) => x.scene)), pairedMedian: median(d) };
      console.log(`q${q} A/B scene pass (ref-3 view): on ${run.ab.sceneOn?.toFixed(2)} off ${run.ab.sceneOff?.toFixed(2)} paired median ${run.ab.pairedMedian?.toFixed(3)} ms`);
      report.runs.push(run);
    }
  } finally {
    await browser.close();
  }
  report.errors = errors;
  fs.writeFileSync(path.join(OUT, 'check.json'), JSON.stringify(report, null, 1));
  if (errors.length) console.log('page errors:', errors.slice(0, 5));
  console.log(`-> ${path.relative(ROOT, OUT)}/check.json`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
