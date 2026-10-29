#!/bin/bash
# Builds the one-click update package (ffbridge-update.tar.gz + ffbridge-update.json).
#   bash pi-bridge/image/make-update.sh --bridge-bin pibridge --version 1.0.12 --out out
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; PIB="$(cd "$HERE/.." && pwd)"
BIN=""; VERSION=""; OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --bridge-bin) BIN="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "unknown option $1"; exit 1 ;;
  esac
done
[ -f "$BIN" ] && [ -n "$VERSION" ] && [ -n "$OUT" ] || { echo "usage: make-update.sh --bridge-bin FILE --version X --out DIR"; exit 1; }
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
install -d "$STAGE/opt/ffbridge/bin" "$STAGE/opt/ffbridge/ai" "$STAGE/opt/ffbridge/setup-web"
install -m 755 "$BIN" "$STAGE/opt/ffbridge/bin/pibridge"
cp -a "$PIB/bridge/web/." "$STAGE/opt/ffbridge/setup-web/"
install -m 644 "$PIB/ai/ffai_server.py" "$PIB/ai/requirements.txt" "$STAGE/opt/ffbridge/ai/"
echo "$VERSION" > "$STAGE/opt/ffbridge/VERSION"
(cd "$HERE/rootfs" && find . -name __pycache__ -prune -o -type f -print | sed 's#^\./##' | while read -r f; do
  install -D -m "$(stat -c %a "$f")" "$f" "$STAGE/$f"; done)
chmod 755 "$STAGE/usr/local/sbin/ffbridge-helper" 2>/dev/null || true
mkdir -p "$OUT"
tar -C "$STAGE" --owner=0 --group=0 -czf "$OUT/ffbridge-update.tar.gz" .
SHA="$(sha256sum "$OUT/ffbridge-update.tar.gz" | cut -d' ' -f1)"
python3 - "$OUT/ffbridge-update.json" "$VERSION" "$SHA" "$(bash "$HERE/image-hash.sh")" "$PIB/RELEASE-NOTES.md" <<'PY'
import json, sys, time
out, version, sha, image_hash, notes = sys.argv[1:6]
whats_new = ""
text = open(notes, encoding="utf-8").read()
if "## What's new" in text:
    whats_new = text.split("## What's new", 1)[1].split("\n## ", 1)[0].strip()
json.dump({"version": version, "sha256": sha, "imageHash": image_hash, "replaceDirs": ["opt/ffbridge/setup-web"],
           "built": time.strftime("%Y-%m-%d"), "notes": whats_new[:2000]}, open(out, "w"), indent=1)
PY
echo "update package: $OUT/ffbridge-update.tar.gz ($VERSION)"
