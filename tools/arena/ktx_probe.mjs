// A0 probe: KTX-Software detection + gltf-transform compression of the probe GLB (plan 5.8).
//   node tools/arena/ktx_probe.mjs <outDir> [inputGlb]
// Finds `ktx` (KTX-Software 4.3+ / 5.x; gltf-transform 4.x calls `ktx create`, not the old `toktx`) on
// PATH or in C:\Program Files\KTX-Software\bin or tools/bin/ktx, then runs meshopt, uastc (+zstd),
// etc1s and webp on the GLB, plus `ktx create` directly on the baked PNGs (the path that works with
// KTX-Software 5.0: gltf-transform 4.x passes the 4.x-only flag --assign-oetf), and writes ktx_probe.json.
// Exported helper for later milestones: findKtx() returns { exe, dir, version } or null.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require_spawn = (exe, args, env) => {
  const r = spawnSync(exe, args, { env, encoding: 'utf8' });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function findKtx() {
  const cands = [];
  try {
    const w = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['ktx'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    cands.push(...w.split(/\r?\n/).filter(Boolean));
  } catch {}
  cands.push('C:\\Program Files\\KTX-Software\\bin\\ktx.exe', path.join(ROOT, 'tools', 'bin', 'ktx', 'bin', 'ktx.exe'), path.join(ROOT, 'tools', 'bin', 'ktx', 'ktx.exe'));
  for (const exe of cands) {
    if (!fs.existsSync(exe)) continue;
    try {
      const v = execFileSync(exe, ['--version'], { encoding: 'utf8' }).trim();
      return { exe, dir: path.dirname(exe), version: v };
    } catch {}
  }
  return null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.resolve(process.argv[2] || path.join(ROOT, 'tools/arena/_bake/ktx_probe'));
  const input = path.resolve(process.argv[3] || path.join(ROOT, 'tools/arena/_bake/probe_bake_1024/probe_pillar.glb'));
  fs.mkdirSync(out, { recursive: true });
  const k = findKtx();
  const res = { ktx: k, input, inputBytes: fs.existsSync(input) ? fs.statSync(input).size : null, runs: {} };
  const cli = path.join(ROOT, 'node_modules', '@gltf-transform', 'cli', 'bin', 'cli.js');
  const env = { ...process.env, PATH: (k ? k.dir + path.delimiter : '') + process.env.PATH };
  const run = (name, args, from) => {
    const dst = path.join(out, `${name}.glb`);
    const t = Date.now();
    try {
      const r = require_spawn(process.execPath, [cli, ...args.slice(0, 1), from, dst, ...args.slice(1), '--verbose'], env);
      // gltf-transform 4.x exits 0 even when every texture failed to encode: look at its log
      const failed = /error:|Failed/.test(r.out);
      res.runs[name] = { ok: r.status === 0 && !failed && fs.existsSync(dst), bytes: fs.existsSync(dst) ? fs.statSync(dst).size : null, seconds: (Date.now() - t) / 1000, log: failed ? r.out.split(/\r?\n/).filter((l) => /error|fatal|Failed/.test(l)).slice(0, 4) : undefined };
    } catch (e) {
      res.runs[name] = { ok: false, error: String(e.stderr || e.message).slice(0, 600), seconds: (Date.now() - t) / 1000 };
    }
    console.log(name, JSON.stringify(res.runs[name]));
    return dst;
  };
  if (!fs.existsSync(input)) {
    res.error = 'input GLB missing (run the probe_bake_1024 job first)';
  } else {
    const mo = run('meshopt', ['meshopt'], input);
    run('uastc', ['uastc', '--level', '2', '--zstd', '18'], mo);
    run('etc1s', ['etc1s', '--quality', '128'], mo);
    run('webp', ['webp'], mo);
    // direct `ktx create` (KTX-Software 5.x syntax: --assign-tf, not 4.x's --assign-oetf that gltf-transform 4.x passes)
    if (k) {
      const dir = path.dirname(input);
      const pngs = fs.readdirSync(dir).filter((f) => f.endsWith('.png'));
      res.direct = {};
      for (const f of pngs) {
        const normal = /normal/.test(f);
        const dst = path.join(out, f.replace('.png', '.ktx2'));
        const args = normal
          ? ['create', '--format', 'R8G8B8_UNORM', '--assign-tf', 'linear', '--encode', 'uastc', '--uastc-quality', '2', '--zstd', '18', '--generate-mipmap', path.join(dir, f), dst]
          : ['create', '--format', 'R8G8B8_SRGB', '--assign-tf', 'srgb', '--encode', 'basis-lz', '--qlevel', '128', '--generate-mipmap', path.join(dir, f), dst];
        const t = Date.now();
        const r = require_spawn(k.exe, args, process.env);
        res.direct[f] = { ok: r.status === 0 && fs.existsSync(dst), codec: normal ? 'uastc+zstd18' : 'basis-lz (etc1s)', pngBytes: fs.statSync(path.join(dir, f)).size, ktx2Bytes: fs.existsSync(dst) ? fs.statSync(dst).size : null, seconds: (Date.now() - t) / 1000, err: r.status ? r.out.slice(0, 200) : undefined };
      }
    }
    // KTX2 container check of the UASTC output's first texture
    try {
      const inspect = execFileSync(process.execPath, [cli, 'inspect', path.join(out, 'uastc.glb'), '--format', 'md'], { env, encoding: 'utf8' });
      res.inspectUastc = inspect.split('\n').filter((l) => /image\/ktx2|KHR_texture_basisu|EXT_meshopt/.test(l)).slice(0, 8);
    } catch (e) {
      res.inspectUastc = String(e.message).slice(0, 300);
    }
  }
  fs.writeFileSync(path.join(out, 'ktx_probe.json'), JSON.stringify(res, null, 1));
  console.log(k ? `ktx found: ${k.exe} (${k.version})` : 'ktx NOT found: WebP fallback only');
}
