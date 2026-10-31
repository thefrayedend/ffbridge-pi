// 3MF in and out for the slicer page.
//
// Painting works the way OrcaSlicer stores it: every triangle of the model can carry a small
// subdivision tree ("paint_color" attribute, TriangleSelector format) saying which filament
// covers which part of the triangle. In the browser each model triangle is split evenly
// 4^level times (level per triangle, depending on its size); paint is kept per small piece and
// written back as a tree on the ORIGINAL triangle, so the model itself is never altered.
//
// Import keeps the geometry, per-part filaments and painting of a project and deliberately
// ignores its printer, process and filament settings (the open printer's profiles are used).
import { unzipSync, zipSync, strFromU8, strToU8 } from './vendor/fflate.js'; // relative, not the page's import map: this file also runs in work.js

// ------------------------------------------------------------------ subdivision (shared with Orca)
// Split of a triangle [a,b,c] into 4: corners a, b, c, then the middle one.
export function split4(a, b, c) {
  const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
  return [[a, ab, ca], [ab, b, bc], [bc, c, ca], [ab, bc, ca]];
}
const mid = (p, q) => p.map((x, i) => (x + q[i]) / 2);

// Orca's split for 1-3 extra children (used only when reading trees made by Orca / Bambu).
function splitN(v, count, side) {
  const [a, b, c] = [v[side], v[(side + 1) % 3], v[(side + 2) % 3]];
  const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
  if (count === 1) return [[a, b, bc], [bc, c, a]];
  if (count === 2) return [[a, ab, ca], [ab, b, ca], [b, c, ca]];
  return [[a, ab, ca], [ab, b, bc], [bc, c, ca], [ab, bc, ca]];
}

// ------------------------------------------------------------------ paint codes
/** Paint tree of one triangle from its even split: states[0..4^level) in split4 order. */
export function encodeTree(states, offset, level) {
  const nibbles = [];
  const leaf = (s) => {
    if (s < 3) nibbles.push(s << 2);
    else if (s - 3 < 15) nibbles.push(12, s - 3);
    else nibbles.push(12, 15, s - 18);
  };
  const walk = (off, lvl) => {
    const n = 4 ** lvl;
    const first = states[off];
    let same = true;
    for (let i = 1; i < n; i++) if (states[off + i] !== first) { same = false; break; }
    if (same) { leaf(first); return; }
    nibbles.push(3); // 4 children, side 0
    const q = n / 4;
    for (let i = 3; i >= 0; i--) walk(off + i * q, lvl - 1); // read back last child first
  };
  walk(offset, level);
  if (nibbles.length === 1 && nibbles[0] === 0) return '';
  return nibbles.reverse().map((x) => x.toString(16).toUpperCase()).join('');
}

export function decodeTree(code) {
  if (!code) return { state: 0 };
  if (!/^[0-9a-f]+$/i.test(code) || code.length > 2000000) throw new Error('Invalid paint data');
  const n = [...code].reverse().map((c) => parseInt(c, 16));
  let cur = 0, nodes = 0;
  const next = () => { if (cur >= n.length) throw new Error('Truncated paint data'); return n[cur++]; };
  const read = (depth) => {
    if (depth > 30 || ++nodes > 500000) throw new Error('Paint data too detailed');
    const bits = next(), count = bits & 3, side = bits >> 2;
    if (!count) {
      let s = side;
      if (s === 3) { s = next(); s = s === 15 ? next() + 18 : s + 3; }
      return { state: s };
    }
    const children = Array(count + 1);
    for (let i = count; i >= 0; i--) children[i] = read(depth + 1);
    return { count, side, children };
  };
  return read(0);
}

