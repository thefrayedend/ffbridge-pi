// Flash Bridge slicer: Prepare (place models), Paint (colours), Preview (layer by layer).
// The 3D work happens in the browser; the board runs the OrcaSlicer engine with the open
// printer's own Flashforge profiles (src/slicer.dart). Loaded by app.js on first use.
import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { TransformControls } from './vendor/TransformControls.js';
import { STLLoader } from './vendor/STLLoader.js';
import { OBJLoader } from './vendor/OBJLoader.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast, INTERSECTED, NOT_INTERSECTED, CONTAINED } from './vendor/three-mesh-bvh.js';
import { import3mf, export3mf, subdivide, pieceCentres, decodeTree, stateAt, encodeTree } from './project3mf.js';
import { parseGcode, FEATURES } from './gcode.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

let F; // helpers from app.js (api, toast, esc, current, …)
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => F.esc(s);

// Settings shown in the side panel (everything else is under "All settings").
const SIMPLE = [
  ['layer_height', 'Layer height'], ['wall_loops', 'Walls'], ['top_shell_layers', 'Top layers'], ['bottom_shell_layers', 'Bottom layers'],
  ['sparse_infill_density', 'Infill'], ['sparse_infill_pattern', 'Infill pattern'], ['enable_support', 'Supports'], ['support_type', 'Support type'],
  ['support_on_build_plate_only', 'Supports only from the plate'], ['brim_type', 'Brim'], ['enable_prime_tower', 'Prime tower'],
];

const S = {
  ready: false, mode: 'prepare', printerId: '', info: null, schema: null, values: {}, loading: false, err: '',
  process: '', bedType: '', filaments: [], overrides: {},
  objects: [], selected: null, tool: 'move',
  paint: { filament: 2, size: 3 },
  job: null, preview: null, previewColor: 'tool', hiddenFeatures: new Set(), sliceKey: '',
  undo: [],
};
let renderer, scene, camera, controls, tcontrols, bedGroup, objGroup, previewGroup, brushRing, raycaster, needRender = true, nextId = 1;

// ================================================================== entry points (app.js)
export function init(ffb) {
  F = ffb;
  $('#sl-file').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
  $('#view-slicer').addEventListener('click', onClick);
  $('#view-slicer').addEventListener('change', onChange);
  $('#view-slicer').addEventListener('input', onInput);
  $('#sl-busy-cancel').addEventListener('click', cancelSlice);
  $('#sl-layer').addEventListener('input', () => setLayer(+$('#sl-layer').value));
  $('#sl-all-search').addEventListener('input', renderAll);
  $('#sl-all-changed').addEventListener('change', renderAll);
  $('#sl-all-list').addEventListener('change', onChange);
  $('#sl-all-list').addEventListener('click', onClick);
  $('#sl-plate-list').addEventListener('click', (e) => { const b = e.target.closest('[data-plate]'); if (b) { $('#sl-plate-dialog').close(b.dataset.plate); } });
  window.addEventListener('keydown', onKey);
  const stage = $('#sl-stage');
  ['dragenter', 'dragover'].forEach((ev) => stage.addEventListener(ev, (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); $('#sl-drop').classList.remove('hidden'); } }));
  ['dragleave', 'drop'].forEach((ev) => stage.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || e.target === $('#sl-drop')) $('#sl-drop').classList.add('hidden'); }));
  stage.addEventListener('drop', (e) => { if (e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]); });
}

export async function show(mode) {
  const st = await F.api('slicer');
  if (!st.installed) { showSetup(st); return; }
  $('#sl-setup').classList.add('hidden');
  $('#sl-wrap').classList.remove('hidden');
  if (!S.ready) setup3d();
  S.mode = mode;
  if (st.job) S.job = st.job;
  const p = F.current();
  if (p && p.id !== S.printerId) await loadPrinter(p.id);
  if (mode === 'paint' && !S.selected && S.objects.length) S.selected = S.objects[0];
  applyMode();
  resize();
  if (S.job && S.job.state === 'slicing') { poll(); return; }
  if (mode === 'preview' && S.info && S.info.known) {
    // "Slice & preview": slice straight away when the plate changed since the last slice
    if (S.objects.length && S.sliceKey !== plateKey()) slice();
    else if (!S.preview && S.job && S.job.state === 'done') loadPreview();
  }
}

export function hide() { /* rendering stops by itself when nothing changes */ }

export async function printerChanged() {
  const p = F.current();
  if (p && p.id !== S.printerId) { await loadPrinter(p.id); applyMode(); }
}

function showSetup(st) {
  $('#sl-wrap').classList.add('hidden');
  const box = $('#sl-setup');
  box.classList.remove('hidden');
  box.innerHTML = `<div class="card"><h2>Set up the slicer</h2>
    <p class="muted">The slicer engine (OrcaSlicer, about 35 MB) is downloaded once to the board. After that you can slice here: place models, paint colours, check every layer and print, with your printer's own Flashforge profiles.</p>
    ${st.supported ? '<a class="btn primary" href="#settings/general">Go to Settings → Slicer</a>' : '<div class="notice warn">The slicer engine runs on the board only.</div>'}</div>`;
}

// ================================================================== printer + profiles
const prefKey = (id) => 'ffb-slicer-' + id;
function savePrefs() {
  try { localStorage.setItem(prefKey(S.printerId), JSON.stringify({ machine: S.info && S.info.machine, process: S.process, bedType: S.bedType, filaments: S.filaments, overrides: S.overrides, color: S.previewColor })); } catch (_) { /* private mode */ }
}
function loadPrefs(id) { try { return JSON.parse(localStorage.getItem(prefKey(id)) || '{}'); } catch (_) { return {}; } }

async function loadPrinter(id, extra = '') {
  S.printerId = id;
  S.loading = true; S.err = '';
  renderSide();
  const prefs = loadPrefs(id);
  const q = `id=${encodeURIComponent(id)}${prefs.machine && !extra ? '&machine=' + encodeURIComponent(prefs.machine) : ''}${extra}`;
  const r = await F.api('slicer/printer?' + q);
  S.loading = false;
  if (!r.ok) { S.info = null; S.err = r.message || 'Could not read the printer profiles.'; renderSide(); return; }
  S.info = r;
  if (!r.known) { renderSide(); return; }
  if (!S.schema) { const sc = await F.api('slicer/schema'); S.schema = sc.settings || []; }
  S.process = r.processes.includes(prefs.process) ? prefs.process : r.defaultProcess;
  S.bedType = prefs.bedType || r.defaultBedType || '';
  S.overrides = prefs.overrides && typeof prefs.overrides === 'object' ? prefs.overrides : {};
  S.previewColor = prefs.color || 'tool';
  S.filaments = defaultFilaments(r, prefs.filaments);
  await loadValues();
  buildBed();
  for (const o of S.objects) recolor(o);
  checkBounds();
  renderSide();
  invalidate();
}

async function loadValues() {
  const r = await F.api(`slicer/resolved?id=${encodeURIComponent(S.printerId)}&machine=${encodeURIComponent(S.info.machine)}&process=${encodeURIComponent(S.process)}`);
  S.values = r.values || {};
}

/** Filaments: one per printer slot / head, matched to the loaded spools. */
function defaultFilaments(info, saved) {
  const p = F.current();
  const slots = (p && p.slots) || [];
  const n = Math.max(1, Math.min(16, slots.length || info.extruders || 1));
  const list = info.filaments;
  const pick = (material) => {
    const fam = F.family(material || 'PLA');
    const tries = [(f) => f.startsWith(`Flashforge ${fam} Basic`), (f) => f.startsWith(`Generic ${fam} @`), (f) => f.startsWith(`Flashforge ${fam}`) && !/-CF|-GF/.test(f), (f) => F.family(f.replace(/^(Flashforge|Generic)\s+/, '')) === fam];
    for (const t of tries) { const m = list.find(t); if (m) return m; }
    return list.find((f) => /PLA Basic/.test(f)) || list[0];
  };
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = slots[i];
    const keep = saved && saved[i] && list.includes(saved[i].preset) ? saved[i] : null;
    out.push(keep || { preset: pick(s && s.material), color: (s && s.hasFilament !== false && s.color) || ['#E8E8E8', '#202020', '#D32F2F', '#1E63D6'][i % 4] });
  }
  return out;
}
function useLoaded() {
  const p = F.current();
  const slots = (p && p.slots) || [];
  if (!slots.length) { F.toast('The printer did not report any loaded filament.', true); return; }
  S.filaments = defaultFilaments(S.info, null);
  savePrefs();
  for (const o of S.objects) recolor(o);
  renderSide(); invalidate();
  F.toast('Filaments set to what is loaded in the printer.');
}
const filColor = (n) => (S.filaments[n - 1] ? S.filaments[n - 1].color : '#8a8f98');

