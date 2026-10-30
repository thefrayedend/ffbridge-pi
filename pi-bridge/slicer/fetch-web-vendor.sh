#!/usr/bin/env bash
# Puts the 3D libraries the slicer page uses into bridge/web/slicer/vendor (pinned versions,
# checked against known checksums). Run by the GitHub build before the bridge is packed.
#   bash pi-bridge/slicer/fetch-web-vendor.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
V="$HERE/../bridge/web/slicer/vendor"
W="$(mktemp -d)"
trap 'rm -rf "$W"' EXIT
mkdir -p "$V"

get() { # name version sha256
  curl -fsSL --retry 3 -o "$W/$1.tgz" "https://registry.npmjs.org/$1/-/$1-$2.tgz"
  echo "$3  $W/$1.tgz" | sha256sum -c - >/dev/null
  mkdir -p "$W/$1" && tar -xzf "$W/$1.tgz" -C "$W/$1"
}
get three 0.170.0 4a608a355dcaba72e0e5383cdc814303f5b6060b43c238cdf6932dceb699238d
get three-mesh-bvh 0.8.3 be096ff206b7604ca2546687aede3acf861f8b61e50e9be8c49352e31386ed61
get fflate 0.8.2 61fd5061e2fc8e5e3e3129f7f2fec7bd78a313e1bf4becbf1cc1cc9998d141dc

T="$W/three/package"
cp "$T/build/three.module.js" "$V/three.module.js"
for f in controls/OrbitControls.js controls/TransformControls.js loaders/STLLoader.js loaders/OBJLoader.js; do cp "$T/examples/jsm/$f" "$V/"; done
cp "$T/LICENSE" "$V/three-LICENSE.txt"
cp "$W/three-mesh-bvh/package/build/index.module.js" "$V/three-mesh-bvh.js"
cp "$W/three-mesh-bvh/package/LICENSE" "$V/three-mesh-bvh-LICENSE.txt"
cp "$W/fflate/package/esm/browser.js" "$V/fflate.js"
cp "$W/fflate/package/LICENSE" "$V/fflate-LICENSE.txt"
ls -l "$V"
