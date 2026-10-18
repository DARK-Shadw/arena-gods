// Camera readability audit on a built dist/ (one headless Chromium): runs __arena.cameraAudit on the standard 8-match list
// (tools/anim/_scratch/camaudit.expr, the A2b baseline: 93.8 % readable) or on the colosseum-only list (5 layouts), and
// prints / writes the summary.
//   npm run build && node tools/arena/check_camera.cjs [--list=standard|colosseum] [--params=arena=legacy] [--out=file.json]
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
const LIST = opt('list', 'standard');
const PARAMS = opt('params', '');
const OUT = opt('out', '');
const exe = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.webp': 'image/webp', '.ktx2': 'image/ktx2', '.wasm': 'application/wasm', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml', '.bin': 'application/octet-stream' };
const LISTS = {
  standard: [
    ['gorak', 'aldric', 4242, 'colosseum', 'pit', 7],
    ['maw', 'vex', 404, 'colosseum', 'pit', 7],
    ['erika', 'fenrik', 101, 'forge', 'cross', 11],
    ['ozrel', 'hollowjack', 202, 'skytemple', 'oval', 5],
    ['vex', 'gorak', 303, 'sakura', 'gauntlet', 9],
    ['aldric', 'maw', 505, 'glacier', 'split', 13],
    ['fenrik', 'erika', 606, 'moonlake', 'pit', 3],
    ['hollowjack', 'ozrel', 707, 'desert', 'cross', 21],
  ],
  colosseum: [
    ['gorak', 'aldric', 4242, 'colosseum', 'pit', 7],
    ['maw', 'vex', 404, 'colosseum', 'oval', 5],
    ['erika', 'fenrik', 101, 'colosseum', 'cross', 11],
    ['ozrel', 'hollowjack', 202, 'colosseum', 'split', 13],
    ['vex', 'gorak', 303, 'colosseum', 'gauntlet', 9],
  ],
};

(async () => {
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
  let r;
  try {
    const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
    await page.route('http://arena.local/**', (route) => {
      const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\//, '') || 'index.html';
      const f = path.join(DIST, rel);
      if (fs.existsSync(f) && fs.statSync(f).isFile()) route.fulfill({ path: f, contentType: MIME[path.extname(f)] || 'application/octet-stream' });
      else route.fulfill({ status: 404, body: '' });
    });
    await page.goto(`http://arena.local/index.html?manual=1&q=1${PARAMS ? '&' + PARAMS : ''}`);
    await page.waitForFunction(() => window.__arena && window.__arena.arena, null, { timeout: 120000 });
    r = await page.evaluate(async (list) => {
      const r = await window.__arena.cameraAudit(list);
      const sum = (k) => r.reduce((s, x) => s + x[k], 0);
      return {
        readable: +((sum('readable') / sum('frames')) * 100).toFixed(1),
        contact: +((sum('contactsSeen') / sum('contacts')) * 100).toFixed(1),
        cutsPerMin: +(sum('cutsPerMin') / r.length).toFixed(1),
        shortShots: sum('shortShots'),
        per: r.map((x) => x.key + ' ' + ((x.readable / x.frames) * 100).toFixed(1) + '% c' + ((x.contactsSeen / Math.max(1, x.contacts)) * 100).toFixed(0) + '% cuts' + x.cutsPerMin),
        bad: r.flatMap((x) => Object.entries(x.byShot).filter(([, v]) => v.bad > 20).map(([k, v]) => x.key.split(' ')[0] + ':' + k + ' ' + v.bad + '/' + v.n + ' ' + JSON.stringify(v.why ?? {}))),
        worst: r.map((x) => x.worst.slice(0, 4)),
      };
    }, LISTS[LIST]);
    await ctx.close();
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify({ list: LIST, params: PARAMS, readable: r.readable, contact: r.contact, cutsPerMin: r.cutsPerMin, shortShots: r.shortShots }));
  for (const p of r.per) console.log('  ' + p);
  for (const b of r.bad) console.log('  bad ' + b);
  if (OUT) {
    fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
    fs.writeFileSync(path.resolve(OUT), JSON.stringify(r, null, 1));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
