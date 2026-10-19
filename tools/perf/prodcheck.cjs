// A21 production-build checks on a built dist/ (no dev server), ONE headless Chromium.
//   node tools/perf/prodcheck.cjs falls [--dist=dist] [--prefix=/arena-gods/] [--q=1] [--seeds=4242,11,7] [--theme=colosseum]
//     Plays fights (skipIntro) frame by frame and checks that every knockdown / launch / getup / death frame the sim
//     emits is drawn with the sim-chosen library clip ('lib:<id>') and not a fallback. `--prefix` serves the build
//     under a sub-path the way GitHub Pages does (https://<user>.github.io/<repo>/), 404 HTML for anything else.
//   node tools/perf/prodcheck.cjs net [--dist=dist] [--prefix=/] [--q=1] [--intro=1]
//     First-visit network: every file the page requests (bytes from disk and gzip size: GitHub Pages gzips every response) with the
//     time it was requested, grouped by phase (before the menu / arena built / fight start / finisher), plus the
//     time to the first arena frame and to the fight.
// Writes JSON with --json=<file>. Memory: one browser, one page at a time, closed at the end.
const { chromium } = require('playwright-core');
const path = require('path'),
  fs = require('fs'),
  zlib = require('zlib');
const ROOT = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
const mode = args.find((a) => !a.startsWith('--')) || 'falls';
const opt = (k, d) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const DIST = path.resolve(ROOT, opt('dist', 'dist'));
const PREFIX = opt('prefix', '/');
const Q = Number(opt('q', '1'));
const JSON_OUT = opt('json', '');
// --remote=<https://host/path/>: run against a hosted build instead of dist (read-only, nothing is routed)
const REMOTE = opt('remote', '');
const exe = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.webp': 'image/webp', '.ktx2': 'image/ktx2', '.wasm': 'application/wasm', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml', '.bin': 'application/octet-stream', '.u16': 'application/octet-stream', '.u8': 'application/octet-stream' };
const GZC = new Map();

async function openPage(browser, url, w = 960, h = 540) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const t0 = Date.now();
  const log = { errors: [], notFound: [], files: [], console: [] };
  page.on('pageerror', (e) => log.errors.push(e.message));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' || m.type() === 'warning') log.errors.push(`${m.type()}: ${t}`.slice(0, 300));
    if (/^\[arena\]/.test(t)) log.console.push(`${Date.now() - t0} ${t}`.slice(0, 300));
  });
  await page.route('http://arena.local/**', (route) => {
    const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
    const notFound = () => {
      log.notFound.push(pathname);
      route.fulfill({ status: 404, contentType: 'text/html', body: '<!doctype html><title>404</title><h1>404 File not found</h1>' });
    };
    if (!pathname.startsWith(PREFIX)) return notFound();
    const rel = pathname.slice(PREFIX.length) || 'index.html';
    const p = path.join(DIST, rel);
    if (!(fs.existsSync(p) && fs.statSync(p).isFile())) return notFound();
    const ext = path.extname(p);
    const bytes = fs.statSync(p).size;
    // GitHub Pages gzips every response (also .bin / .glb / .wasm / .ktx2), so the wire size is the gzip size
    // (gzip sizes are computed after the run: gzipping in the route would slow the serving down)
    log.files.push({ rel, p, bytes, t: Date.now() - t0 });
    route.fulfill({ path: p, contentType: MIME[ext] || 'application/octet-stream' });
  });
  await page.goto(url);
  return { page, ctx, log, t0 };
}