// ================================================================== 3D setup
function setup3d() {
  S.ready = true;
  const stage = $('#sl-stage');
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.domElement.tabIndex = 0;
  stage.prepend(renderer.domElement);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(40, 1, 1, 5000);
  camera.up.set(0, 0, 1);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3f47, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(-150, -250, 400); scene.add(sun);
  const fill = new THREE.DirectionalLight(0xffffff, 0.6); fill.position.set(300, 200, 150); scene.add(fill);
  bedGroup = new THREE.Group(); objGroup = new THREE.Group(); previewGroup = new THREE.Group();
  scene.add(bedGroup, objGroup, previewGroup);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.15;
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  controls.addEventListener('change', invalidate);
  tcontrols = new TransformControls(camera, renderer.domElement);
  tcontrols.setSize(0.9);
  tcontrols.addEventListener('change', invalidate);
  tcontrols.addEventListener('dragging-changed', (e) => {
    controls.enabled = !e.value;
    if (e.value) pushUndo({ type: 'xf', obj: S.selected, m: S.selected.mesh.matrix.clone() });
    else if (S.selected) { fixScale(S.selected); dropToBed(S.selected); checkBounds(); renderSide(); }
  });
  tcontrols.addEventListener('objectChange', () => { if (S.selected) { clampToBedTop(S.selected); renderXf(); } });
  scene.add(tcontrols.getHelper());
  raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true;
  brushRing = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25, depthWrite: false }));
  brushRing.visible = false; scene.add(brushRing);
  const el = renderer.domElement;
  el.addEventListener('pointerdown', onPointerDown, true);
  el.addEventListener('pointermove', onPointerMove);
  el.addEventListener('pointerup', onPointerUp);
  el.addEventListener('pointerleave', () => { brushRing.visible = false; invalidate(); });
  new ResizeObserver(resize).observe(stage);
  buildBed();
  viewHome();
  const loop = () => {
    requestAnimationFrame(loop);
    if (!$('#view-slicer').classList.contains('active')) return;
    controls.update();
    if (needRender) { needRender = false; renderer.render(scene, camera); }
  };
  loop();
}
function invalidate() { needRender = true; }
function resize() {
  if (!renderer) return;
  const st = $('#sl-stage');
  const w = st.clientWidth, h = st.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  invalidate();
}
const bed = () => (S.info && S.info.bed) || { x0: 0, y0: 0, w: 256, d: 256, h: 256 };

function buildBed() {
  if (!bedGroup) return;
  bedGroup.clear();
  const b = bed();
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(b.w, b.d), new THREE.MeshStandardMaterial({ color: 0x2b2f35, roughness: 0.9 }));
  plate.position.set(b.x0 + b.w / 2, b.y0 + b.d / 2, -0.05);
  plate.receiveShadow = true;
  bedGroup.add(plate);
  const pts = [], major = [];
  for (let x = 0; x <= b.w + 1e-6; x += 10) (Math.round(x) % 50 === 0 ? major : pts).push(b.x0 + x, b.y0, 0, b.x0 + x, b.y0 + b.d, 0);
  for (let y = 0; y <= b.d + 1e-6; y += 10) (Math.round(y) % 50 === 0 ? major : pts).push(b.x0, b.y0 + y, 0, b.x0 + b.w, b.y0 + y, 0);
  const line = (arr, color, opacity) => {
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
  };
  bedGroup.add(line(pts, 0x8a919b, 0.25), line(major, 0x9aa3ad, 0.55));
  const edge = [b.x0, b.y0, 0, b.x0 + b.w, b.y0, 0, b.x0 + b.w, b.y0, 0, b.x0 + b.w, b.y0 + b.d, 0, b.x0 + b.w, b.y0 + b.d, 0, b.x0, b.y0 + b.d, 0, b.x0, b.y0 + b.d, 0, b.x0, b.y0, 0];
  bedGroup.add(line(edge, 0x4c9aff, 0.9));
  // printable height as a faint box
  const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(b.w, b.d, b.h)), new THREE.LineBasicMaterial({ color: 0x9aa3ad, transparent: true, opacity: 0.12 }));
  box.position.set(b.x0 + b.w / 2, b.y0 + b.d / 2, b.h / 2);
  bedGroup.add(box);
  invalidate();
}
function viewHome() {
  const b = bed();
  const c = new THREE.Vector3(b.x0 + b.w / 2, b.y0 + b.d / 2, 0);
  const r = Math.max(b.w, b.d);
  camera.position.set(c.x, c.y - r * 1.25, r * 1.0);
  controls.target.copy(c);
  controls.update();
  invalidate();
}

// ================================================================== objects
/**
 * Adds a model. positions: world mm (Float32Array, 9 per triangle); codes: paint per triangle or null.
 * place: 'keep' (3MF positions) or 'center' (new STL/OBJ: middle of the free space).
 */
function addObject({ name, positions, codes, filament = 1 }) {
  // centre the model on its own bounding box; the mesh position puts it back
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
  const orig = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) { orig[i] = positions[i] - cx; orig[i + 1] = positions[i + 1] - cy; orig[i + 2] = positions[i + 2] - cz; }
  const sub = subdivide(orig, { budget: Math.max(150000, 900000 - totalTris()) });
  const states = new Uint8Array(sub.count);
  if (codes) {
    for (let t = 0; t < codes.length; t++) {
      if (!codes[t]) continue;
      let tree;
      try { tree = decodeTree(codes[t]); } catch (_) { continue; }
      const lvl = sub.levels[t], st = sub.start[t];
      if (!tree.children) { states.fill(Math.min(tree.state, 16), st, st + 4 ** lvl); continue; }
      const cs = pieceCentres(lvl);
      for (let k = 0; k < cs.length; k++) states[st + k] = Math.min(stateAt(tree, cs[k]), 16);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(sub.fine, 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(sub.fine.length), 3));
  g.computeVertexNormals();
  g.computeBoundsTree();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.02, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(g, mat);
  mesh.position.set(cx, cy, cz);
  const o = { id: nextId++, name: name || 'Model', mesh, orig, levels: sub.levels, start: sub.start, states, filament: Math.max(1, filament), outside: false };
  mesh.userData.obj = o;
  objGroup.add(mesh);
  S.objects.push(o);
  recolor(o);
  return o;
}
const totalTris = () => S.objects.reduce((n, o) => n + o.states.length, 0);

function recolor(o, from = 0, to = o.states.length) {
  const col = o.mesh.geometry.attributes.color;
  const arr = col.array;
  const cache = new Map();
  const rgb = (n) => {
    if (!cache.has(n)) { const c = new THREE.Color(filColor(n)).convertSRGBToLinear(); cache.set(n, [c.r, c.g, c.b]); }
    return cache.get(n);
  };
  for (let t = from; t < to; t++) {
    const c = rgb(o.states[t] || o.filament);
    const k = t * 9;
    arr[k] = arr[k + 3] = arr[k + 6] = c[0];
    arr[k + 1] = arr[k + 4] = arr[k + 7] = c[1];
    arr[k + 2] = arr[k + 5] = arr[k + 8] = c[2];
  }
  col.needsUpdate = true;
  invalidate();
}

function worldBox(o) { o.mesh.updateMatrixWorld(true); return new THREE.Box3().setFromObject(o.mesh, true); }
function dropToBed(o) {
  const b = worldBox(o);
  o.mesh.position.z -= b.min.z;
  o.mesh.updateMatrixWorld(true);
  invalidate();
}
function clampToBedTop(o) { /* keep moves on the plate plane */ if (tcontrols.mode === 'translate') dropToBed(o); }
function fixScale(o) {
  const s = o.mesh.scale;
  s.set(Math.max(0.01, Math.abs(s.x)), Math.max(0.01, Math.abs(s.y)), Math.max(0.01, Math.abs(s.z)));
}
function checkBounds() {
  const b = bed();
  for (const o of S.objects) {
    const w = worldBox(o);
    o.outside = w.min.x < b.x0 - 0.01 || w.min.y < b.y0 - 0.01 || w.max.x > b.x0 + b.w + 0.01 || w.max.y > b.y0 + b.d + 0.01 || w.max.z > b.h + 0.01;
    o.mesh.material.emissive.setHex(o.outside ? 0x5a0d0d : (o === S.selected ? 0x10294d : 0x000000));
  }
  $('#sl-empty').classList.toggle('hidden', !!S.objects.length || S.mode === 'preview');
  invalidate();
}

function select(o) {
  S.selected = o;
  if (o && S.mode === 'prepare' && ['move', 'rotate', 'scale'].includes(S.tool)) {
    tcontrols.attach(o.mesh);
    tcontrols.setMode({ move: 'translate', rotate: 'rotate', scale: 'scale' }[S.tool]);
    tcontrols.showZ = S.tool !== 'move';
  } else tcontrols.detach();
  checkBounds();
  renderSide();
}

