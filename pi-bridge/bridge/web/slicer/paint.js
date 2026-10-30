// Painting tools for the slicer page, modelled on OrcaSlicer's painting gizmos:
// circle, sphere, triangle, height range, fill (bucket / smart fill with edge detection) and gap fill,
// for three channels: filament colour, support enforcers / blockers and seam enforcers / blockers.
//
// Every model is shown as an even split of its own triangles ("fine" triangles, see project3mf.js);
// paint is one byte per fine triangle and channel. The tools below only pick fine triangles; the
// caller sets the value, records undo and recolours.
import * as THREE from 'three';

export const CHANNELS = {
  color: { attr: 'paint_color', label: 'Colour' },
  support: { attr: 'paint_supports', label: 'Supports' },
  seam: { attr: 'paint_seam', label: 'Seam' },
};

/** Paint array of a channel (created on first use for supports / seam). */
export function channel(o, ch, create = false) {
  if (ch === 'color') return o.states;
  const key = ch === 'support' ? 'sup' : 'seam';
  if (!o[key] && create) o[key] = new Uint8Array(o.states.length);
  return o[key] || null;
}

const fineCount = (o) => o.states.length;
const pos = (o) => o.mesh.geometry.attributes.position.array;

/** Original model triangle that a fine triangle belongs to. */
export function origOf(o, t) {
  const s = o.start;
  let lo = 0, hi = s.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s[mid] <= t) lo = mid; else hi = mid - 1;
  }
  return lo;
}
export const piecesOf = (o, orig) => [o.start[orig], o.start[orig] + 4 ** o.levels[orig]];

// ------------------------------------------------------------------ per-triangle geometry (local)
/** Unit normals, centroids and areas of the fine triangles, in the model's own coordinates. */
export function geometry(o) {
  if (o.geo) return o.geo;
  const p = pos(o), n = fineCount(o);
  const normal = new Float32Array(n * 3), cen = new Float32Array(n * 3), area = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    const k = t * 9;
    const ax = p[k], ay = p[k + 1], az = p[k + 2];
    const ux = p[k + 3] - ax, uy = p[k + 4] - ay, uz = p[k + 5] - az;
    const vx = p[k + 6] - ax, vy = p[k + 7] - ay, vz = p[k + 8] - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    area[t] = l / 2;
    nx /= l; ny /= l; nz /= l;
    normal[t * 3] = nx; normal[t * 3 + 1] = ny; normal[t * 3 + 2] = nz;
    cen[t * 3] = (ax + p[k + 3] + p[k + 6]) / 3;
    cen[t * 3 + 1] = (ay + p[k + 4] + p[k + 7]) / 3;
    cen[t * 3 + 2] = (az + p[k + 5] + p[k + 8]) / 3;
  }
  // Inside-out models (wound the wrong way round) still have their outside on the outside:
  // the sign of the enclosed volume says which way the normals really point.
  let vol = 0;
  for (let t = 0; t < n; t++) {
    const k = t * 9;
    vol += p[k] * (p[k + 4] * p[k + 8] - p[k + 5] * p[k + 7]) - p[k + 1] * (p[k + 3] * p[k + 8] - p[k + 5] * p[k + 6]) + p[k + 2] * (p[k + 3] * p[k + 7] - p[k + 4] * p[k + 6]);
  }
  if (vol < 0) for (let i = 0; i < normal.length; i++) normal[i] = -normal[i];
  return (o.geo = { normal, cen, area });
}

/** Neighbour of every fine triangle across each of its three edges (-1: open edge / non-manifold). */
export function adjacency(o) {
  if (o.adj) return o.adj;
  const p = pos(o), n = fineCount(o);
  const ids = new Map();
  const vid = new Int32Array(n * 3);
  const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
  const bits = (x) => { f32[0] = x; return u32[0]; };
  for (let i = 0; i < n * 3; i++) {
    const key = bits(p[i * 3]) + ',' + bits(p[i * 3 + 1]) + ',' + bits(p[i * 3 + 2]);
    let v = ids.get(key);
    if (v === undefined) { v = ids.size; ids.set(key, v); }
    vid[i] = v;
  }
  const V = ids.size;
  const adj = new Int32Array(n * 3).fill(-1);
  const open = new Map();
  for (let t = 0; t < n; t++) {
    for (let e = 0; e < 3; e++) {
      const a = vid[t * 3 + e], b = vid[t * 3 + ((e + 1) % 3)];
      if (a === b) continue;
      const key = a < b ? a * V + b : b * V + a;
      const other = open.get(key);
      if (other === undefined) open.set(key, t * 3 + e);
      else if (other >= 0) {
        adj[t * 3 + e] = Math.floor(other / 3);
        adj[other] = t;
        open.set(key, -1); // a third triangle on this edge is not joined (non-manifold)
      }
    }
  }
  return (o.adj = adj);
}

