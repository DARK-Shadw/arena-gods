// Run an async expression inside a page served by the dev server and print / save the JSON result.
//   node tools/shots/eval.cjs "<path?query>" "<js expression returning a promise or value>" [--out=file.json] [--port=5173] [--wait=__arena]
// e.g. node tools/shots/eval.cjs "/index.html?manual=1" "__arena.animAudit([['gorak','vex']], 1)"
const { chromium } = require('playwright-core');
const path = require('path'),
  fs = require('fs');
const args = process.argv.slice(2);
const opt = (k, d) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const [url, expr] = args.filter((a) => !a.startsWith('--'));
const port = opt('port', '5173');
const waitFor = opt('wait', '__arena');
const exe = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
(async () => {
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: Number(opt('w', 960)), height: Number(opt('h', 540)) } });
  const logs = [];
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning' || /\[audit\]/.test(m.text())) && logs.push(m.text()));
  page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));
  await page.goto(`http://localhost:${port}${url}`);
  await page.waitForFunction((w) => !!window[w], waitFor, { timeout: 180000 });
  const t0 = Date.now();
  const res = await page.evaluate(async (e) => {
    const v = await eval(e);
    return JSON.parse(JSON.stringify(v ?? null));
  }, expr);
  const out = opt('out', null);
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(res, null, 1));
  }
  const txt = JSON.stringify(res);
  console.log(txt.length > 6000 ? txt.slice(0, 6000) + ' …(truncated)' : txt);
  console.log(`[eval] ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (logs.length) console.log('--- console\n' + [...new Set(logs)].slice(0, 25).join('\n'));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
