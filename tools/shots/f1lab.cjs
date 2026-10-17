// F1 FX Lab sheets: soft vs hard particles, heat shimmer / ripple A/B (+ amplified difference),
// bloom looks per theme, grade presets at 0 / 0.5 / 1. Needs the dev server (npm run dev; stop it after).
//   node tools/shots/f1lab.cjs <outDir> [--port=5173] [--seed=1]
// ONE headless browser, sequential.
const { chromium } = require('playwright-core');
const path = require('path'),
  fs = require('fs');
const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith('--')) || 'docs/milestones/F1/lab';
const opt = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).slice(k.length + 3);
const port = opt('port', '5173');
const seed = Number(opt('seed', '1'));
const exe = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');

const HELPERS = () => {
  const L = window.__fxlab;
  const load = (url) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = url; });
  window.__f1 = {
    /** strip of shots: cells = [{label, setup: {post...}, t}] for one item */
    async strip(key, cells, w = 480) {
      await L.play(key, { seed: window.__seed });
      const imgs = [];
      for (const c of cells) {
        L.setPost(c.setup || {});
        L.at(c.t);
        imgs.push({ img: await load(L.shot()), label: c.label });
      }
      const h = Math.round((w * imgs[0].img.height) / imgs[0].img.width);
      const cv = document.createElement('canvas');
      cv.width = w * imgs.length;
      cv.height = h + 20;
      const g = cv.getContext('2d');
      g.fillStyle = '#000';
      g.fillRect(0, 0, cv.width, cv.height);
      imgs.forEach((x, i) => {
        g.drawImage(x.img, i * w, 0, w, h);
        g.fillStyle = '#ddd';
        g.font = '13px monospace';
        g.fillText(x.label, i * w + 6, h + 15);
      });
      L.setPost({ post: true, soft: true, dist: true, look: 'lab', preset: '', presetW: 1 });
      return cv.toDataURL('image/png');
    },
    /** A/B at one time + |A-B| x gain */
    async diff(key, t, a, b, gain = 8, w = 560) {
      await L.play(key, { seed: window.__seed });
      L.setPost(a);
      L.at(t);
      const A = await load(L.shot());
      L.setPost(b);
      L.at(t);
      const B = await load(L.shot());
      const h = Math.round((w * A.height) / A.width);
      const cv = document.createElement('canvas');
      cv.width = w * 3;
      cv.height = h + 20;
      const g = cv.getContext('2d');
      g.drawImage(A, 0, 0, w, h);
      g.drawImage(B, w, 0, w, h);
      const da = g.getImageData(0, 0, w, h), db = g.getImageData(w, 0, w, h);
      const d = g.createImageData(w, h);
      for (let i = 0; i < d.data.length; i += 4) {
        for (let k = 0; k < 3; k++) d.data[i + k] = Math.min(255, Math.abs(da.data[i + k] - db.data[i + k]) * gain);
        d.data[i + 3] = 255;
      }
      g.putImageData(d, 2 * w, 0);
      g.fillStyle = '#000';
      g.fillRect(0, h, cv.width, 20);
      g.fillStyle = '#ddd';
      g.font = '13px monospace';
      g.fillText(`${key} t=${t}  A: ${JSON.stringify(a)}`, 6, h + 15);
      g.fillText(`B: ${JSON.stringify(b)}`, w + 6, h + 15);
      g.fillText(`|A-B| x${gain}`, 2 * w + 6, h + 15);
      L.setPost({ post: true, soft: true, dist: true, look: 'lab', preset: '', presetW: 1 });
      return cv.toDataURL('image/png');
    },
  };
};

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
  const logs = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
    page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));
    page.on('console', (m) => m.type() === 'error' && logs.push('CONSOLE ' + m.text()));
    await page.goto(`http://localhost:${port}/tools/fxlab/index.html?pause=1&bg=dark&q=2&seed=${seed}`);
    await page.waitForFunction(() => window.__fxlab && window.__fxlab.ready, null, { timeout: 180000 });
    await page.evaluate((s) => (window.__seed = s), seed);
    await page.evaluate(HELPERS);
    const save = (name, url) => fs.writeFileSync(path.join(out, name), Buffer.from(url.split(',')[1], 'base64'));
    const soft = (k, t) => [
      { label: `soft ON  t=${t}`, setup: { soft: true }, t },
      { label: `soft OFF (all hard)  t=${t}`, setup: { soft: false }, t },
    ];
    // soft vs hard (each item also has a hard left / soft right split inside one frame)
    for (const [k, ts] of [['f1.soft.dust', [0.25, 0.6]], ['f1.soft.smoke', [0.5, 1.2]], ['f1.soft.body', [0.4, 1.0]]]) {
      save(`${k.replace(/\./g, '_')}.png`, await page.evaluate(([k, c]) => __f1.strip(k, c), [k, ts.flatMap((t) => soft(k, t))]));
      save(`${k.replace(/\./g, '_')}_diff.png`, await page.evaluate(([k, t]) => __f1.diff(k, t, { soft: true }, { soft: false }, 6), [k, ts[0]]));
    }
    // distortion A/B
    save('f1_heat_brazier_diff.png', await page.evaluate(() => __f1.diff('f1.heat.brazier', 1.3, { dist: true }, { dist: false }, 10)));
    save('f1_heat_explosion_diff.png', await page.evaluate(() => __f1.diff('f1.heat.explosion', 0.18, { dist: true }, { dist: false }, 6)));
    save('f1_ripple_heavy_diff.png', await page.evaluate(() => __f1.diff('f1.ripple.heavy', 0.1, { dist: true }, { dist: false }, 8)));
    save('f1_heat_explosion_strip.png', await page.evaluate(() => __f1.strip('f1.heat.explosion', [0.05, 0.15, 0.3, 0.6, 1.2].map((t) => ({ label: `t=${t}`, t })))));
    // bloom: post off vs lab look vs every theme look, same frame
    const looks = ['lab', 'colosseum', 'skytemple', 'sakura', 'forge', 'glacier', 'moonlake', 'desert'];
    save('f1_bloom_looks_a.png', await page.evaluate((ls) => __f1.strip('f1.bloom', [{ label: 'post OFF (pre-F1 lab)', setup: { post: false }, t: 0.12 }, ...ls.map((l) => ({ label: `look ${l}`, setup: { look: l }, t: 0.12 }))], 360), looks.slice(0, 4)));
    save('f1_bloom_looks_b.png', await page.evaluate((ls) => __f1.strip('f1.bloom', ls.map((l) => ({ label: `look ${l}`, setup: { look: l }, t: 0.12 })), 360), looks.slice(4)));
    // grade presets at 0 / 0.5 / 1 on the forge look
    const presets = ['finisher', 'ultimate', 'lastStand', 'killcam', 'victory', 'impact'];
    for (const p of presets)
      save(`f1_preset_${p}.png`, await page.evaluate((p) => __f1.strip('f1.bloom', [0, 0.5, 1].map((w) => ({ label: `${p} w=${w}`, setup: { look: 'forge', preset: p, presetW: w }, t: 0.12 })), 400), p));
    // tiers on one frame (strip() keeps the quality the last play() set)
    for (const q of [2, 1, 0]) {
      save(`f1_tier_q${q}_explosion.png`, await page.evaluate(async (q) => {
        await __fxlab.play('f1.heat.explosion', { seed: window.__seed, q });
        return __f1.strip('f1.heat.explosion', [0.05, 0.18, 0.5].map((t) => ({ label: `q${q} t=${t}`, t })));
      }, q));
    }
    await page.evaluate(() => __fxlab.play('f1.bloom', { q: 2 }));
    const stats = await page.evaluate(() => __fxlab.stats());
    fs.writeFileSync(path.join(out, 'f1lab-report.json'), JSON.stringify({ logs, stats }, null, 1));
  } finally {
    await browser.close();
  }
  console.log(logs.length ? logs.join('\n') : 'no page errors');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
