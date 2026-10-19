// A21 GPU frame-time probe for the Moon Gate (kit colosseum) at 1920 x 1080, per quality tier, on a built dist/.
//   node tools/perf/a21perf.cjs [--dist=dist] [--q=2,1,0] [--n=90] [--rounds=8] [--block=10] [--json=<file>] [--shots=<dir>]
// A fight frame (Gorak vs Erika, seed 4242, oval #7, t = 20 s: both fighters mid-exchange, side-on camera as
// tools/shots/postprobe.cjs) with the A19-A20 events the earlier probes did not time switched ON:
//   * a FIRING fire jet (a flamejet vent added 3.5 m beside the fighters; the colosseum's sim never places one, so it is
//     injected the way the A19 sheets forced it: an extra hazard in the layout + its frame state held at 2 = firing),
//   * a burning-oil pool (Frame.fires injected: 1.4 m pool, full life) 2.5 m on the other side,
//   * a lightning strike held at its peak (the arena's skyFlashAt = 40.02, the `?skyflash` debug clock).
// Reports per post pass GPU ms (EXT_disjoint_timer_query_webgl2 via Post.setProfiling / gpuTimes), the whole frame's
// GPU ms (one query round the post chain), CPU ms per tick, draw calls / triangles / programs, and same-page paired
// A/B deltas (alternating blocks, median of the pair differences: the iGPU's clock drifts by ~0.5 ms) for: the events,
// the fire field, the backdrop, the sky, the fighters, the wet-floor reflection, ambient (embers / mist).
// Memory: one browser, one page at a time. Do not run with Blender.
const { chromium } = require('playwright-core');
const path = require('path'),
  fs = require('fs');
const ROOT = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
const opt = (k, d) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const DIST = path.resolve(ROOT, opt('dist', 'dist'));
const QS = opt('q', '2,1,0').split(',').map(Number);
const N = Number(opt('n', 90));
const ROUNDS = Number(opt('rounds', 8));
const BLOCK = Number(opt('block', 10));
const PAIRS = Number(opt('pairs', 120));
const INTRO = opt('scene', 'fight') === 'intro';
const JSON_OUT = opt('json', '');
const SHOTS = opt('shots', '');
const TOGGLES = opt('toggles', 'events,fireField,backdrop,sky,fighters,reflection,ambient,shadows').split(',').filter(Boolean);
const exe = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.webp': 'image/webp', '.ktx2': 'image/ktx2', '.wasm': 'application/wasm', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml', '.bin': 'application/octet-stream' };
const F = { a: 'gorak', b: 'erika', seed: 4242, theme: 'colosseum', layout: 'oval', aseed: 7, t: 20, cam: [4.6, 1.9, 1] };