function removeObject(o) {
  if (!o) return;
  pushUndo({ type: 'remove', obj: o });
  objGroup.remove(o.mesh);
  S.objects = S.objects.filter((x) => x !== o);
  if (S.selected === o) select(null);
  checkBounds(); renderSide();
}
function duplicate(o) {
  if (!o) return;
  const g = o.mesh.geometry.clone();
  g.computeBoundsTree();
  const mesh = new THREE.Mesh(g, o.mesh.material.clone());
  mesh.position.copy(o.mesh.position); mesh.quaternion.copy(o.mesh.quaternion); mesh.scale.copy(o.mesh.scale);
  const c = { ...o, id: nextId++, mesh, states: o.states.slice(), name: o.name + ' (copy)' };
  mesh.userData.obj = c;
  objGroup.add(mesh);
  S.objects.push(c);
  const w = worldBox(o);
  mesh.position.x += w.max.x - w.min.x + 5;
  if (!placeFree(c)) arrange();
  dropToBed(c); select(c);
}

/** Moves an object to a free spot on the plate (false when there is none). */
function placeFree(o) {
  const b = bed();
  const w = worldBox(o);
  const sx = w.max.x - w.min.x, sy = w.max.y - w.min.y;
  const others = S.objects.filter((x) => x !== o).map(worldBox);
  const free = (x, y) => others.every((q) => x + sx + 3 < q.min.x || x - 3 > q.max.x || y + sy + 3 < q.min.y || y - 3 > q.max.y);
  const cx = b.x0 + b.w / 2 - sx / 2, cy = b.y0 + b.d / 2 - sy / 2;
  const cand = [];
  for (let y = b.y0 + 2; y + sy <= b.y0 + b.d - 2; y += 5) for (let x = b.x0 + 2; x + sx <= b.x0 + b.w - 2; x += 5) cand.push([x, y]);
  cand.sort((p, q) => Math.hypot(p[0] - cx, p[1] - cy) - Math.hypot(q[0] - cx, q[1] - cy));
  const spot = free(cx, cy) && cx >= b.x0 ? [cx, cy] : cand.find(([x, y]) => free(x, y));
  if (!spot) return false;
  o.mesh.position.x += spot[0] - w.min.x;
  o.mesh.position.y += spot[1] - w.min.y;
  o.mesh.updateMatrixWorld(true);
  return true;
}

/** Shelf packing of all objects on the plate, biggest first. */
function arrange() {
  if (!S.objects.length) return;
  pushUndo({ type: 'many', list: S.objects.map((o) => ({ obj: o, m: o.mesh.matrix.clone() })) });
  const b = bed(), gap = 6;
  const items = S.objects.map((o) => ({ o, w: worldBox(o) })).sort((p, q) => (q.w.max.y - q.w.min.y) - (p.w.max.y - p.w.min.y));
  let x = 0, y = 0, rowH = 0, rows = [[]];
  for (const it of items) {
    const sx = it.w.max.x - it.w.min.x, sy = it.w.max.y - it.w.min.y;
    if (x > 0 && x + sx > b.w) { y += rowH + gap; x = 0; rowH = 0; rows.push([]); }
    it.x = x; it.y = y; x += sx + gap; rowH = Math.max(rowH, sy);
    rows[rows.length - 1].push(it);
  }
  const totalH = y + rowH;
  const offY = b.y0 + Math.max(0, (b.d - totalH) / 2);
  for (const row of rows) {
    const rowW = row.length ? row[row.length - 1].x + (row[row.length - 1].w.max.x - row[row.length - 1].w.min.x) : 0;
    const offX = b.x0 + Math.max(0, (b.w - rowW) / 2);
    for (const it of row) {
      it.o.mesh.position.x += offX + it.x - it.w.min.x;
      it.o.mesh.position.y += offY + it.y - it.w.min.y;
      it.o.mesh.updateMatrixWorld(true);
    }
  }
  checkBounds(); renderSide();
  if (S.objects.some((o) => o.outside)) F.toast('Not everything fits on the plate. Remove or shrink something.', true);
}

/** Rotates so the given world-space direction points down onto the plate. */
function layDown(o, worldNormal) {
  pushUndo({ type: 'xf', obj: o, m: o.mesh.matrix.clone() });
  const q = new THREE.Quaternion().setFromUnitVectors(worldNormal.clone().normalize(), new THREE.Vector3(0, 0, -1));
  o.mesh.quaternion.premultiply(q);
  o.mesh.updateMatrixWorld(true);
  dropToBed(o); checkBounds(); renderSide();
}

/** Auto-orient: the biggest flat side goes down. */
function autoOrient(o) {
  if (!o) return;
  o.mesh.updateMatrixWorld(true);
  const p = o.orig, m = o.mesh.matrixWorld;
  const areas = new Map();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < p.length; i += 9) {
    a.set(p[i], p[i + 1], p[i + 2]).applyMatrix4(m); b.set(p[i + 3], p[i + 4], p[i + 5]).applyMatrix4(m); c.set(p[i + 6], p[i + 7], p[i + 8]).applyMatrix4(m);
    n.subVectors(b, a).cross(c.clone().sub(a));
    const area = n.length() / 2;
    if (area < 1e-6) continue;
    n.normalize();
    const key = `${Math.round(n.x * 40)},${Math.round(n.y * 40)},${Math.round(n.z * 40)}`;
    const e = areas.get(key) || { area: 0, n: new THREE.Vector3() };
    e.area += area; e.n.addScaledVector(n, area);
    areas.set(key, e);
  }
  let best = null;
  for (const e of areas.values()) if (!best || e.area > best.area) best = e;
  if (best) layDown(o, best.n.normalize());
}

// ================================================================== importing files
async function addFiles(files) {
  if (!files.length) return;
  if (S.mode !== 'prepare' && S.mode !== 'paint') location.hash = '#slicer/prepare';
  for (const file of files) {
    const lower = file.name.toLowerCase();
    try {
      busy('Opening ' + file.name + '…', 'Reading the model…', null);
      await new Promise((r) => setTimeout(r, 30));
      const buf = await file.arrayBuffer();
      const base = file.name.replace(/\.[^.]+$/, '');
      if (lower.endsWith('.3mf')) await add3mf(buf, base);
      else if (lower.endsWith('.stl')) {
        const g = new STLLoader().parse(buf);
        placeNew(addObject({ name: base, positions: nonIndexed(g) }));
      } else if (lower.endsWith('.obj')) {
        const grp = new OBJLoader().parse(new TextDecoder().decode(buf));
        const parts = [];
        grp.updateMatrixWorld(true);
        grp.traverse((ch) => { if (ch.isMesh) { const g = ch.geometry.clone(); g.applyMatrix4(ch.matrixWorld); parts.push(nonIndexed(g)); } });
        if (!parts.length) throw new Error('No surfaces found in this OBJ.');
        const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
        let k = 0; for (const p of parts) { all.set(p, k); k += p.length; }
        placeNew(addObject({ name: base, positions: all }));
      } else throw new Error('Only STL, OBJ and 3MF files can be added.');
    } catch (e) {
      F.toast(file.name + ': ' + e.message, true);
    } finally { busy(null); }
  }
  S.preview = null; clearPreview();
  checkBounds(); renderSide();
  if (S.objects.length === files.length || S.objects.length <= 3) frameObjects();
}
function nonIndexed(g) {
  const ng = g.index ? g.toNonIndexed() : g;
  return Float32Array.from(ng.attributes.position.array);
}
function placeNew(o) {
  dropToBed(o);
  if (!placeFree(o)) { F.toast('No free space left on the plate; put it next to it.', true); }
  checkBounds();
  select(o);
}

async function add3mf(buf, base) {
  const r = import3mf(buf);
  let objs = r.objects;
  if (r.plates.length > 1) {
    const list = $('#sl-plate-list');
    list.innerHTML = r.plates.map((p) => `<button type="button" class="list-item" data-plate="${p.id}"><span>Plate ${p.id}${p.name ? ' – ' + esc(p.name) : ''}</span><span class="sub">${p.objectIds.length} object${p.objectIds.length === 1 ? '' : 's'}</span></button>`).join('');
    const d = $('#sl-plate-dialog');
    busy(null);
    d.showModal();
    const choice = await new Promise((res) => d.addEventListener('close', () => res(d.returnValue), { once: true }));
    if (!choice) return;
    const plate = r.plates.find((p) => String(p.id) === choice);
    const ids = new Set(plate.objectIds);
    objs = objs.filter((o) => ids.has(o.id));
  }
  const added = [];
  for (const o of objs) {
    added.push(addObject({ name: o.name || base, positions: o.positions, codes: o.paint, filament: o.filament }));
  }
  // The project was made for another printer: if it does not sit on this plate, centre it.
  const b = bed();
  const box = new THREE.Box3();
  added.forEach((o) => box.union(worldBox(o)));
  const fits = box.min.x >= b.x0 && box.min.y >= b.y0 && box.max.x <= b.x0 + b.w && box.max.y <= b.y0 + b.d;
  const dx = fits ? 0 : b.x0 + b.w / 2 - (box.min.x + box.max.x) / 2, dy = fits ? 0 : b.y0 + b.d / 2 - (box.min.y + box.max.y) / 2;
  for (const o of added) { o.mesh.position.x += dx; o.mesh.position.y += dy; dropToBed(o); }
  const maxFil = Math.max(...added.map((o) => Math.max(o.filament, ...o.states)));
  if (maxFil > S.filaments.length) F.toast(`This project uses ${maxFil} filaments; your printer has ${S.filaments.length}. Parts on filament ${S.filaments.length + 1}+ show grey — pick other filaments for them.`, true);
  if (r.skipped) F.toast(`${r.skipped} modifier / helper part${r.skipped === 1 ? ' was' : 's were'} left out (only printable parts are opened).`);
  F.toast(`Opened ${base}: ${added.length} object${added.length === 1 ? '' : 's'}. Your printer's own profiles are used, not the ones saved in the project.`);
  if (added.length) select(added[0]);
}

