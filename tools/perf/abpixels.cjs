// A21: same-page pixel A/B of the render-path optimisations (no asset change involved): renders a frame with the A21
// paths ON (default build) and again with the OLD paths restored at runtime, and compares the canvas pixels:
//   * Post.render's single scene-matrix update  -> OLD: call Post.renderPasses() directly (every pass updates matrices)
//   * lights on the FX layers                    -> OLD: FX_ADD / FX_DIST layer bits removed from every light
//   * the kit sky drawn last among opaques       -> OLD: sky.renderOrder = -10
// Frames: the Moon Gate fight frame with FX spawned (hits, explosion, blood) at q2 / q1 / q0, the forge (kit) and the
// legacy colosseum. Expect max difference 0.
//   node tools/perf/abpixels.cjs [--dist=dist] [--out=<dir>]
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
const OUT = opt('out', '');
const exe = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.webp': 'image/webp', '.ktx2': 'image/ktx2', '.wasm': 'application/wasm', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml', '.bin': 'application/octet-stream' };
const RUNS = [
  { name: 'moongate_q2', q: 2, qs: 'theme=colosseum&layout=oval&aseed=7' },
  { name: 'moongate_q1', q: 1, qs: 'theme=colosseum&layout=oval&aseed=7' },
  { name: 'moongate_q0', q: 0, qs: 'theme=colosseum&layout=oval&aseed=7' },
  { name: 'forge_q2', q: 2, qs: 'theme=forge&layout=pit&aseed=3' },
  { name: 'legacy_q2', q: 2, qs: 'theme=colosseum&layout=oval&aseed=7&arena=legacy' },
];

(async () => {
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
  let bad = 0;
  try {
    for (const R of RUNS) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
      await page.addInitScript(() => {
        // seeded Math.random (cosmetic randomness) so the two renders see the same values
        let s = 1234567;
        Math.random = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
      });
      await page.route('http://arena.local/**', (route) => {
        const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\//, '') || 'index.html';
        const p = path.join(DIST, rel);
        if (fs.existsSync(p) && fs.statSync(p).isFile()) route.fulfill({ path: p, contentType: MIME[path.extname(p)] || 'application/octet-stream' });
        else route.fulfill({ status: 404, body: '' });
      });
      await page.goto(`http://arena.local/index.html?manual=1&auto=1&skip=1&a=gorak&b=erika&seed=4242&q=${R.q}&${R.qs}`);
      await page.waitForFunction(() => window.__arena && window.__arena.state === 'fight' && window.__arena.arena, null, { timeout: 180000 });
      const res = await page.evaluate(async () => {
        const A = window.__arena;
        A.debugSeekFight(20);
        A.paused = true;
        const f = A.playback.frameAt(A.playback.t).f;
        const mx = (f[0].x + f[1].x) / 2,
          mz = (f[0].z + f[1].z) / 2;
        A.debugView([mx + 3.5, 2.0, mz + 3.5], [mx, 1.05, mz], 50);
        A.fx.spawn('impact.default.heavy', { x: mx, y: 1.2, z: mz }, { seed: 78 });
        A.fx.spawn('explosion.keg', { x: mx + 1, y: 0.6, z: mz - 1 }, { seed: 77 });
        A.fx.spawn('blood.cut', { x: mx, y: 1.3, z: mz }, { seed: 79 });
        // wait for atlases
        for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 30));
        const canvas = A.renderer.domElement;
        const gl = A.renderer.getContext();
        const grab = () => {
          const w = gl.drawingBufferWidth,
            h = gl.drawingBufferHeight;
          const px = new Uint8Array(w * h * 4);
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
          return { px, w, h };
        };
        const post = A.post;
        const newRender = post.render;
        const lights = [];
        A.scene.traverse((o) => o.isLight && lights.push(o));
        const sky = A.arena.sky;
        const skyOrder = sky.renderOrder;
        const setOld = (old) => {
          if (old) {
            post.render = () => post.renderPasses();
            post.lightScan = 1e9;
            for (const l of lights) l.layers.disable(20), l.layers.disable(22);
            sky.renderOrder = -10;
          } else {
            post.render = newRender;
            post.lightScan = 0;
            sky.renderOrder = skyOrder;
          }
        };
        // render the SAME frame state: no tick between the renders (ticks advance seeded randomness / clocks)
        A.tick(1 / 60);
        const shot = (old) => {
          setOld(old);
          post.render();
          post.render();
          return grab();
        };
        const a = shot(false);
        const b = shot(true);
        const c = shot(false);
        let maxAB = 0,
          nAB = 0,
          maxAC = 0;
        for (let i = 0; i < a.px.length; i++) {
          const d = Math.abs(a.px[i] - b.px[i]);
          if (d > maxAB) maxAB = d;
          if (d > 0) nAB++;
          maxAC = Math.max(maxAC, Math.abs(a.px[i] - c.px[i]));
        }
        setOld(false);
        return { maxAB, nAB, maxAC, w: a.w, h: a.h, skyOrder, lights: lights.length, calls: A.renderer.info.render.calls };
      });
      const ok = res.maxAB === 0;
      if (!ok) bad++;
      console.log(`${R.name.padEnd(14)} new vs old: max diff ${res.maxAB} (${res.nAB} channel values differ)  repeat new vs new: max ${res.maxAC}  sky order ${res.skyOrder}  lights ${res.lights}  ${ok ? 'IDENTICAL' : 'DIFFERS'}`);
      if (OUT) {
        fs.mkdirSync(OUT, { recursive: true });
        await page.screenshot({ path: path.join(OUT, `${R.name}.png`) });
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
