// Frame-time breakdown probe: toggles post passes / shadows / crowd on a built arena.
//   node tools/shots/perfprobe.cjs theme:layout:aseed [--w=1280 --h=720]
const { chromium } = require('playwright-core');
const path = require('path'),
  fs = require('fs');
const args = process.argv.slice(2);
const spec = args.find((a) => !a.startsWith('--')) || 'colosseum:oval:7';
const opt = (k, d) => {
  const a = args.find((x) => x.startsWith(`--${k}`));
  return a ? a.split('=')[1] : d;
};
const W = Number(opt('w', 1280)),
  H = Number(opt('h', 720));
const DIST = path.resolve(__dirname, '../../dist');
const exe = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary' };
(async () => {
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  await page.route('http://arena.local/**', (route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\//, '') || 'index.html';
    const p = path.join(DIST, rel);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) route.fulfill({ path: p, contentType: MIME[path.extname(p)] || 'application/octet-stream' });
    else route.fulfill({ status: 404, body: '' });
  });
  const [theme, layout, aseed] = spec.split(':');
  await page.goto(`http://arena.local/index.html?manual=1&auto=1&skip=1&a=gorak&b=erika&seed=4242&theme=${theme}&layout=${layout}&aseed=${aseed}&q=2`);
  await page.waitForFunction(() => window.__arena && window.__arena.state === 'fight', null, { timeout: 120000 });
  await page.evaluate(() => __arena.debugSeekFight(20));
  const run = async (label, fn) => {
    await page.evaluate(fn);
    const r = await page.evaluate(() => __arena.bench(60));
    console.log(label.padEnd(28), JSON.stringify(r));
  };
  await run('full high', () => {});
  await run('- god rays', () => (__arena.post.rays.uniforms.strength.value = 0, __arena.post.setLook({ ...__arena.arena.theme, godrays: 0, sunDir: __arena.arena.theme.sky.sunDir })));
  await run('- AO', () => (__arena.post.quality = 1));
  await run('- bloom', () => (__arena.post.bloom.enabled = false));
  await run('- shadows', () => (__arena.renderer.shadowMap.enabled = false));
  await run('- ambient particles', () => (__arena.arena.ambient.group.visible = false));
  await run('- backdrop/stands', () => __arena.arena.group.children.forEach((c) => { if (c.isInstancedMesh) c.visible = false; }));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