async function falls(browser) {
  const seeds = opt('seeds', '4242,11,7').split(',').map(Number);
  const theme = opt('theme', 'colosseum');
  const pairs = (opt('pairs', 'gorak:vex,maw:fenrik,ozrel:erika')).split(',').map((p) => p.split(':'));
  const out = [];
  for (const seed of seeds)
    for (const [a, b] of pairs) {
      const url = `${REMOTE || 'http://arena.local' + PREFIX}index.html?manual=1&auto=1&skip=1&q=${Q}&a=${a}&b=${b}&seed=${seed}&theme=${theme}&layout=oval&aseed=7`;
      const { page, ctx, log } = await openPage(browser, url, 480, 270);
      try {
        await page.waitForFunction(() => window.__arena && window.__arena.arena && window.__arena.state === 'fight', null, { timeout: 180000 });
        const r = await page.evaluate(() => {
          const app = window.__arena;
          app.headless = true;
          const S = ['knockdown', 'launched', 'getup', 'dead'];
          const res = { frames: 0, byState: {}, fallbackFrames: [], clipsSeen: {}, end: 0, hipsMin: {}, hipsStand: [] };
          // pose-level check: the hips bone's world height (m) in each state (a real fall drops it to about 0.1-0.4 m)
          const hips = app.views.map((v) => {
            let h = null;
            v.root.traverse((o) => {
              if (!h && o.isBone && /Hips$/.test(o.name)) h = o;
            });
            return h;
          });
          const wp = new (app.camera.position.constructor)();
          for (let i = 0; i < 2; i++) res.hipsStand.push(hips[i] ? +hips[i].getWorldPosition(wp).y.toFixed(2) : null);
          const dur = app.rec.duration ?? app.rec.frames[app.rec.frames.length - 1].t;
          for (let k = 0; k < 60 * 200 && app.playback.t < dur - 0.05; k++) {
            app.stepFrames(1, 1 / 60);
            const fr = app.playback.frameAt(app.playback.t);
            res.frames++;
            for (let i = 0; i < 2; i++) {
              const f = fr.f[i];
              if (!S.includes(f.state)) continue;
              const st = (res.byState[f.state] ??= { frames: 0, lib: 0, other: 0, noclip: 0 });
              st.frames++;
              const cur = app.views[i].anim.current;
              if (!f.clip) st.noclip++;
              else if (cur === 'lib:' + f.clip) st.lib++;
              else {
                st.other++;
                if (res.fallbackFrames.length < 12) res.fallbackFrames.push({ t: +app.playback.t.toFixed(2), i, state: f.state, clip: f.clip, cur });
              }
              res.clipsSeen[f.clip || '-'] = 1;
              if (hips[i]) {
                const y = hips[i].getWorldPosition(wp).y - (f.state === 'launched' || f.state === 'dead' ? f.y : 0);
                const key = f.state + i;
                res.hipsMin[key] = Math.min(res.hipsMin[key] ?? 9, +y.toFixed(2));
              }
            }
          }
          res.end = app.playback.t;
          res.spriteLayers = app.vfx?.sprites ? [...app.vfx.sprites.keys()] : [];
          res.clipsSeen = Object.keys(res.clipsSeen).length;
          return res;
        });
        out.push({ seed, a, b, ...r, notFound: log.notFound.slice(0, 10), errors: log.errors.slice(0, 6) });
        console.log(JSON.stringify(out[out.length - 1]));
      } catch (e) {
        out.push({ seed, a, b, error: String(e).slice(0, 300), notFound: log.notFound.slice(0, 10), errors: log.errors.slice(0, 6) });
        console.log(JSON.stringify(out[out.length - 1]));
      } finally {
        await ctx.close();
      }
    }
  return out;
}

