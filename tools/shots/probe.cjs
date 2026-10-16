// Evaluate an expression in the built app after a match is set up (debug helper).
//   node tools/shots/probe.cjs "<query string>" "<js expression returning JSON-able>"
const { chromium } = require('playwright-core');
const path = require('path'),
  fs = require('fs');
const [qs, expr, shot] = process.argv.slice(2);
const DIST = path.resolve(__dirname, '../../dist');
const exe = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary' };
(async () => {
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--enable-gpu', '--use-angle=d3d11'] });
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  page.on('console', (m) => /error|warn/i.test(m.text()) && console.log('[page]', m.text()));
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.route('http://arena.local/**', (route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\//, '') || 'index.html';
    const p = path.join(DIST, rel);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) route.fulfill({ path: p, contentType: MIME[path.extname(p)] || 'application/octet-stream' });
    else route.fulfill({ status: 404, body: '' });
  });
  await page.goto(`http://arena.local/index.html?manual=1&auto=1&skip=1&${qs}`);
  await page.waitForFunction(() => window.__arena && window.__arena.state === 'fight', null, { timeout: 120000 });
  const r = await page.evaluate(expr);
  console.log(JSON.stringify(r, null, 1));
  if (shot) await page.screenshot({ path: shot });
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
