// FX Lab contact strips (plan §3.9): one PNG per effect at fixed times and seed.
//   npm run dev   (in another shell; stop it afterwards)
//   node tools/shots/fxsheet.cjs <outDir> [--port=5173] [--filter=regex] [--times=0.05,0.15,0.3,0.6,1.0] [--seed=1] [--q=2] [--bg=dark]
//        [--abs=1 (times in seconds, not fractions of the duration)] [--gore=off|standard|full] [--look=forge]
// ONE headless browser, sequential. Do not run next to a Blender bake or another headless browser
// (the owner's PC has had low-memory kills).
const { chromium } = require('playwright-core');
const path = require('path'),
  fs = require('fs');
const args = process.argv.slice(2);
const out = args[0] || 'docs/milestones/F2/lab';
const opt = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).slice(k.length + 3);
const port = opt('port', '5173');
const filter = new RegExp(opt('filter', '.'));
const times = opt('times', '0.05,0.15,0.3,0.6,1.0').split(',').map(Number);
const seed = Number(opt('seed', '1'));
const q = Number(opt('q', '2'));
const bg = opt('bg', 'dark');
const abs = opt('abs', '0') === '1';
const gore = opt('gore', 'standard');
const look = opt('look', 'lab');
const exe = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
  const logs = [];
  page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));
  page.on('console', (m) => m.type() === 'error' && logs.push('CONSOLE ' + m.text()));
  await page.goto(`http://localhost:${port}/tools/fxlab/index.html?pause=1&bg=${bg}&q=${q}&seed=${seed}&gore=${gore}&look=${look}`);
  await page.waitForFunction(() => window.__fxlab && window.__fxlab.ready, null, { timeout: 120000 });
  const items = await page.evaluate(() => window.__fxlab.list());
  const pick = items.filter((i) => i.parts > 0 && filter.test(i.key));
  const report = [];
  for (const it of pick) {
    // play once and give the atlases of any new FX layer time to load (F3: layers bind textures lazily)
    await page.evaluate(async ([k, s, qq, g]) => {
      await window.__fxlab.play(k, { seed: s, q: qq, gore: g });
      window.__fxlab.at(0.3);
    }, [it.key, seed, q, gore]);
    await page.waitForTimeout(400);
    const url = await page.evaluate(async ([k, t, s, qq, a, g]) => {
      await window.__fxlab.play(k, { seed: s, q: qq, gore: g });
      const d = window.__fxlab.durationOf();
      return window.__fxlab.sheet(k, a ? t : t.map((x) => x * d));
    }, [it.key, times, seed, q, abs, gore]);
    const st = await page.evaluate(() => window.__fxlab.stats());
    const file = path.join(out, it.key.replace(/[^a-z0-9._-]+/gi, '_') + (gore !== 'standard' ? '.' + gore : '') + (q !== 2 ? '.q' + q : '') + '.png');
    fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
    report.push({ key: it.key, drawCalls: st.drawCalls, particles: st.fx.particles, frameMs: st.frameMs, atlasFormat: st.atlasFormat, atlasGpuMB: +st.atlasGpuMB.toFixed(1) });
    console.log(it.key, '->', file);
  }
  fs.writeFileSync(path.join(out, 'fxsheet-report.json'), JSON.stringify({ seed, q, bg, times, items: report, errors: logs }, null, 1));
  if (logs.length) console.log(logs.slice(0, 20).join('\n'));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
