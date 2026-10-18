// FX probe (milestone F0): perf, particle counts, leak check, seek reproducibility and screenshots.
// Serves the built dist/ (run `npm run build` first; no dev server needed). ONE browser, sequential.
//   node tools/shots/fxprobe.cjs <outDir> [--w=1920 --h=1080] [--shots=1] [--fights=0,1,2]
// Works against both the pre-F0 VFX (CPU pools) and the F0 FX director, so before/after use the same script.
const { chromium } = require('playwright-core');
const path = require('path'),
  fs = require('fs');
const args = process.argv.slice(2);
const opt = (k, d) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const out = args.find((a) => !a.startsWith('--')) || 'fxprobe-out';
const W = Number(opt('w', 1920)),
  H = Number(opt('h', 1080));
const SHOTS = opt('shots', '1') === '1';
const DIST = path.resolve(opt('dist', path.resolve(__dirname, '../../dist')));
// --seedrandom=1: seed Math.random in the page (camera shot choice) so screenshots of old and new builds frame the same shots
const SEEDRANDOM = opt('seedrandom', '0') === '1';
// --only=shots: screenshots only (skip perf / leak / seek measurements)
const ONLY = opt('only', '');
const exe = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.webp': 'image/webp', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.ktx2': 'image/ktx2' };
const FIGHTS = [
  { a: 'gorak', b: 'erika', seed: 4242, theme: 'colosseum', layout: 'oval', aseed: 7 },
  { a: 'ozrel', b: 'maw', seed: 77, theme: 'forge', layout: 'pit', aseed: 3 },
  { a: 'aldric', b: 'vex', seed: 1234, theme: 'glacier', layout: 'cross', aseed: 5 },
];
const pick = opt('fights', '0,1,2').split(',').map(Number);