const PAGE = async ([T, CAM, INTRO, INTRO_AT]) => {
  const A = window.__arena;
  const gl = A.renderer.getContext();
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  let setEvents = () => {};
  if (INTRO) {
    // --scene=intro: the cinematic as it plays (stepped at 1/60 s per measured frame), from --at=<s> into the intro
    A.stepFrames(Math.round(INTRO_AT * 60), 1 / 60);
  } else {
  // --- 1. rebuild the arena with an extra fire jet beside the fighters at time T (same pack: cached assets)
  A.debugSeekFight(T);
  let f = A.playback.frameAt(A.playback.t).f;
  const mx = (f[0].x + f[1].x) / 2,
    mz = (f[0].z + f[1].z) / 2;
  let dx = f[1].x - f[0].x,
    dz = f[1].z - f[0].z;
  const l = Math.hypot(dx, dz) || 1;
  dx /= l;
  dz /= l;
  // camera side (-dz, dx) * side; the jet goes behind the fighters' line, the oil pool in front (both in frame)
  const sx = -dz * CAM[2],
    sz = dx * CAM[2];
  const L = A.arena.layout;
  const L2 = { ...L, hazards: [...L.hazards, { id: 900, kind: 'flamejet', x: mx - sx * 3.5 + dx * 1.2, z: mz - sz * 3.5 + dz * 1.2, r: 1.0, period: 6.5, phase: 0 }] };
  const jetIndex = L2.hazards.length - 1;
  const pack = A.arena.kit;
  A.buildArena(A.arenaSpec, L2, pack, performance.now());
  A.arena.prewarm?.();
  const oil = [mx + sx * 2.2 - dx * 1.5, mz + sz * 2.2 - dz * 1.5, 1.4, 1.0];
  const orig = A.arena.applyFrame.bind(A.arena);
  const ev = { on: true };
  A.arena.applyFrame = (fr, ...rest) => {
    if (!ev.on) return orig(fr, ...rest);
    const haz = [...fr.haz];
    while (haz.length < jetIndex) haz.push(0);
    haz[jetIndex] = 2;
    return orig({ ...fr, haz, fires: [...(fr.fires ?? []), ...oil] }, ...rest);
  };
  setEvents = (on) => {
    ev.on = on;
    A.arena.skyFlashAt = on ? 40.02 : null;
  };
  setEvents(true);
  A.debugSeekFight(T);
  f = A.playback.frameAt(A.playback.t).f;
  A.debugView([mx - dz * CAM[0] * CAM[2], CAM[1], mz + dx * CAM[0] * CAM[2]], [mx, 1.05, mz], 50);
  A.paused = true;
  }
  // --- 2. timing
  const pending = [];
  const total = [];
  const tagged = {};
  let tag = null;
  const poll = () => {
    for (let i = pending.length - 1; i >= 0; i--) {
      const { q, tg } = pending[i];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) continue;
      if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) {
        const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        if (tg) tagged[tg] = ms;
        else total.push(ms);
      }
      gl.deleteQuery(q);
      pending.splice(i, 1);
    }
  };
  const origRender = A.post.render.bind(A.post);
  let profiling = false;
  A.post.render = () => {
    // one TIME_ELAPSED query at a time: the outer frame query only while the per-pass timers are off
    if (!ext || profiling) return origRender();
    const q = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    try {
      return origRender();
    } finally {
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      pending.push({ q, tg: tag });
    }
  };
  const px = new Uint8Array(4);
  const med = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : NaN;
  };
  const p95 = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length * 0.95)] : NaN;
  };
  const frames = async (n) => {
    total.length = 0;
    const cpu = [];
    for (let i = 0; i < n; i++) {
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
    return { gpu: [...total], cpu };
  };
  const views = () => A.views.map((v) => v.root);
  const amb = A.arena.ambient;
  const T_ = {
    events: [() => setEvents(false), () => setEvents(true)],
    fireField: [() => A.arena.fire && (A.arena.fire.enabled = false), () => A.arena.fire && (A.arena.fire.enabled = true)],
    backdrop: [() => A.arena.backdrop && (A.arena.backdrop.group.visible = false), () => A.arena.backdrop && (A.arena.backdrop.group.visible = true)],
    sky: [() => (A.arena.sky.visible = false), () => (A.arena.sky.visible = true)],
    fighters: [() => views().forEach((r) => (r.visible = false)), () => views().forEach((r) => (r.visible = true))],
    reflection: [
      () => {
        A.__pre = A.post.preScene;
        A.post.preScene = null;
      },
      () => (A.post.preScene = A.__pre),
    ],
    ambient: [() => amb && amb.group && (amb.group.visible = false), () => amb && amb.group && (amb.group.visible = true)],
    // the moon's shadow map re-rendered every frame (off = keep the last map: no recompiles, no change to the frame)
    shadows: [() => (A.renderer.shadowMap.autoUpdate = false), () => (A.renderer.shadowMap.autoUpdate = true)],
  };
  window.__perf = {
    hasTimer: !!ext,
    async base(n) {
      await frames(30); // warm
      const r = await frames(n);
      // draw calls / triangles of one whole frame (all passes)
      A.renderer.info.autoReset = false;
      A.renderer.info.reset();
      A.tick(1 / 60);
      const calls = A.renderer.info.render.calls,
        tris = A.renderer.info.render.triangles;
      A.renderer.info.autoReset = true;
      profiling = true;
      A.post.setProfiling(true);
      await frames(n);
      for (let k = 0; k < 120 && A.post.timer && A.post.timer.pending.length; k++) await new Promise((res) => setTimeout(res, 16)), A.post.gpuTimes();
      const passes = A.post.gpuTimes();
      A.post.setProfiling(false);
      profiling = false;
      const info = A.renderer.info;
      return { gpu: { p50: med(r.gpu), p95: p95(r.gpu), n: r.gpu.length }, cpu: { p50: med(r.cpu), p95: p95(r.cpu) }, passes, calls, tris, programs: info.programs.length, textures: info.memory.textures, geometries: info.memory.geometries };
    },
    // real-time: the app's own RAF loop (not ?manual) for `sec` seconds on the same frame: frame-interval percentiles and
    // the CPU time of tick() (submit only, no GPU sync)
    async live(sec) {
      const iv = [],
        cpu = [];
      const ot = A.tick.bind(A);
      A.tick = (dt) => {
        const t0 = performance.now();
        ot(dt);
        cpu.push(performance.now() - t0);
      };
      A.manual = false;
      let last = performance.now();
      let run = true;
      const raf = () => {
        if (!run) return;
        const now = performance.now();
        iv.push(now - last);
        last = now;
        requestAnimationFrame(raf);
      };
      requestAnimationFrame(raf);
      await new Promise((r) => setTimeout(r, sec * 1000));
      run = false;
      A.manual = true;
      A.tick = ot;
      iv.shift();
      const s = [...iv].sort((a, b) => a - b);
      const c = [...cpu].sort((a, b) => a - b);
      return { frames: iv.length, fps: +(1000 / (iv.reduce((a, b) => a + b, 0) / iv.length)).toFixed(1), p50: +s[s.length >> 1].toFixed(1), p95: +s[Math.floor(s.length * 0.95)].toFixed(1), over20: +((iv.filter((x) => x > 20).length / iv.length) * 100).toFixed(1), cpuP50: +c[c.length >> 1].toFixed(2), cpuP95: +c[Math.floor(c.length * 0.95)].toFixed(2) };
    },
    // fine-grained interleave: off / on alternate every second frame (the iGPU clock drifts over seconds, not frames);
    // the first frame after a switch is not measured. Median of the per-pair differences.
    async ab2(name, pairs) {
      const [off, on] = T_[name];
      for (const k in tagged) delete tagged[k];
      for (let k = 0; k < pairs; k++) {
        off();
        tag = null;
        A.tick(1 / 60);
        tag = `off${k}`;
        A.tick(1 / 60);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        on();
        tag = null;
        A.tick(1 / 60);
        tag = `on${k}`;
        A.tick(1 / 60);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        tag = null;
        poll();
        if (k % 8 === 7) await new Promise((r) => setTimeout(r, 0));
      }
      for (let k = 0; k < 60 && pending.length; k++) {
        await new Promise((r) => setTimeout(r, 16));
        poll();
      }
      total.length = 0;
      const d = [],
        offs = [],
        ons = [];
      for (let k = 0; k < pairs; k++) {
        const a = tagged[`off${k}`],
          b = tagged[`on${k}`];
        if (a === undefined || b === undefined) continue;
        offs.push(a);
        ons.push(b);
        d.push(b - a);
      }
      const q1 = (xs) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length * 0.25)];
      const q3 = (xs) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length * 0.75)];
      return { name, delta: +med(d).toFixed(3), off: +med(offs).toFixed(3), on: +med(ons).toFixed(3), spread: [+q1(d).toFixed(2), +q3(d).toFixed(2)], n: d.length };
    },
    async ab(name, rounds, block) {
      const [off, on] = T_[name];
      const d = [],
        offs = [],
        ons = [];
      for (let k = 0; k < rounds; k++) {
        off();
        await frames(3);
        const a = await frames(block);
        on();
        await frames(3);
        const b = await frames(block);
        const ma = med(a.gpu),
          mb = med(b.gpu);
        offs.push(ma);
        ons.push(mb);
        d.push(mb - ma);
      }
      on();
      return { name, delta: +med(d).toFixed(3), off: +med(offs).toFixed(3), on: +med(ons).toFixed(3), spread: [+Math.min(...d).toFixed(2), +Math.max(...d).toFixed(2)] };
    },
  };
};

