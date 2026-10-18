// A3 in-game check of the stone kit (one headless Chromium on dist/): colosseum fights on q0 / q1 / q2 x pit / cross,
// played for --secs of sim time with fixed steps; reports console errors, which obstacles use kit assets, each kit
// obstacle's measured visible top vs the sim's o.h (9-slice fit), its footprint vs o.r, ring meshes (merged trim
// mesh + rubble), draw calls, and how many obstacles fell (topple path exercised); one screenshot per run.
//   npm run build && node tools/arena/check_kitstone.cjs [--secs=60] [--out=docs/milestones/A3/load]
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
const OUT = path.resolve(opt('out', path.join(ROOT, 'docs/milestones/A3/load')));
const SECS = Number(opt('secs', '60'));
const exe = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.webp': 'image/webp', '.ktx2': 'image/ktx2', '.wasm': 'application/wasm', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml', '.bin': 'application/octet-stream' };
const RUNS = [0, 1, 2].flatMap((q) => ['pit', 'cross'].map((layout) => ({ q, layout })));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
  const res = [];
  try {
    for (const run of RUNS) {
      const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
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
      await page.goto(`http://arena.local/index.html?manual=1&q=${run.q}&auto=1&skip=1&a=gorak&b=maw&seed=7&theme=colosseum&layout=${run.layout}&aseed=3`);
      await page.waitForFunction(() => window.__arena && window.__arena.arena && window.__arena.rec && window.__arena.state === 'fight', null, { timeout: 120000 });
      for (let t = 0; t < SECS; t += 5) await page.evaluate(() => window.__arena.stepFrames(150, 1 / 30));
      const info = await page.evaluate(() => {
        const A = window.__arena.arena;
        const out = { obstacles: [], ring: [], fallen: 0 };
        for (const ov of A.obstacles) {
          if (ov.fallen) out.fallen++;
          const g = ov.mesh;
          const kit = g.userData.asset || null;
          let ymax = -1e9,
            r = 0;
          if (kit && !ov.fallen) {
            const p0 = ov.pivot.position.clone(),
              q0 = ov.pivot.quaternion.clone();
            ov.pivot.position.set(0, 0, 0);
            ov.pivot.quaternion.identity();
            ov.pivot.updateMatrixWorld(true);
            const v = new p0.constructor();
            g.traverse((o) => {
              if (!o.isMesh || !o.visible || o.userData.col || o.userData.frac) return;
              const pos = o.geometry.attributes.position;
              for (let i = 0; i < pos.count; i++) {
                v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
                ymax = Math.max(ymax, v.y);
                r = Math.max(r, Math.hypot(v.x, v.z));
              }
            });
            ov.pivot.position.copy(p0);
            ov.pivot.quaternion.copy(q0);
            ov.pivot.updateMatrixWorld(true);
          }
          out.obstacles.push({ kind: ov.def.kind, kit, h: +ov.def.h.toFixed(3), top: kit && !ov.fallen ? +ymax.toFixed(3) : null, r: ov.def.r, foot: kit && !ov.fallen ? +(r / ov.def.r).toFixed(3) : null });
        }
        for (const o of A.group.children) if (o.name && o.name.startsWith('kitRing_')) out.ring.push({ name: o.name, tris: o.geometry.index ? o.geometry.index.count / 3 : 0 });
        out.drawCalls = window.__arena.renderer?.info?.render?.calls ?? null;
        return out;
      });
      await page.screenshot({ path: path.join(OUT, `kit_q${run.q}_${run.layout}.jpg`), type: 'jpeg', quality: 85 });
      const bad = info.obstacles.filter((o) => o.kit && o.top !== null && Math.abs(o.top - o.h) > 0.01);
      console.log(`q${run.q} ${run.layout.padEnd(6)} obstacles ${info.obstacles.length} (kit ${info.obstacles.filter((o) => o.kit).length}, fallen ${info.fallen}) top mismatches ${bad.length} ring ${info.ring.map((x) => `${x.name}:${x.tris}`).join(' ')} errors ${errors.length}`);
      res.push({ ...run, ...info, errors });
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(OUT, 'kitstone.json'), JSON.stringify(res, null, 1));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
