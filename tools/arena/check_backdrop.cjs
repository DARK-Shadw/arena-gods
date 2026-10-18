// A6 backdrop checker (arena art plan 5.6 / 6.4 / 6.6): parallax, AOV animation, GPU cost, memory, per tier.
//   npm run build && node tools/arena/check_backdrop.cjs [--q=2,1,0] [--n=120] [--rounds=3] [--out=docs/milestones/A6/check]
// ONE headless Chromium on dist/ (no dev server); never run it together with a Blender job.
//   parallax   fixed colosseum fight paused; the camera at the ref-3 position looking at the arch, then translated 5 m
//              sideways and 5 m forward with the SAME view direction: shots + the measured screen shift of the arch top
//              (projected from the backdrop geometry) against the moon (at infinity)
//   aov        zoomed views of the waterfall (azimuth 160) and the tier fires (azimuth -60), two frames 0.5 s apart:
//              shots + mean absolute pixel change (animated AOVs change; a static backdrop gives ~0)
//   perf       GPU timer queries (Post's own per-pass timers) on a fixed ref-3-like camera, backdrop visible / hidden
//              INTERLEAVED in the same page (on, off, on, off, ...), n frames each: the 'scene' and 'reflect' deltas
//              are the backdrop's cost (it draws inside the scene pass and the planar reflection)
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
const OUT = path.resolve(opt('out', path.join(ROOT, 'docs/milestones/A6/check')));
const QS = opt('q', '2,1,0').split(',').map(Number);
const N = Number(opt('n', '30'));
const ROUNDS = Number(opt('rounds', '16'));
const W = Number(opt('w', 1920)),
  H = Number(opt('h', 1080));
const exe = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.webp': 'image/webp', '.ktx2': 'image/ktx2', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml', '.bin': 'application/octet-stream', '.wasm': 'application/wasm' };

