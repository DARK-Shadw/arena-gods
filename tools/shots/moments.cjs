// Screenshot specific fight moments through the dev server (no build).
//   node tools/shots/moments.cjs <outDir> "<query>" t1,t2,... [--cam=director|side] [--step=0] [--port=5173] [--w=960 --h=540]
// query: a=..&b=..&seed=..&theme=..&layout=..&aseed=..  (the game URL params)
// --step=N  after seeking, also capture N extra frames 0.1 s apart
const { chromium } = require('playwright-core');
const path = require('path'),
  fs = require('fs');
const args = process.argv.slice(2);
const opt = (k, d) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const [out, query, times] = args.filter((a) => !a.startsWith('--'));
const port = opt('port', '5173');
const cam = opt('cam', 'director');
const step = Number(opt('step', 0));
const dt = Number(opt('dt', 0.1));
const exe = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: Number(opt('w', 960)), height: Number(opt('h', 540)) } });
  const logs = [];
  page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));
  page.on('console', (m) => m.type() === 'error' && logs.push(m.text()));
  await page.goto(`http://localhost:${port}/index.html?manual=1&auto=1&skip=1&${query}`);
  await page.waitForFunction(() => window.__arena && window.__arena.state === 'fight', null, { timeout: 120000 });
  const side = () =>
    page.evaluate(() => {
      const A = __arena.views[0].position,
        B = __arena.views[1].position;
      const mx = (A.x + B.x) / 2,
        mz = (A.z + B.z) / 2;
      let ax = B.x - A.x,
        az = B.z - A.z;
      const l = Math.hypot(ax, az) || 1;
      ax /= l;
      az /= l;
      const d = Math.max(5, l * 0.9 + 3.2);
      const s = -az * -mx + ax * -mz >= 0 ? 1 : -1;
      __arena.debugView([mx - az * d * s, 2.0, mz + ax * d * s], [mx, 1.0, mz], 50);
    });
  let n = 0;
  for (const t of String(times).split(',').map(Number)) {
    await page.evaluate(() => (__arena.freeCam = false));
    await page.evaluate((t) => __arena.debugSeekFight(t), t);
    for (let k = 0; k <= step; k++) {
      if (cam === 'side') await side();
      await page.screenshot({ path: path.join(out, `m${String(n).padStart(2, '0')}_${t.toFixed(2)}_${String(k).padStart(2, "0")}.png`) });
      if (k < step) await page.evaluate((s) => __arena.stepFrames(Math.max(1, Math.round(s * 60)), 1 / 60), dt);
    }
    n++;
  }
  if (logs.length) console.log('--- console\n' + logs.slice(0, 20).join('\n'));
  console.log('captured', n);
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