// ---- page-side helpers (must work on old and new code) ----
const PAGE_HELPERS = () => {
  const A = window.__arena;
  const V = A.vfx;
  window.__probe = {
    alive() {
      if (A.fxStats) {
        const s = A.fxStats();
        return { add: s.particles.add, alpha: s.particles.alpha, rings: s.rings, debris: s.debris };
      }
      const cnt = (p) => {
        let n = 0;
        for (const l of p.life) if (l > 0) n++;
        return n;
      };
      return { add: cnt(V.add), alpha: cnt(V.alpha), rings: V.rings.length, debris: V.debris.length };
    },
    /** hash of the live FX state (positions of live particles etc.) */
    stateHash() {
      if (A.fxStateHash) return A.fxStateHash();
      let h = 2166136261 >>> 0;
      const mix = (x) => {
        h ^= Math.round(x * 1000) | 0;
        h = Math.imul(h, 16777619) >>> 0;
      };
      for (const p of [V.add, V.alpha]) for (let i = 0; i < p.life.length; i++) if (p.life[i] > 0) mix(p.pos[i * 3]), mix(p.pos[i * 3 + 1]), mix(p.pos[i * 3 + 2]), mix(p.life[i]);
      return h.toString(16);
    },
    idHash() {
      return A.fxHash ? A.fxHash() : 'n/a (pre-F0: no effect list)';
    },
    /** CPU time spent in FX over n fight frames (VFX methods + update + fx.frame), nested calls counted once */
    fxCpu(n) {
      let depth = 0,
        acc = 0,
        maxAdd = 0,
        maxAlpha = 0;
      const wrap = (obj, name) => {
        const f = obj[name];
        if (typeof f !== 'function') return () => {};
        obj[name] = function (...a) {
          if (depth++ > 0) {
            try {
              return f.apply(this, a);
            } finally {
              depth--;
            }
          }
          const t0 = performance.now();
          try {
            return f.apply(this, a);
          } finally {
            acc += performance.now() - t0;
            depth--;
          }
        };
        return () => (obj[name] = f);
      };
      const names = ['sparks', 'flash', 'dust', 'smoke', 'fire', 'embers', 'shockwave', 'arrow', 'debrisBurst', 'update'];
      const undo = names.map((nm) => wrap(V, nm));
      if (A.fx) undo.push(wrap(A.fx, 'frame'));
      const frames = [];
      for (let i = 0; i < n; i++) {
        const before = acc;
        A.stepFrames(1, 1 / 60);
        frames.push(acc - before);
        const c = this.alive();
        maxAdd = Math.max(maxAdd, c.add);
        maxAlpha = Math.max(maxAlpha, c.alpha);
      }
      undo.forEach((u) => u());
      frames.sort((x, y) => x - y);
      return { msPerFrame: +(acc / n).toFixed(4), p95: +frames[Math.floor(n * 0.95)].toFixed(4), maxAdd, maxAlpha };
    },
    /** CPU per VFX.update with nothing alive */
    idle(n) {
      V.clear();
      if (A.fx) A.fx.clear();
      // old pools keep dead slots; let everything expire first
      for (let i = 0; i < 400; i++) V.update(1 / 60);
      const t0 = performance.now();
      for (let i = 0; i < n; i++) V.update(1 / 60);
      return +((performance.now() - t0) / n).toFixed(4);
    },
    mem() {
      const m = A.renderer.info.memory;
      return { geometries: m.geometries, textures: m.textures, programs: A.renderer.info.programs?.length ?? -1, groupChildren: V.group.children.length, heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : -1 };
    },
    /** spam the leak-prone helpers, let everything expire, report memory */
    leak(rounds) {
      const T = window.__THREE;
      const before = this.mem();
      for (let r = 0; r < rounds; r++) {
        const p = new T.Vector3((r % 5) - 2, 0.5, ((r * 3) % 5) - 2);
        V.shockwave(p, '#ffd8a0', 4, 0.5);
        V.debrisBurst(p, '#6b4a2c', 10);
        A.stepFrames(6, 1 / 60);
      }
      A.stepFrames(480, 1 / 60); // debris lives 6 s
      const after = this.mem();
      return { before, after };
    },
    /** fixed side camera on the pair (the director's shot choice is random, so shots would not match) */
    side() {
      const P = A.views[0].position,
        Q = A.views[1].position;
      const mx = (P.x + Q.x) / 2,
        mz = (P.z + Q.z) / 2;
      let ax = Q.x - P.x,
        az = Q.z - P.z;
      const l = Math.hypot(ax, az) || 1;
      ax /= l;
      az /= l;
      const d = Math.max(5, l * 0.9 + 3.2);
      const s = -az * -mx + ax * -mz >= 0 ? 1 : -1;
      A.debugView([mx - az * d * s, 2.0, mz + ax * d * s], [mx, 1.0, mz], 50);
    },
    moments() {
      const ev = A.rec.events;
      const first = (f, after = 6) => ev.find((e) => e.t > after && f(e));
      const list = [
        ['heavy_hit', first((e) => e.type === 'hit' && e.data && e.data.heavy)],
        ['block', first((e) => e.type === 'block')],
        ['parry', first((e) => e.type === 'parry')],
        ['ultimate', first((e) => e.type === 'ability_used')],
        ['explosion', first((e) => e.type === 'explosion', 0)],
        ['knockdown', first((e) => e.type === 'knockdown')],
      ];
      return list.filter(([, e]) => e).map(([k, e]) => [k, +(e.t + 0.12).toFixed(2)]);
    },
  };
};

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-precise-memory-info'] });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  if (SEEDRANDOM)
    await page.addInitScript(() => {
      let st = 12345;
      Math.random = () => {
        st = (st + 0x6d2b79f5) >>> 0;
        let z = st;
        z = Math.imul(z ^ (z >>> 15), z | 1);
        z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
        return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
      };
    });
  const logs = [];
  page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));
  page.on('console', (m) => m.type() === 'error' && logs.push(m.text()));
  await page.route('http://arena.local/**', (route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\//, '') || 'index.html';
    const p = path.join(DIST, rel);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) route.fulfill({ path: p, contentType: MIME[path.extname(p)] || 'application/octet-stream' });
    else route.fulfill({ status: 404, body: '' });
  });
  const load = async (F, extra = '') => {
    await page.goto(`http://arena.local/index.html?manual=1&auto=1&skip=1&a=${F.a}&b=${F.b}&seed=${F.seed}&theme=${F.theme}&layout=${F.layout}&aseed=${F.aseed}&q=2${extra}`);
    await page.waitForFunction(() => window.__arena && window.__arena.state === 'fight' && window.__arena.views.length === 2, null, { timeout: 180000 });
    await page.evaluate(PAGE_HELPERS);
  };
  const report = { w: W, h: H, fights: [] };
  for (const fi of pick) {
    const F = FIGHTS[fi];
    const tag = `${F.a}-${F.b}#${F.seed}_${F.theme}`;
    console.log('==', tag);
    await load(F);
    const R = { tag };
    R.moments = await page.evaluate(() => __probe.moments());
    if (ONLY === 'bench') {
      await page.evaluate(() => __arena.debugSeekFight(20));
      R.bench20 = await page.evaluate(() => __arena.bench(120));
      console.log('BENCH', tag, JSON.stringify(R.bench20));
      report.fights.push(R);
      continue;
    }
    if (ONLY === 'shots') {
      for (const [k, t] of R.moments) {
        await page.evaluate((t) => ((__arena.freeCam = false), __arena.debugSeekFight(t), __probe.side()), t);
        await page.screenshot({ path: path.join(out, `${tag}_${k}_${t.toFixed(2)}.png`) });
      }
      report.fights.push(R);
      continue;
    }
    // perf: GPU-synced frame time at t=20 and during the busiest moment
    await page.evaluate(() => __arena.debugSeekFight(20));
    R.bench20 = await page.evaluate(() => __arena.bench(90));
    if (R.moments.length) {
      await page.evaluate((t) => __arena.debugSeekFight(t - 0.1), R.moments[0][1]);
      R.benchHit = await page.evaluate(() => __arena.bench(60));
    }
    // CPU FX cost over 10 s of fight from t=15 (no render)
    await page.evaluate(() => __arena.debugSeekFight(15));
    R.fxCpu = await page.evaluate(() => __probe.fxCpu(600));
    R.idleUpdateMs = await page.evaluate(() => __probe.idle(600));
    // seek reproducibility: same session, each moment twice (with other play in between)
    R.seekSameSession = [];
    for (const [k, t] of R.moments) {
      const snap = (t) => (__arena.debugSeekFight(t), { id: __probe.idHash(), st: __probe.stateHash(), n: __probe.alive() });
      const s1 = await page.evaluate(snap, t);
      await page.evaluate(() => (__arena.debugSeekFight(30), __arena.stepFrames(200, 1 / 60)));
      const s2 = await page.evaluate(snap, t);
      R.seekSameSession.push({ k, t, n: s1.n, idEqual: s1.id === s2.id, stateEqual: s1.st === s2.st, s1: s1.st, s2: s2.st });
    }
    const tS = R.moments.length ? R.moments[0][1] : 24.5;
    // leak check
    R.leak = await page.evaluate(() => __probe.leak(40));
    // screenshots
    if (SHOTS) {
      for (const [k, t] of R.moments) {
        await page.evaluate((t) => ((__arena.freeCam = false), __arena.debugSeekFight(t), __probe.side()), t);
        await page.screenshot({ path: path.join(out, `${tag}_${k}_${t.toFixed(2)}.png`) });
      }
    }
    // fresh-load ?t= reproducibility (two loads)
    const fresh = [];
    for (let k = 0; k < 2; k++) {
      await load(F, `&t=${tS}&pause=1`);
      fresh.push(await page.evaluate(() => ({ id: __probe.idHash(), st: __probe.stateHash(), n: __probe.alive() })));
    }
    R.seekFreshLoad = { fresh, idEqual: fresh[0].id === fresh[1].id, stateEqual: fresh[0].st === fresh[1].st };
    console.log(JSON.stringify(R, null, 1));
    report.fights.push(R);
  }
  report.logs = logs.slice(0, 30);
  fs.writeFileSync(path.join(out, 'fxprobe.json'), JSON.stringify(report, null, 1));
  if (logs.length) console.log('--- console\n' + logs.slice(0, 20).join('\n'));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