const PAGE = () => {
  const A = window.__arena;
  const gl = A.renderer.getContext();
  const px = new Uint8Array(4);
  const D = Math.PI / 180;
  window.__bd = {
    info() {
      const b = A.arena.backdrop;
      return b ? { ...b.stats(), loadMs: Math.round(b.data.ms) } : null;
    },
    view(p, look, fov) {
      A.debugView(p, look, fov);
    },
    /** screen x of a world point and of a direction at infinity, current camera */
    project(pt, dir) {
      const cam = A.camera;
      cam.updateMatrixWorld();
      const v = new (A.camera.position.constructor)(...pt).project(cam);
      const d = new (A.camera.position.constructor)(...dir).normalize().multiplyScalar(1e5).add(cam.position).project(cam);
      return { pt: [((v.x + 1) / 2) * innerWidth, ((1 - v.y) / 2) * innerHeight], dir: [((d.x + 1) / 2) * innerWidth, ((1 - d.y) / 2) * innerHeight] };
    },
    step(n, dt) {
      A.stepFrames(n, dt);
    },
    async perf(n, rounds) {
      const b = A.arena.backdrop;
      const res = { on: [], off: [] };
      for (let r = 0; r < rounds * 2; r++) {
        const on = r % 2 === 0;
        if (b) b.visible = on;
        for (let i = 0; i < 6; i++) A.tick(1 / 60), gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        A.post.setProfiling(true);
        for (let i = 0; i < n; i++) A.tick(1 / 60), gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        for (let k = 0; k < 120 && A.post.timer && A.post.timer.pending && A.post.timer.pending.length; k++) await new Promise((r) => setTimeout(r, 16)), A.post.gpuTimes();
        const t = A.post.gpuTimes();
        A.post.setProfiling(false);
        res[on ? 'on' : 'off'].push({ scene: t.scene?.avg ?? null, reflect: t.reflect?.avg ?? null, total: Object.values(t).reduce((s, x) => s + x.avg, 0), calls: A.renderer.info.render.calls });
      }
      if (b) b.visible = true;
      return res;
    },
    /** the backdrop's own GPU time: after each normal frame, its draws are re-issued alone into the post's scene
     * target (the frame's depth buffer still bound, so the depth test rejects what the walls hide, as in the real
     * pass), wrapped in one timer query. Stable where the on / off difference of two whole passes is not. */
    async isolated(n) {
      const b = A.arena.backdrop;
      if (!b) return null;
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      if (!ext) return null;
      const R = A.renderer;
      const parent = b.group.parent;
      const tmp = new (A.scene.constructor)();
      tmp.fog = A.scene.fog;
      const pend = [];
      const out = [];
      for (let i = 0; i < n; i++) {
        A.tick(1 / 60);
        tmp.add(b.group);
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
        parent.add(b.group);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
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
      const s = out.sort((a, c) => a - c);
      return { n: s.length, avg: +(s.reduce((a, c) => a + c, 0) / s.length).toFixed(3), p50: +s[s.length >> 1].toFixed(3), p95: +s[Math.floor(s.length * 0.95)].toFixed(3) };
    },
    texInfo() {
      const b = A.arena.backdrop;
      if (!b) return null;
      return b.data.textures.map((t) => ({ w: t.image?.width ?? t.mipmaps?.[0]?.width, h: t.image?.height ?? t.mipmaps?.[0]?.height, fmt: t.format, compressed: !!t.isCompressedTexture }));
    },
  };
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
      await page.evaluate(() => {
        __arena.debugSeekFight(2);
        __arena.paused = true;
      });
      const run = { q, info: await page.evaluate(() => __bd.info()), tex: await page.evaluate(() => __bd.texInfo()) };
      console.log(`q${q} backdrop`, JSON.stringify(run.info));
      // ---- parallax: same view direction, camera translated
      const look = [74, 30, 0];
      const base = [-7.5, 1.6, -0.3];
      const moonDir = [Math.cos(27 * Math.PI / 180) * Math.cos(-1.7 * Math.PI / 180), Math.sin(27 * Math.PI / 180), Math.cos(27 * Math.PI / 180) * Math.sin(-1.7 * Math.PI / 180)];
      run.parallax = [];
      for (const [tag, d] of [['base', [0, 0, 0]], ['side5', [0, 0, 5]], ['fwd5', [5, 0, 0]]]) {
        const p = base.map((x, i) => x + d[i]);
        const l = look.map((x, i) => x + d[i]);
        await page.evaluate(([p, l]) => __bd.view(p, l, 50), [p, l]);
        await page.evaluate(() => __bd.step(2, 1 / 60));
        await page.screenshot({ path: path.join(OUT, `parallax_q${q}_${tag}.jpg`), quality: 85 });
        const pr = await page.evaluate(([a, m]) => __bd.project(a, m), [[74, 57.5, 0], moonDir]);
        run.parallax.push({ tag, cam: p, archTopPx: pr.pt.map((x) => +x.toFixed(1)), moonPx: pr.dir.map((x) => +x.toFixed(1)), archMinusMoonX: +(pr.pt[0] - pr.dir[0]).toFixed(1) });
      }
      const p0 = run.parallax[0].archMinusMoonX;
      for (const r of run.parallax) r.shiftVsBasePx = +(r.archMinusMoonX - p0).toFixed(1);
      console.log(`q${q} parallax`, JSON.stringify(run.parallax.map((r) => [r.tag, r.shiftVsBasePx])));
      // ---- AOV animation: two frames 0.5 s apart, zoomed
      run.aov = {};
      // from 24 m up at the arena centre: above the stands (about 15 m), which hide the backdrop's lower band
      for (const [tag, az, el, fov] of [['waterfall', 160, 3, 16], ['fires', -62, -4, 24], ['clouds', -30, 22, 40]]) {
        const a = (az * Math.PI) / 180,
          e = (el * Math.PI) / 180;
        await page.evaluate(([l, f]) => __bd.view([0, 24, 0], l, f), [[Math.cos(e) * Math.cos(a) * 100, 24 + Math.sin(e) * 100, Math.cos(e) * Math.sin(a) * 100], fov]);
        await page.evaluate(() => __bd.step(2, 1 / 60));
        const f0 = path.join(OUT, `aov_q${q}_${tag}_0.png`);
        const f1 = path.join(OUT, `aov_q${q}_${tag}_1.png`);
        await page.screenshot({ path: f0 });
        await page.evaluate(() => __bd.step(15, 1 / 30));
        await page.screenshot({ path: f1 });
        run.aov[tag] = { files: [path.basename(f0), path.basename(f1)] };
      }
      // ---- perf on the ref-3-like view (the backdrop fills the upper half)
      await page.evaluate(([p, l]) => __bd.view(p, l, 45), [[-7.5, 1.0, -0.3], [74, 25, -26]]);
      await page.evaluate(() => __bd.step(10, 1 / 60));
      await page.screenshot({ path: path.join(OUT, `perfview_q${q}.jpg`), quality: 85 });
      run.isolated = await page.evaluate(() => __bd.isolated(240));
      console.log(`q${q} isolated backdrop GPU ms`, JSON.stringify(run.isolated));
      run.perf = await page.evaluate(([n, r]) => __bd.perf(n, r), [N, ROUNDS]);
      const avg = (xs, k) => xs.reduce((s, x) => s + (x[k] ?? 0), 0) / xs.length;
      run.perfSummary = {
        sceneOn: +avg(run.perf.on, 'scene').toFixed(3),
        sceneOff: +avg(run.perf.off, 'scene').toFixed(3),
        reflectOn: +avg(run.perf.on, 'reflect').toFixed(3),
        reflectOff: +avg(run.perf.off, 'reflect').toFixed(3),
        perRound: run.perf.on.map((x, i) => +(x.scene - run.perf.off[i].scene).toFixed(3)),
      };
      // pairs alternate on / off in short blocks: the median of the paired differences cancels the GPU clock drift
      const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? +s[s.length >> 1].toFixed(3) : null; };
      run.perfSummary.sceneDeltaMedian = med(run.perfSummary.perRound);
      run.perfSummary.reflectDeltaMedian = med(run.perf.on.map((x, i) => (x.reflect ?? 0) - (run.perf.off[i].reflect ?? 0)));
      run.perfSummary.sceneDelta = +(run.perfSummary.sceneOn - run.perfSummary.sceneOff).toFixed(3);
      run.perfSummary.reflectDelta = +(run.perfSummary.reflectOn - run.perfSummary.reflectOff).toFixed(3);
      console.log(`q${q} perf`, JSON.stringify(run.perfSummary));
      report.runs.push(run);
    }
  } finally {
    await browser.close();
  }
  report.errors = errors;
  // AOV pixel change (Pillow / numpy, outside the browser)
  const { execFileSync } = require('child_process');
  for (const run of report.runs)
    for (const [tag, a] of Object.entries(run.aov)) {
      const out = execFileSync('python', ['-c', 'import sys,numpy as np;from PIL import Image;a=np.asarray(Image.open(sys.argv[1]).convert("RGB")).astype(float);b=np.asarray(Image.open(sys.argv[2]).convert("RGB")).astype(float);a=a[110:1030];b=b[110:1030];d=np.abs(a-b).mean(2);m=(np.maximum(a.mean(2),b.mean(2))>110);print(round(float(d.mean()),3),round(float((d>6).mean()),4),round(float(d[m].mean()) if m.any() else 0,2),int(m.sum()))', path.join(OUT, a.files[0]), path.join(OUT, a.files[1])], { encoding: 'utf8' }).trim().split(' ');
      a.meanAbsDiff = +out[0];
      a.changedShare = +out[1];
      a.brightMeanAbsDiff = +out[2];
      a.brightPx = +out[3];
      for (const f of a.files) {
        execFileSync('python', ['-c', 'import sys;from PIL import Image;Image.open(sys.argv[1]).convert("RGB").save(sys.argv[2],quality=85)', path.join(OUT, f), path.join(OUT, f.replace('.png', '.jpg'))]);
        fs.rmSync(path.join(OUT, f));
      }
      a.files = a.files.map((f) => f.replace('.png', '.jpg'));
    }
  fs.writeFileSync(path.join(OUT, 'check.json'), JSON.stringify(report, null, 1));
  console.log('errors', errors.length ? errors : 'none');
  for (const run of report.runs) console.log(`q${run.q} aov`, JSON.stringify(Object.fromEntries(Object.entries(run.aov).map(([k, v]) => [k, [v.meanAbsDiff, v.changedShare, v.brightMeanAbsDiff, v.brightPx]]))));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
