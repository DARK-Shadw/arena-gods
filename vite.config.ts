import { defineConfig, type Plugin } from 'vite';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * DEV ONLY: serve the original source FBX files (../Assets, read-only) under
 * /src-assets/ so the Animation Lab (tools/animlab/) can preview any of the
 * catalogued clips on any fighter. Never part of a build.
 */
function srcAssets(): Plugin {
  const root = path.resolve(__dirname, '../Assets');
  return {
    name: 'src-assets',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/src-assets/', (req, res, next) => {
        if (req.method !== 'GET' || !req.url) return next();
        const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
        const p = path.resolve(root, rel);
        if (!p.startsWith(root + path.sep) || !/\.(fbx|json)$/i.test(p) || !fs.existsSync(p)) {
          res.statusCode = 404;
          return res.end();
        }
        res.setHeader('Content-Type', 'application/octet-stream');
        fs.createReadStream(p).pipe(res);
      });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [srcAssets()],
  build: { target: 'es2020', chunkSizeWarningLimit: 1200 },
});
