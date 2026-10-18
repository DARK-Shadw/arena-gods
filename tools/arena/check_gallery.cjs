// A3 kit gallery screenshots: starts Vite's dev server IN THIS PROCESS (closed at the end), opens the gallery page
// (tools/arena/gallery/) in ONE headless Chromium per tier and writes one screenshot per camera view.
//   node tools/arena/check_gallery.cjs [--out=docs/milestones/A3/gallery] [--tiers=full,low] [--w=1600] [--h=900]
// Memory: one browser, one page at a time; never run together with a Blender job.
const { chromium } = require('playwright-core');
const path = require('path'),
  fs = require('fs');
const ROOT = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
const opt = (k, d) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const OUT = path.resolve(opt('out', path.join(ROOT, 'docs/milestones/A3/gallery')));
const TIERS = opt('tiers', 'full,low').split(',');
const W = Number(opt('w', '1600')),
  H = Number(opt('h', '900'));
const exe = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { createServer } = await import('vite');
  const server = await createServer({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), server: { port: 5199, strictPort: false }, logLevel: 'error' });
  await server.listen();
  const port = server.config.server.port;
  const url = server.resolvedUrls?.local?.[0] ?? `http://localhost:${port}/`;
  let browser;
  const report = {};
  try {
    browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
    for (const tier of TIERS) {
      const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 300)));
      await page.goto(`${url}tools/arena/gallery/index.html?tier=${tier}&still=1`);
      await page.waitForFunction(() => window.__gallery && window.__gallery.ready, null, { timeout: 180000 });
      const views = await page.evaluate(() => window.__gallery.views);
      for (let i = 0; i < views.length; i++) {
        await page.evaluate((k) => window.__gallery.setView(k), i);
        await page.waitForTimeout(300);
        await page.evaluate(() => window.__gallery.render());
        const f = path.join(OUT, `${tier}_${i}_${views[i]}.jpg`);
        await page.screenshot({ path: f, type: 'jpeg', quality: 88 });
        console.log('wrote', path.relative(ROOT, f));
      }
      report[tier] = { info: await page.evaluate(() => window.__gallery.info), errors };
      await ctx.close();
    }
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
  fs.writeFileSync(path.join(OUT, 'gallery.json'), JSON.stringify(report, null, 1));
  console.log(JSON.stringify(report, null, 1).slice(0, 2000));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
