#!/usr/bin/env bash
# Runs every FX bake ONE AT A TIME (memory safety on the owner's PC), then packs.
# Usage: bash tools/fx/bake_all.sh [--engine cycles] [extra args passed to every bake]
# Env: BLENDER=path/to/blender.exe (default: Blender 5.0 install path)
set -u
cd "$(dirname "$0")/../.."
BLENDER="${BLENDER:-/c/Program Files/Blender Foundation/Blender 5.0/blender.exe}"
OUT=tools/fx/_bake
LOG=$OUT/bake.log
mkdir -p "$OUT"
run() {  # id script [args...]
  local id=$1; shift; local script=$1; shift
  if [ -f "$OUT/$id/bake.json" ] && [ "${FORCE:-0}" != 1 ]; then echo "skip $id (bake.json exists; FORCE=1 to redo)"; return; fi
  echo "=== $id $(date +%T)" | tee -a "$LOG"
  for try in 1 2; do
    "$BLENDER" -b --factory-startup -P "tools/fx/blender/$script" -- --out "$OUT/$id" "$@" "${EXTRA[@]}" 2>&1 \
      | grep -E "fxbake|Error|Traceback" | tee -a "$LOG"
    [ -f "$OUT/$id/bake.json" ] && return
    echo "!! $id failed (try $try); waiting 30 s before retry" | tee -a "$LOG"; sleep 30
  done
}
EXTRA=("$@")
run fire_loop    bake_fire_loop.py
run fire_burst   bake_fireball.py --kind burst
run explosion    bake_fireball.py --kind explosion
run smoke_wisp   bake_smoke_wisp.py
run dust_puff    bake_dust.py --kind puff
run dust_ring    bake_dust.py --kind ring
run splash       bake_liquid.py --kind splash
run blood_spray  bake_liquid.py --kind blood
run embers       bake_embers.py
run energy_swirl bake_energy.py
echo "=== bakes done $(date +%T)" | tee -a "$LOG"