const cross2 = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
function inTri(t, p) {
  const d1 = cross2(t[0], t[1], p), d2 = cross2(t[1], t[2], p), d3 = cross2(t[2], t[0], p);
  const neg = d1 < -1e-12 || d2 < -1e-12 || d3 < -1e-12, pos = d1 > 1e-12 || d2 > 1e-12 || d3 > 1e-12;
  return !(neg && pos);
}
/** State of a tree at a point given in the triangle's own (u, v) coordinates. */
export function stateAt(tree, p, tri = [[0, 0], [1, 0], [0, 1]]) {
  while (tree.children) {
    const parts = splitN(tri, tree.count, tree.side);
    let k = parts.findIndex((t) => inTri(t, p));
    if (k < 0) k = 0;
    tree = tree.children[k];
    tri = parts[k];
  }
  return tree.state;
}

// ------------------------------------------------------------------ fine mesh for display + paint
/**
 * Splits every triangle evenly so painting can be finer than the model's own triangles.
 * positions: Float32Array (9 per triangle). Returns {fine (Float32Array), levels (Uint8Array per
 * original triangle), start (Uint32Array: first fine triangle of each original), count}.
 */
export function subdivide(positions, { target = 2.0, budget = 600000, maxLevel = 5 } = {}) {
  const tris = positions.length / 9;
  const levels = new Uint8Array(tris);
  const longest = new Float32Array(tris);
  for (let t = 0; t < tris; t++) {
    const o = t * 9;
    const e = (i, j) => Math.hypot(positions[o + i] - positions[o + j], positions[o + i + 1] - positions[o + j + 1], positions[o + i + 2] - positions[o + j + 2]);
    longest[t] = Math.max(e(0, 3), e(3, 6), e(6, 0));
  }
  let tgt = target, total = 0;
  for (let tries = 0; tries < 12; tries++) {
    total = 0;
    for (let t = 0; t < tris; t++) {
      let l = 0;
      while (l < maxLevel && longest[t] / 2 ** l > tgt) l++;
      levels[t] = l;
      total += 4 ** l;
    }
    if (total <= Math.max(budget, tris)) break;
    tgt *= 1.6;
  }
  const fine = new Float32Array(total * 9);
  const start = new Uint32Array(tris);
  let w = 0;
  const emit = (a, b, c, lvl) => {
    if (lvl === 0) { fine.set(a, w); fine.set(b, w + 3); fine.set(c, w + 6); w += 9; return; }
    for (const [x, y, z] of split4(a, b, c)) emit(x, y, z, lvl - 1);
  };
  for (let t = 0; t < tris; t++) {
    start[t] = w / 9;
    const o = t * 9;
    emit([positions[o], positions[o + 1], positions[o + 2]], [positions[o + 3], positions[o + 4], positions[o + 5]], [positions[o + 6], positions[o + 7], positions[o + 8]], levels[t]);
  }
  return { fine, levels, start, count: total };
}

/** (u,v) centres of the 4^level pieces of the unit triangle, in split4 order. */
const centreCache = new Map();
export function pieceCentres(level) {
  if (centreCache.has(level)) return centreCache.get(level);
  const out = [];
  const walk = (a, b, c, l) => {
    if (l === 0) { out.push([(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3]); return; }
    for (const [x, y, z] of split4(a, b, c)) walk(x, y, z, l - 1);
  };
  walk([0, 0], [1, 0], [0, 1], level);
  centreCache.set(level, out);
  return out;
}

// ------------------------------------------------------------------ import
const UNITS = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };

function parseTransform(s) {
  if (!s) return null;
  const n = s.trim().split(/\s+/).map(Number);
  if (n.length !== 12 || n.some((x) => !Number.isFinite(x))) throw new Error('Invalid 3MF transform');
  return n; // column-major 3x4: x' = n0 x + n3 y + n6 z + n9 ...
}
const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
function mul(a, b) { // a after b
  const r = new Array(12);
  for (let c = 0; c < 3; c++) for (let row = 0; row < 3; row++) r[c * 3 + row] = a[row] * b[c * 3] + a[3 + row] * b[c * 3 + 1] + a[6 + row] * b[c * 3 + 2];
  for (let row = 0; row < 3; row++) r[9 + row] = a[row] * b[9] + a[3 + row] * b[10] + a[6 + row] * b[11] + a[9 + row];
  return r;
}

