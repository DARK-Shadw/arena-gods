// Finisher FX captures in the Animation Lab (dev server).
//   node tools/shots/fxshots.cjs <outDir> [--port=5173]
// For each fighter: the neck split statistics + behead (full) shot; then one fighter per effect / gore level.
const { chromium } = require('playwright-core');
const path = require('path'),
  fs = require('fs');
const args = process.argv.slice(2);
const out = args[0];
const port = (args.find((a) => a.startsWith('--port=')) || '--port=5173').slice(7);
const exe = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const FIGHTERS = ['gorak', 'aldric', 'ozrel', 'erika', 'vex', 'fenrik', 'maw', 'hollowjack'];
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const logs = [];
  page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));
  await page.goto(`http://localhost:${port}/tools/animlab/index.html?pause=1&src=own`);
  await page.waitForFunction(() => window.__lab && window.__lab.ready, null, { timeout: 120000 });
  const stats = {};
  const shot = async (name) => page.screenshot({ path: path.join(out, name + '.png'), clip: { x: 330, y: 0, width: 570, height: 560 } });
  const pose = async (f) => {
    await page.evaluate(async (f) => {
      window.__lab.fxReset();
      await window.__lab.show(f, 'own:idle');
      window.__lab.view([0.4, 1.3, 3.4], [0, 1.0, 0]);
      window.__lab.seek(0.6);
    }, f);
  };
  for (const f of FIGHTERS) {
    await pose(f);
    stats[f] = await page.evaluate(() => window.__lab.splitStats());
    await page.evaluate(() => window.__lab.fxDemo('behead', 'full', 14));
    await shot(`behead_full_${f}`);
  }
  for (const [kind, gore, f, steps] of [
    ['bisect', 'full', 'aldric', 24],
    ['bisect', 'stylised', 'gorak', 24],
    ['behead', 'stylised', 'vex', 14],
    ['behead', 'off', 'vex', 20],
    ['burn', 'off', 'erika', 45],
    ['shatter', 'off', 'fenrik', 26],
    ['dissolve', 'off', 'ozrel', 22],
    ['drain', 'stylised', 'hollowjack', 30],
  ]) {
    await pose(f);
    const shown = await page.evaluate(([k, g, s]) => window.__lab.fxDemo(k, g, s), [kind, gore, steps]);
    await shot(`${kind}_${gore}_${f}`);
    console.log(kind, gore, f, '->', shown);
  }
  fs.writeFileSync(path.join(out, 'neck-split-stats.json'), JSON.stringify(stats, null, 1));
  console.log(JSON.stringify(stats));
  if (logs.length) console.log(logs.slice(0, 10).join('\n'));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
