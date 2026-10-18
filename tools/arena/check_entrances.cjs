// Entrance validator on a built dist/ (one headless Chromium): runs __arena.validateEntrances for the given themes /
// fighters with and without extra URL params, so a dressing change can be compared against its baseline.
//   npm run build && node tools/arena/check_entrances.cjs [--themes=colosseum] [--fighters=gorak,maw] [--params=,kitstone=0]
//        [--out=docs/milestones/A3/entrances.json]
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
const OUT = path.resolve(opt('out', path.join(ROOT, 'docs/milestones/A3/entrances.json')));
const themes = opt('themes', 'colosseum').split(',');
const fighters = opt('fighters', 'gorak,maw').split(',');
const PARAMS = opt('params', ',kitstone=0').split(',');
const exe = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.webp': 'image/webp', '.ktx2': 'image/ktx2', '.wasm': 'application/wasm', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml', '.bin': 'application/octet-stream' };

(async () => {
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
  const out = {};
  try {
    for (const p of PARAMS) {
      const ctx = await browser.newContext({ viewport: { width: 640, height: 360 } });
      const page = await ctx.newPage();
      await page.route('http://arena.local/**', (route) => {
        const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\//, '') || 'index.html';
        const f = path.join(DIST, rel);
        if (fs.existsSync(f) && fs.statSync(f).isFile()) route.fulfill({ path: f, contentType: MIME[path.extname(f)] || 'application/octet-stream' });
        else route.fulfill({ status: 404, body: '' });
      });
      await page.goto(`http://arena.local/index.html?manual=1&q=1${p ? '&' + p : ''}`);
      await page.waitForFunction(() => window.__arena && window.__arena.arena, null, { timeout: 120000 });
      const r = await page.evaluate(async (o) => {
        const res = await window.__arena.validateEntrances(o);
        return { configs: res.configs, failed: res.failed, fails: res.results.filter((x) => !x.ok).map((x) => ({ theme: x.theme, layout: x.layout, gate: x.gate, fighter: x.fighter, variant: x.variant, issues: (x.issues ?? []).slice(0, 4) })) };
      }, { fighters, themes });
      out[p || 'kit'] = r;
      console.log(`${(p || 'kit').padEnd(12)} configs ${r.configs} failed ${r.failed}`);
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
