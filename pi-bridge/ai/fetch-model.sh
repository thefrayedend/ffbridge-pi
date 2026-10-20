#!/bin/bash
# Downloads Obico's failure-detection model (ONNX, ~200 MB) and checks its SHA-256.
# URL and checksum come from obico-server/ml_api/model/model-weights.onnx.{url,sha256}.
# Usage: fetch-model.sh <output-file>
set -euo pipefail
OUT="${1:-model-weights.onnx}"
URL="${OBICO_ONNX_URL:-https://www.obico.io/static_pub/ml-models/model-weights-5a6b1be1fa.onnx}"
SHA="${OBICO_ONNX_SHA256:-0a6ebd8e30dbf6a450c50f9c0a5406f04ba7eb1c99fd5996e888c78bb383b9aa}"

if [ -f "$OUT" ] && echo "$SHA  $OUT" | sha256sum -c --status; then
  echo "Model already present: $OUT"
  exit 0
fi
mkdir -p "$(dirname "$OUT")"
echo "Downloading $URL"
curl -fL --retry 5 --retry-delay 5 -o "$OUT.part" "$URL"
echo "$SHA  $OUT.part" | sha256sum -c -
mv "$OUT.part" "$OUT"
echo "Saved $OUT ($(du -h "$OUT" | cut -f1))"