function frameObjects() {
  if (!S.objects.length) { viewHome(); return; }
  const box = new THREE.Box3();
  S.objects.forEach((o) => box.union(worldBox(o)));
  const c = box.getCenter(new THREE.Vector3());
  const r = Math.max(60, box.getSize(new THREE.Vector3()).length());
  const dir = camera.position.clone().sub(controls.target).normalize();
  controls.target.copy(c);
  camera.position.copy(c).addScaledVector(dir, r * 1.6);
  controls.update(); invalidate();
}

// ================================================================== pointer: select, lay on face, paint
let painting = null; // {obj, changed: Map}
const pointer = new THREE.Vector2();
function hitAt(e) {
  const r = renderer.domElement.getBoundingClientRect();
  pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(objGroup.children, false);
  return hits[0] || null;
}
let downAt = null;
function onPointerDown(e) {
  if (S.mode === 'preview' || e.button !== 0) return;
  downAt = [e.clientX, e.clientY];
  if (S.mode === 'paint') {
    const h = hitAt(e);
    if (!h) return; // orbit
    e.stopPropagation(); e.preventDefault();
    controls.enabled = false;
    const o = h.object.userData.obj;
    painting = { obj: o, changed: new Map() };
    paintAt(h);
    renderer.domElement.setPointerCapture(e.pointerId);
  }
}
function onPointerMove(e) {
  if (S.mode !== 'paint') return;
  const h = hitAt(e);
  if (h) {
    brushRing.visible = true;
    brushRing.position.copy(h.point);
    brushRing.scale.setScalar(S.paint.size);
    if (painting && h.object.userData.obj === painting.obj) paintAt(h);
  } else brushRing.visible = false;
  invalidate();
}
function onPointerUp(e) {
  if (painting) {
    if (painting.changed.size) pushUndo({ type: 'paint', obj: painting.obj, changed: painting.changed });
    painting = null; controls.enabled = true;
    S.preview = null;
    renderSide();
    return;
  }
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4 || tcontrols.dragging) { downAt = null; return; }
  downAt = null;
  if (S.mode === 'preview') return;
  const h = hitAt(e);
  if (S.mode === 'prepare' && S.tool === 'face' && h) {
    const n = h.face.normal.clone().transformDirection(h.object.matrixWorld);
    layDown(h.object.userData.obj, n);
    return;
  }
  if (S.mode === 'prepare') select(h ? h.object.userData.obj : null);
}

const fineTri = (geom, triIndex) => { const a = geom.index ? geom.index.getX(triIndex * 3) : triIndex * 3; return Math.floor(a / 3); };
function paintAt(h) {
  const o = painting.obj;
  const mesh = o.mesh;
  const inv = mesh.matrixWorld.clone().invert();
  const centre = h.point.clone().applyMatrix4(inv);
  const s = mesh.scale;
  const sphere = new THREE.Sphere(centre, S.paint.size / Math.max(s.x, s.y, s.z));
  const value = S.paint.filament; // 0 = back to the object's filament
  let lo = Infinity, hi = -1;
  mesh.geometry.boundsTree.shapecast({
    intersectsBounds: (box) => (sphere.intersectsBox(box) ? (sphere.containsPoint(box.min) && sphere.containsPoint(box.max) ? CONTAINED : INTERSECTED) : NOT_INTERSECTED),
    intersectsTriangle: (tri, triIndex) => {
      if (!tri.intersectsSphere(sphere)) return false;
      const t = fineTri(mesh.geometry, triIndex);
      if (o.states[t] === value) return false;
      if (!painting.changed.has(t)) painting.changed.set(t, o.states[t]);
      o.states[t] = value;
      if (t < lo) lo = t; if (t > hi) hi = t;
      return false;
    },
  });
  if (hi >= 0) recolor(o, lo, hi + 1);
}

function fillObject(o, value) {
  if (!o) return;
  const changed = new Map();
  for (let t = 0; t < o.states.length; t++) if (o.states[t] !== 0) changed.set(t, o.states[t]);
  pushUndo({ type: 'paint', obj: o, changed, filament: o.filament });
  o.states.fill(0);
  o.filament = value || o.filament;
  recolor(o); renderSide();
}

// ================================================================== undo
function pushUndo(u) { S.undo.push(u); if (S.undo.length > 40) S.undo.shift(); }
function undo() {
  const u = S.undo.pop();
  if (!u) return;
  if (u.type === 'xf') { u.obj.mesh.matrix.copy(u.m); u.obj.mesh.matrix.decompose(u.obj.mesh.position, u.obj.mesh.quaternion, u.obj.mesh.scale); }
  if (u.type === 'many') for (const it of u.list) { it.obj.mesh.matrix.copy(it.m); it.obj.mesh.matrix.decompose(it.obj.mesh.position, it.obj.mesh.quaternion, it.obj.mesh.scale); }
  if (u.type === 'paint') { for (const [t, v] of u.changed) u.obj.states[t] = v; if (u.filament) u.obj.filament = u.filament; recolor(u.obj); }
  if (u.type === 'remove') { objGroup.add(u.obj.mesh); S.objects.push(u.obj); }
  S.preview = null;
  checkBounds(); renderSide(); invalidate();
}

function onKey(e) {
  if (!$('#view-slicer').classList.contains('active') || e.target.closest('input, select, textarea, dialog')) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if (S.mode === 'preview') {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); setLayer((S.layer || 1) + (e.key === 'ArrowUp' ? 1 : -1)); }
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && S.selected && S.mode === 'prepare') { removeObject(S.selected); return; }
  if (S.mode === 'paint' && /^[0-9]$/.test(e.key)) { const n = +e.key; if (n <= S.filaments.length) { S.paint.filament = n; renderSide(); } return; }
  if (S.mode === 'paint' && (e.key === '[' || e.key === ']')) { S.paint.size = Math.max(0.5, Math.min(30, S.paint.size * (e.key === ']' ? 1.25 : 0.8))); renderSide(); return; }
  const keys = { m: 'move', r: 'rotate', s: 'scale', f: 'face' };
  if (S.mode === 'prepare' && keys[e.key.toLowerCase()]) setTool(keys[e.key.toLowerCase()]);
}
function setTool(t) {
  S.tool = t;
  select(S.selected);
  renderTools();
}

