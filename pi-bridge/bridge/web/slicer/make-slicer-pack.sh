#!/usr/bin/env bash
# Builds the slicer engine pack the board downloads when someone switches the slicer on
# (Settings -> General -> Slicer). Runs on GitHub's ubuntu-24.04-arm runner.
#
#   bash pi-bridge/slicer/make-slicer-pack.sh --out DIR
#
# The engine is Helio Additive's slicer-cli (the OrcaSlicer engine as a command-line program,
# AGPL-3.0). It needs a newer C library (glibc 2.35) than the board's Debian bullseye (2.31),
# so the pack carries the runner's own C library in rt/ and the engine program is pointed at
# that loader. Nothing on the board's system is changed: it all lives in
# /var/lib/ffbridge/slicer/engine.
#
# Only the Flashforge printer profiles (plus Orca's generic filament library they build on)
# are kept: the slicer can only ever pick Flashforge profiles, and the engine starts ~6x faster.
set -euo pipefail

ENGINE_VERSION="v0.1.0-dev-19"
ENGINE_URL="https://github.com/Helio-Additive/slicer-cli/releases/download/slicer-cli/${ENGINE_VERSION}/slicer-cli-${ENGINE_VERSION}-linux-arm64.tar.gz"
ENGINE_SHA256="41f35cfd8bf767fab3af6f869de96b7bd906fefc9967e3517286ade17dec7eca"
# Where the board unpacks it (the bridge's data folder). The loader path is baked into the program.
INSTALL_DIR="/var/lib/ffbridge/slicer/engine"

OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[ -n "$OUT" ] || { echo "usage: $0 --out DIR" >&2; exit 2; }
[ "$(uname -m)" = aarch64 ] || { echo "must run on arm64 (the runtime is copied from this machine)" >&2; exit 1; }
command -v patchelf >/dev/null || { echo "patchelf is needed (apt-get install patchelf)" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT"

echo "== download engine $ENGINE_VERSION"
curl -fsSL --retry 3 -o "$WORK/engine.tgz" "$ENGINE_URL"
echo "$ENGINE_SHA256  $WORK/engine.tgz" | sha256sum -c -
tar -xzf "$WORK/engine.tgz" -C "$WORK"
E="$(find "$WORK" -mindepth 1 -maxdepth 1 -type d | head -1)"
[ -x "$E/bin/slicer_cli-orcaslicer" ] || { echo "engine program not found in the download" >&2; exit 1; }

echo "== trim to the OrcaSlicer engine and Flashforge profiles"
rm -f "$E/bin/slicer_cli"                 # the BambuStudio engine, not used
rm -rf "$E/resources/profiles"            # BambuStudio's profiles
P="$E/resources/profiles-orca"
find "$P" -mindepth 1 -maxdepth 1 -print0 | while IFS= read -r -d '' f; do
  b="$(basename "$f")"
  case "$b" in
    Flashforge|Flashforge.json|OrcaFilamentLibrary|OrcaFilamentLibrary.json|blacklist.json) ;;
    *) if [ -d "$f" ] || [[ "$b" == *.json ]]; then rm -rf "$f"; fi ;;
  esac
done
ls "$P"

echo "== C library for the engine (from this runner: $(ldd --version | head -1))"
mkdir -p "$E/rt"
for l in ld-linux-aarch64.so.1 libc.so.6 libm.so.6 libpthread.so.0 libdl.so.2 librt.so.1 libresolv.so.2 libutil.so.1 libanl.so.1; do
  src="/lib/aarch64-linux-gnu/$l"
  [ -e "$src" ] && cp -L "$src" "$E/rt/$l"
done
cp /usr/share/doc/libc6/copyright "$E/rt/GLIBC-COPYRIGHT.txt" 2>/dev/null || true
patchelf --set-interpreter "$INSTALL_DIR/rt/ld-linux-aarch64.so.1" "$E/bin/slicer_cli-orcaslicer"
cat > "$E/FFBRIDGE.txt" <<EOF
OrcaSlicer engine for FlashForge Bridge
Engine: Helio Additive slicer-cli $ENGINE_VERSION (OrcaSlicer 2.4 engine), AGPL-3.0-or-later.
Source: https://github.com/Helio-Additive/slicer-cli  (this pack: trimmed to Flashforge profiles,
program loader set to $INSTALL_DIR/rt, C library from Ubuntu 24.04 in rt/ - LGPL, see rt/GLIBC-COPYRIGHT.txt)
EOF
echo "$ENGINE_VERSION" > "$E/VERSION"

echo "== pack"
tar -C "$E" -czf "$OUT/ffbridge-slicer-arm64.tar.gz" .
SHA="$(sha256sum "$OUT/ffbridge-slicer-arm64.tar.gz" | cut -d' ' -f1)"
SIZE="$(stat -c %s "$OUT/ffbridge-slicer-arm64.tar.gz")"
UNPACKED="$(du -sb "$E" | cut -f1)"
cat > "$OUT/ffbridge-slicer.json" <<EOF
{"engine": "$ENGINE_VERSION", "file": "ffbridge-slicer-arm64.tar.gz", "sha256": "$SHA", "size": $SIZE, "unpacked": $UNPACKED}
EOF
cat "$OUT/ffbridge-slicer.json"