// real-time variant of `falls`: no ?manual, the RAF loop runs (GPU render, auto quality unless --q), the intro plays
// unless --skip=1; a per-frame sampler records states / clips / hips height until the fight ends
async function live(browser) {
  const seed = Number(opt('seeds', '4242'));
  const [a, b] = opt('pairs', 'gorak:maw').split(':');
  const skip = opt('skip', '1') === '1';
  const qp = opt('q', '') === '' ? '' : `&q=${Q}`;
  const url = `${REMOTE || 'http://arena.local' + PREFIX}index.html?auto=1${skip ? '&skip=1' : ''}${qp}&a=${a}&b=${b}&seed=${seed}&theme=${opt('theme', 'colosseum')}&layout=oval&aseed=7`;
  const { page, ctx, log } = await openPage(browser, url, Number(opt('w', 960)), Number(opt('h', 540)));
  try {
    await page.waitForFunction(() => window.__arena && window.__arena.arena && window.__arena.views && window.__arena.views.length === 2, null, { timeout: 180000 });
    await page.evaluate((opt) => {
      const app = window.__arena;
      const S = ['knockdown', 'launched', 'getup', 'dead'];
      const res = (window.__falls = { frames: 0, byState: {}, hipsMin: {}, fallback: [], states: {}, q: app.quality });
      const hips = app.views.map((v) => {
        let h = null;
        v.root.traverse((o) => {
          if (!h && o.isBone && /Hips$/.test(o.name)) h = o;
        });
        return h;
      });
      const wp = new (app.camera.position.constructor)();
      // shader programs compiled after the first frame (each one is a main-thread hitch) and long frames
      res.compiles = [];
      res.long = [];
      let nProg = -1,
        lastT = performance.now();
      const tick = () => {
        requestAnimationFrame(tick);
        const now = performance.now();
        const dt = now - lastT;
        lastT = now;
        const progs = app.renderer.info.programs || [];
        if (nProg >= 0 && progs.length > nProg) res.compiles.push({ state: app.prewarmAt > now - dt ? 'prewarm' : app.state, t: +(app.playback?.t ?? app.realT ?? 0).toFixed(2), shot: app.director?.shotName, dt: +dt.toFixed(1), names: progs.slice(nProg).map((p) => p.name), keys: opt.keys ? progs.slice(nProg).map((p) => p.name + '|' + p.cacheKey) : undefined });
        if (nProg >= 0 && dt > 50 && res.long.length < 40) res.long.push({ state: app.prewarmAt > now - dt ? 'prewarm' : app.state, t: +(app.playback?.t ?? 0).toFixed(2), shot: app.director?.shotName, dt: +dt.toFixed(1) });
        nProg = progs.length;
        res.progs = nProg;
        if (app.state === 'intro' || app.state === 'faceoff') (res.ivIntro ??= []).push(+dt.toFixed(2));
        if (app.state !== 'fight' || !app.playback) return;
        (res.iv ??= []).push(+dt.toFixed(2));
        res.frames++;
        res.t = app.playback.t;
        const fr = app.playback.frameAt(app.playback.t);
        for (let i = 0; i < 2; i++) {
          const f = fr.f[i];
          res.states[f.state] = (res.states[f.state] ?? 0) + 1;
          if (!S.includes(f.state)) continue;
          const st = (res.byState[f.state] ??= { frames: 0, lib: 0, other: 0 });
          st.frames++;
          if (app.views[i].anim.current === 'lib:' + f.clip) st.lib++;
          else {
            st.other++;
            if (res.fallback.length < 10) res.fallback.push({ t: app.playback.t, i, state: f.state, clip: f.clip, cur: app.views[i].anim.current });
          }
          const y = hips[i].getWorldPosition(wp).y - (f.state === 'launched' || f.state === 'dead' ? f.y : 0);
          res.hipsMin[f.state + i] = Math.min(res.hipsMin[f.state + i] ?? 9, +y.toFixed(2));
        }
      };
      requestAnimationFrame(tick);
    }, { keys: opt('keys', '0') === '1' });
    await page.waitForFunction(() => window.__arena.state === 'post' || (window.__falls && window.__falls.byState.dead), null, { timeout: Number(opt('timeout', 400000)), polling: 1000 });
    await page.waitForTimeout(1500);
    const r = await page.evaluate(() => {
      const R = window.__falls;
      const iv = (R.iv || []).slice(2).sort((a, b) => a - b);
      R.fight = iv.length ? { frames: iv.length, fps: +(1000 / (iv.reduce((a, b) => a + b, 0) / iv.length)).toFixed(1), p50: iv[iv.length >> 1], p95: iv[Math.floor(iv.length * 0.95)], p99: iv[Math.floor(iv.length * 0.99)], over20: +((iv.filter((x) => x > 20).length / iv.length) * 100).toFixed(1), over33: +((iv.filter((x) => x > 33.4).length / iv.length) * 100).toFixed(2) } : null;
      const ii = (R.ivIntro || []).slice(2).sort((a, b) => a - b);
      R.intro = ii.length ? { frames: ii.length, fps: +(1000 / (ii.reduce((a, b) => a + b, 0) / ii.length)).toFixed(1), p50: ii[ii.length >> 1], p95: ii[Math.floor(ii.length * 0.95)], over20: +((ii.filter((x) => x > 20).length / ii.length) * 100).toFixed(1), over33: +((ii.filter((x) => x > 33.4).length / ii.length) * 100).toFixed(1) } : null;
      delete R.iv;
      delete R.ivIntro;
      return R;
    });
    const res = { seed, a, b, skip, ...r, notFound: log.notFound, errors: log.errors.slice(0, 6) };
    console.log(JSON.stringify(res));
    return res;
  } finally {
    await ctx.close();
  }
}