// ================================================================== mode + tool bar
const ICON = {
  add: '<path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z"/>',
  move: '<path d="M10 9h4V6h3l-5-5-5 5h3v3zm-1 1H6V7l-5 5 5 5v-3h3v-4zm14 2-5-5v3h-3v4h3v3l5-5zm-9 3h-4v3H7l5 5 5-5h-3v-3z"/>',
  rotate: '<path d="M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/>',
  scale: '<path d="M21 3h-7l2.6 2.6L12 10.2 13.8 12l4.6-4.6L21 10V3zM3 21h7l-2.6-2.6 4.6-4.6L10.2 12l-4.6 4.6L3 14v7z"/>',
  face: '<path d="M4 18h16v2H4zM12 3 5 10l1.4 1.4L11 6.8V16h2V6.8l4.6 4.6L19 10z"/>',
  orient: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>',
  arrange: '<path d="M3 3h8v8H3zm10 0h8v5h-8zm0 7h8v11h-8zM3 13h8v8H3z"/>',
  copy: '<path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/>',
  del: '<path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>',
  undo: '<path d="M12.5 8c-2.6 0-5 1-6.9 2.6L2 7v9h9l-3.6-3.6A8 8 0 0 1 20.1 16l2.4-.8A10.5 10.5 0 0 0 12.5 8z"/>',
  home: '<path d="M12 5.7 17 10v8h-3v-5h-4v5H7v-8l5-4.3M12 3 2 12h3v8h6v-6h2v6h6v-8h3L12 3z"/>',
};
const ic = (n) => `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><g fill="currentColor">${ICON[n]}</g></svg>`;
function renderTools() {
  const t = $('#sl-tools');
  const sel = !!S.selected;
  if (S.mode === 'prepare') {
    t.innerHTML = `<div class="grp"><button data-sl="add" title="Add a model (STL, OBJ, 3MF)">${ic('add')}</button></div>
      <div class="grp">${[['move', 'Move (M)'], ['rotate', 'Rotate (R)'], ['scale', 'Scale (S)'], ['face', 'Lay on face (F): click the side that should be on the plate']].map(([k, tt]) => `<button data-tool="${k}" class="${S.tool === k ? 'active' : ''}" title="${tt}">${ic(k)}</button>`).join('')}</div>
      <div class="grp"><button data-sl="orient" title="Auto-orient: biggest flat side down" ${sel ? '' : 'disabled'}>${ic('orient')}</button>
        <button data-sl="arrange" title="Arrange everything on the plate" ${S.objects.length ? '' : 'disabled'}>${ic('arrange')}</button>
        <button data-sl="copy" title="Duplicate" ${sel ? '' : 'disabled'}>${ic('copy')}</button>
        <button data-sl="del" title="Delete (Del)" ${sel ? '' : 'disabled'}>${ic('del')}</button></div>
      <div class="grp"><button data-sl="undo" title="Undo (Ctrl+Z)" ${S.undo.length ? '' : 'disabled'}>${ic('undo')}</button><button data-sl="view" title="Reset view">${ic('home')}</button></div>`;
  } else if (S.mode === 'paint') {
    t.innerHTML = `<div class="grp"><button data-sl="undo" title="Undo (Ctrl+Z)" ${S.undo.length ? '' : 'disabled'}>${ic('undo')}</button><button data-sl="view" title="Reset view">${ic('home')}</button></div>`;
  } else t.innerHTML = `<div class="grp"><button data-sl="view" title="Reset view">${ic('home')}</button></div>`;
  const touch = matchMedia('(pointer: coarse)').matches;
  const hints = {
    prepare: S.tool === 'face' ? 'Tap the side of a model that should lie on the plate' : (S.objects.length ? (touch ? 'Tap a model to select it · one finger turns the view · two fingers zoom and move' : 'Click a model to select it · drag to turn the view · right-drag to pan · wheel to zoom') : ''),
    paint: touch ? 'Drag on a model to paint · drag next to it to turn the view' : 'Drag on a model to paint · drag next to it to turn the view · keys 1–9 pick a filament, [ ] brush size',
    preview: '',
  };
  $('#sl-hint').textContent = S.objects.length || S.mode !== 'prepare' ? hints[S.mode] : '';
}

function applyMode() {
  const prev = S.mode === 'preview';
  objGroup.visible = !prev;
  previewGroup.visible = prev;
  bedGroup.visible = true;
  brushRing.visible = false;
  $('#sl-layers').classList.toggle('hidden', !prev || !S.preview);
  $('#sl-legend').classList.toggle('hidden', !prev || !S.preview);
  if (S.mode !== 'prepare') tcontrols.detach(); else select(S.selected);
  checkBounds();
  renderTools(); renderSide();
  invalidate();
}

// ================================================================== side panel
function renderSide() {
  const side = $('#sl-side');
  if (!side || !$('#view-slicer').classList.contains('active') && side.innerHTML) return;
  if (S.loading) { side.innerHTML = '<div class="card"><p class="muted">Reading the printer profiles…</p></div>'; return; }
  if (S.err) { side.innerHTML = `<div class="card"><div class="notice err">${esc(S.err)}</div><button class="btn small" data-sl="retry">Try again</button></div>`; return; }
  if (!S.info) { side.innerHTML = '<div class="card"><p class="muted">Add a printer first (Settings → Advanced → Printers).</p></div>'; return; }
  if (!S.info.known) {
    side.innerHTML = `<div class="card"><h2>Which printer is ${esc(S.info.name)}?</h2>
      <p class="muted small">The printer has not told the board its model yet (is it switched on?). Pick it once; only its own profiles are used.</p>
      <select data-set="model"><option value="">Choose…</option>${S.info.models.map((m) => `<option>${esc(m)}</option>`).join('')}</select></div>`;
    return;
  }
  if (S.mode === 'paint') side.innerHTML = paintPanel();
  else if (S.mode === 'preview') side.innerHTML = previewPanel();
  else side.innerHTML = preparePanel();
  renderTools();
}

function printerCard() {
  const i = S.info;
  const nozzle = (n) => (/(\d\.\d+)\s*(HF\s*)?nozzle/i.exec(n) || [n, n])[0];
  const bedEnum = (S.schema || []).find((s) => s.key === 'curr_bed_type');
  return `<div class="card"><h2><span class="sl-printer">${esc(i.model.replace(/^Flashforge /, 'Flashforge '))}</span>
      <span class="lock" title="Only profiles of the open printer can be used">🔒 ${esc(i.name)}</span></h2>
    <div class="row gap">
      <label class="field" style="flex:1"><span class="label">Nozzle</span><select data-set="machine">${i.nozzles.map((n) => `<option value="${esc(n)}" ${n === i.machine ? 'selected' : ''}>${esc(nozzle(n))}</option>`).join('')}</select></label>
      <label class="field" style="flex:1.4"><span class="label">Plate</span><select data-set="bed">${(bedEnum ? bedEnum.enum : [{ value: S.bedType, label: S.bedType }]).map((e) => `<option value="${esc(e.value)}" ${e.value === S.bedType ? 'selected' : ''}>${esc(e.label)}</option>`).join('')}</select></label>
    </div></div>`;
}