/**
 * Reads a 3MF (Orca / Bambu / MakerWorld / Prusa / plain). Returns
 * { objects: [{name, positions: Float32Array, paint: [codes per triangle], filament}], plates: [{id, name, objectIds}],
 *   plateCount, bed: {x0, y0, w, d} of the source printer or null, colours / types of its filaments,
 *   settings: the project's support / infill / wall / brim settings (PROJECT_KEYS),
 *   skipped: number of modifier / negative / support parts left out }
 * Each object is one build item (parts merged). Part filaments become paint.
 */
/** Print settings a project brings along (they are about the model, not the printer). */
export const PROJECT_KEYS = ['enable_support', 'support_type', 'support_style', 'support_on_build_plate_only', 'support_threshold_angle',
  'sparse_infill_density', 'wall_loops', 'brim_type', 'brim_width', 'top_shell_layers', 'bottom_shell_layers'];

// ------------------------------------------------------------------ fast .model reader
// A 3MF model file can be hundreds of MB of XML (millions of <vertex>/<triangle> lines). The
// browser's DOMParser needs several times that in memory and tens of seconds; this reads the
// few tags we need straight from the bytes, in one pass, into typed arrays.
const CH = { lt: 60, gt: 62, slash: 47, eq: 61, dq: 34, sq: 39, sp: 32, qm: 63, excl: 33 };
const isSpace = (c) => c === 32 || c === 10 || c === 13 || c === 9;
const td = new TextDecoder();
/** Number from bytes [i, e): sign, digits, '.', exponent. NaN when not a number. */
function numAt(b, i, e) {
  let neg = false, v = 0, seen = false;
  if (b[i] === 45) { neg = true; i++; } else if (b[i] === 43) i++;
  for (; i < e && b[i] >= 48 && b[i] <= 57; i++) { v = v * 10 + (b[i] - 48); seen = true; }
  if (i < e && b[i] === 46) {
    i++;
    let f = 0.1;
    for (; i < e && b[i] >= 48 && b[i] <= 57; i++) { v += (b[i] - 48) * f; f *= 0.1; seen = true; }
  }
  if (!seen) return NaN;
  if (i < e && (b[i] === 101 || b[i] === 69)) {
    i++;
    let eneg = false, ex = 0;
    if (b[i] === 45) { eneg = true; i++; } else if (b[i] === 43) i++;
    for (; i < e && b[i] >= 48 && b[i] <= 57; i++) ex = ex * 10 + (b[i] - 48);
    v *= Math.pow(10, eneg ? -ex : ex);
  }
  return neg ? -v : v;
}
const fnv = (str) => { let h = 2166136261; for (let k = 0; k < str.length; k++) h = Math.imul(h ^ str.charCodeAt(k), 16777619); return h >>> 0; };
const TAGS = new Map(['vertex', 'triangle', 'object', 'component', 'build', 'item', 'model', 'mesh'].map((t) => [fnv(t), t]));
const xmlText = (s) => (s.includes('&') ? s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&') : s);

/**
 * Reads one .model file. Returns { unit, objects: Map(id -> { type, name, mesh: { v: Float32Array,
 * t: Uint32Array, paint, sup, seam: string[] | null } | null, components: [{ objectid, path, transform }] }),
 * build: [{ objectid, transform, printable }] }.
 */
export function readModel(b) {
  const n = b.length;
  const objects = new Map(), build = [];
  let unit = 'millimeter', cur = null, inBuild = false;
  // per-mesh growing buffers
  let V = null, nv = 0, T = null, nt = 0, paint = null, sup = null, seam = null;
  const grow = (a, need, Type) => { if (need <= a.length) return a; const na = new Type(Math.max(need, a.length * 2)); na.set(a); return na; };
  // attribute scan: after a tag name, fills `at` (known attribute -> [start, end] of the value bytes).
  // Names are matched by a hash of their bytes, so nothing is decoded for the millions of
  // x/y/z/v1/v2/v3 attributes.
  const KNOWN = ['x', 'y', 'z', 'v1', 'v2', 'v3', 'paint_color', 'slic3rpe:mmu_segmentation', 'paint_supports', 'slic3rpe:custom_supports',
    'paint_seam', 'slic3rpe:custom_seam', 'id', 'type', 'name', 'objectid', 'p:path', 'path', 'transform', 'printable', 'unit'];
  const slot = new Map(KNOWN.map((k, idx) => [fnv(k), idx]));
  const at = new Int32Array(KNOWN.length * 2);
  const K = Object.fromEntries(KNOWN.map((k, idx) => [k, idx]));
  let i = 0;
  const readAttrs = (j) => {
    at.fill(-1);
    for (;;) {
      while (j < n && isSpace(b[j])) j++;
      if (j >= n || b[j] === CH.gt || b[j] === CH.slash) return j;
      let h = 2166136261;
      while (j < n && b[j] !== CH.eq && !isSpace(b[j]) && b[j] !== CH.gt) { h = Math.imul(h ^ b[j], 16777619); j++; }
      while (j < n && isSpace(b[j])) j++;
      if (b[j] !== CH.eq) continue;
      j++;
      while (j < n && isSpace(b[j])) j++;
      const q = b[j];
      if (q !== CH.dq && q !== CH.sq) return j;
      const vs = ++j;
      while (j < n && b[j] !== q) j++;
      const idx = slot.get(h >>> 0);
      if (idx !== undefined) { at[idx * 2] = vs; at[idx * 2 + 1] = j; }
      j++;
    }
  };
  const str = (k) => { const a0 = at[K[k] * 2]; return a0 < 0 ? null : xmlText(td.decode(b.subarray(a0, at[K[k] * 2 + 1]))); };
  const num = (k) => { const a0 = at[K[k] * 2]; return a0 < 0 ? NaN : numAt(b, a0, at[K[k] * 2 + 1]); };
  // a paint code without the string machinery when the attribute is absent (the common case)
  const code = (k1, k2) => (at[K[k1] * 2] >= 0 ? str(k1) : at[K[k2] * 2] >= 0 ? str(k2) : '');
  const finishMesh = () => {
    if (!cur || !V) return;
    cur.mesh = { v: V.subarray(0, nv * 3), t: T.subarray(0, nt * 3), paint: paint && paint.some(Boolean) ? paint : null, sup: sup && sup.some(Boolean) ? sup : null, seam: seam && seam.some(Boolean) ? seam : null };
    V = T = paint = sup = seam = null;
  };
  while (i < n) {
    if (b[i] !== CH.lt) { i++; continue; }
    let j = i + 1;
    if (b[j] === CH.slash) { // closing tag
      j++;
      const s = j;
      while (j < n && b[j] !== CH.gt) j++;
      const tag = td.decode(b.subarray(s, j));
      if (tag === 'object') { finishMesh(); cur = null; } else if (tag === 'build') inBuild = false;
      i = j + 1; continue;
    }
    if (b[j] === CH.qm || b[j] === CH.excl) { while (j < n && b[j] !== CH.gt) j++; i = j + 1; continue; }
    let th = 2166136261;
    while (j < n && !isSpace(b[j]) && b[j] !== CH.gt && b[j] !== CH.slash) { th = Math.imul(th ^ b[j], 16777619); j++; }
    const tag = TAGS.get(th >>> 0) || '';
    if (tag === 'vertex' && cur) {
      j = readAttrs(j);
      if (!V) { V = new Float32Array(3 * 1024); nv = 0; }
      V = grow(V, (nv + 1) * 3, Float32Array);
      V[nv * 3] = num('x'); V[nv * 3 + 1] = num('y'); V[nv * 3 + 2] = num('z'); nv++;
    } else if (tag === 'triangle' && cur) {
      j = readAttrs(j);
      if (!T) { T = new Uint32Array(3 * 1024); nt = 0; paint = []; sup = []; seam = []; }
      T = grow(T, (nt + 1) * 3, Uint32Array);
      T[nt * 3] = num('v1'); T[nt * 3 + 1] = num('v2'); T[nt * 3 + 2] = num('v3');
      paint.push(code('paint_color', 'slic3rpe:mmu_segmentation'));
      sup.push(code('paint_supports', 'slic3rpe:custom_supports'));
      seam.push(code('paint_seam', 'slic3rpe:custom_seam'));
      nt++;
    } else if (tag === 'object') {
      j = readAttrs(j);
      finishMesh();
      cur = { type: str('type') || 'model', name: str('name'), mesh: null, components: [] };
      objects.set(str('id'), cur);
    } else if (tag === 'component' && cur) {
      j = readAttrs(j);
      cur.components.push({ objectid: str('objectid'), path: str('p:path') || str('path'), transform: str('transform') });
    } else if (tag === 'build') { inBuild = true; j = readAttrs(j); }
    else if (tag === 'item' && inBuild) {
      j = readAttrs(j);
      build.push({ objectid: str('objectid'), transform: str('transform'), printable: str('printable') !== '0' });
    } else if (tag === 'model') { j = readAttrs(j); unit = str('unit') || 'millimeter'; }
    else if (tag === 'mesh') { V = new Float32Array(3 * 1024); nv = 0; T = new Uint32Array(3 * 1024); nt = 0; paint = []; sup = []; seam = []; }
    while (j < n && b[j] !== CH.gt) j++;
    i = j + 1;
  }
  finishMesh();
  return { unit, objects, build };
}

/** model_settings.config (Orca / Bambu / Prusa): objects with metadata and parts, and plates. No DOM needed. */
export function readConfig(text) {
  const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([\w:.-]+)="([^"]*)"/g)].map((m) => [m[1], xmlText(m[2])]));
  const metaOf = (block) => { const m = {}; for (const t of block.matchAll(/<metadata\b([^>]*)\/?>/g)) { const a = attrs(t[1]); if (a.key) m[a.key] = a.value; } return m; };
  const objects = [], plates = [];
  for (const ob of text.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
    const a = attrs(ob[1]);
    const parts = [...ob[2].matchAll(/<part\b([^>]*)>([\s\S]*?)<\/part>/g)].map((pt) => { const pa = attrs(pt[1]); return { id: pa.id, subtype: pa.subtype, meta: metaOf(pt[2]) }; });
    const own = ob[2].replace(/<part\b[\s\S]*?<\/part>/g, ''); // the object's own metadata, not its parts'
    objects.push({ id: a.id, meta: metaOf(own), parts });
  }
  for (const pl of text.matchAll(/<plate>([\s\S]*?)<\/plate>/g)) {
    const inst = [...pl[1].matchAll(/<model_instance>([\s\S]*?)<\/model_instance>/g)].map((mi) => metaOf(mi[1]).object_id).filter(Boolean);
    const own = pl[1].replace(/<model_instance>[\s\S]*?<\/model_instance>/g, '');
    plates.push({ meta: metaOf(own), objectIds: inst });
  }
  return { objects, plates };
}

