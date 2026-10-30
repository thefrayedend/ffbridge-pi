#!/usr/bin/env bash
# Proves the slicer pack works on the board's system: unpacks it inside a Debian bullseye
# (arm64, glibc 2.31 - same as the board image) container at the board's install path, lists the
# Creator 5 Pro presets and slices a two-colour test print.
#   bash pi-bridge/slicer/test-slicer-pack.sh DIR-WITH-PACK
set -euo pipefail
PACK_DIR="$(cd "$1" && pwd)"
HERE="$(cd "$(dirname "$0")" && pwd)"
W="$(mktemp -d)"
trap 'rm -rf "$W"' EXIT
python3 "$HERE/make-test-model.py" "$W/cube.3mf"   # same layout the web page writes (paint + 2 filaments)
docker run --rm -v "$PACK_DIR:/pack:ro" -v "$W:/w:ro" debian:bullseye-slim bash -euc '
  echo "C library in the container: $(ldd --version | head -1)"
  D=/var/lib/ffbridge/slicer/engine
  mkdir -p $D && tar -xzf /pack/ffbridge-slicer-arm64.tar.gz -C $D
  export LD_LIBRARY_PATH=$D/rt:$D/lib
  E=$D/bin/slicer_cli-orcaslicer
  time $E --list-presets --printer "Flashforge Creator 5 Pro 0.4 nozzle" > /tmp/presets.json
  grep -q "0.20mm Standard @FF C5" /tmp/presets.json || { echo "Creator 5 Pro presets missing"; exit 1; }
  if grep -q "Bambu Lab" /tmp/presets.json; then echo "non-Flashforge printer profiles left in the pack"; exit 1; fi
  cp /w/cube.3mf /tmp/cube.3mf
  mkdir -p /tmp/out
  time $E /tmp/cube.3mf --printer-preset "Flashforge Creator 5 Pro 0.4 nozzle" --process-preset "0.20mm Standard @FF C5" \
    --filament-preset "Flashforge PLA Basic @FF C5P" --filament-preset "Flashforge PLA Basic @FF C5P" \
    --filament-colour "#FF0000;#0000FF" --arrange 0 --slice 0 --outputdir /tmp/out --export-3mf plate.gcode.3mf > /tmp/slice.log 2>&1 || { tail -30 /tmp/slice.log; exit 1; }
  G=/tmp/out/plate_1.gcode
  [ -s $G ] || { echo "no G-code written"; tail -30 /tmp/slice.log; exit 1; }
  grep -q "^; estimated printing time" $G
  T1=$(grep -c "^T1" $G || true)
  echo "G-code: $(wc -c < $G) bytes, $(grep -c "^T" $G) tool changes ($T1 to the second head)"
  [ "$T1" -gt 0 ] || { echo "the painted / second-filament part was not printed with the second head"; exit 1; }
  [ -s /tmp/out/plate.gcode.3mf ] || { echo "no sliced project (.gcode.3mf) written"; exit 1; }
  echo "slicer pack OK on bullseye"
'
