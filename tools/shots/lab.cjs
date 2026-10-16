// Headless Animation Lab captures (needs the dev server: npm run dev on :5173, or --port=5175).
//   node tools/shots/lab.cjs <outDir> <spec.json> [--port=5173] [--w=900 --h=700]
// spec.json: [{ "name": "hits", "a": "gorak", "clip": "lib:Head_Hit", "b": "vex", "clipB": "lib:Head_Hit~M",
//               "times": [0, 0.2, 0.4], "view": [[x,y,z],[lx,ly,lz]], "root": false }]
// Writes <outDir>/<name>_<i>.png per time (tile them with tools/shots/tile.py).
const { chromium } = require('playwright-core');
const path = require('path'),
  fs = require('fs');
const args = process.argv.slice(2);
const out = args[0];
const spec = JSON.parse(fs.readFileSync(args[1], 'utf8'));
const opt = (k, d) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? a.split('=')[1] : d;
};
const port = opt('port', '5173');
const W = Number(opt('w', 900)),
  H = Number(opt('h', 700));
const exe = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const logs = [];
  page.on('console', (m) => /error|warn/i.test(m.type()) && logs.push(m.text()));
  page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));
  await page.goto(`http://localhost:${port}/tools/animlab/index.html?pause=1${spec[0]?.root ? '&root=1' : ''}`);
  await page.waitForFunction(() => window.__lab && window.__lab.ready, null, { timeout: 120000 });
  for (const s of spec) {
    await page.evaluate(async (s) => {
      await window.__lab.show(s.a, s.clip, s.b, s.clipB);
      if (s.view) window.__lab.view(s.view[0], s.view[1]);
    }, s);
    let i = 0;
    for (const t of s.times) {
      await page.evaluate((t) => window.__lab.seek(t), t);
      await page.waitForTimeout(30);
      await page.screenshot({ path: path.join(out, `${s.name}_${String(i++).padStart(2, '0')}.png`), clip: s.crop ? { x: s.crop[0], y: s.crop[1], width: s.crop[2], height: s.crop[3] } : undefined });
    }
    console.log('captured', s.name, s.times.length);
  }
  if (logs.length) console.log('--- console\n' + logs.slice(0, 30).join('\n'));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
