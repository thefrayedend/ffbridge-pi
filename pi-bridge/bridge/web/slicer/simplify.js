// "Simplify model" (like OrcaSlicer's): fewer triangles, same shape and the same painting.
//
// Models with millions of triangles (scans, sculpts) are far finer than a 0.4 mm nozzle can
// print, and they slow the browser and the board's slicer down or run it out of memory.
// The model is split into regions of the same paint (colour + supports + seam); every region is
// simplified on its own with its border locked, so colour borders stay exactly where they are and
// no gaps open between regions. Triangles painted finer than one triangle are kept as they are.
// meshoptimizer (MIT) does the edge collapses; it only moves vertices onto existing vertices.
import { MeshoptSimplifier as M } from './vendor/meshopt_simplifier.js';

/** Above this many triangles a model is simplified when it is opened. */
export const SIMPLIFY_AT = 1500000;
/** What it is simplified to. */
export const SIMPLIFY_TO = 1000000;
/** Never move the surface more than this (mm); stops earlier if that is reached first. */
export const MAX_ERROR_MM = 0.05;

/** A paint code for one whole triangle (no subdivision): "", "4", "8", "xC" or "xFC". */
const isLeaf = (c) => c.length <= 1 || (c.length === 2 && c[1] === 'C') || (c.length === 3 && c[1] === 'F' && c[2] === 'C');

/** Same position -> same vertex (exact float match), for a non-indexed triangle list. */
export function weld(pos) {
  const n = pos.length / 3;
  const pu = new Uint32Array(pos.buffer, pos.byteOffset, pos.length);
  let size = 1;
  while (size < n * 2) size *= 2;
  const mask = size - 1;
  const table = new Int32Array(size).fill(-1);
  const index = new Uint32Array(n);
  const verts = new Float32Array(pos.length);
  const vu = new Uint32Array(verts.buffer);
  let nv = 0;
  for (let i = 0; i < n; i++) {
    const a = pu[i * 3], b = pu[i * 3 + 1], c = pu[i * 3 + 2];
    let h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) & mask;
    for (;;) {
      const k = table[h];
      if (k < 0) { table[h] = nv; vu[nv * 3] = a; vu[nv * 3 + 1] = b; vu[nv * 3 + 2] = c; index[i] = nv++; break; }
      if (vu[k * 3] === a && vu[k * 3 + 1] === b && vu[k * 3 + 2] === c) { index[i] = k; break; }
      h = (h + 1) & mask;
    }
  }
  return { index, verts: verts.slice(0, nv * 3) };
}

/**
 * positions: Float32Array, 9 numbers per triangle. paint: {color, supports, seam}, each an array
 * of per-triangle paint codes (or null). Returns the same shape with fewer triangles, plus
 * {before, after, error (mm)}.
 */
export async function simplifyModel(positions, paint, target = SIMPLIFY_TO, maxErr = MAX_ERROR_MM) {
  await M.ready;
  const n = positions.length / 9;
  const ch = ['color', 'supports', 'seam'].map((k) => paint[k] || null);
  const { index, verts } = weld(positions);
  // region per triangle
  const keyOf = new Map(), keys = [];
  const region = new Uint32Array(n);
  const frozen = [];
  for (let t = 0; t < n; t++) {
    const c = ch.map((a) => (a && a[t]) || '');
    if (!c.every(isLeaf)) { region[t] = 0xffffffff; frozen.push(t); continue; }
    const k = c.join('|');
    let r = keyOf.get(k);
    if (r === undefined) { r = keys.length; keyOf.set(k, r); keys.push(c); }
    region[t] = r;
  }
  const counts = new Uint32Array(keys.length);
  for (let t = 0; t < n; t++) if (region[t] !== 0xffffffff) counts[region[t]]++;
  const lists = keys.map((_, r) => new Uint32Array(counts[r] * 3));
  const fill = new Uint32Array(keys.length);
  for (let t = 0; t < n; t++) {
    const r = region[t];
    if (r === 0xffffffff) continue;
    const o = fill[r]++ * 3;
    lists[r][o] = index[t * 3]; lists[r][o + 1] = index[t * 3 + 1]; lists[r][o + 2] = index[t * 3 + 2];
  }
  const ratio = Math.min(1, Math.max(0, target - frozen.length) / Math.max(1, n - frozen.length));
  let worst = 0;
  const outs = lists.map((idx, r) => {
    if (ratio >= 1 || idx.length < 300) return idx;
    const want = Math.max(3, Math.round((idx.length / 3) * ratio) * 3);
    const [res, err] = M.simplify(idx, verts, 3, want, maxErr, ['LockBorder', 'Sparse', 'ErrorAbsolute']);
    if (err > worst) worst = err;
    return res;
  });
  const after = outs.reduce((s, a) => s + a.length / 3, 0) + frozen.length;
  const out = new Float32Array(after * 9);
  const codes = ch.map((a) => (a ? new Array(after) : null));
  let tri = 0;
  outs.forEach((idx, r) => {
    for (let i = 0; i < idx.length; i += 3) {
      for (let j = 0; j < 3; j++) { const v = idx[i + j]; out[tri * 9 + j * 3] = verts[v * 3]; out[tri * 9 + j * 3 + 1] = verts[v * 3 + 1]; out[tri * 9 + j * 3 + 2] = verts[v * 3 + 2]; }
      codes.forEach((a, c) => { if (a) a[tri] = keys[r][c]; });
      tri++;
    }
  });
  for (const t of frozen) {
    out.set(positions.subarray(t * 9, t * 9 + 9), tri * 9);
    codes.forEach((a, c) => { if (a) a[tri] = ch[c][t] || ''; });
    tri++;
  }
  return { positions: out, color: codes[0], supports: codes[1], seam: codes[2], before: n, after, error: worst };
}
