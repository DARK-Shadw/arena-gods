// A1 in-game check of the kit assets: loads a built dist/ in ONE headless Chromium (no dev server) and, per
// quality tier (q0 / q1 / q2) x texture format (ktx2 / webp) plus one `?arena=legacy` run, opens a fight in an
// arena that spawns braziers (forge / cross / aseed 1: 6 braziers), then
//   * checks every brazier prop is the kit asset (or the legacy mesh with ?arena=legacy),
//   * measures its visible bounds in the prop's own frame (max horizontal radius, y range; COL excluded)
//     against the sim contract (PROP_BASE.brazier.r 0.45, TOP.brazier 1.2),
//   * reports the texture types the GPU got (compressed KTX2 vs RGBA WebP), LOD node, draw calls, load time,
//   * writes a close-up screenshot per run.
//   npm run build && node tools/arena/check_load.cjs [--out=docs/milestones/A1/load] [--dist=dist]
// Memory: one browser, one page at a time, closed at the end (also on errors). Do not run with Blender.
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
const OUT = path.resolve(opt('out', path.join(ROOT, 'docs/milestones/A1/load')));
const exe = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.webp': 'image/webp', '.ktx2': 'image/ktx2', '.wasm': 'application/wasm', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml', '.bin': 'application/octet-stream' };
const RUNS = [
  ...[0, 1, 2].flatMap((q) => [{ q, fmt: 'ktx2' }, { q, fmt: 'webp' }]),
  { q: 1, fmt: 'legacy' },
];
const R0 = 0.45,
  TOP = 1.2;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
  const results = [];
  let fail = 0;
  try {
    for (const run of RUNS) {
      const ctx = await browser.newContext({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      const errors = [];
      const logs = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`.slice(0, 300));
        if (/\[arena\]/.test(m.text())) logs.push(m.text());
      });
      await page.route('http://arena.local/**', (route) => {
        const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\//, '') || 'index.html';
        const p = path.join(DIST, rel);
        if (fs.existsSync(p) && fs.statSync(p).isFile()) route.fulfill({ path: p, contentType: MIME[path.extname(p)] || 'application/octet-stream' });
        else route.fulfill({ status: 404, body: '' });
      });
      const extra = run.fmt === 'legacy' ? '&arena=legacy' : run.fmt === 'webp' ? '&arenatex=webp' : '';
      const t0 = Date.now();
      await page.goto(`http://arena.local/index.html?manual=1&q=${run.q}&auto=1&skip=1&a=gorak&b=vex&seed=11&theme=forge&layout=cross&aseed=1${extra}`);
      await page.waitForFunction(() => window.__arena && window.__arena.arena && window.__arena.rec && window.__arena.state === 'fight', null, { timeout: 120000 });
      const tReady = Date.now() - t0;
      await page.evaluate(() => window.__arena.stepFrames(2, 1 / 60));
      const tFirst = Date.now() - t0 - tReady;
      const info = await page.evaluate(() => {
        const app = window.__arena;
        const A = app.arena;
        const out = { props: [], textures: {}, lods: {}, format: app.arenaAssets.format, loaded: app.arenaAssets.info().loaded };
        for (const pv of A.props) {
          if (pv.kind !== 'brazier') continue;
          const g = pv.obj;
          const p0 = g.position.clone(),
            r0 = g.rotation.clone();
          g.position.set(0, 0, 0);
          g.rotation.set(0, 0, 0);
          g.updateMatrixWorld(true);
          let r = 0,
            ymin = 1e9,
            ymax = -1e9,
            meshes = 0;
          const v = new g.position.constructor();
          g.traverse((o) => {
            if (!o.isMesh || !o.visible) return;
            if (pv.kit ? !o.userData.kit || o.userData.col : o.parent !== g) return; // kit: asset meshes only (no COL, no flame); legacy: the prop mesh
            meshes++;
            const pos = o.geometry.attributes.position;
            for (let i = 0; i < pos.count; i++) {
              v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
              r = Math.max(r, Math.hypot(v.x, v.z));
              ymin = Math.min(ymin, v.y);
              ymax = Math.max(ymax, v.y);
            }
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            for (const m of mats)
              for (const k of ['map', 'normalMap', 'roughnessMap', 'aoMap'])
                if (m[k]) out.textures[`${m.name}.${k}`] = { compressed: !!m[k].isCompressedTexture, w: m[k].image?.width ?? m[k].mipmaps?.[0]?.width, format: m[k].format };
          });
          let lod = null;
          g.traverse((o) => {
            if (/^LOD\d$/.test(o.name)) lod = o.name;
          });
          g.position.copy(p0);
          g.rotation.copy(r0);
          g.updateMatrixWorld(true);
          out.props.push({ kit: pv.kit ?? null, lod, meshes, r, ymin, ymax, x: p0.x, z: p0.z });
        }
        return out;
      });
      // close-up of the first brazier, fight paused, free camera
      const b = info.props[0];
      await page.evaluate(
        ({ x, z }) => {
          const app = window.__arena;
          app.paused = true;
          app.freeCam = true;
          app.controls.enabled = false;
          app.controls.target.set(x, 0.75, z);
          const d = Math.hypot(x, z) || 1;
          app.camera.position.set(x - (x / d) * 2.4 + 0.6, 1.5, z - (z / d) * 2.4 + 0.6);
          app.stepFrames(3, 1 / 60);
        },
        { x: b.x, z: b.z },
      );
      const ri = await page.evaluate(() => {
        const r = window.__arena.renderer.info;
        r.autoReset = false;
        r.reset();
        window.__arena.stepFrames(1, 1 / 60);
        const o = { calls: r.render.calls, tris: r.render.triangles, textures: r.memory.textures, geometries: r.memory.geometries };
        r.autoReset = true;
        return o;
      });
      const shot = path.join(OUT, `brazier_q${run.q}_${run.fmt}.jpg`);
      await page.screenshot({ path: shot, type: 'jpeg', quality: 88 });
      // verdict
      const v = [];
      const legacy = run.fmt === 'legacy';
      if (!info.props.length) v.push('no brazier props');
      for (const p of info.props) {
        if (legacy ? p.kit : p.kit !== 'kit/brazier_tripod') v.push(`prop kit=${p.kit}`);
        if (!legacy) {
          if (Math.abs(p.r - R0) > 0.005 || Math.abs(p.ymax - TOP) > 0.005 || Math.abs(p.ymin) > 0.003) v.push(`bounds r ${p.r.toFixed(4)} y ${p.ymin.toFixed(4)}..${p.ymax.toFixed(4)}`);
          if (p.lod !== (run.q === 0 ? 'LOD1' : 'LOD0')) v.push(`lod ${p.lod}`);
        }
      }
      if (!legacy) {
        const tex = Object.values(info.textures);
        if (!tex.length) v.push('no textures');
        if (run.fmt === 'ktx2' && tex.some((t) => !t.compressed)) v.push('KTX2 run with uncompressed textures');
        if (run.fmt === 'webp' && tex.some((t) => t.compressed)) v.push('WebP run with compressed textures');
        if (info.format !== run.fmt) v.push(`loader format ${info.format}`);
      }
      const errs = errors.filter((e) => !/AudioContext|autoplay|favicon/i.test(e));
      if (errs.length) v.push(`${errs.length} console errors/warnings`);
      if (v.length) fail++;
      const rec = { run: `q${run.q}/${run.fmt}`, ok: !v.length, problems: v, ms: Date.now() - t0, readyMs: tReady, firstFramesMs: tFirst, ...info, renderer: ri, errors: errs.slice(0, 8), logs, shot: path.relative(OUT, shot) };
      results.push(rec);
      const p = info.props[0] || {};
      console.log(`${rec.run.padEnd(12)} ${rec.ok ? 'OK  ' : 'FAIL'} braziers ${info.props.length} kit ${p.kit} ${p.lod} r ${p.r?.toFixed(4)} y ${p.ymin?.toFixed(4)}..${p.ymax?.toFixed(4)} tex ${Object.values(info.textures).map((t) => `${t.w}${t.compressed ? 'c' : 'u'}`).join(',')} calls ${ri.calls} ${rec.ms} ms (ready ${tReady}, first frames ${tFirst}) ${v.join('; ')}`);
      if (errs.length) console.log('   ' + errs.slice(0, 4).join('\n   '));
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(OUT, 'load.json'), JSON.stringify(results, null, 1));
  console.log(fail ? `FAIL: ${fail} of ${results.length} runs` : `all ${results.length} runs OK -> ${path.relative(ROOT, OUT)}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
