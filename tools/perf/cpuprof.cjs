// A21: CPU profile of the game's tick on the Moon Gate fight frame (same scene as a21perf.cjs, real-time RAF loop),
// from an unminified build so function names survive:
//   npx vite build --minify false --outDir dist_prof && node tools/perf/cpuprof.cjs [--dist=dist_prof] [--q=2] [--sec=6]
//        [--paused=1] (frozen fight frame with the forced jet / oil / lightning) or --paused=0 (the fight plays from t)
// Prints the top functions by self time and by inclusive time (Chrome DevTools Profiler over CDP).
const { chromium } = require('playwright-core');
const path = require('path'),
  fs = require('fs');
const ROOT = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
const opt = (k, d) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const DIST = path.resolve(ROOT, opt('dist', 'dist_prof'));
const Q = Number(opt('q', 2));
const SEC = Number(opt('sec', 6));
const PAUSED = opt('paused', '1') === '1';
const INTRO = opt('intro', '0') === '1';
const SKIPMS = Number(opt('skipms', 0));
const exe = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.webp': 'image/webp', '.ktx2': 'image/ktx2', '.wasm': 'application/wasm', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml', '.bin': 'application/octet-stream' };

(async () => {
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.route('http://arena.local/**', (route) => {
      const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\//, '') || 'index.html';
      const p = path.join(DIST, rel);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) route.fulfill({ path: p, contentType: MIME[path.extname(p)] || 'application/octet-stream' });
      else route.fulfill({ status: 404, body: '' });
    });
    await page.goto(`http://arena.local/index.html?${INTRO ? '' : 'manual=1&'}auto=1${INTRO ? '' : '&skip=1'}&a=gorak&b=erika&seed=4242&theme=colosseum&layout=oval&aseed=7&q=${Q}`);
    await page.waitForFunction((intro) => window.__arena && window.__arena.state === (intro ? 'intro' : 'fight') && window.__arena.arena, INTRO, { timeout: 180000 });
    if (INTRO) await page.waitForTimeout(SKIPMS);
    else await page.evaluate((paused) => {
      const A = window.__arena;
      A.debugSeekFight(20);
      A.paused = paused;
      A.manual = false;
    }, PAUSED);
    if (!INTRO) await page.waitForTimeout(2000);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
    await cdp.send('Profiler.start');
    await page.waitForTimeout(SEC * 1000);
    const { profile } = await cdp.send('Profiler.stop');
    // self time per node, then aggregate by function name + url line
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const self = new Map();
    const dt = profile.timeDeltas;
    for (let i = 0; i < profile.samples.length; i++) self.set(profile.samples[i], (self.get(profile.samples[i]) ?? 0) + (dt[i] ?? 0));
    const parent = new Map();
    for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
    const key = (n) => `${n.callFrame.functionName || '(anon)'} ${path.basename(n.callFrame.url || '')}:${n.callFrame.lineNumber + 1}`;
    const selfBy = new Map(),
      inclBy = new Map();
    let total = 0;
    for (const [id, t] of self) {
      total += t;
      const n = byId.get(id);
      selfBy.set(key(n), (selfBy.get(key(n)) ?? 0) + t);
      // inclusive: walk up, count each function once per sample stack
      const seen = new Set();
      for (let x = id; x !== undefined; x = parent.get(x)) {
        const k = key(byId.get(x));
        if (seen.has(k)) continue;
        seen.add(k);
        inclBy.set(k, (inclBy.get(k) ?? 0) + t);
      }
    }
    const fmt = (m) =>
      [...m.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 40)
        .map(([k, t]) => `${((t / total) * 100).toFixed(1).padStart(5)} %  ${(t / 1000 / SEC).toFixed(2).padStart(6)} ms/s  ${k}`)
        .join('\n');
    console.log(`profile ${SEC} s, total sampled ${(total / 1000).toFixed(0)} ms`);
    console.log('--- self');
    console.log(fmt(selfBy));
    // --who=<fn>: who calls it (first ancestor that is a different function), by time
    const WHO = opt('who', '');
    if (WHO) {
      const callers = new Map();
      for (const [id, t] of self) {
        let x = id;
        let hit = false;
        for (; x !== undefined; x = parent.get(x)) if (byId.get(x).callFrame.functionName === WHO) (hit = true), (x = x);
        if (!hit) continue;
        // walk up from the sample to the OUTERMOST frame of WHO, then take its caller (and the caller's caller)
        let outer = null;
        for (let y = id; y !== undefined; y = parent.get(y)) if (byId.get(y).callFrame.functionName === WHO) outer = y;
        const c1 = parent.get(outer);
        const c2 = c1 !== undefined ? parent.get(c1) : undefined;
        const k = `${c1 !== undefined ? key(byId.get(c1)) : '-'}  <-  ${c2 !== undefined ? key(byId.get(c2)) : '-'}`;
        callers.set(k, (callers.get(k) ?? 0) + t);
      }
      console.log(`--- callers of ${WHO}`);
      console.log(fmt(callers));
    }
    console.log('--- inclusive');
    console.log(fmt(inclBy));
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
