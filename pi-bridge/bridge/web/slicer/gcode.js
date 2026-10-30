// G-code -> printed paths for the layer preview.
// Every extruding move becomes one segment: start/end XY, Z, layer height, tool and feature type.

export const FEATURES = [
  ['Outer wall', '#ff8a00'], ['Inner wall', '#ffd400'], ['Overhang wall', '#2f6bff'], ['Sparse infill', '#b0262d'],
  ['Internal solid infill', '#c03fc8'], ['Top surface', '#ff4d4d'], ['Bottom surface', '#5f9b5f'], ['Bridge', '#4fa3c7'],
  ['Gap infill', '#ffffff'], ['Support', '#2cb67d'], ['Support interface', '#1f7a55'], ['Brim / skirt', '#00a6a6'],
  ['Prime tower', '#7a8ba0'], ['Ironing', '#ff7fbf'], ['Other', '#9aa0a8'],
];
const FEATURE_OF = {
  'outer wall': 0, 'external perimeter': 0, 'inner wall': 1, 'perimeter': 1, 'overhang wall': 2, 'overhang perimeter': 2,
  'sparse infill': 3, 'internal infill': 3, 'internal solid infill': 4, 'solid infill': 4, 'top surface': 5, 'top solid infill': 5,
  'bottom surface': 6, 'bridge': 7, 'internal bridge': 7, 'bridge infill': 7, 'gap infill': 8, 'support': 9, 'support material': 9,
  'support interface': 10, 'support material interface': 10, 'support transition': 10, 'brim': 11, 'skirt': 11, 'skirt/brim': 11,
  'prime tower': 12, 'wipe tower': 12, 'ironing': 13,
};

/**
 * Parses G-code text. Returns {count, seg: Float32Array(count*7: x0,y0,x1,y1,z,h,w),
 * tool: Uint8Array, feature: Uint8Array, layerEnd: Uint32Array (segments up to and incl. layer i),
 * layerZ: Float32Array, bounds}.
 */
export function parseGcode(text, { onProgress } = {}) {
  let cap = 1 << 16, count = 0;
  let seg = new Float32Array(cap * 7), tool = new Uint8Array(cap), feat = new Uint8Array(cap);
  const grow = () => {
    cap *= 2;
    const s = new Float32Array(cap * 7); s.set(seg); seg = s;
    const t = new Uint8Array(cap); t.set(tool); tool = t;
    const f = new Uint8Array(cap); f.set(feat); feat = f;
  };
  const layerEnd = [], layerZ = [];
  let x = 0, y = 0, z = 0, e = 0, relE = true, absXY = true, t = 0, ft = 14, h = 0.2, w = 0.45, lastZ = -1;
  let layerOpen = false;
  const closeLayer = () => { if (layerOpen && count > (layerEnd.length ? layerEnd[layerEnd.length - 1] : 0)) { layerEnd.push(count); layerZ.push(lastZ); } layerOpen = false; };
  const len = text.length;
  let pos = 0, lines = 0;
  while (pos < len) {
    let nl = text.indexOf('\n', pos);
    if (nl < 0) nl = len;
    const c0 = text.charCodeAt(pos);
    if (c0 === 59) { // ';' comment
      if (text.startsWith(';TYPE:', pos)) {
        const name = text.slice(pos + 6, nl).trim().toLowerCase();
        ft = FEATURE_OF[name] ?? 14;
      } else if (text.startsWith(';LAYER_CHANGE', pos)) closeLayer();
      else if (text.startsWith(';HEIGHT:', pos)) h = parseFloat(text.slice(pos + 8, nl)) || h;
      else if (text.startsWith(';WIDTH:', pos)) w = parseFloat(text.slice(pos + 7, nl)) || w;
    } else if (c0 === 71) { // 'G'
      const sc = text.indexOf(';', pos);
      const line = text.slice(pos, sc >= 0 && sc < nl ? sc : nl);
      const code = parseInt(line.slice(1), 10);
      if (code === 0 || code === 1 || code === 2 || code === 3) {
        let nx = x, ny = y, nz = z, ne = null, ii = null, jj = null;
        const parts = line.split(' ');
        for (let k = 1; k < parts.length; k++) {
          const p = parts[k];
          if (!p) continue;
          const v = parseFloat(p.slice(1));
          switch (p.charCodeAt(0)) {
            case 88: nx = absXY ? v : x + v; break;
            case 89: ny = absXY ? v : y + v; break;
            case 90: nz = absXY ? v : z + v; break;
            case 69: ne = v; break;
            case 73: ii = v; break;
            case 74: jj = v; break;
          }
        }
        const de = ne === null ? 0 : (relE ? ne : ne - e);
        if (ne !== null && !relE) e = ne;
        if (de > 0 && (nx !== x || ny !== y)) {
          if (nz !== lastZ || !layerOpen) {
            if (layerOpen && nz > lastZ + 1e-4) closeLayer();
            lastZ = nz; layerOpen = true;
          }
          const add = (ax, ay, bx, by) => {
            if (count >= cap) grow();
            const o = count * 7;
            seg[o] = ax; seg[o + 1] = ay; seg[o + 2] = bx; seg[o + 3] = by; seg[o + 4] = nz; seg[o + 5] = h; seg[o + 6] = w;
            tool[count] = t; feat[count] = ft; count++;
          };
          if ((code === 2 || code === 3) && ii !== null && jj !== null) {
            const cx = x + ii, cy = y + jj, r = Math.hypot(ii, jj);
            let a0 = Math.atan2(y - cy, x - cx), a1 = Math.atan2(ny - cy, nx - cx);
            if (code === 3 && a1 <= a0) a1 += 2 * Math.PI;
            if (code === 2 && a1 >= a0) a1 -= 2 * Math.PI;
            const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) * r / 1.0));
            let px = x, py = y;
            for (let k = 1; k <= n; k++) {
              const a = a0 + (a1 - a0) * k / n;
              const qx = k === n ? nx : cx + r * Math.cos(a), qy = k === n ? ny : cy + r * Math.sin(a);
              add(px, py, qx, qy); px = qx; py = qy;
            }
          } else add(x, y, nx, ny);
        }
        x = nx; y = ny; z = nz;
      } else if (code === 90) absXY = true;
      else if (code === 91) absXY = false;
      else if (code === 92) { const m = /E(-?[\d.]+)/.exec(line); if (m) e = parseFloat(m[1]); }
    } else if (c0 === 77) { // 'M'
      if (text.startsWith('M82', pos)) relE = false;
      else if (text.startsWith('M83', pos)) relE = true;
    } else if (c0 === 84) { // 'T'
      const n = parseInt(text.slice(pos + 1, nl), 10);
      if (n >= 0 && n < 64) t = n;
    }
    pos = nl + 1;
    if (onProgress && (++lines & 0x3ffff) === 0) onProgress(pos / len);
  }
  closeLayer();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = 0;
  for (let i = 0; i < count; i++) {
    const o = i * 7;
    minX = Math.min(minX, seg[o], seg[o + 2]); maxX = Math.max(maxX, seg[o], seg[o + 2]);
    minY = Math.min(minY, seg[o + 1], seg[o + 3]); maxY = Math.max(maxY, seg[o + 1], seg[o + 3]);
    maxZ = Math.max(maxZ, seg[o + 4]);
  }
  return {
    count, seg: seg.subarray(0, count * 7), tool: tool.subarray(0, count), feature: feat.subarray(0, count),
    layerEnd: Uint32Array.from(layerEnd), layerZ: Float32Array.from(layerZ), bounds: { minX, minY, maxX, maxY, maxZ },
  };
}