/** World-space height of every fine triangle's centre (cached until the model moves). */
export function worldZ(o) {
  const m = o.mesh.matrixWorld.elements;
  const key = m.join(',');
  if (o.wz && o.wzKey === key) return o.wz;
  const { cen } = geometry(o);
  const n = fineCount(o), z = new Float32Array(n);
  for (let t = 0; t < n; t++) z[t] = m[2] * cen[t * 3] + m[6] * cen[t * 3 + 1] + m[10] * cen[t * 3 + 2] + m[14];
  o.wzKey = key;
  return (o.wz = z);
}

/** World-space normals' z (for overhang detection). */
export function worldNormalZ(o) {
  const key = o.mesh.matrixWorld.elements.join(',');
  if (o.wnz && o.wnzKey === key) return o.wnz;
  const { normal } = geometry(o);
  const nm = new THREE.Matrix3().getNormalMatrix(o.mesh.matrixWorld).elements; // column-major
  const n = fineCount(o), z = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    const x = normal[t * 3], y = normal[t * 3 + 1], w = normal[t * 3 + 2];
    const wx = nm[0] * x + nm[3] * y + nm[6] * w, wy = nm[1] * x + nm[4] * y + nm[7] * w, wz = nm[2] * x + nm[5] * y + nm[8] * w;
    z[t] = wz / (Math.hypot(wx, wy, wz) || 1);
  }
  o.wnzKey = key;
  return (o.wnz = z);
}

// ------------------------------------------------------------------ tools (return fine triangle ids)
/** Sphere brush: everything within radius r (mm) of the point (world). */
export function sphereTool(o, THREE, hitWorld, r, INTERSECTED, NOT_INTERSECTED, CONTAINED, fineTri) {
  const mesh = o.mesh;
  const inv = mesh.matrixWorld.clone().invert();
  const centre = hitWorld.clone().applyMatrix4(inv);
  const s = mesh.scale;
  const sphere = new THREE.Sphere(centre, r / Math.max(s.x, s.y, s.z));
  const out = [];
  mesh.geometry.boundsTree.shapecast({
    intersectsBounds: (box) => (sphere.intersectsBox(box) ? (sphere.containsPoint(box.min) && sphere.containsPoint(box.max) ? CONTAINED : INTERSECTED) : NOT_INTERSECTED),
    intersectsTriangle: (tri, triIndex) => { if (tri.intersectsSphere(sphere)) out.push(fineTri(mesh.geometry, triIndex)); return false; },
  });
  return out;
}

/** Circle brush: a cylinder along the view direction; only surfaces facing the camera, near the hit. */
export function circleTool(o, THREE, hitWorld, viewDirWorld, r, INTERSECTED, NOT_INTERSECTED, fineTri) {
  const mesh = o.mesh;
  const inv = mesh.matrixWorld.clone().invert();
  const P = hitWorld.clone().applyMatrix4(inv);
  const D = viewDirWorld.clone().transformDirection(inv).normalize();
  const s = mesh.scale, sc = Math.max(s.x, s.y, s.z);
  const rl = r / sc, depth = 3 * rl + 0.5 / sc;
  const { normal } = geometry(o);
  const v = new THREE.Vector3(), c = new THREE.Vector3();
  const out = [];
  mesh.geometry.boundsTree.shapecast({
    intersectsBounds: (box) => {
      box.getCenter(c);
      const hd = box.min.distanceTo(box.max) / 2;
      v.subVectors(c, P);
      const t = v.dot(D);
      if (Math.abs(t) > depth + hd) return NOT_INTERSECTED;
      v.addScaledVector(D, -t);
      return v.length() <= rl + hd ? INTERSECTED : NOT_INTERSECTED;
    },
    intersectsTriangle: (tri, triIndex) => {
      const f = fineTri(mesh.geometry, triIndex);
      if (normal[f * 3] * D.x + normal[f * 3 + 1] * D.y + normal[f * 3 + 2] * D.z >= 0) return false; // facing away
      tri.getMidpoint(c);
      v.subVectors(c, P);
      const t = v.dot(D);
      if (Math.abs(t) > depth) return false;
      v.addScaledVector(D, -t);
      if (v.length() <= rl) out.push(f);
      else {
        // big triangles: any corner inside the circle counts too
        for (const q of [tri.a, tri.b, tri.c]) { v.subVectors(q, P); const tt = v.dot(D); v.addScaledVector(D, -tt); if (v.length() <= rl && Math.abs(tt) <= depth) { out.push(f); break; } }
      }
      return false;
    },
  });
  return out;
}