async function net(browser) {
  const intro = opt('intro', '1') === '1';
  const theme = opt('theme', 'colosseum');
  const url = `${REMOTE || 'http://arena.local' + PREFIX}index.html?manual=1&auto=1&q=${Q}&a=gorak&b=maw&seed=4242&theme=${theme}&layout=oval&aseed=7${intro ? '' : '&skip=1'}`;
  const { page, ctx, log, t0 } = await openPage(browser, url, 960, 540);
  const marks = {};
  try {
    // a user gesture starts the audio engine (sfx + voice downloads), as a real visitor's first click does
    await page.waitForTimeout(300);
    await page.mouse.click(5, 5);
    await page.waitForFunction(() => window.__arena && window.__arena.arena, null, { timeout: 180000, polling: 50 });
    marks.arena = Date.now() - t0;
    await page.waitForFunction(() => window.__arena.state === 'intro' || window.__arena.state === 'fight', null, { timeout: 180000, polling: 50 });
    marks.start = Date.now() - t0;
    // let late streams finish (entrance / finisher bundles, atlases)
    await page.waitForTimeout(Number(opt('settle', 8000)));
    marks.settled = Date.now() - t0;
  } finally {
    await ctx.close();
  }
  for (const f of log.files) {
    let gz = GZC.get(f.p);
    if (gz === undefined) GZC.set(f.p, (gz = Math.min(f.bytes, zlib.gzipSync(fs.readFileSync(f.p), { level: 6 }).length)));
    f.gz = gz;
    delete f.p;
  }
  const groups = {};
  for (const f of log.files) {
    const g = f.rel.split('/').slice(0, f.rel.startsWith('arena/') ? 2 : 1).join('/');
    const G = (groups[g] ??= { n: 0, bytes: 0, gz: 0, beforeStart: 0 });
    G.n++;
    G.bytes += f.bytes;
    G.gz += f.gz;
    if (f.t <= marks.start) G.beforeStart += f.gz;
  }
  const total = log.files.reduce((s, f) => s + f.gz, 0);
  const MB = (b) => +(b / 1048576).toFixed(2);
  const rows = Object.entries(groups)
    .sort((x, y) => y[1].gz - x[1].gz)
    .map(([g, v]) => ({ group: g, files: v.n, MB: MB(v.bytes), wireMB: MB(v.gz), beforeStartMB: MB(v.beforeStart) }));
  const top = [...log.files].sort((x, y) => y.gz - x.gz).slice(0, 25).map((f) => ({ rel: f.rel, MB: MB(f.gz), t: f.t }));
  const res = { q: Q, intro, marks, totalMB: MB(total), beforeStartMB: MB(log.files.filter((f) => f.t <= marks.start).reduce((s, f) => s + f.gz, 0)), rows, top, files: log.files, notFound: log.notFound, errors: log.errors.slice(0, 10), console: log.console };
  console.log(JSON.stringify(res, null, 1));
  return res;
}

(async () => {
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
  let res;
  try {
    res = mode === 'net' ? await net(browser) : mode === 'live' ? await live(browser) : await falls(browser);
  } finally {
    await browser.close();
  }
  if (JSON_OUT) fs.writeFileSync(path.resolve(ROOT, JSON_OUT), JSON.stringify(res, null, 1));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
