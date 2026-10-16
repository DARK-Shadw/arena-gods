// Offline converter runner: node tools/convert/run.cjs tools/convert/task_convert.cjs (needs 'npm run dev' on :5173 and playwright-core + Chromium)
const { chromium } = require('playwright-core');
const path = require('path'), fs = require('fs');
const exe = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const ASSETS = 'C:/Programming/GameDev/Research/Assets';
(async () => {
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--enable-gpu', '--use-angle=d3d11'] });
  const page = await browser.newPage();
  page.on('console', (m) => console.log('[page]', m.text()));
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.route('**/src-assets/**', (route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/src-assets\//, ''));
    const p = path.join(ASSETS, rel);
    if (fs.existsSync(p)) route.fulfill({ path: p });
    else { console.log('[404]', rel); route.fulfill({ status: 404, body: '' }); }
  });
  await page.exposeFunction('saveFile', (name, b64) => { fs.mkdirSync(path.dirname(name), { recursive: true }); fs.writeFileSync(name, Buffer.from(b64, 'base64')); return true; });
  await page.goto('http://localhost:5173/tools/convert/index.html');
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const task = require(path.resolve(process.argv[2]));
  await task(page);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
