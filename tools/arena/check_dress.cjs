// A4 in-game check of the shared dressing kit (one headless Chromium on dist/): kit-mode fights per theme / layout / tier,
// played for --secs of sim time with fixed steps; reports console errors, which props / features / hazards use kit assets,
// every kit prop's measured bounds in its own frame vs the sim contract (PROP_BASE r / TOP, from the manifest), the ring
// dressing meshes (merged banners, rods, chains, candle glow), the CPU time of the banner sway / chain swing clock
// (Arena.swayStats, ms per frame), draw calls; screenshots from the fight camera and from fixed spots near the dressing.
//   npm run build && node tools/arena/check_dress.cjs [--secs=40] [--out=docs/milestones/A4/load]
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
const OUT = path.resolve(opt('out', path.join(ROOT, 'docs/milestones/A4/load')));
const SECS = Number(opt('secs', '40'));
const exe = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.webp': 'image/webp', '.ktx2': 'image/ktx2', '.wasm': 'application/wasm', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml', '.bin': 'application/octet-stream' };
const RUNS = (opt('runs', '') || 'colosseum:pit:1,colosseum:cross:2,colosseum:oval:0,forge:pit:1,desert:cross:1,sakura:oval:1')
  .split(',')
  .map((s) => {
    const [theme, layout, q] = s.split(':');
    return { theme, layout, q: Number(q) };
  });
const man = JSON.parse(fs.readFileSync(path.join(DIST, 'arena', 'manifest.json'), 'utf8'));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
  const res = [];
  try {
    for (const run of RUNS) {
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
      await page.goto(`http://arena.local/index.html?manual=1&q=${run.q}&auto=1&skip=1&a=gorak&b=maw&seed=7&theme=${run.theme}&layout=${run.layout}&aseed=3`);
      await page.waitForFunction(() => window.__arena && window.__arena.arena && window.__arena.rec && window.__arena.state === 'fight', null, { timeout: 120000 });
      await page.evaluate(() => {
        const A = window.__arena.arena;
        A.swayStats.ms = 0;
        A.swayStats.frames = 0;
      });
      for (let t = 0; t < SECS; t += 5) await page.evaluate(() => window.__arena.stepFrames(150, 1 / 30));
      await page.screenshot({ path: path.join(OUT, `fight_${run.theme}_${run.layout}_q${run.q}.jpg`), type: 'jpeg', quality: 85 });
      const info = await page.evaluate((contracts) => {
        const A = window.__arena.arena;
        const out = { props: [], features: [], hazards: [], ring: [], sway: { ...A.swayStats } };
        const V = A.group.position.constructor;
        const v = new V();
        for (const pv of A.props) {
          if (!pv.kit) {
            out.props.push({ kind: pv.kind, kit: null });
            continue;
          }
          const g = pv.obj;
          const p0 = g.position.clone(),
            r0 = g.rotation.clone();
          g.position.set(0, 0, 0);
          g.rotation.set(0, 0, 0);
          g.updateMatrixWorld(true);
          let r = 0,
            ymin = 1e9,
            ymax = -1e9;
          g.traverse((o) => {
            if (!o.isMesh || o.userData.col || o.userData.frac || !o.userData.kit) return;
            const pos = o.geometry.attributes.position;
            for (let i = 0; i < pos.count; i++) {
              v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
              r = Math.max(r, Math.hypot(v.x, v.z));
              ymin = Math.min(ymin, v.y);
              ymax = Math.max(ymax, v.y);
            }
          });
          g.position.copy(p0);
          g.rotation.copy(r0);
          g.updateMatrixWorld(true);
          const c = contracts[pv.kit];
          out.props.push({ kind: pv.kind, kit: pv.kit, r: +r.toFixed(4), y: [+ymin.toFixed(4), +ymax.toFixed(4)], want: c ? [c.radius, c.height] : null });
        }
        for (const ov of A.obstacles) if (ov.def.kind === 'banner' || ov.def.kind === 'barricade') {
          let kit = null;
          ov.mesh.traverse((o) => (kit ??= o.userData.asset ?? null));
          out.features.push({ kind: ov.def.kind, kit, fallen: ov.fallen });
        }
        for (const h of A.hazards) {
          let kit = null;
          h.group.traverse((o) => (kit ??= o.userData.asset ?? null));
          out.hazards.push({ kind: h.def.kind, kit });
        }
        for (const o of A.group.children) if (o.name && /^kit(Banner|Candle|Ring)/.test(o.name)) out.ring.push({ name: o.name, tris: o.geometry?.index ? o.geometry.index.count / 3 : 0, inst: o.count ?? 0 });
        out.drawCalls = window.__arena.renderer?.info?.render?.calls ?? null;
        out.tris = window.__arena.renderer?.info?.render?.triangles ?? null;
        return out;
      }, Object.fromEntries(Object.entries(man.assets).map(([id, a]) => [id, a.contract ?? null])));
      const bad = info.props.filter((p) => p.kit && p.want && (Math.abs(p.r - p.want[0]) > 0.006 || Math.abs(p.y[1] - p.want[1]) > 0.006 || Math.abs(p.y[0]) > 0.003));
      const swayMs = info.sway.frames ? info.sway.ms / info.sway.frames : 0;
      console.log(
        `${run.theme}/${run.layout} q${run.q}: props ${info.props.length} (kit ${info.props.filter((p) => p.kit).length}, contract mismatches ${bad.length}) features ${info.features.map((f) => `${f.kind}:${f.kit ?? '-'}`).join(' ')} hazards ${info.hazards
          .filter((h) => h.kit)
          .map((h) => h.kind)
          .join(',')} ring ${info.ring.map((x) => x.name).join(',')} sway ${swayMs.toFixed(4)} ms/frame over ${info.sway.frames} frames, calls ${info.drawCalls}, errors ${errors.length}`,
      );
      res.push({ ...run, ...info, contractMismatch: bad, swayMsPerFrame: swayMs, errors });
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(OUT, 'dress.json'), JSON.stringify(res, null, 1));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
