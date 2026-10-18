// A2 wet-floor checker: one headless Chromium on a built dist/, the ref-3 concept preset (colosseum, kit mode).
//   npm run build && node tools/arena/check_floor.cjs [--q=1] [--out=docs/milestones/A2/floor] [--extra=&moongate=0]
// Per run: a screenshot, the planar reflection target (tone-mapped dump), the floor light map (dump), floor state
// (reflection on / size / frames, light-map renders + ms, streak count, surfaceAt over a grid: water / wet share),
// draw calls with and without the reflection, console errors. Writes <out>/floor_q<q>.json + PNGs.
const { chromium } = require('playwright-core');
const path = require('path'),
  fs = require('fs');
const ROOT = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const opt = (k, d) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const DIST = path.resolve(opt('dist', path.join(ROOT, 'dist')));
const OUT = path.resolve(opt('out', path.join(ROOT, 'docs/milestones/A2/floor')));
const QS = opt('q', '1').split(',').map(Number);
const EXTRA = opt('extra', '');
const exe = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.webp': 'image/webp', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ktx2': 'image/ktx2' };

// in the page: read a render target (float or byte) into a PNG data URL (Reinhard + sRGB for HDR targets)
const DUMP = (which) => {
  const A = window.__arena;
  const r = A.renderer;
  const ar = A.arena;
  const rt = which === 'refl' ? ar.reflection && ar.reflection.rt : ar.lightMap && ar.lightMap.rt;
  if (!rt) return null;
  const w = rt.width,
    h = rt.height;
  const half = rt.texture.type === 1016; // HalfFloatType
  const buf = half ? new Uint16Array(w * h * 4) : new Uint8Array(w * h * 4);
  r.readRenderTargetPixels(rt, 0, 0, w, h, buf);
  const f16 = (u) => {
    const s = (u & 0x8000) >> 15,
      e = (u & 0x7c00) >> 10,
      m = u & 0x3ff;
    const v = e === 0 ? (m / 1024) * 2 ** -14 : e === 31 ? 65504 : (1 + m / 1024) * 2 ** (e - 15);
    return s ? -v : v;
  };
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  const img = g.createImageData(w, h);
  const k = which === 'lm' ? 1.5 : 1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = ((h - 1 - y) * w + x) * 4,
        o = (y * w + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        let v = half ? f16(buf[i + ch]) : buf[i + ch] / 255;
        v *= k;
        v = v / (1 + v);
        img.data[o + ch] = Math.round(255 * Math.pow(Math.max(0, v), 1 / 2.2));
      }
      img.data[o + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
  const report = [];
  try {
    for (const q of QS) {
      const ctx = await browser.newContext({ viewport: { width: 1793, height: 877 }, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
      await page.route('http://arena.local/**', (route) => {
        const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\//, '') || 'index.html';
        const p = path.join(DIST, rel);
        if (fs.existsSync(p) && fs.statSync(p).isFile()) route.fulfill({ path: p, contentType: MIME[path.extname(p)] || 'application/octet-stream' });
        else route.fulfill({ status: 404, body: '' });
      });
      await page.goto(`http://arena.local/index.html?manual=1&q=${q}&concept=ref-3${EXTRA}`);
      await page.waitForFunction(() => window.__arena && window.__arena.conceptReady, null, { timeout: 120000 });
      await page.evaluate(() => window.__arena.stepFrames(2, 1 / 60));
      const tag = `q${q}${EXTRA.replace(/[^a-z0-9]+/gi, '_')}`;
      await page.screenshot({ path: path.join(OUT, `floor_${tag}.jpg`), type: 'jpeg', quality: 88 });
      for (const w of ['refl', 'lm']) {
        const url = await page.evaluate(DUMP, w);
        if (url) fs.writeFileSync(path.join(OUT, `${w}_${tag}.png`), Buffer.from(url.split(',')[1], 'base64'));
      }
      const st = await page.evaluate(() => {
        const A = window.__arena;
        const ar = A.arena;
        const F = ar.wetFloor;
        const out = { kitFloor: !!F, theme: ar.theme.name, look: ar.theme.lookId || null };
        if (F) {
          let water = 0,
            wet = 0,
            n = 0;
          const L = ar.layout;
          for (let x = -L.rx; x <= L.rx; x += 0.25)
            for (let z = -L.rz; z <= L.rz; z += 0.25) {
              if ((x / L.rx) ** 2 + (z / L.rz) ** 2 > 1) continue;
              const s = ar.surfaceAt(x, z);
              n++;
              if (s === 'water') water++;
              else if (s === 'wet') wet++;
            }
          out.surfaceGrid = { n, water: +(water / n).toFixed(3), wet: +(wet / n).toFixed(3) };
          out.reflection = ar.reflection ? { on: ar.reflection.uniforms.uReflOn.value, frames: ar.reflection.frames, size: ar.reflection.rt ? [ar.reflection.rt.width, ar.reflection.rt.height] : null } : null;
          out.lightMap = ar.lightMap ? { renders: ar.lightMap.renders, ms: +ar.lightMap.lastMs.toFixed(2) } : null;
          out.streaks = ar.streaks ? ar.streaks.mesh.count : 0;
          out.sources = ar.floorSrc.length;
          // draw calls of one frame with / without the planar pass
          const info = A.renderer.info;
          info.autoReset = false;
          info.reset();
          A.stepFrames(1, 1 / 60);
          out.callsFrame = info.render.calls;
          const pre = A.post.preScene;
          A.post.preScene = null;
          info.reset();
          A.stepFrames(1, 1 / 60);
          out.callsNoReflect = info.render.calls;
          A.post.preScene = pre;
          info.autoReset = true;
        }
        return out;
      });
      st.q = q;
      st.extra = EXTRA;
      st.errors = errors;
      report.push(st);
      console.log(JSON.stringify(st));
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(OUT, `floor${EXTRA ? EXTRA.replace(/[^a-z0-9]+/gi, '_') : ''}.json`), JSON.stringify(report, null, 1));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