/** Triangle: all pieces of the model triangle under the cursor. */
export function triangleTool(o, fine) {
  const [a, b] = piecesOf(o, origOf(o, fine));
  const out = [];
  for (let t = a; t < b; t++) out.push(t);
  return out;
}

/** Height range: a horizontal band of the given height around the clicked height. */
export function heightTool(o, zWorld, h) {
  const z = worldZ(o), out = [];
  const lo = zWorld - h / 2, hi = zWorld + h / 2;
  for (let t = 0; t < z.length; t++) if (z[t] >= lo && z[t] <= hi) out.push(t);
  return out;
}

/**
 * Fill: the connected area that has the same paint as the clicked spot. With edge detection
 * ("smart fill") it also stops where neighbouring surfaces meet at more than the angle.
 */
export function fillTool(o, arr, seed, angleDeg) {
  const adj = adjacency(o);
  const { normal } = geometry(o);
  const n = fineCount(o);
  const same = arr ? arr[seed] : 0;
  const get = (t) => (arr ? arr[t] : 0);
  const cos = angleDeg == null ? -2 : Math.cos((angleDeg * Math.PI) / 180);
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  let qh = 0, qt = 0;
  queue[qt++] = seed; seen[seed] = 1;
  while (qh < qt) {
    const t = queue[qh++];
    for (let e = 0; e < 3; e++) {
      const nb = adj[t * 3 + e];
      if (nb < 0 || seen[nb] || get(nb) !== same) continue;
      if (cos > -2) {
        const d = normal[t * 3] * normal[nb * 3] + normal[t * 3 + 1] * normal[nb * 3 + 1] + normal[t * 3 + 2] * normal[nb * 3 + 2];
        if (d < cos) continue;
      }
      seen[nb] = 1;
      queue[qt++] = nb;
    }
  }
  return Array.from(queue.subarray(0, qt));
}

/**
 * Gap fill: unpainted islands smaller than maxArea (mm²) take the paint around them.
 * Returns [[fine, value], ...].
 */
export function gapFill(o, arr, maxArea) {
  if (!arr) return [];
  const adj = adjacency(o);
  const { area } = geometry(o);
  const s = o.mesh.scale, sc2 = Math.abs(s.x * s.y + s.y * s.z + s.z * s.x) / 3;
  const n = fineCount(o);
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  const out = [];
  for (let start = 0; start < n; start++) {
    if (seen[start] || arr[start] !== 0) continue;
    let qh = 0, qt = 0, sum = 0;
    const around = new Map();
    queue[qt++] = start; seen[start] = 1;
    while (qh < qt) {
      const t = queue[qh++];
      sum += area[t] * sc2;
      for (let e = 0; e < 3; e++) {
        const nb = adj[t * 3 + e];
        if (nb < 0) continue;
        if (arr[nb] !== 0) { around.set(arr[nb], (around.get(arr[nb]) || 0) + 1); continue; }
        if (!seen[nb]) { seen[nb] = 1; queue[qt++] = nb; }
      }
    }
    if (sum <= maxArea && around.size) {
      let best = 0, bestN = -1;
      for (const [v, c] of around) if (c > bestN) { best = v; bestN = c; }
      for (let i = 0; i < qt; i++) out.push([queue[i], best]);
    }
  }
  return out;
}

/** Overhangs: surfaces facing down more steeply than the angle (from horizontal, Orca style). */
export function overhangs(o, angleDeg) {
  const nz = worldNormalZ(o), wz = worldZ(o), out = [];
  const lim = -Math.cos((angleDeg * Math.PI) / 180);
  for (let t = 0; t < nz.length; t++) if (nz[t] < lim && wz[t] > 0.3) out.push(t);
  return out;
}
