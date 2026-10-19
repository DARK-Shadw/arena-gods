// Concept-match harness (arena art plan 3.3, milestone A0).
// Renders every concept preset (src/render/arena/conceptCams.ts) from a built dist/ in ONE headless
// Chromium (no dev server), at the concept's pixel size, then runs tools/arena/concept_compare.py
// (side-by-side, blend, guides, metrics C1-C5 + C8, contact sheet).
//   npm run build && node tools/shots/concept.cjs [--refs=ref-3,ref-4|all] [--q=1] [--views=counter,flank,overview|none]
//        [--out=docs/milestones/A0/concept] [--dist=dist] [--theme=<id>] [--layout=<id>] [--aseed=<n>]
//        [--arena=legacy] (A1: pre-A1 procedural dressing) [--arenatex=webp] (A1: WebP fallback art)
//        [--clip=4] (C9: 8 frames over 4 s per preset, written as a strip) [--compare=0] (renders only)
// Determinism: Math.random is replaced by a seeded generator before the page loads (the ambient /
// cosmetic randomness), the fight is frozen at frame 0, and the FX / arena clocks advance by fixed
// steps, so two runs of the same build give the same images (up to GPU driver noise).
// Memory: one browser, one page, sequential; the browser is closed at the end (also on errors).
const { chromium } = require('playwright-core');
const { execFileSync } = require('child_process');
const path = require('path'),
  fs = require('fs');
const ROOT = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
const opt = (k, d) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const DIST = path.resolve(opt('dist', path.join(ROOT, 'dist')));
const OUT = path.resolve(opt('out', path.join(ROOT, 'docs/milestones/A0/concept')));
const Q = Number(opt('q', '1'));
const CLIP = Number(opt('clip', '0'));
const COMPARE = opt('compare', '1') !== '0';
const VIEWS = opt('views', 'counter,flank,overview') === 'none' ? [] : opt('views', 'counter,flank,overview').split(',');
const OVR = ['theme', 'layout', 'aseed', 'arena', 'arenatex', 'kitstone', 'lit', 'backdrop', 'stage', 'sky', 'skyflash'].map((k) => (opt(k, '') ? `&${k}=${opt(k, '')}` : '')).join('');
const exe = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.webp': 'image/webp', '.ktx2': 'image/ktx2', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml', '.bin': 'application/octet-stream' };

// preset list from the TS source (single source of truth)
const src = fs.readFileSync(path.join(ROOT, 'src/render/arena/conceptCams.ts'), 'utf8');
const ALL = [...src.matchAll(/\{ id: '(ref-\d+)', image: '([^']+)', w: (\d+), h: (\d+)/g)].map((m) => ({ id: m[1], image: m[2], w: +m[3], h: +m[4] }));
const want = opt('refs', 'all');
const PRESETS = want === 'all' ? ALL : ALL.filter((p) => want.split(',').includes(p.id));
if (!PRESETS.length) throw new Error('no presets matched ' + want);
if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error(`no build at ${DIST}: run npm run build first`);

const seedRandom = (seed) => {
  let st = seed >>> 0 || 1;
  Math.random = () => {
    st = (st + 0x6d2b79f5) >>> 0;
    let z = st;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
};

(async () => {
  fs.mkdirSync(path.join(OUT, 'game'), { recursive: true });
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
  const infos = [];
  const t0 = Date.now();
  try {
    for (const P of PRESETS) {
      const jobs = [{ view: '', file: `${P.id}_q${Q}` }, ...VIEWS.map((v) => ({ view: v, file: `${P.id}_${v}_q${Q}` }))];
      for (const J of jobs) {
        const ctx = await browser.newContext({ viewport: { width: P.w, height: P.h }, deviceScaleFactor: 1 });
        const page = await ctx.newPage();
        page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
        await page.addInitScript(seedRandom, 1234 + Number(P.id.slice(4)) * 97);
        await page.route('http://arena.local/**', (route) => {
          const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\//, '') || 'index.html';
          const p = path.join(DIST, rel);
          if (fs.existsSync(p) && fs.statSync(p).isFile()) route.fulfill({ path: p, contentType: MIME[path.extname(p)] || 'application/octet-stream' });
          else route.fulfill({ status: 404, body: '' });
        });
        const ts = Date.now();
        await page.goto(`http://arena.local/index.html?manual=1&q=${Q}&concept=${P.id}${J.view ? `&view=${J.view}` : ''}${OVR}`);
        await page.waitForFunction(() => window.__arena && window.__arena.conceptReady, null, { timeout: 120000 });
        const info = await page.evaluate(() => window.__arena.conceptReady);
        await page.evaluate(() => window.__arena.stepFrames(1, 1 / 60));
        const png = path.join(OUT, 'game', `${J.file}.png`);
        await page.screenshot({ path: png });
        // C1: geometric sky mask (sky dome visible, 1/4 res) and a sky-only frame (visual sky = where the
        // normal frame equals the sky-only frame); the arena is hidden, rendered once, then restored
        const mask = await page.evaluate(() => window.__arena.conceptSkyMask(4));
        fs.writeFileSync(path.join(OUT, 'game', `${J.file}_skygeo.png`), Buffer.from(mask.split(',')[1], 'base64'));
        await page.evaluate(() => window.__arena.conceptSkyOnly(true));
        await page.screenshot({ path: path.join(OUT, 'game', `${J.file}_skyonly.png`) });
        await page.evaluate(() => window.__arena.conceptSkyOnly(false));
        info.view = J.view || 'concept';
        info.file = path.relative(OUT, png).replace(/\\/g, '/');
        info.image = P.image;
        info.ms = Date.now() - ts;
        if (CLIP > 0 && !J.view) {
          const frames = [];
          for (let k = 0; k < 8; k++) {
            await page.evaluate((n) => window.__arena.stepFrames(n, 1 / 60), Math.round((CLIP * 60) / 8));
            const f = path.join(OUT, 'game', `${J.file}_clip${k}.png`);
            await page.screenshot({ path: f });
            frames.push(path.relative(OUT, f).replace(/\\/g, '/'));
          }
          info.clip = frames;
        }
        infos.push(info);
        console.log(`${J.file.padEnd(22)} ${info.theme}/${info.layout}#${info.aseed} ${info.size.join('x')} calls ${info.calls} tris ${info.tris} ${info.ms} ms`);
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
  }
  const infoPath = path.join(OUT, 'info.json');
  // merge with an earlier run (other refs / views keep their entries)
  let prev = [];
  try {
    prev = JSON.parse(fs.readFileSync(infoPath, 'utf8')).filter((x) => !infos.some((y) => y.file === x.file));
  } catch {}
  fs.writeFileSync(infoPath, JSON.stringify([...prev, ...infos], null, 1));
  console.log(`rendered ${infos.length} views in ${((Date.now() - t0) / 1000).toFixed(0)} s -> ${path.relative(ROOT, OUT)}`);
  if (COMPARE) {
    const py = process.env.PYTHON || 'python';
    execFileSync(py, [path.join(ROOT, 'tools/arena/concept_compare.py'), '--dir', OUT, '--q', String(Q)], { stdio: 'inherit' });
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
