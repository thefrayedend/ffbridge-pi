#!/bin/bash
# Prints a short fingerprint of everything that only a new SD card image can change
# (system packages, Python packages, AI model, Mainsail, the image layout).
# The board stores it at build time; an update with a different fingerprint asks for a reflash.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cat "$REPO/pi-bridge/image/customize.sh" "$REPO/pi-bridge/image/build-image.sh" \
    "$REPO/pi-bridge/ai/requirements.txt" "$REPO/pi-bridge/ai/fetch-model.sh" \
    "$REPO/android-tv-app/source/assets/mainsail.zip" | sha256sum | cut -c1-16
