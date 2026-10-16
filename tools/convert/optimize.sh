#!/usr/bin/env sh
# Post-process converted GLBs: meshopt compression (quantize + compress), dedup, resample.
# Textures are already resized by convert.ts. Runtime needs MeshoptDecoder.
set -e
cd "$(dirname "$0")/../.."
for f in public/models/*.glb; do
  npx gltf-transform optimize "$f" "$f.tmp.glb" --compress meshopt --texture-compress false --simplify false --join false --flatten false --instance false --palette false > /dev/null
  mv "$f.tmp.glb" "$f"
done
node tools/convert/glbstats.cjs public/models/*.glb