export function import3mf(buffer) {
  let expanded = 0;
  const files = unzipSync(new Uint8Array(buffer), {
    filter: (f) => { expanded += f.originalSize; if (expanded > 1024 * 1024 * 1024) throw new Error('This 3MF is too big to open in a browser (over 1 GB unpacked).'); return /\.(model|config|xml|rels)$/i.test(f.name); },
  });
  const docs = new Map();
  for (const [name, bytes] of Object.entries(files)) {
    if (!/\.model$/i.test(name)) continue;
    docs.set(name.replace(/^\//, ''), readModel(bytes));
  }
  const root = docs.get('3D/3dmodel.model') || docs.values().next().value;
  if (!root) throw new Error('No model found in this 3MF.');

  // Orca / Bambu extras: names, filament per object / part, part type, plates.
  const cfgFile = files['Metadata/model_settings.config'] || files['Metadata/Slic3r_PE_model.config'];
  const objInfo = new Map(), partInfo = new Map();
  const plates = [];
  if (cfgFile) {
    const cfg = readConfig(strFromU8(cfgFile));
    for (const o of cfg.objects) {
      objInfo.set(o.id, { name: o.meta.name, extruder: Number(o.meta.extruder) || 0 });
      for (const p of o.parts) partInfo.set(o.id + '/' + p.id, { subtype: p.subtype || 'normal_part', extruder: Number(p.meta.extruder) || 0 });
    }
    for (const pl of cfg.plates) plates.push({ id: Number(pl.meta.plater_id) || plates.length + 1, name: pl.meta.plater_name || '', objectIds: [...new Set(pl.objectIds)] });
  }

  // The printer the project was made for: its bed (where the plates are) and its filaments.
  let bed = null, colours = [], types = [], presets = [];
  const settings = {};
  const ps = files['Metadata/project_settings.config'];
  if (ps) {
    try {
      const j = JSON.parse(strFromU8(ps));
      const pts = (j.printable_area || []).map((p) => String(p).split('x').map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite));
      if (pts.length >= 3) {
        const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
        const x0 = Math.min(...xs), y0 = Math.min(...ys), w = Math.max(...xs) - x0, d = Math.max(...ys) - y0;
        if (w > 20 && d > 20 && w < 2000 && d < 2000) bed = { x0, y0, w, d };
      }
      if (Array.isArray(j.filament_colour)) colours = j.filament_colour.map((c) => (/^#[0-9a-f]{6}/i.test(c) ? c.slice(0, 7).toUpperCase() : '#888888'));
      if (Array.isArray(j.filament_type)) types = j.filament_type.map(String);
      if (Array.isArray(j.filament_settings_id)) presets = j.filament_settings_id.map(String);
      for (const k of PROJECT_KEYS) if (j[k] !== undefined) settings[k] = String(Array.isArray(j[k]) ? j[k][0] : j[k]);
    } catch (_) { /* not JSON (PrusaSlicer ini): plates are guessed */ }
  }
  const plateCount = plates.length;

  const factor = UNITS[root.unit];
  if (!factor) throw new Error('Unsupported 3MF unit');

  let skipped = 0;
  const objects = [];
  for (const item of root.build) {
    if (!item.printable) continue;
    const topId = item.objectid;
    const info = objInfo.get(topId) || {};
    const objFil = info.extruder || 1;
    const parts = []; // {pos, codes, sup, seam}
    let total = 0;
    const visit = (doc, id, m, depth, partKey) => {
      if (depth > 16) throw new Error('This 3MF nests its parts too deeply.');
      const o = doc.objects.get(id);
      if (!o) throw new Error('A part of this 3MF is missing (' + id + ').');
      if (!['model', 'solidsupport'].includes(o.type)) { skipped++; return; }
      if (o.mesh) {
        const part = partInfo.get(topId + '/' + (partKey || id)) || partInfo.get(topId + '/' + id);
        if (part && !['normal_part', '0', ''].includes(part.subtype)) { skipped++; return; }
        const partFil = part && part.extruder ? part.extruder : 0;
        const { v, t } = o.mesh;
        const nvx = v.length / 3, ntr = t.length / 3;
        total += ntr;
        if (total > 12000000) throw new Error('This model has more than 12 million triangles, too many to open in a browser. Simplify it on a PC first (OrcaSlicer: right-click → Simplify model).');
        // transform the vertices once
        const vx = new Float64Array(nvx * 3);
        for (let k = 0; k < nvx; k++) {
          const x = v[k * 3], y = v[k * 3 + 1], z = v[k * 3 + 2];
          vx[k * 3] = (m[0] * x + m[3] * y + m[6] * z + m[9]) * factor;
          vx[k * 3 + 1] = (m[1] * x + m[4] * y + m[7] * z + m[10]) * factor;
          vx[k * 3 + 2] = (m[2] * x + m[5] * y + m[8] * z + m[11]) * factor;
        }
        const flip = det(m) < 0;
        const pos = new Float32Array(ntr * 9);
        for (let k = 0; k < ntr; k++) {
          const a = t[k * 3], b2 = flip ? t[k * 3 + 2] : t[k * 3 + 1], c = flip ? t[k * 3 + 1] : t[k * 3 + 2];
          if (a >= nvx || b2 >= nvx || c >= nvx) throw new Error('Damaged triangle in 3MF');
          const o9 = k * 9;
          pos[o9] = vx[a * 3]; pos[o9 + 1] = vx[a * 3 + 1]; pos[o9 + 2] = vx[a * 3 + 2];
          pos[o9 + 3] = vx[b2 * 3]; pos[o9 + 4] = vx[b2 * 3 + 1]; pos[o9 + 5] = vx[b2 * 3 + 2];
          pos[o9 + 6] = vx[c * 3]; pos[o9 + 7] = vx[c * 3 + 1]; pos[o9 + 8] = vx[c * 3 + 2];
        }
        // paint: mirrored parts drop theirs (keep it simple); a part on another filament than its
        // object is painted whole with it
        const whole = partFil && partFil !== objFil ? encodeTree([partFil], 0, 0) : '';
        let codes = null;
        if (!flip && o.mesh.paint) { codes = o.mesh.paint.slice(); if (whole) for (let k = 0; k < ntr; k++) if (!codes[k]) codes[k] = whole; }
        else if (whole) codes = new Array(ntr).fill(whole);
        parts.push({ pos, codes, sup: flip ? null : o.mesh.sup, seam: flip ? null : o.mesh.seam, n: ntr });
      } else {
        for (const c of o.components) {
          const child = c.path ? docs.get(c.path.replace(/^\//, '')) : doc;
          if (!child) throw new Error('A part file of this 3MF is missing.');
          visit(child, c.objectid, mul(m, parseTransform(c.transform) || IDENT), depth + 1, depth === 0 ? c.objectid : partKey);
        }
      }
    };
    visit(root, topId, parseTransform(item.transform) || IDENT, 0, null);
    if (!total) continue;
    // merge the parts of this object
    const positions = new Float32Array(total * 9);
    const anyCodes = parts.some((p) => p.codes), anySup = parts.some((p) => p.sup), anySeam = parts.some((p) => p.seam);
    const codes = anyCodes ? new Array(total) : null, sup = anySup ? new Array(total) : null, seam = anySeam ? new Array(total) : null;
    let off = 0;
    for (const p of parts) {
      positions.set(p.pos, off * 9);
      for (let k = 0; k < p.n; k++) {
        if (codes) codes[off + k] = p.codes ? p.codes[k] : '';
        if (sup) sup[off + k] = p.sup ? p.sup[k] : '';
        if (seam) seam[off + k] = p.seam ? p.seam[k] : '';
      }
      off += p.n;
    }
    const name = info.name || (root.objects.get(topId) || {}).name || `Object ${objects.length + 1}`;
    objects.push({ id: topId, name, positions, paint: codes, sup, seam, filament: objFil, parts: parts.length });
  }
  if (!objects.length) throw new Error(skipped ? 'This 3MF only has modifier or helper parts, nothing to print.' : 'There is nothing printable in this 3MF.');
  return { objects, plates: plates.filter((p) => p.objectIds.length), plateCount, bed, colours, types, presets, settings, skipped };
}
const det = (m) => m[0] * (m[4] * m[8] - m[7] * m[5]) - m[3] * (m[1] * m[8] - m[7] * m[2]) + m[6] * (m[1] * m[5] - m[4] * m[2]);

// ------------------------------------------------------------------ export
const fmt = (v) => { const s = (Math.round(v * 1e5) / 1e5).toString(); return s === '-0' ? '0' : s; };

/** Same position -> same vertex index (exact float match), for a non-indexed triangle list. */
export function weldPositions(pos) {
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
  return { index, verts: verts.subarray(0, nv * 3), count: nv };
}

/**
 * Writes a plate (for slicing) or a whole project (Save). objects: [{name, positions (world, mm,
 * Float32Array 9/triangle), paint: {color, supports, seam} (per-triangle codes or null), filament}].
 * No printer / process settings are written: the board slices with the open printer's own profiles.
 * Built as byte chunks (no giant string): a million-triangle plate is ~100 MB of XML.
 */
export function export3mf(objects, title = 'Plate', { plates = null, filaments = null, bed = null } = {}) {
  const x = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
  const chunks = [];
  let chunkLen = 0;
  const put = (str) => { const u = strToU8(str); chunks.push(u); chunkLen += u.length; };
  put('<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">'
    + '<metadata name="Application">Flash Bridge</metadata><metadata name="Title">' + x(title) + '</metadata><resources>');
  const build = ['<build>'];
  const cfg = ['<?xml version="1.0" encoding="UTF-8"?>\n<config>'];
  objects.forEach((o, n) => {
    const id = n + 1;
    const { index, verts, count } = weldPositions(o.positions);
    put(`<object id="${id}" type="model" name="${x(o.name)}"><mesh><vertices>`);
    const parts = [];
    for (let i = 0; i < count; i++) {
      parts.push(`<vertex x="${fmt(verts[i * 3])}" y="${fmt(verts[i * 3 + 1])}" z="${fmt(verts[i * 3 + 2])}"/>`);
      if (parts.length === 20000) { put(parts.join('')); parts.length = 0; }
    }
    put(parts.join('') + '</vertices><triangles>'); parts.length = 0;
    const P = o.paint || {};
    for (let f = 0; f < index.length / 3; f++) {
      const a = index[f * 3], b = index[f * 3 + 1], c = index[f * 3 + 2];
      if (a === b || b === c || a === c) continue; // degenerate
      let extra = '';
      if (P.color && P.color[f]) extra += ` paint_color="${P.color[f]}"`;
      if (P.supports && P.supports[f]) extra += ` paint_supports="${P.supports[f]}"`;
      if (P.seam && P.seam[f]) extra += ` paint_seam="${P.seam[f]}"`;
      parts.push(`<triangle v1="${a}" v2="${b}" v3="${c}"${extra}/>`);
      if (parts.length === 20000) { put(parts.join('')); parts.length = 0; }
    }
    put(parts.join('') + '</triangles></mesh></object>');
    build.push(`<item objectid="${id}" printable="1"/>`);
    cfg.push(`<object id="${id}"><metadata key="name" value="${x(o.name)}"/><metadata key="extruder" value="${o.filament}"/>`
      + `<part id="${id}" subtype="normal_part"><metadata key="name" value="${x(o.name)}"/><metadata key="extruder" value="${o.filament}"/></part></object>`);
  });
  put('</resources>' + build.join('') + '</build></model>');
  const model = new Uint8Array(chunkLen);
  let off = 0;
  for (const c of chunks) { model.set(c, off); off += c.length; }
  // plates: [[object numbers (1-based)], ...]; one plate with everything when not given
  const plateList = plates || [objects.map((_, n) => n + 1)];
  plateList.forEach((ids, k) => {
    cfg.push(`<plate><metadata key="plater_id" value="${k + 1}"/>` + ids.map((id) => `<model_instance><metadata key="object_id" value="${id}"/><metadata key="instance_id" value="0"/></model_instance>`).join('') + '</plate>');
  });
  cfg.push('</config>');
  const files = {
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),
    '3D/3dmodel.model': model,
    'Metadata/model_settings.config': strToU8(cfg.join('')),
  };
  // a saved project also remembers its filaments and the bed it was laid out on (read back by import3mf)
  if (filaments) {
    files['Metadata/project_settings.config'] = strToU8(JSON.stringify({
      filament_colour: filaments.map((f) => f.color), filament_type: filaments.map((f) => f.type || 'PLA'), filament_settings_id: filaments.map((f) => f.preset || ''),
      printable_area: bed ? [`${bed.x0}x${bed.y0}`, `${bed.x0 + bed.w}x${bed.y0}`, `${bed.x0 + bed.w}x${bed.y0 + bed.d}`, `${bed.x0}x${bed.y0 + bed.d}`] : undefined,
    }));
  }
  return zipSync(files, { level: 1 }); // fast: the board unpacks it anyway; level 6 only saves ~15% for minutes of work
}
