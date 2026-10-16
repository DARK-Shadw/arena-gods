// node tools/convert/glbstats.cjs public/models/x.glb  -- size breakdown of a GLB
const fs = require('fs');
for (const file of process.argv.slice(2)) {
  const b = fs.readFileSync(file);
  const jl = b.readUInt32LE(12);
  const j = JSON.parse(b.slice(20, 20 + jl).toString());
  const bv = j.bufferViews;
  const used = new Map();
  const tag = (i, t) => { if (i !== undefined && !used.has(i)) used.set(i, t); };
  (j.images || []).forEach((im) => tag(im.bufferView, 'images'));
  (j.animations || []).forEach((a) => a.samplers.forEach((s) => { tag(j.accessors[s.input].bufferView, 'anim'); tag(j.accessors[s.output].bufferView, 'anim'); }));
  const sums = {};
  bv.forEach((v, i) => { const t = used.get(i) || 'mesh/skin'; sums[t] = (sums[t] || 0) + v.byteLength; });
  console.log(file, (b.length / 1e6).toFixed(1) + 'MB', Object.entries(sums).map(([k, v]) => `${k} ${(v / 1e6).toFixed(1)}MB`).join(', '), `images ${(j.images || []).length}`, (j.images||[]).map(i=>i.mimeType[6]).join(''));
}