function filamentsCard(withPresets = true) {
  const p = F.current();
  return `<div class="card"><h2>Filaments ${(p && p.slots && p.slots.length) ? '<button class="btn tiny" data-sl="loaded" title="Use the spools loaded in the printer">Use loaded</button>' : ''}</h2>
    <div class="sl-fils">${S.filaments.map((f, i) => `<div class="sl-fil"><span class="n">${i + 1}</span>
      <input type="color" value="${esc(f.color)}" data-fil-color="${i}" title="Colour of filament ${i + 1}">
      ${withPresets ? `<select data-fil-preset="${i}">${S.info.filaments.map((x) => `<option ${x === f.preset ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>` : `<span class="small">${esc(f.preset.replace(/ @.*$/, ''))}</span>`}</div>`).join('')}</div></div>`;
}

const fmtVal = (v) => (Array.isArray(v) ? v[0] : v);
function valueOf(key) { return S.overrides[key] !== undefined ? S.overrides[key] : (key === 'curr_bed_type' ? S.bedType : fmtVal(S.values[key])); }
function settingRow(s, label, tip = false) {
  const key = s.key, v = String(valueOf(key) ?? ''), changed = S.overrides[key] !== undefined;
  let input;
  if (s.type === 'bool') input = `<input type="checkbox" data-ov="${key}" ${v === '1' || v === 'true' ? 'checked' : ''}>`;
  else if (s.type === 'enum') input = `<select data-ov="${key}">${s.enum.map((e) => `<option value="${esc(e.value)}" ${e.value === v ? 'selected' : ''}>${esc(e.label)}</option>`).join('')}</select>`;
  else if (s.type === 'percent') input = `<span class="unit-in"><input type="number" data-ov="${key}" data-pct value="${esc(v.replace('%', ''))}" ${s.min !== undefined ? `min="${s.min}"` : ''} ${s.max !== undefined ? `max="${s.max}"` : ''} step="any"><span>%</span></span>`;
  else if (s.type === 'int' || s.type === 'float') input = `<span class="unit-in"><input type="number" data-ov="${key}" value="${esc(v)}" ${s.min !== undefined ? `min="${s.min}"` : ''} ${s.max !== undefined && s.max < 1e6 ? `max="${s.max}"` : ''} step="${s.type === 'int' ? 1 : 'any'}"><span>${esc(s.unit || '')}</span></span>`;
  else input = `<input data-ov="${key}" value="${esc(v)}" title="${esc(s.unit || '')}">`;
  return `<div class="sl-set ${changed ? 'changed' : ''}"><span class="nm" title="${esc(s.tooltip || '')}"><span>${esc(label || s.label)}</span>${changed ? `<button class="reset" data-reset="${key}" title="Back to the profile's value">↺</button>` : ''}</span>${input}${tip && s.tooltip ? `<span class="tip">${esc(s.tooltip)}</span>` : ''}</div>`;
}

function preparePanel() {
  const byKey = new Map((S.schema || []).map((s) => [s.key, s]));
  const nChanged = Object.keys(S.overrides).filter((k) => k !== 'curr_bed_type').length;
  const sel = S.selected;
  return `${printerCard()}${filamentsCard()}
    <div class="card"><h2>Quality <button class="btn tiny" data-sl="all">All settings${nChanged ? ` (${nChanged} changed)` : ''}</button></h2>
      <label class="field"><span class="label">Profile</span><select data-set="process">${S.info.processes.map((p) => `<option ${p === S.process ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></label>
      ${SIMPLE.map(([k, l]) => byKey.has(k) ? settingRow(byKey.get(k), l) : '').join('')}
    </div>
    <div class="card"><h2>Objects <span class="muted small">${S.objects.length || ''}</span></h2>
      ${S.objects.length ? `<div class="sl-objs">${S.objects.map((o) => `<div class="sl-obj ${o === sel ? 'sel' : ''}" data-obj="${o.id}">
        ${F.swatch(filColor(o.filament), 'sm')}<span class="nm" title="${esc(o.name)}">${esc(o.name)} ${o.outside ? '<span class="warn">off the plate</span>' : ''}</span>
        <select data-obj-fil="${o.id}" title="Filament">${S.filaments.map((_, i) => `<option value="${i + 1}" ${o.filament === i + 1 ? 'selected' : ''}>${i + 1}</option>`).join('')}</select>
        <button data-obj-del="${o.id}" title="Delete">✕</button></div>`).join('')}</div>${sel ? xfFields(sel) : ''}`
        : '<p class="muted small">Nothing on the plate yet. Drop STL, OBJ or 3MF files on the 3D view.</p>'}
      <div class="row gap wrap" style="margin-top:8px"><button class="btn small" data-sl="add">Add model</button>${S.objects.length ? '<button class="btn small" data-sl="arrange">Arrange</button><button class="btn small ghost-danger" data-sl="clear">Clear plate</button>' : ''}</div>
    </div>
    ${goButton()}`;
}
function xfFields(o) {
  const m = o.mesh, b = worldBox(o);
  const e = new THREE.Euler().setFromQuaternion(m.quaternion, 'XYZ');
  const deg = (r) => Math.round(THREE.MathUtils.radToDeg(r) * 10) / 10;
  const r1 = (v) => Math.round(v * 10) / 10;
  return `<div class="sl-xf" id="sl-xf">
    <label>X mm<input type="number" step="1" data-xf="x" value="${r1((b.min.x + b.max.x) / 2)}"></label>
    <label>Y mm<input type="number" step="1" data-xf="y" value="${r1((b.min.y + b.max.y) / 2)}"></label>
    <label>Turn °<input type="number" step="15" data-xf="rz" value="${deg(e.z)}"></label>
    <label>Size %<input type="number" step="5" min="1" data-xf="s" value="${Math.round(m.scale.x * 1000) / 10}"></label>
    <label>Tilt X °<input type="number" step="15" data-xf="rx" value="${deg(e.x)}"></label>
    <label>Tilt Y °<input type="number" step="15" data-xf="ry" value="${deg(e.y)}"></label>
  </div><p class="hint">${r1(b.max.x - b.min.x)} × ${r1(b.max.y - b.min.y)} × ${r1(b.max.z - b.min.z)} mm</p>`;
}
function renderXf() {
  const box = $('#sl-xf');
  if (box && S.selected && !box.contains(document.activeElement)) box.outerHTML = xfFields(S.selected).replace(/<p class="hint">.*<\/p>$/, '');
}

function goButton() {
  const busyNow = S.job && S.job.state === 'slicing';
  const dis = !S.objects.length || S.objects.some((o) => o.outside) || busyNow;
  return `<div class="sl-go"><button class="btn primary big" data-sl="slice" ${dis ? 'disabled' : ''}>${busyNow ? 'Slicing…' : 'Slice & preview'}</button>
    ${S.objects.some((o) => o.outside) ? '<p class="hint" style="text-align:center">Move everything onto the plate first.</p>' : ''}
    <div class="sl-source">OrcaSlicer engine (AGPL-3.0) · <a href="https://github.com/Helio-Additive/slicer-cli" target="_blank" rel="noopener">source</a></div></div>`;
}

function paintPanel() {
  const o = S.selected;
  return `${filamentsCard(false)}
    <div class="card"><h2>Brush</h2>
      <div class="sl-pal">${S.filaments.map((f, i) => `<button data-pf="${i + 1}" class="${S.paint.filament === i + 1 ? 'active' : ''}" style="background:${esc(f.color)};color:${contrast(f.color)}" title="Filament ${i + 1} (key ${i + 1})">${i + 1}</button>`).join('')}
        <button data-pf="0" class="erase ${S.paint.filament === 0 ? 'active' : ''}" title="Eraser: back to the object's own filament (key 0)">⌫</button></div>
      <label class="field" style="margin-top:12px"><span class="label">Brush size: <b id="sl-bs">${S.paint.size.toFixed(1)} mm</b></span><input type="range" min="0.5" max="30" step="0.5" value="${S.paint.size}" data-set="brush"></label>
      <p class="hint">Painting is as fine as the model allows: very large flat faces are split into pieces of about 2 mm.</p>
    </div>
    <div class="card"><h2>Whole object</h2>
      ${S.objects.length ? `<label class="field"><span class="label">Object</span><select data-set="paintobj">${S.objects.map((x) => `<option value="${x.id}" ${x === o ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
      <div class="row gap wrap"><button class="btn small" data-sl="fillobj" ${o ? '' : 'disabled'}>Whole object in filament ${S.paint.filament || o?.filament || 1}</button><button class="btn small" data-sl="clearpaint" ${o ? '' : 'disabled'}>Remove its paint</button></div>`
        : '<p class="muted small">Add a model in Prepare first.</p>'}
    </div>
    ${goButton()}`;
}
const contrast = (hex) => { const h = hex.replace('#', ''); const l = (0.299 * parseInt(h.substr(0, 2), 16) + 0.587 * parseInt(h.substr(2, 2), 16) + 0.114 * parseInt(h.substr(4, 2), 16)); return l > 150 ? '#111' : '#fff'; };

function previewPanel() {
  const j = S.job;
  if (!j) return `<div class="card"><p class="muted">Nothing sliced yet.</p><a class="btn primary" href="#slicer/prepare">Back to Prepare</a></div>`;
  if (j.state === 'error') return `<div class="card"><h2>Slicing failed</h2><div class="notice err">${esc(j.error || j.message)}</div><a class="btn" href="#slicer/prepare">Back to Prepare</a></div>`;
  if (j.state !== 'done') return `<div class="card"><p class="muted">${esc(j.message || 'Slicing…')}</p></div>`;
  const st = j.stats || {};
  const used = (st.grams || []).map((g, i) => [i, g, (st.meters || [])[i]]).filter((x) => x[1] > 0);
  const stale = S.objects.length && S.sliceKey && S.sliceKey !== plateKey();
  return `<div class="card"><h2>${esc(j.name.replace(/\.gcode(\.3mf)?$/, ''))}</h2>
      ${stale ? '<div class="notice warn">The plate changed since this slice. <button class="btn tiny" data-sl="slice">Slice again</button></div>' : ''}
      <div class="sl-stats"><div><span class="muted small">Print time</span><div class="big">${esc(st.time || '–')}</div></div>
      <div class="row gap wrap small muted"><span>${st.layers || 0} layers</span><span>${(st.totalGrams || 0).toFixed(1)} g</span>${st.changes ? `<span>${st.changes} filament changes</span>` : ''}</div></div>
    </div>
    <div class="card"><h2>Filament use</h2>${used.map(([i, g, m]) => `<div class="sl-use">${F.swatch(filColor(i + 1), 'sm')}<span>${i + 1} · ${esc((S.filaments[i] || {}).preset ? S.filaments[i].preset.replace(/ @.*$/, '') : '')}</span><span>${g.toFixed(1)} g${m ? ` · ${m} m` : ''}</span></div>`).join('') || '<p class="muted small">–</p>'}</div>
    ${(j.warnings || []).length ? `<div class="card"><h2>Check</h2>${j.warnings.map((w) => `<div class="notice warn small">${esc(w)}</div>`).join('')}</div>` : ''}
    <div class="card"><h2>Show</h2><div class="segmented"><button data-pc="tool" class="${S.previewColor === 'tool' ? 'active' : ''}">Filament</button><button data-pc="feature" class="${S.previewColor === 'feature' ? 'active' : ''}">Line type</button></div></div>
    <div class="sl-go"><div class="row gap"><a class="btn" href="/api/slicer/gcode?download=1" download title="Save the G-code (for a USB stick or another program)">G-code</a>${j.hasProject ? '<a class="btn" href="/api/slicer/gcode?download=3mf" download title="Save the sliced project (.gcode.3mf, opens in OrcaSlicer)">3MF</a>' : ''}<button class="btn primary big" style="flex:1" data-sl="print">Print…</button></div>
      <div class="sl-source">OrcaSlicer engine (AGPL-3.0) · <a href="https://github.com/Helio-Additive/slicer-cli" target="_blank" rel="noopener">source</a></div></div>`;
}

// ================================================================== events from the panel
async function onClick(e) {
  const b = e.target.closest('button, [data-obj]');
  if (!b) return;
  const act = b.dataset.sl;
  if (b.dataset.tool) { setTool(b.dataset.tool); return; }
  if (b.dataset.pf !== undefined) { S.paint.filament = +b.dataset.pf; renderSide(); return; }
  if (b.dataset.pc) { S.previewColor = b.dataset.pc; savePrefs(); colorPreview(); renderSide(); return; }
  if (b.dataset.feat !== undefined) { const f = +b.dataset.feat; S.hiddenFeatures.has(f) ? S.hiddenFeatures.delete(f) : S.hiddenFeatures.add(f); colorPreview(); return; }
  if (b.dataset.reset) { delete S.overrides[b.dataset.reset]; changed(); return; }
  if (b.dataset.objDel) { removeObject(S.objects.find((o) => o.id === +b.dataset.objDel)); return; }
  if (b.dataset.obj && !e.target.closest('select, button')) { if (S.mode === 'prepare') select(S.objects.find((o) => o.id === +b.dataset.obj)); return; }
  switch (act) {
    case 'add': $('#sl-file').click(); break;
    case 'orient': autoOrient(S.selected); break;
    case 'arrange': arrange(); break;
    case 'copy': duplicate(S.selected); break;
    case 'del': removeObject(S.selected); break;
    case 'undo': undo(); break;
    case 'view': if (S.mode === 'preview') viewHome(); else frameObjects(); break;
    case 'loaded': useLoaded(); break;
    case 'all': renderAll(); $('#sl-all-dialog').showModal(); break;
    case 'slice': slice(); break;
    case 'print': sendToPrinter(); break;
    case 'retry': loadPrinter(F.current().id); break;
    case 'fillobj': fillObject(S.selected, S.paint.filament || S.selected.filament); break;
    case 'clearpaint': fillObject(S.selected, 0); break;
    case 'clear':
      if (!(await F.confirmBox('Clear the plate?', 'All models are removed from the plate.', 'Clear'))) return;
      for (const o of S.objects) objGroup.remove(o.mesh);
      S.objects = []; S.undo = []; select(null); clearPreview(); break;
    default:
  }
}

function onInput(e) {
  const t = e.target;
  if (t.dataset.set === 'brush') { S.paint.size = +t.value; $('#sl-bs').textContent = S.paint.size.toFixed(1) + ' mm'; }
  if (t.dataset.filColor !== undefined) {
    S.filaments[+t.dataset.filColor].color = t.value;
    for (const o of S.objects) recolor(o);
    if (S.preview) colorPreview();
  }
}

async function onChange(e) {
  const t = e.target;
  const set = t.dataset.set;
  if (set === 'model') { await loadPrinter(S.printerId, '&model=' + encodeURIComponent(t.value)); applyMode(); return; }
  if (set === 'machine') { savePrefsMachine(t.value); await loadPrinter(S.printerId); return; }
  if (set === 'bed') { S.bedType = t.value; changed(false); return; }
  if (set === 'process') { S.process = t.value; S.loading = true; renderSide(); await loadValues(); S.loading = false; changed(); return; }
  if (set === 'paintobj') { S.selected = S.objects.find((o) => o.id === +t.value) || null; checkBounds(); renderSide(); return; }
  if (t.dataset.filPreset !== undefined) { S.filaments[+t.dataset.filPreset].preset = t.value; changed(false); return; }
  if (t.dataset.filColor !== undefined) { savePrefs(); renderSide(); return; }
  if (t.dataset.objFil) { const o = S.objects.find((x) => x.id === +t.dataset.objFil); o.filament = +t.value; recolor(o); S.preview = null; renderSide(); return; }
  if (t.dataset.ov) {
    const key = t.dataset.ov;
    let v = t.type === 'checkbox' ? (t.checked ? '1' : '0') : t.value;
    if (t.dataset.pct !== undefined) v = v + '%';
    if (String(fmtVal(S.values[key])) === v) delete S.overrides[key]; else S.overrides[key] = v;
    changed();
    return;
  }
  if (t.dataset.xf) { applyXf(t.dataset.xf, +t.value); }
}
function savePrefsMachine(m) { const p = loadPrefs(S.printerId); p.machine = m; try { localStorage.setItem(prefKey(S.printerId), JSON.stringify(p)); } catch (_) { /* */ } }
function changed(rerender = true) {
  savePrefs();
  if (rerender) renderSide();
  if ($('#sl-all-dialog').open) renderAll();
}

function applyXf(k, v) {
  const o = S.selected;
  if (!o || !Number.isFinite(v)) return;
  pushUndo({ type: 'xf', obj: o, m: o.mesh.matrix.clone() });
  const m = o.mesh;
  const b = worldBox(o);
  if (k === 'x') m.position.x += v - (b.min.x + b.max.x) / 2;
  if (k === 'y') m.position.y += v - (b.min.y + b.max.y) / 2;
  if (k === 's') m.scale.setScalar(Math.max(0.01, v / 100));
  if (k === 'rx' || k === 'ry' || k === 'rz') {
    const e = new THREE.Euler().setFromQuaternion(m.quaternion, 'XYZ');
    e[k[1]] = THREE.MathUtils.degToRad(v);
    m.quaternion.setFromEuler(e);
  }
  m.updateMatrixWorld(true);
  dropToBed(o); checkBounds(); renderSide();
}

// ================================================================== all settings dialog
function renderAll() {
  const list = $('#sl-all-list');
  if (!S.schema) return;
  const q = $('#sl-all-search').value.trim().toLowerCase();
  const onlyChanged = $('#sl-all-changed').checked;
  const groups = new Map();
  for (const s of S.schema) {
    if (s.key === 'curr_bed_type') continue;
    if (onlyChanged && S.overrides[s.key] === undefined) continue;
    if (q && !(`${s.label} ${s.key} ${s.category || ''} ${s.tooltip || ''}`.toLowerCase().includes(q))) continue;
    const g = s.category || 'Other';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }
  const order = ['Quality', 'Strength', 'Speed', 'Support', 'Others', 'Advanced'];
  const names = [...groups.keys()].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  list.innerHTML = names.map((g) => `<h3>${esc(g)}</h3>${groups.get(g).sort((a, b) => (a.mode === 'simple' ? 0 : 1) - (b.mode === 'simple' ? 0 : 1) || a.label.localeCompare(b.label)).map((s) => settingRow(s, `${s.label}${q ? '' : ''}`, true)).join('')}`).join('')
    || '<p class="muted">No setting matches.</p>';
}

// ================================================================== slicing
function plateKey() {
  return JSON.stringify([S.printerId, S.info && S.info.machine, S.process, S.bedType, S.filaments, S.overrides,
    S.objects.map((o) => [o.id, o.filament, o.mesh.matrix.elements.map((x) => Math.round(x * 1000)), hashStates(o.states)])]);
}
function hashStates(a) { let h = 0; for (let i = 0; i < a.length; i++) h = (h * 31 + a[i]) | 0; return h; }

function busy(title, msg, pct, cancel = false) {
  const b = $('#sl-busy');
  if (!title) { b.classList.add('hidden'); return; }
  b.classList.remove('hidden');
  $('#sl-busy-title').textContent = title;
  $('#sl-busy-msg').textContent = msg || '';
  $('#sl-busy-bar').parentElement.classList.toggle('hidden', pct === null);
  $('#sl-busy-bar').style.width = (pct || 0) + '%';
  $('#sl-busy-cancel').classList.toggle('hidden', !cancel);
}

function platePositions(o) {
  o.mesh.updateMatrixWorld(true);
  const m = o.mesh.matrixWorld.elements, p = o.orig, out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return out;
}
function paintCodes(o) {
  const n = o.levels.length;
  let any = false;
  const codes = new Array(n);
  for (let t = 0; t < n; t++) { codes[t] = encodeTree(o.states, o.start[t], o.levels[t]); if (codes[t]) any = true; }
  return any ? codes : null;
}

let pollTimer = null;
async function slice() {
  if (!S.objects.length) { F.toast('Add a model first.', true); return; }
  checkBounds();
  if (S.objects.some((o) => o.outside)) { F.toast('Some models are off the plate. Move them onto it first.', true); location.hash = '#slicer/prepare'; return; }
  const used = new Set(S.objects.flatMap((o) => [o.filament, ...new Set(o.states)]).filter(Boolean));
  const missing = [...used].filter((n) => n > S.filaments.length);
  if (missing.length) { F.toast(`Filament ${missing.join(', ')} is used but this printer has only ${S.filaments.length}. Change those parts first.`, true); return; }
  if (location.hash !== '#slicer/preview') history.replaceState(null, '', '#slicer/preview');
  S.mode = 'preview';
  $$('#mode-tabs a').forEach((a) => a.classList.toggle('active', a.dataset.mode === 'preview'));
  clearPreview();
  applyMode();
  busy('Preparing the plate…', 'Packing the models', 0, false);
  await new Promise((r) => setTimeout(r, 30));
  const key = plateKey();
  let blob;
  try {
    const data = export3mf(S.objects.map((o) => ({ name: o.name, positions: platePositions(o), paintCodes: paintCodes(o), filament: o.filament })), plateName());
    blob = new Blob([data], { type: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml' });
  } catch (e) { busy(null); F.toast('Could not pack the plate: ' + e.message, true); return; }
  const overrides = { ...S.overrides };
  if (S.bedType) overrides.curr_bed_type = S.bedType;
  const opts = { printer: S.printerId, machine: S.info.machine, process: S.process, filaments: S.filaments, overrides, name: plateName(), thumb: thumbnail() };
  const fd = new FormData();
  fd.append('options', JSON.stringify(opts));
  fd.append('model', blob, 'plate.3mf');
  const r = await new Promise((res) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/slicer/slice');
    xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) busy('Sending the plate to the board…', `${(ev.loaded / 1e6).toFixed(1)} of ${(ev.total / 1e6).toFixed(1)} MB`, ev.loaded / ev.total * 100); };
    xhr.onload = () => { try { res(JSON.parse(xhr.responseText)); } catch (_) { res({ ok: false, message: 'The board gave no answer.' }); } };
    xhr.onerror = () => res({ ok: false, message: 'Lost the connection to the board.' });
    xhr.send(fd);
  });
  if (!r.ok) { busy(null); F.toast(r.message || 'Slicing could not start.', true); S.job = null; renderSide(); return; }
  S.job = r.job; S.sliceKey = key;
  renderSide();
  poll();
}
function plateName() {
  const names = [...new Set(S.objects.map((o) => o.name))];
  return (names.length === 1 ? names[0] : names.length ? `${names[0]} + ${names.length - 1} more` : 'Plate').slice(0, 60);
}
async function poll() {
  clearTimeout(pollTimer);
  const r = await F.api('slicer/job');
  const j = r.job;
  if (!j) { busy(null); return; }
  S.job = j;
  if (j.state === 'slicing') {
    busy('Slicing on the board…', `${j.message || ''} (${j.seconds}s)`, j.percent, true);
    pollTimer = setTimeout(poll, 700);
    return;
  }
  busy(null);
  if (j.state === 'done') await loadPreview();
  else if (j.state === 'error') F.toast('Slicing failed: ' + (j.error || j.message), true);
  renderSide();
}
async function cancelSlice() {
  await F.api('slicer/job/cancel', { method: 'POST' });
  clearTimeout(pollTimer);
  busy(null);
  S.job = null; S.sliceKey = '';
  location.hash = '#slicer/prepare';
}

async function sendToPrinter() {
  const r = await F.api('slicer/send', { method: 'POST', body: { printer: S.printerId } });
  if (!r.ok) { F.toast(r.message, true); return; }
  if (F.current().id !== S.printerId) { F.toast('Saved to ' + S.info.name + "'s files."); return; }
  F.printFile(r.file);
}

// ================================================================== preview
function clearPreview() {
  previewGroup.clear();
  S.preview = null;
  invalidate();
}
async function loadPreview() {
  busy('Loading the preview…', 'Reading the G-code', null);
  try {
    const res = await fetch('/api/slicer/gcode', { cache: 'no-store' });
    if (!res.ok) throw new Error('The G-code could not be fetched.');
    const text = await res.text();
    await new Promise((r) => setTimeout(r, 20));
    const g = parseGcode(text);
    buildPreview(g);
  } catch (e) {
    F.toast(e.message, true);
  } finally { busy(null); }
}
let segMesh = null, segGeom = null;
function buildPreview(g) {
  previewGroup.clear();
  S.preview = g;
  const n = g.count;
  if (!n) { F.toast('The G-code has no printed paths.', true); return; }
  const box = new THREE.BoxGeometry(1, 1, 1);
  box.translate(0, 0, 0);
  const mat = new THREE.MeshLambertMaterial();
  segMesh = new THREE.InstancedMesh(box, mat, n);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), z = new THREE.Vector3(0, 0, 1);
  const seg = g.seg;
  for (let i = 0; i < n; i++) {
    const o = i * 7, x0 = seg[o], y0 = seg[o + 1], x1 = seg[o + 2], y1 = seg[o + 3], zz = seg[o + 4], h = Math.max(0.05, seg[o + 5]), w = Math.max(0.1, seg[o + 6]);
    const len = Math.hypot(x1 - x0, y1 - y0);
    p.set((x0 + x1) / 2, (y0 + y1) / 2, zz - h / 2);
    q.setFromAxisAngle(z, Math.atan2(y1 - y0, x1 - x0));
    s.set(len + w * 0.5, w, h * 0.9);
    m.compose(p, q, s);
    segMesh.setMatrixAt(i, m);
  }
  segMesh.instanceMatrix.needsUpdate = true;
  segMesh.frustumCulled = false;
  previewGroup.add(segMesh);
  colorPreview();
  const sl = $('#sl-layer');
  sl.max = String(g.layerEnd.length);
  setLayer(g.layerEnd.length);
  $('#sl-layers').classList.toggle('hidden', S.mode !== 'preview');
  $('#sl-legend').classList.toggle('hidden', S.mode !== 'preview');
  invalidate();
}
function colorPreview() {
  const g = S.preview;
  if (!g || !segMesh) return;
  const c = new THREE.Color();
  const tools = S.filaments.map((f) => new THREE.Color(f.color));
  const feats = FEATURES.map(([, col]) => new THREE.Color(col));
  const hidden = new THREE.Color(0, 0, 0);
  const byTool = S.previewColor === 'tool';
  for (let i = 0; i < g.count; i++) {
    const f = g.feature[i];
    if (S.hiddenFeatures.has(f)) { segMesh.setColorAt(i, hidden); continue; }
    c.copy(byTool ? (tools[g.tool[i]] || feats[14]) : feats[f]);
    segMesh.setColorAt(i, c);
  }
  segMesh.instanceColor.needsUpdate = true;
  // hidden line types: scale them away
  if (S.hiddenFeatures.size || segMesh.userData.hid) {
    const m = new THREE.Matrix4(), zero = new THREE.Matrix4().makeScale(0, 0, 0);
    if (!segMesh.userData.saved) { segMesh.userData.saved = segMesh.instanceMatrix.array.slice(); }
    const saved = segMesh.userData.saved;
    for (let i = 0; i < g.count; i++) {
      if (S.hiddenFeatures.has(g.feature[i])) segMesh.setMatrixAt(i, zero);
      else { m.fromArray(saved, i * 16); segMesh.setMatrixAt(i, m); }
    }
    segMesh.instanceMatrix.needsUpdate = true;
    segMesh.userData.hid = S.hiddenFeatures.size > 0;
  }
  // legend
  const used = byTool ? [...new Set(g.tool)].sort((a, b) => a - b) : [...new Set(g.feature)].sort((a, b) => a - b);
  $('#sl-legend').innerHTML = byTool
    ? used.map((t) => `<div class="li"><i style="background:${esc((S.filaments[t] || {}).color || '#888')}"></i>Filament ${t + 1}</div>`).join('')
    : used.map((f) => `<button class="li ${S.hiddenFeatures.has(f) ? 'off' : ''}" data-feat="${f}" title="Show / hide"><i style="background:${FEATURES[f][1]}"></i>${FEATURES[f][0]}</button>`).join('');
  invalidate();
}
function setLayer(n) {
  const g = S.preview;
  if (!g || !segMesh) return;
  n = Math.max(1, Math.min(g.layerEnd.length, n));
  S.layer = n;
  segMesh.count = g.layerEnd[n - 1];
  $('#sl-layer').value = String(n);
  $('#sl-layer-n').textContent = n;
  $('#sl-layer-z').textContent = g.layerZ[n - 1].toFixed(2);
  invalidate();
}

// ================================================================== thumbnail for the file list / printer screen
let thumbRenderer = null;
function thumbnail() {
  try {
    const size = 300;
    thumbRenderer ??= new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    thumbRenderer.setSize(size, size, false);
    const box = new THREE.Box3();
    S.objects.forEach((o) => box.union(worldBox(o)));
    const c = box.getCenter(new THREE.Vector3()), r = box.getSize(new THREE.Vector3()).length() / 2;
    const cam = new THREE.PerspectiveCamera(30, 1, 1, 5000);
    cam.up.set(0, 0, 1);
    cam.position.set(c.x + r * 1.6, c.y - r * 2.4, c.z + r * 2.0);
    cam.lookAt(c);
    const was = [bedGroup.visible, previewGroup.visible, objGroup.visible, tcontrols.getHelper().visible, brushRing.visible];
    bedGroup.visible = false; previewGroup.visible = false; objGroup.visible = true; tcontrols.getHelper().visible = false; brushRing.visible = false;
    S.objects.forEach((o) => o.mesh.material.emissive.setHex(0));
    thumbRenderer.render(scene, cam);
    [bedGroup.visible, previewGroup.visible, objGroup.visible, tcontrols.getHelper().visible, brushRing.visible] = was;
    checkBounds();
    return thumbRenderer.domElement.toDataURL('image/png');
  } catch (_) { return ''; }
}