(async () => {
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
  const out = { dist: DIST, n: N, rounds: ROUNDS, block: BLOCK, runs: [] };
  try {
    for (const q of QS) {
      const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
      await page.route('http://arena.local/**', (route) => {
        const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\//, '') || 'index.html';
        const p = path.join(DIST, rel);
        if (fs.existsSync(p) && fs.statSync(p).isFile()) route.fulfill({ path: p, contentType: MIME[path.extname(p)] || 'application/octet-stream' });
        else route.fulfill({ status: 404, body: '' });
      });
      await page.goto(`http://arena.local/index.html?manual=1&auto=1${INTRO ? '' : '&skip=1'}&a=${F.a}&b=${F.b}&seed=${F.seed}&theme=${F.theme}&layout=${F.layout}&aseed=${F.aseed}&q=${q}`);
      await page.waitForFunction((intro) => window.__arena && window.__arena.state === (intro ? 'intro' : 'fight') && window.__arena.arena && window.__arena.arena.kit, INTRO, { timeout: 180000 });
      await page.evaluate(PAGE, [F.t, F.cam, INTRO, Number(opt('at', 0))]);
      if (SHOTS) {
        fs.mkdirSync(SHOTS, { recursive: true });
        await page.evaluate(() => __arena.stepFrames(2, 1 / 60));
        await page.screenshot({ path: path.join(SHOTS, `perf_q${q}.png`) });
      }
      const base = await page.evaluate((n) => __perf.base(n), N);
      const ab = [];
      for (const t of TOGGLES) ab.push(await page.evaluate(([t, r, b, P]) => (t === 'events' ? __perf.ab(t, r, b) : __perf.ab2(t, P)), [t, ROUNDS, BLOCK, PAIRS]));
      const live = await page.evaluate((s) => __perf.live(s), Number(opt('live', 8)));
      const run = { q, timer: await page.evaluate(() => __perf.hasTimer), base, live, ab };
      out.runs.push(run);
      const P = Object.entries(base.passes)
        .map(([k, v]) => `${k} ${v.p50.toFixed(2)}`)
        .join('  ');
      console.log(`q${q}  GPU frame p50 ${base.gpu.p50.toFixed(2)} ms (p95 ${base.gpu.p95.toFixed(2)})  CPU tick p50 ${base.cpu.p50.toFixed(2)}  calls ${base.calls}  tris ${base.tris}  programs ${base.programs}`);
      console.log(`    passes: ${P}`);
      console.log(`    real time (RAF, ${live.frames} frames): ${live.fps} fps, interval p50 ${live.p50} p95 ${live.p95} ms, ${live.over20} % over 20 ms; tick CPU p50 ${live.cpuP50} p95 ${live.cpuP95} ms`);
      console.log(`    A/B (on - off, ms): ${ab.map((x) => `${x.name} ${x.delta >= 0 ? '+' : ''}${x.delta} [${x.spread.join('..')}]`).join('  ')}`);
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  if (JSON_OUT) fs.writeFileSync(path.resolve(ROOT, JSON_OUT), JSON.stringify(out, null, 1));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
