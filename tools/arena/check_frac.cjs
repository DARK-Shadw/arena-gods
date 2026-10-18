// A5 in-game check of the fracture sets (one headless Chromium on dist/): for each run (theme / layout / quality) fights are
// known to topple a kit obstacle (statue, pillar, column; found by tools/arena/find_topples.ts) are seeked to just
// after the impact and the check reports where the obstacle's FRAC_* pieces lie (along / across its fall line, height above
// the floor), whether the intact mesh is hidden, the debris pools (one InstancedMesh per debris kind, with the kit chunk
// geometry in kit mode) and the draw calls with the intact obstacle vs the broken one; screenshots from beside the fall line
// (impact + 0.25 s while the pieces hop, + 2 s at rest). `--legacy` runs the same with ?arena=legacy (pool comparison).
//   npm run build && node tools/arena/check_frac.cjs [--out=docs/milestones/A5/frac] [--cases=desert:oval:1:maw:ozrel:5:7,...] [--legacy]
const { chromium } = require('playwright-core');
const path = require('path'),
  fs = require('fs');
const ROOT = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
const opt = (k, d) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const DIST = path.join(ROOT, 'dist');
const OUT = path.resolve(opt('out', path.join(ROOT, 'docs/milestones/A5/frac')));
const LEGACY = args.includes('--legacy');
const exe = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.webp': 'image/webp', '.ktx2': 'image/ktx2', '.wasm': 'application/wasm', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml', '.bin': 'application/octet-stream' };
// cases theme:layout:q:a:b:seed:aseed (fights that topple a kit obstacle: npx tsx tools/arena/find_topples.ts <theme:layout>)
const RUNS = opt('cases', 'desert:oval:1:maw:ozrel:5:7,desert:pit:2:gorak:erika:36:7,colosseum:oval:1:maw:ozrel:21:3,colosseum:cross:0:hollowjack:ozrel:15:3')
  .split(',')
  .map((s) => {
    const [theme, layout, q, a, b, seed, aseed] = s.split(':');
    return { theme, layout, q: Number(q), a, b, seed: Number(seed), aseed: Number(aseed) };
  });

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
  const res = [];
  try {
    for (const run of RUNS) {
      let done = false;
      for (let seed = run.seed; seed <= run.seed && !done; seed++) {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('console', (m) => (m.type() === 'error' || (m.type() === 'warning' && /arena/.test(m.text()))) && errors.push(m.text().slice(0, 300)));
        await page.route('http://arena.local/**', (route) => {
          const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\//, '') || 'index.html';
          const f = path.join(DIST, rel);
          if (fs.existsSync(f) && fs.statSync(f).isFile()) route.fulfill({ path: f, contentType: MIME[path.extname(f)] || 'application/octet-stream' });
          else route.fulfill({ status: 404, body: '' });
        });
        await page.goto(`http://arena.local/index.html?manual=1&q=${run.q}&auto=1&skip=1&a=${run.a}&b=${run.b}&seed=${seed}&theme=${run.theme}&layout=${run.layout}&aseed=${run.aseed}${LEGACY ? '&arena=legacy' : ''}`);
        await page.waitForFunction(() => window.__arena && window.__arena.arena && window.__arena.rec && window.__arena.state === 'fight', null, { timeout: 120000 });
        const hit = await page.evaluate(() => {
          const A = window.__arena.arena;
          const ev = window.__arena.rec.events;
          for (const e of ev) {
            if (e.type !== 'topple') continue;
            const i = Number(e.data.obs);
            const o = A.layout.obstacles[i];
            if (!o || o.kind === 'banner') continue;
            const imp = ev.find((x) => x.type === 'topple_impact' && Number(x.data.obs) === i);
            if (imp) return { i, kind: o.kind, t: e.t, timp: imp.t, dx: Number(e.data.dx), dz: Number(e.data.dz), x: o.x, z: o.z, h: o.h, r: o.r };
          }
          return null;
        });
        if (!hit) {
          await ctx.close();
          continue;
        }
        done = true;
        const tag = `${run.theme}_${run.layout}_q${run.q}${LEGACY ? '_legacy' : ''}`;
        // draw calls with the obstacle still standing (just before the topple)
        await page.evaluate((t) => window.__arena.debugSeekFight(t), hit.t - 0.3);
        const before = await page.evaluate(() => window.__arena.bench(8));
        const shots = [];
        let info = null;
        for (const [dt, name] of [
          [0.25, 'hop'],
          [2.0, 'rest'],
        ]) {
          await page.evaluate((t) => window.__arena.debugSeekFight(t), hit.timp + dt);
          info = await page.evaluate((h) => {
            const A = window.__arena.arena;
            const ov = A.obstacles[h.i];
            const out = { landed: ov.landed, intactVisible: ov.mesh.visible, frac: null, pools: [] };
            if (ov.frac) {
              const V = A.group.position.constructor;
              const v = new V();
              let n = 0,
                alongMin = 1e9,
                alongMax = -1e9,
                lat = 0,
                ymin = 1e9,
                ymax = -1e9,
                tris = 0;
              for (const m of ov.frac.meshes) {
                const p = m.geometry.attributes.position;
                tris += m.geometry.index ? m.geometry.index.count / 3 : p.count / 3;
                for (let k = 0; k < p.count; k++) {
                  v.fromBufferAttribute(p, k);
                  const rx = v.x - h.x,
                    rz = v.z - h.z;
                  const al = rx * h.dx + rz * h.dz;
                  alongMin = Math.min(alongMin, al);
                  alongMax = Math.max(alongMax, al);
                  lat = Math.max(lat, Math.abs(-rx * h.dz + rz * h.dx));
                  ymin = Math.min(ymin, v.y);
                  ymax = Math.max(ymax, v.y);
                  n++;
                }
              }
              out.frac = { meshes: ov.frac.meshes.length, visible: ov.frac.meshes.every((m) => m.visible), verts: n, tris, along: [+alongMin.toFixed(2), +alongMax.toFixed(2)], lateral: +lat.toFixed(2), y: [+ymin.toFixed(2), +ymax.toFixed(2)] };
            }
            for (const c of A.debris.group.children) out.pools.push({ verts: c.geometry.attributes.position.count, kitMat: !!c.userData.sharedMat });
            return out;
          }, hit);
          const mid = { x: hit.x + hit.dx * hit.h * 0.5, z: hit.z + hit.dz * hit.h * 0.5 };
          const side = { x: -hit.dz, z: hit.dx };
          await page.evaluate(
            ([p, l]) => window.__arena.debugView(p, l, 50),
            [
              [mid.x + side.x * 7.5 - hit.dx * 1.5, 3.2, mid.z + side.z * 7.5 - hit.dz * 1.5],
              [mid.x, 0.6, mid.z],
            ],
          );
          const file = path.join(OUT, `${tag}_${name}.jpg`);
          await page.screenshot({ path: file, type: 'jpeg', quality: 86 });
          shots.push(path.relative(ROOT, file));
        }
        await page.evaluate((t) => window.__arena.debugSeekFight(t), hit.timp + 2.0);
        const after = await page.evaluate(() => window.__arena.bench(8));
        // A/B on ONE frame: the broken obstacle (FRAC set, intact hidden) vs the same frame with the intact mesh shown and
        // every FRAC set hidden (one full render each, all passes: shadows, reflection, main, post)
        const ab = await page.evaluate((i) => {
          const app = window.__arena;
          const A = app.arena;
          const ov = A.obstacles[i];
          const fr = [];
          A.group.traverse((o) => o.name === 'fracSet' && fr.push(o));
          const calls = () => {
            const inf = app.renderer.info;
            inf.autoReset = false;
            inf.reset();
            app.post.render();
            const c = inf.render.calls;
            inf.autoReset = true;
            return c;
          };
          const broken = calls();
          const vis = fr.map((m) => m.visible);
          fr.forEach((m) => (m.visible = false));
          ov.mesh.visible = true;
          const intact = calls();
          fr.forEach((m, k) => (m.visible = vis[k]));
          ov.mesh.visible = false;
          return { broken, intact, fracSets: fr.length, fracSetsVisible: vis.filter(Boolean).length };
        }, hit.i);
        const r = { ...run, seed, legacy: LEGACY, obstacle: hit, ...info, drawCalls: { standing: before.calls, broken: after.calls, sameFrame: ab }, shots, errors };
        console.log(
          `${tag} seed ${seed}: ${hit.kind} #${hit.i} h ${hit.h} topple ${hit.t.toFixed(2)} s -> impact ${hit.timp.toFixed(2)} s; intact hidden ${!info.intactVisible}; FRAC ${info.frac ? `${info.frac.meshes} mesh, ${info.frac.tris} tris, along ${info.frac.along.join('..')} m (h ${hit.h}), lateral ${info.frac.lateral} m, y ${info.frac.y.join('..')}` : 'none'}; pools ${info.pools.length} (${info.pools.map((p) => p.verts + (p.kitMat ? 'k' : '')).join(' ')}); calls ${before.calls} -> ${after.calls} (same frame: intact ${ab.intact} / broken ${ab.broken}, frac sets ${ab.fracSetsVisible}/${ab.fracSets}); errors ${errors.length}`,
        );
        res.push(r);
        await ctx.close();
      }
      if (!done) console.log(`${run.theme}/${run.layout} seed ${run.seed}: no kit topple`);
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(OUT, `frac${LEGACY ? '_legacy' : ''}.json`), JSON.stringify(res, null, 1));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
