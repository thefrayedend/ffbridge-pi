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
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';

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
const apply = (m, x, y, z) => [m[0] * x + m[3] * y + m[6] * z + m[9], m[1] * x + m[4] * y + m[7] * z + m[10], m[2] * x + m[5] * y + m[8] * z + m[11]];

/**
 * Reads a 3MF (Orca / Bambu / MakerWorld / Prusa / plain). Returns
 * { objects: [{name, positions: Float32Array, paint: [codes per triangle], filament}], plates: [{id, name, objectIds}],
 *   skipped: number of modifier / negative / support parts left out }
 * Each object is one build item (parts merged). Part filaments become paint.
 */
export function import3mf(buffer) {
  let expanded = 0;
  const files = unzipSync(new Uint8Array(buffer), {
    filter: (f) => { expanded += f.originalSize; if (expanded > 512 * 1024 * 1024) throw new Error('This 3MF is too big to open here (over 512 MB unpacked).'); return /\.(model|config|xml|rels)$/i.test(f.name); },
  });
  const parser = new DOMParser();
  const docs = new Map();
  for (const [name, bytes] of Object.entries(files)) {
    if (!/\.model$/i.test(name)) continue;
    const d = parser.parseFromString(strFromU8(bytes), 'application/xml');
    if (d.querySelector('parsererror')) throw new Error('The 3MF model data is damaged.');
    docs.set(name.replace(/^\//, ''), d);
  }
  const root = docs.get('3D/3dmodel.model') || docs.values().next().value;
  if (!root) throw new Error('No model found in this 3MF.');

  // Orca / Bambu extras: names, filament per object / part, part type, plates.
  const cfgFile = files['Metadata/model_settings.config'] || files['Metadata/Slic3r_PE_model.config'];
  const objInfo = new Map(), partInfo = new Map();
  const plates = [];
  if (cfgFile) {
    const cfg = parser.parseFromString(strFromU8(cfgFile), 'application/xml');
    const meta = (el) => Object.fromEntries([...el.children].filter((x) => x.tagName === 'metadata').map((x) => [x.getAttribute('key'), x.getAttribute('value')]));
    for (const o of cfg.getElementsByTagName('object')) {
      const m = meta(o);
      objInfo.set(o.getAttribute('id'), { name: m.name, extruder: Number(m.extruder) || 0 });
      for (const p of o.getElementsByTagName('part')) {
        const pm = meta(p);
        partInfo.set(o.getAttribute('id') + '/' + p.getAttribute('id'), { subtype: p.getAttribute('subtype') || 'normal_part', extruder: Number(pm.extruder) || 0 });
      }
    }
    for (const pl of cfg.getElementsByTagName('plate')) {
      const m = meta(pl);
      const ids = [...pl.getElementsByTagName('model_instance')].map((mi) => meta(mi).object_id).filter(Boolean);
      plates.push({ id: Number(m.plater_id) || plates.length + 1, name: m.plater_name || '', objectIds: [...new Set(ids)] });
    }
  }

  const factor = UNITS[root.documentElement.getAttribute('unit') || 'millimeter'];
  if (!factor) throw new Error('Unsupported 3MF unit');
  const objectsOf = new Map();
  for (const [n, d] of docs) objectsOf.set(n, new Map([...d.getElementsByTagName('object')].map((o) => [o.getAttribute('id'), o])));
  const docName = (d) => [...docs].find((x) => x[1] === d)[0];

  let skipped = 0;
  const objects = [];
  const build = root.getElementsByTagName('build')[0];
  for (const item of build ? build.getElementsByTagName('item') : []) {
    if (item.getAttribute('printable') === '0') continue;
    const topId = item.getAttribute('objectid');
    const info = objInfo.get(topId) || {};
    const objFil = info.extruder || 1;
    const pos = [], codes = [];
    let partCount = 0;
    const visit = (doc, id, m, depth, partKey) => {
      if (depth > 16) throw new Error('This 3MF nests its parts too deeply.');
      const o = objectsOf.get(docName(doc)).get(id);
      if (!o) throw new Error('A part of this 3MF is missing (' + id + ').');
      if (o.getAttribute('type') && !['model', 'solidsupport'].includes(o.getAttribute('type'))) { skipped++; return; }
      const mesh = o.getElementsByTagName('mesh')[0];
      if (mesh) {
        const part = partInfo.get(topId + '/' + (partKey || id)) || partInfo.get(topId + '/' + id);
        if (part && !['normal_part', '0', ''].includes(part.subtype)) { skipped++; return; }
        partCount++;
        const partFil = part && part.extruder ? part.extruder : 0;
        const vs = mesh.getElementsByTagName('vertex');
        const vx = new Float64Array(vs.length * 3);
        for (let i = 0; i < vs.length; i++) {
          const p = apply(m, +vs[i].getAttribute('x'), +vs[i].getAttribute('y'), +vs[i].getAttribute('z'));
          vx[i * 3] = p[0] * factor; vx[i * 3 + 1] = p[1] * factor; vx[i * 3 + 2] = p[2] * factor;
        }
        const flip = det(m) < 0;
        for (const t of mesh.getElementsByTagName('triangle')) {
          let ids = [+t.getAttribute('v1'), +t.getAttribute('v2'), +t.getAttribute('v3')];
          if (flip) ids = [ids[0], ids[2], ids[1]];
          for (const k of ids) { if (!(k >= 0 && k < vs.length)) throw new Error('Damaged triangle in 3MF'); pos.push(vx[k * 3], vx[k * 3 + 1], vx[k * 3 + 2]); }
          let code = t.getAttribute('paint_color') || t.getAttribute('slic3rpe:mmu_segmentation') || '';
          if (code && flip) code = ''; // mirrored parts: keep it simple, drop the paint
          // a part on another filament than its object: paint the whole part with it
          if (!code && partFil && partFil !== objFil) code = encodeTree([partFil], 0, 0);
          codes.push(code);
        }
        if (pos.length / 9 > 2000000) throw new Error('This model has more than 2 million triangles.');
      } else {
        for (const c of o.getElementsByTagName('component')) {
          const path = c.getAttribute('p:path') || c.getAttribute('path');
          const child = path ? docs.get(path.replace(/^\//, '')) : doc;
          if (!child) throw new Error('A part file of this 3MF is missing.');
          visit(child, c.getAttribute('objectid'), mul(m, parseTransform(c.getAttribute('transform')) || IDENT), depth + 1, depth === 0 ? c.getAttribute('objectid') : partKey);
        }
      }
    };
    visit(root, topId, parseTransform(item.getAttribute('transform')) || IDENT, 0, null);
    if (!pos.length) continue;
    const name = info.name || objectsOf.get(docName(root)).get(topId)?.getAttribute('name') || `Object ${objects.length + 1}`;
    objects.push({ id: topId, name, positions: new Float32Array(pos), paint: codes, filament: objFil, parts: partCount });
  }
  if (!objects.length) throw new Error(skipped ? 'This 3MF only has modifier or helper parts, nothing to print.' : 'There is nothing printable in this 3MF.');
  return { objects, plates: plates.filter((p) => p.objectIds.length), skipped };
}
const det = (m) => m[0] * (m[4] * m[8] - m[7] * m[5]) - m[3] * (m[1] * m[8] - m[7] * m[2]) + m[6] * (m[1] * m[5] - m[4] * m[2]);

// ------------------------------------------------------------------ export
const fmt = (v) => { const s = (Math.round(v * 1e5) / 1e5).toString(); return s === '-0' ? '0' : s; };

/**
 * Writes the plate. objects: [{name, positions (world, mm, Float32Array 9/triangle),
 * paintCodes (array of strings per triangle or null), filament}]. No printer / process settings
 * are written: the board slices with the open printer's own profiles.
 */
export function export3mf(objects, title = 'Plate') {
  const x = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
  const model = ['<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">',
    '<metadata name="Application">Flash Bridge</metadata><metadata name="Title">' + x(title) + '</metadata><resources>'];
  const build = ['<build>'];
  const cfg = ['<?xml version="1.0" encoding="UTF-8"?>\n<config>'];
  objects.forEach((o, n) => {
    const id = n + 1;
    const p = o.positions;
    const index = new Map();
    const verts = [];
    const tri = [];
    for (let i = 0; i < p.length; i += 3) {
      const key = fmt(p[i]) + ' ' + fmt(p[i + 1]) + ' ' + fmt(p[i + 2]);
      let k = index.get(key);
      if (k === undefined) { k = index.size; index.set(key, k); const [a, b, c] = key.split(' '); verts.push(`<vertex x="${a}" y="${b}" z="${c}"/>`); }
      tri.push(k);
    }
    model.push(`<object id="${id}" type="model" name="${x(o.name)}"><mesh><vertices>`, verts.join(''), '</vertices><triangles>');
    const t = [];
    for (let f = 0; f < tri.length / 3; f++) {
      const a = tri[f * 3], b = tri[f * 3 + 1], c = tri[f * 3 + 2];
      if (a === b || b === c || a === c) continue; // collapsed by rounding
      const code = o.paintCodes ? o.paintCodes[f] : '';
      t.push(`<triangle v1="${a}" v2="${b}" v3="${c}"${code ? ` paint_color="${code}"` : ''}/>`);
    }
    model.push(t.join(''), '</triangles></mesh></object>');
    build.push(`<item objectid="${id}" printable="1"/>`);
    cfg.push(`<object id="${id}"><metadata key="name" value="${x(o.name)}"/><metadata key="extruder" value="${o.filament}"/>`
      + `<part id="${id}" subtype="normal_part"><metadata key="name" value="${x(o.name)}"/><metadata key="extruder" value="${o.filament}"/></part></object>`);
  });
  model.push('</resources>', build.join(''), '</build></model>');
  cfg.push('<plate><metadata key="plater_id" value="1"/>' + objects.map((_, n) => `<model_instance><metadata key="object_id" value="${n + 1}"/><metadata key="instance_id" value="0"/></model_instance>`).join('') + '</plate></config>');
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),
    '3D/3dmodel.model': strToU8(model.join('')),
    'Metadata/model_settings.config': strToU8(cfg.join('')),
  }, { level: 6 });
}
