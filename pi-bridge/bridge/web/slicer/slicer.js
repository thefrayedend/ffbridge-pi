// Flash Bridge slicer: Prepare (place models), Paint (colours, supports, seams), Preview (layer by layer).
// The 3D work happens in the browser; the board runs the OrcaSlicer engine with the open
// printer's own Flashforge profiles (src/slicer.dart). Loaded by app.js on first use.
//
// Plates work like OrcaSlicer's: several beds side by side. An object belongs to the plate it
// stands on; every plate is sliced, previewed and printed on its own.
import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { TransformControls } from './vendor/TransformControls.js';
import { STLLoader } from './vendor/STLLoader.js';
import { simplifyModel, SIMPLIFY_AT } from './simplify.js';
import { OBJLoader } from './vendor/OBJLoader.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast, INTERSECTED, NOT_INTERSECTED, CONTAINED } from './vendor/three-mesh-bvh.js';
import { import3mf, export3mf, subdivide, pieceCentres, decodeTree, stateAt, encodeTree } from './project3mf.js';
import { parseGcode, FEATURES } from './gcode.js';
import * as P from './paint.js';

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
// Enforcer / blocker colours (as in OrcaSlicer).
const ENFORCE = '#2f7bff', BLOCK = '#e5383b', BASE = '#c9ccd1', OVERHANG = '#f2a33a';

const S = {
  ready: false, mode: 'prepare', printerId: '', info: null, schema: null, values: {}, loading: false, err: '',
  process: '', bedType: '', filaments: [], overrides: {},
  objects: [], selected: null, tool: 'move',
  nPlates: 1, plate: 0,
  res: [], // per plate: {job, key, g (parsed G-code), tools (filament number per tool)}
  merge: {}, // per plate: {u: used filaments, map: {extra filament: filament it prints with}}
  paint: { ch: 'color', tool: 'circle', filament: 2, mark: 1, size: 3, height: 2, smart: true, angle: 30, gap: 2, clip: 100, overhang: false, ohAngle: 30 },
  previewColor: 'tool', hiddenFeatures: new Set(), layer: 0,
  undo: [],
};
window.__sl = S; // for the automated browser checks (also __slCam)
let renderer, scene, camera, controls, tcontrols, bedGroup, objGroup, previewGroup, cursorSphere, cursorRing, cursorBand, raycaster, needRender = true, nextId = 1;
const clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 1e6);

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
  const p = F.current();
  if (p && p.id !== S.printerId) await loadPrinter(p.id);
  if (mode === 'paint' && (!S.selected || S.selected.plate !== S.plate)) S.selected = platesObjects(S.plate)[0] || S.selected || S.objects[0] || null;
  applyMode();
  resize();
  const running = Object.values(st.jobs || {}).find((j) => j.state === 'slicing');
  if (running) { poll(running.plate - 1); return; }
  if (mode === 'preview' && S.info && S.info.known) previewPlate(S.plate);
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
  try { localStorage.setItem(prefKey(S.printerId), JSON.stringify({ machine: S.info && S.info.machine, process: S.process, bedType: S.bedType, filaments: S.filaments, overrides: S.overrides, color: S.previewColor, infill: S.infillFil || 0 })); } catch (_) { /* private mode */ }
}
function loadPrefs(id) { try { return JSON.parse(localStorage.getItem(prefKey(id)) || '{}'); } catch (_) { return {}; } }

async function loadPrinter(id, extra = '') {
  try {
    await loadPrinterInner(id, extra);
  } catch (e) {
    // never sit on "Reading the printer profiles…": show what went wrong (and a retry button)
    console.error(e);
    S.loading = false; S.info = null;
    S.err = `Could not open the slicer: ${e && e.message ? e.message : e}. Reload the page. If it keeps happening, take a screenshot of this message.`;
    renderSide();
  }
}
async function loadPrinterInner(id, extra) {
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
  S.infillFil = +prefs.infill || 0;
  S.filaments = defaultFilaments(r, prefs.filaments);
  S.res = [];
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
const MAX_FILAMENTS = 16;
/** The printer's filament profile for a material (PLA, PETG …): Flashforge's own first. */
function pickPreset(material, info = S.info) {
  const list = info.filaments;
  const fam = F.family(material || 'PLA');
  const tries = [(f) => f.startsWith(`Flashforge ${fam} Basic`), (f) => f.startsWith(`Generic ${fam} @`), (f) => f.startsWith(`Flashforge ${fam}`) && !/-CF|-GF/.test(f), (f) => F.family(f.replace(/^(Flashforge|Generic)\s+/, '')) === fam];
  for (const t of tries) { const m = list.find(t); if (m) return m; }
  return list.find((f) => /PLA Basic/.test(f)) || list[0];
}
function defaultFilaments(info, saved) {
  const p = F.current();
  const slots = (p && p.slots) || [];
  const n = Math.max(1, Math.min(MAX_FILAMENTS, Math.max(saved ? saved.length : 0, slots.length || info.extruders || 1)));
  const pick = (material) => pickPreset(material, info);
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = slots[i];
    const keep = saved && saved[i] && info.filaments.includes(saved[i].preset) ? saved[i] : null;
    out.push(keep || { preset: pick(s && s.material), color: (s && s.hasFilament !== false && s.color) || ['#E8E8E8', '#202020', '#D32F2F', '#1E63D6'][i % 4] });
  }
  return out;
}
function useLoaded() {
  const p = F.current();
  const slots = (p && p.slots) || [];
  if (!slots.length) { F.toast('The printer did not report any loaded filament.', true); return; }
  const loaded = defaultFilaments(S.info, null);
  S.filaments = loaded.concat(S.filaments.slice(loaded.length)); // extra project filaments stay
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
  renderer.localClippingEnabled = true;
  renderer.domElement.tabIndex = 0;
  stage.prepend(renderer.domElement);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(40, 1, 1, 8000);
  camera.up.set(0, 0, 1);
  window.__slCam = camera;
  window.__slTower = (i) => towerSpot(i);
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
    else if (S.selected) { fixScale(S.selected); dropToBed(S.selected); checkBounds(); if (S.selected.plate !== S.plate) setPlate(S.selected.plate, false); renderSide(); }
  });
  tcontrols.addEventListener('objectChange', () => { if (S.selected) { if (tcontrols.mode === 'translate') dropToBed(S.selected); renderXf(); } });
  scene.add(tcontrols.getHelper());
  raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true;
  const ghost = (color, opacity) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide });
  cursorSphere = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), ghost(0xffffff, 0.25));
  cursorRing = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 48), ghost(0xffffff, 0.9));
  cursorRing.material.depthTest = false;
  cursorBand = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), ghost(0xffffff, 0.18));
  for (const c of [cursorSphere, cursorRing, cursorBand]) { c.visible = false; c.renderOrder = 10; scene.add(c); }
  const el = renderer.domElement;
  // Painting starts before the view controls see the press (capture on the parent).
  stage.addEventListener('pointerdown', onPointerDown, true);
  stage.addEventListener('wheel', onWheel, { capture: true, passive: false });
  el.addEventListener('pointermove', onPointerMove);
  el.addEventListener('pointerup', onPointerUp);
  el.addEventListener('pointerleave', () => { hideCursor(); invalidate(); });
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

// ================================================================== plates
/** Distance from one plate to the next (beds stand in a row with a gap, like OrcaSlicer). */
const stride = () => { const b = bed(); return b.w + Math.max(30, Math.round(b.w * 0.2)); };
const plateX = (i) => i * stride();
/** Which plate a world x position is on (between plates: the nearer one). */
function plateAt(x) {
  const b = bed(), st = stride();
  return Math.max(0, Math.min(S.nPlates - 1, Math.floor((x - b.x0 + (st - b.w) / 2) / st)));
}
const platesObjects = (i) => S.objects.filter((o) => o.plate === i);

function labelTexture(text, active) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = active ? '#4c9aff' : '#9aa3ad';
  g.font = 'bold 84px system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 128, 68);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function buildBed() {
  if (!bedGroup) return;
  bedGroup.clear();
  const b = bed();
  const line = (arr, color, opacity) => {
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
  };
  for (let i = 0; i < S.nPlates; i++) {
    const ox = b.x0 + plateX(i), oy = b.y0, cur = i === S.plate;
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(b.w, b.d), new THREE.MeshStandardMaterial({ color: cur ? 0x2e333a : 0x25292f, roughness: 0.9 }));
    plate.position.set(ox + b.w / 2, oy + b.d / 2, -0.05);
    plate.userData.plate = i;
    bedGroup.add(plate);
    const pts = [], major = [];
    for (let x = 0; x <= b.w + 1e-6; x += 10) (Math.round(x) % 50 === 0 ? major : pts).push(ox + x, oy, 0, ox + x, oy + b.d, 0);
    for (let y = 0; y <= b.d + 1e-6; y += 10) (Math.round(y) % 50 === 0 ? major : pts).push(ox, oy + y, 0, ox + b.w, oy + y, 0);
    bedGroup.add(line(pts, 0x8a919b, cur ? 0.25 : 0.12), line(major, 0x9aa3ad, cur ? 0.55 : 0.25));
    const edge = [ox, oy, 0, ox + b.w, oy, 0, ox + b.w, oy, 0, ox + b.w, oy + b.d, 0, ox + b.w, oy + b.d, 0, ox, oy + b.d, 0, ox, oy + b.d, 0, ox, oy, 0];
    bedGroup.add(line(edge, cur ? 0x4c9aff : 0x6b737d, cur ? 0.95 : 0.6));
    if (cur) {
      const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(b.w, b.d, b.h)), new THREE.LineBasicMaterial({ color: 0x9aa3ad, transparent: true, opacity: 0.12 }));
      box.position.set(ox + b.w / 2, oy + b.d / 2, b.h / 2);
      bedGroup.add(box);
    }
    if (S.nPlates > 1) {
      const lab = new THREE.Mesh(new THREE.PlaneGeometry(36, 18), new THREE.MeshBasicMaterial({ map: labelTexture(String(i + 1), cur), transparent: true, depthWrite: false }));
      lab.position.set(ox + 20, oy - 14, 0.1);
      lab.userData.plate = i;
      bedGroup.add(lab);
    }
  }
  renderPlateBar();
  invalidate();
}

function renderPlateBar() {
  const bar = $('#sl-plates');
  if (!bar) return;
  const dot = (i) => {
    const r = S.res[i];
    if (!platesObjects(i).length) return '';
    if (r && r.job && r.job.state === 'slicing') return '<i class="pd busy"></i>';
    if (r && r.job && r.job.state === 'done' && r.key === plateKey(i)) return '<i class="pd ok"></i>';
    return '';
  };
  bar.innerHTML = Array.from({ length: S.nPlates }, (_, i) => `<button data-plate="${i}" class="${i === S.plate ? 'active' : ''}" title="Plate ${i + 1}: ${platesObjects(i).length} object(s)">${dot(i)}Plate ${i + 1}<span>${platesObjects(i).length}</span></button>`).join('')
    + (S.mode === 'preview' ? '' : '<button data-sl="addplate" class="add" title="Add an empty plate (or drag a model past the last plate)">+ Plate</button>');
}

/** Makes plate i the current one; the camera follows. */
function setPlate(i, moveCamera = true) {
  i = Math.max(0, Math.min(S.nPlates - 1, i));
  const dx = plateX(i) - plateX(S.plate);
  S.plate = i;
  if (moveCamera && dx) { controls.target.x += dx; camera.position.x += dx; controls.update(); }
  if (S.selected && S.selected.plate !== i && S.mode !== 'paint') select(null);
  if (S.mode === 'paint' && (!S.selected || S.selected.plate !== i)) S.selected = platesObjects(i)[0] || null;
  buildBed();
  if (S.mode === 'preview') previewPlate(i);
  renderSide();
}

function addPlate() {
  S.nPlates++;
  setPlate(S.nPlates - 1);
  F.toast(`Plate ${S.nPlates} added. Drag models onto it, or use "Plate" in the Objects list.`);
}

async function deletePlate(i) {
  const objs = platesObjects(i);
  if (S.nPlates === 1) { F.toast('There is always at least one plate.', true); return; }
  if (objs.length && !(await F.confirmBox(`Delete plate ${i + 1}?`, `Its ${objs.length} object(s) are removed too.`, 'Delete plate'))) return;
  for (const o of objs) objGroup.remove(o.mesh);
  S.objects = S.objects.filter((o) => !objs.includes(o));
  // plates after it move one place to the left
  for (const o of S.objects) if (o.plate > i) { o.mesh.position.x -= stride(); o.mesh.updateMatrixWorld(true); }
  S.nPlates--;
  S.res = []; S.undo = []; S.merge = {};
  if (S.selected && objs.includes(S.selected)) S.selected = null;
  S.plate = Math.min(S.plate, S.nPlates - 1);
  checkBounds(); buildBed(); viewHome(); renderSide();
}

/** Moves an object to another plate (same spot if free, else the nearest free spot). */
function moveToPlate(o, i) {
  if (i >= S.nPlates) { S.nPlates = i + 1; }
  pushUndo({ type: 'xf', obj: o, m: o.mesh.matrix.clone() });
  o.mesh.position.x += plateX(i) - plateX(o.plate);
  o.mesh.updateMatrixWorld(true);
  o.plate = i;
  if (!placeFree(o, i, true)) F.toast(`Plate ${i + 1} is full; the model is next to the others.`, true);
  checkBounds(); buildBed(); renderSide();
}

function viewHome() {
  const b = bed();
  const c = new THREE.Vector3(b.x0 + plateX(S.plate) + b.w / 2, b.y0 + b.d / 2, 0);
  const r = Math.max(b.w, b.d);
  camera.position.set(c.x, c.y - r * 1.25, r * 1.0);
  controls.target.copy(c);
  controls.update();
  invalidate();
}

// ================================================================== objects
/**
 * Adds a model. positions: world mm (Float32Array, 9 per triangle); codes: colour paint per
 * triangle (or null); sup / seam: support and seam paint per triangle (or null).
 */
function addObject({ name, positions, codes, sup, seam, filament = 1 }) {
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
  const decode = (list, max) => {
    if (!list) return null;
    const arr = new Uint8Array(sub.count);
    for (let t = 0; t < list.length; t++) {
      if (!list[t]) continue;
      let tree;
      try { tree = decodeTree(list[t]); } catch (_) { continue; }
      const lvl = sub.levels[t], st = sub.start[t];
      if (!tree.children) { arr.fill(Math.min(tree.state, max), st, st + 4 ** lvl); continue; }
      const cs = pieceCentres(lvl);
      for (let k = 0; k < cs.length; k++) arr[st + k] = Math.min(stateAt(tree, cs[k]), max);
    }
    return arr;
  };
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(sub.fine, 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(sub.fine.length), 3));
  g.computeVertexNormals();
  g.computeBoundsTree();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.02, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(g, mat);
  mesh.position.set(cx, cy, cz);
  const o = {
    id: nextId++, name: name || 'Model', mesh, orig, levels: sub.levels, start: sub.start,
    states: decode(codes, 16) || new Uint8Array(sub.count), sup: decode(sup, 2), seam: decode(seam, 2),
    filament: Math.max(1, filament), outside: false, plate: S.plate,
  };
  mesh.userData.obj = o;
  objGroup.add(mesh);
  S.objects.push(o);
  applyClip(o);
  recolor(o);
  return o;
}
const totalTris = () => S.objects.reduce((n, o) => n + o.states.length, 0);

/** Colours of one object: filaments, or (while painting supports / seams) enforcers and blockers. */
function recolor(o, from = 0, to = o.states.length) {
  const col = o.mesh.geometry.attributes.color;
  const arr = col.array;
  const cache = new Map();
  const rgb = (hex) => {
    if (!cache.has(hex)) { const c = new THREE.Color(hex).convertSRGBToLinear(); cache.set(hex, [c.r, c.g, c.b]); }
    return cache.get(hex);
  };
  const ch = S.mode === 'paint' ? S.paint.ch : 'color';
  const marks = ch === 'color' ? null : P.channel(o, ch);
  const oh = ch === 'support' && S.paint.overhang ? overhangSet(o) : null;
  for (let t = from; t < to; t++) {
    let hex;
    if (ch === 'color') hex = filColor(o.states[t] || o.filament);
    else {
      const m = marks ? marks[t] : 0;
      hex = m === 1 ? ENFORCE : m === 2 ? BLOCK : (oh && oh[t] ? OVERHANG : BASE);
    }
    const c = rgb(hex);
    const k = t * 9;
    arr[k] = arr[k + 3] = arr[k + 6] = c[0];
    arr[k + 1] = arr[k + 4] = arr[k + 7] = c[1];
    arr[k + 2] = arr[k + 5] = arr[k + 8] = c[2];
  }
  col.needsUpdate = true;
  invalidate();
}
function overhangSet(o) {
  const set = new Uint8Array(o.states.length);
  for (const t of P.overhangs(o, S.paint.ohAngle)) set[t] = 1;
  return set;
}

function worldBox(o) { o.mesh.updateMatrixWorld(true); return new THREE.Box3().setFromObject(o.mesh, true); }
function dropToBed(o) {
  const b = worldBox(o);
  o.mesh.position.z -= b.min.z;
  o.mesh.updateMatrixWorld(true);
  invalidate();
}
function fixScale(o) {
  const s = o.mesh.scale;
  s.set(Math.max(0.01, Math.abs(s.x)), Math.max(0.01, Math.abs(s.y)), Math.max(0.01, Math.abs(s.z)));
}
/** Works out every object's plate and whether it is (partly) off its plate. */
function checkBounds(light = false) {
  const b = bed();
  for (const o of S.objects) {
    const w = worldBox(o);
    o.plate = plateAt((w.min.x + w.max.x) / 2);
    const x0 = b.x0 + plateX(o.plate);
    o.outside = w.min.x < x0 - 0.01 || w.min.y < b.y0 - 0.01 || w.max.x > x0 + b.w + 0.01 || w.max.y > b.y0 + b.d + 0.01 || w.max.z > b.h + 0.01;
    o.mesh.material.emissive.setHex(o.outside ? 0x5a0d0d : (o === S.selected && S.mode === 'prepare' ? 0x10294d : 0x000000));
  }
  $('#sl-empty').classList.toggle('hidden', !!S.objects.length || S.mode === 'preview');
  if (!light) renderPlateBar(); // (light: while dragging; the plate tabs hash every model)
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
  const c = { ...o, id: nextId++, mesh, states: o.states.slice(), sup: o.sup && o.sup.slice(), seam: o.seam && o.seam.slice(), name: o.name + ' (copy)', adj: o.adj, geo: o.geo, wz: null, wnz: null };
  mesh.userData.obj = c;
  objGroup.add(mesh);
  S.objects.push(c);
  applyClip(c);
  if (!placeFree(c, o.plate)) arrange(o.plate);
  dropToBed(c); select(c);
}

/** Moves an object to a free spot on plate i (false when there is none). keepIfFree: stay put when not overlapping. */
function placeFree(o, i = S.plate, keepIfFree = false) {
  const b = bed(), x0 = b.x0 + plateX(i);
  const w = worldBox(o);
  const sx = w.max.x - w.min.x, sy = w.max.y - w.min.y;
  const others = S.objects.filter((x) => x !== o && x.plate === i).map(worldBox);
  const free = (x, y) => others.every((q) => x + sx + 3 < q.min.x || x - 3 > q.max.x || y + sy + 3 < q.min.y || y - 3 > q.max.y);
  if (keepIfFree && w.min.x >= x0 && w.max.x <= x0 + b.w && w.min.y >= b.y0 && w.max.y <= b.y0 + b.d && free(w.min.x, w.min.y)) return true;
  const cx = x0 + b.w / 2 - sx / 2, cy = b.y0 + b.d / 2 - sy / 2;
  const cand = [];
  for (let y = b.y0 + 2; y + sy <= b.y0 + b.d - 2; y += 5) for (let x = x0 + 2; x + sx <= x0 + b.w - 2; x += 5) cand.push([x, y]);
  cand.sort((p, q) => Math.hypot(p[0] - cx, p[1] - cy) - Math.hypot(q[0] - cx, q[1] - cy));
  const spot = free(cx, cy) && cx >= x0 ? [cx, cy] : cand.find(([x, y]) => free(x, y));
  if (!spot) return false;
  o.mesh.position.x += spot[0] - w.min.x;
  o.mesh.position.y += spot[1] - w.min.y;
  o.mesh.updateMatrixWorld(true);
  return true;
}

/**
 * Shelf packing of plate i's objects, biggest first. What does not fit goes onto the next plate
 * (a new one if needed), like OrcaSlicer's arrange.
 */
function arrange(i = S.plate, undoable = true) {
  let items = platesObjects(i);
  if (!items.length) return;
  if (undoable) pushUndo({ type: 'many', list: S.objects.map((o) => ({ obj: o, m: o.mesh.matrix.clone() })) });
  const b = bed(), gap = 6;
  let plate = i, moved = 0;
  while (items.length) {
    const x0 = b.x0 + plateX(plate);
    const sized = items.map((o) => ({ o, w: worldBox(o) })).sort((p, q) => (q.w.max.y - q.w.min.y) - (p.w.max.y - p.w.min.y));
    let x = 0, y = 0, rowH = 0;
    const rows = [[]], rest = [];
    for (const it of sized) {
      const sx = it.w.max.x - it.w.min.x, sy = it.w.max.y - it.w.min.y;
      if (x > 0 && x + sx > b.w) { y += rowH + gap; x = 0; rowH = 0; rows.push([]); }
      if (y + sy > b.d && (x > 0 || y > 0)) { rest.push(it.o); continue; }
      it.x = x; it.y = y; x += sx + gap; rowH = Math.max(rowH, sy);
      rows[rows.length - 1].push(it);
    }
    const totalH = Math.max(0, ...rows.map((r) => (r.length ? Math.max(...r.map((it) => it.y + it.w.max.y - it.w.min.y)) : 0)));
    const offY = b.y0 + Math.max(0, (b.d - totalH) / 2);
    for (const row of rows) {
      if (!row.length) continue;
      const last = row[row.length - 1];
      const rowW = last.x + (last.w.max.x - last.w.min.x);
      const offX = x0 + Math.max(0, (b.w - rowW) / 2);
      for (const it of row) {
        it.o.mesh.position.x += offX + it.x - it.w.min.x;
        it.o.mesh.position.y += offY + it.y - it.w.min.y;
        it.o.mesh.updateMatrixWorld(true);
        it.o.plate = plate;
      }
    }
    if (!rest.length) break;
    // the rest goes onto the next plate
    plate++;
    if (plate >= S.nPlates) S.nPlates = plate + 1;
    for (const o of rest) { o.mesh.position.x += plateX(plate) - plateX(o.plate); o.plate = plate; o.mesh.updateMatrixWorld(true); }
    moved += rest.length;
    items = [...rest, ...S.objects.filter((o) => o.plate === plate && !rest.includes(o))];
  }
  checkBounds(); buildBed(); renderSide();
  if (moved) F.toast(`Not everything fitted on plate ${i + 1}: ${moved} object(s) went onto the next plate.`);
  if (S.objects.some((o) => o.outside)) F.toast('Something is still bigger than the plate. Shrink or rotate it.', true);
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
        placeNew(addObject({ name: base, positions: await lighter(base, nonIndexed(g)) }));
      } else if (lower.endsWith('.obj')) {
        const grp = new OBJLoader().parse(new TextDecoder().decode(buf));
        const parts = [];
        grp.updateMatrixWorld(true);
        grp.traverse((ch) => { if (ch.isMesh) { const g = ch.geometry.clone(); g.applyMatrix4(ch.matrixWorld); parts.push(nonIndexed(g)); } });
        if (!parts.length) throw new Error('No surfaces found in this OBJ.');
        const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
        let k = 0; for (const p of parts) { all.set(p, k); k += p.length; }
        placeNew(addObject({ name: base, positions: await lighter(base, all) }));
      } else throw new Error('Only STL, OBJ and 3MF files can be added.');
    } catch (e) {
      F.toast(file.name + ': ' + e.message, true);
    } finally { busy(null); }
  }
  checkBounds(); buildBed(); renderSide();
  if (S.objects.length === files.length || platesObjects(S.plate).length <= 3) frameObjects();
}
/**
 * Models with millions of triangles (scans, sculpts) are simplified when opened: same shape
 * (within 0.05 mm), same painting, about a million triangles - far finer than the nozzle prints,
 * and light enough for the browser and the board's slicer. Returns the (new) positions; the
 * paint object, if given, gets the matching codes.
 */
async function lighter(name, positions, paint = null) {
  const n = positions.length / 9;
  if (n <= SIMPLIFY_AT) return positions;
  busy(`Simplifying ${name}…`, `${(n / 1e6).toFixed(1)} million triangles is far more detail than the nozzle can print`, null);
  await new Promise((r) => setTimeout(r, 30));
  const r = await simplifyModel(positions, paint || {});
  if (paint) { paint.color = r.color; paint.supports = r.supports; paint.seam = r.seam; }
  F.toast(`${name}: simplified from ${(r.before / 1e6).toFixed(1)} to ${(r.after / 1e6).toFixed(1)} million triangles (shape within ${Math.max(0.01, r.error).toFixed(2)} mm, painting kept) so the board can slice it.`);
  return r.positions;
}
function nonIndexed(g) {
  const ng = g.index ? g.toNonIndexed() : g;
  return Float32Array.from(ng.attributes.position.array);
}
/** A new model goes onto the current plate; when that is full, onto a new plate. */
function placeNew(o) {
  dropToBed(o);
  o.mesh.position.x += plateX(S.plate) - (worldBox(o).min.x + worldBox(o).max.x) / 2 + bed().x0 + bed().w / 2;
  o.mesh.updateMatrixWorld(true);
  o.plate = S.plate;
  if (!placeFree(o, S.plate)) {
    S.nPlates++;
    o.mesh.position.x += plateX(S.nPlates - 1) - plateX(S.plate);
    o.mesh.updateMatrixWorld(true);
    o.plate = S.nPlates - 1;
    placeFree(o, o.plate);
    setPlate(o.plate);
    F.toast(`Plate ${S.plate} was full, so it went onto a new plate ${S.plate + 1}.`);
  }
  checkBounds();
  select(o);
}

/**
 * Opens a project with all its plates. Bambu / Orca lay plates out in a grid (columns = √count,
 * gap = 1/5 of the bed of the printer it was made for, read from the project). Every plate keeps
 * its layout, centred on one of ours (new plates after the ones in use). Models that were not on
 * any plate in the project get their own plate. Its filaments join the project's filament list.
 */
async function add3mf(buf, base) {
  const r = import3mf(buf);
  const byId = new Map(r.objects.map((o) => [o.id, o]));
  const groups = r.plates.map((p) => ({ id: p.id, list: p.objectIds.map((id) => byId.get(id)).filter(Boolean) }));
  const assigned = new Set(groups.flatMap((g) => g.list));
  const loose = r.objects.filter((o) => !assigned.has(o));
  if (!groups.length) groups.push({ id: 0, list: loose.splice(0) }); // plain 3MF: one plate
  const used = groups.filter((g) => g.list.length);
  // first plate to fill: the current one if it is empty, else a new one after the last used plate
  let first = S.objects.length ? (platesObjects(S.plate).length ? lastPlate() + 1 : S.plate) : 0;
  const fresh = !S.objects.length;
  const fmap = takeFilaments(r, fresh);
  const kept = fresh ? takeSettings(r.settings || {}) : [];
  const b = bed();
  const boxOf = (list) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const o of list) for (let i = 0; i < o.positions.length; i += 3) {
      const x = o.positions[i], y = o.positions[i + 1];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return { x0, y0, x1, y1 };
  };
  // Where a plate's area was in the project: from the plate number when the project names its
  // printer's bed, otherwise the bed size that puts the models inside one grid cell.
  const inCell = (bx, c) => bx.x0 >= c.x0 - 2 && bx.x1 <= c.x0 + c.w + 2 && bx.y0 >= c.y0 - 2 && bx.y1 <= c.y0 + c.d + 2;
  const cellById = (id, sb) => {
    const cols = Math.ceil(Math.sqrt(Math.max(1, r.plateCount))), n = id - 1;
    return { x0: (n % cols) * sb.w * 1.2 + sb.x0, y0: -Math.floor(n / cols) * sb.d * 1.2 + sb.y0, w: sb.w, d: sb.d };
  };
  const cellByPos = (bx, w, d) => {
    const sx = w * 1.2, sy = d * 1.2;
    const col = Math.round(((bx.x0 + bx.x1) / 2 - w / 2) / sx), row = Math.round(-((bx.y0 + bx.y1) / 2 - d / 2) / sy);
    const c = { x0: col * sx, y0: -row * sy, w, d };
    return col >= 0 && row >= 0 && inCell(bx, c) ? c : null;
  };
  const beds = [[256, 256], [180, 180], [330, 320], [350, 320], [b.w, b.d], [220, 220], [235, 235], [250, 210], [300, 300], [320, 320], [400, 400]];
  const boxes = used.map((g) => boxOf(g.list));
  let guess = null, best = 0;
  if (!r.bed) for (const [w, d] of beds) {
    const n = boxes.filter((bx) => cellByPos(bx, w, d)).length;
    if (n > best) { best = n; guess = [w, d]; }
  }
  const added = [];
  const place = async (list, bx, cell, target) => {
    if (target >= S.nPlates) S.nPlates = target + 1;
    const mx = b.x0 + b.w / 2, my = b.y0 + b.d / 2;
    // keep the layout of the source plate (centred), or centre the models when unknown
    let dx = cell ? mx - (cell.x0 + cell.w / 2) : mx - (bx.x0 + bx.x1) / 2;
    let dy = cell ? my - (cell.y0 + cell.d / 2) : my - (bx.y0 + bx.y1) / 2;
    // the source plate was bigger and the models would hang over the edge: centre them
    if (bx.x1 + dx > b.x0 + b.w + 1 || bx.x0 + dx < b.x0 - 1 || bx.y1 + dy > b.y0 + b.d + 1 || bx.y0 + dy < b.y0 - 1) {
      dx = mx - (bx.x0 + bx.x1) / 2; dy = my - (bx.y0 + bx.y1) / 2;
    }
    dx += plateX(target);
    for (const o of list) {
      let pos = o.positions;
      for (let i = 0; i < pos.length; i += 3) { pos[i] += dx; pos[i + 1] += dy; }
      const paint = { color: o.paint, supports: o.sup, seam: o.seam };
      pos = await lighter(o.name || base, pos, paint);
      const obj = addObject({ name: o.name || base, positions: pos, codes: paint.color, sup: paint.supports, seam: paint.seam, filament: fmap(o.filament) });
      const st = obj.states;
      for (let i = 0; i < st.length; i++) if (st[i]) st[i] = fmap(st[i]);
      recolor(obj);
      obj.plate = target;
      dropToBed(obj);
      added.push(obj);
    }
  };
  let target = first;
  for (const [k, g] of used.entries()) {
    const bx = boxes[k];
    let cell = r.bed && g.id ? cellById(g.id, r.bed) : null;
    if (cell && !inCell(bx, cell)) cell = null;
    if (!cell && guess) cell = cellByPos(bx, guess[0], guess[1]);
    await place(g.list, bx, cell, target++);
  }
  // models that sat beside the plates in the project: a plate of their own, packed (more plates if needed)
  if (loose.length) {
    const t = target;
    for (const o of loose) await place([o], boxOf([o]), null, t);
    arrange(t, false);
  }
  // a plain 3MF that names more filaments than the list has: add filaments for them
  let maxFil = 0;
  for (const o of added) {
    if (o.filament > maxFil) maxFil = o.filament;
    const st = o.states;
    for (let i = 0; i < st.length; i++) if (st[i] > maxFil) maxFil = st[i];
  }
  if (maxFil > S.filaments.length) { while (S.filaments.length < maxFil) addFilament(false); added.forEach(recolor); }
  const plates = new Set(added.map((o) => o.plate)).size;
  if (kept.length) F.toast(`Kept the project's print settings: ${kept.join(', ')}. Change them under Quality → All settings.`);
  if (r.skipped) F.toast(`${r.skipped} modifier / helper part${r.skipped === 1 ? ' was' : 's were'} left out (only printable parts are opened).`);
  F.toast(`Opened ${base}: ${added.length} object${added.length === 1 ? '' : 's'} on ${plates} plate${plates === 1 ? '' : 's'}${loose.length ? ` (${loose.length} that were beside the plates got a plate of their own)` : ''}. Your printer's own profiles are used, not the ones saved in the project.`);
  checkBounds();
  renderSide();
  setPlate(first);
  if (added.length) select(added.find((o) => o.plate === first) || added[0]);
}
const lastPlate = () => S.objects.reduce((m, o) => Math.max(m, o.plate), 0);

/**
 * The project's filaments join ours: same colour and material = same filament, others are added
 * (up to 16). Into an empty workspace the project's filaments replace ours, in its order.
 * Returns project filament number -> our filament number.
 */
function takeFilaments(r, fresh) {
  const cols = r.colours || [];
  if (!cols.length) return (f) => Math.min(Math.max(1, f || 1), MAX_FILAMENTS); // list grows to fit after placing
  if (fresh) S.filaments = [];
  const map = cols.map((c, k) => {
    const preset = pickPreset(r.types[k] || 'PLA');
    let n = S.filaments.findIndex((f) => f.color.toUpperCase() === c && F.family(f.preset) === F.family(preset));
    if (n < 0 && S.filaments.length < MAX_FILAMENTS) { S.filaments.push({ color: c, preset }); n = S.filaments.length - 1; }
    if (n < 0) n = nearestFilament(c);
    return n + 1;
  });
  if (!S.filaments.length) S.filaments = defaultFilaments(S.info, null);
  savePrefs();
  return (f) => map[(f || 1) - 1] || 1;
}
/** Takes the project's support / infill / wall / brim settings (only valid values of known settings). */
function takeSettings(set) {
  const byKey = new Map((S.schema || []).map((s) => [s.key, s]));
  const kept = [];
  for (const [k, v] of Object.entries(set)) {
    const sc = byKey.get(k);
    if (!sc || v === '' || v === 'nil') continue;
    if (sc.type === 'enum' && !sc.enum.some((e) => e.value === v)) continue;
    if (sc.type === 'bool' && !/^(0|1|true|false)$/.test(v)) continue;
    if ((sc.type === 'int' || sc.type === 'float') && !Number.isFinite(+v)) continue;
    if (String(fmtVal(S.values[k])) === v) { delete S.overrides[k]; continue; }
    S.overrides[k] = v;
    const label = sc.label || k;
    const shown = sc.type === 'bool' ? (/^(1|true)$/.test(v) ? 'on' : 'off') : sc.type === 'enum' ? (sc.enum.find((e) => e.value === v) || {}).label || v : v;
    kept.push(`${label} ${shown}`);
  }
  if (kept.length) savePrefs();
  return kept;
}
function nearestFilament(color) {
  let best = 0, bd = Infinity;
  S.filaments.forEach((f, i) => { const d = F.colorDiff(f.color, color); if (d < bd) { bd = d; best = i; } });
  return best;
}

function frameObjects() {
  const list = platesObjects(S.plate);
  if (!list.length) { viewHome(); return; }
  const box = new THREE.Box3();
  list.forEach((o) => box.union(worldBox(o)));
  const c = box.getCenter(new THREE.Vector3());
  const r = Math.max(60, box.getSize(new THREE.Vector3()).length());
  const dir = camera.position.clone().sub(controls.target).normalize();
  controls.target.copy(c);
  camera.position.copy(c).addScaledVector(dir, r * 1.6);
  controls.update(); invalidate();
}

// ================================================================== pointer: select, lay on face, paint
let painting = null; // {obj, ch, value, changed: Map}
let downAt = null;
const pointer = new THREE.Vector2();
const clipOn = () => S.mode === 'paint' && S.paint.clip < 100;
function clipZ() {
  if (!clipOn()) return Infinity;
  let top = 0;
  for (const o of platesObjects(S.plate)) top = Math.max(top, worldBox(o).max.z);
  return (top * S.paint.clip) / 100;
}
function applyClip(o) {
  const on = clipOn();
  o.mesh.material.clippingPlanes = on ? [clipPlane] : null;
  o.mesh.material.needsUpdate = true;
}
function updateClip() {
  clipPlane.constant = clipOn() ? clipZ() : 1e6;
  for (const o of S.objects) applyClip(o);
  invalidate();
}

function hitAt(e, objects = objGroup.children) {
  const r = renderer.domElement.getBoundingClientRect();
  pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const cz = clipZ();
  raycaster.firstHitOnly = cz === Infinity;
  const hits = raycaster.intersectObjects(objects, false);
  return hits.find((h) => h.point.z <= cz + 1e-3) || null;
}
function plateHitAt(e) {
  const r = renderer.domElement.getBoundingClientRect();
  pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  raycaster.firstHitOnly = false;
  const h = raycaster.intersectObjects(bedGroup.children.filter((c) => c.isMesh), false)[0];
  return h ? h.object.userData.plate : null;
}

const DRAG_TOOLS = new Set(['circle', 'sphere', 'triangle', 'height']);

// ---- drag a model across the bed (and onto other plates) with the mouse or a finger
let dragging = null; // {obj, plane, off: Vector3, start: Matrix4, moved}
const floorHit = (e, plane) => {
  const r = renderer.domElement.getBoundingClientRect();
  pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  return raycaster.ray.intersectPlane(plane, new THREE.Vector3());
};
function startDrag(e) {
  if (S.tool === 'face' || tcontrols.axis) return; // lay-on-face clicks / the arrows handle themselves
  const h = hitAt(e);
  if (!h) return; // empty space: turn the view
  e.stopPropagation(); e.preventDefault();
  const o = h.object.userData.obj;
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -h.point.z);
  const p = floorHit(e, plane);
  if (!p) return;
  dragging = { obj: o, plane, off: o.mesh.position.clone().sub(p), start: o.mesh.matrix.clone(), moved: false, x: e.clientX, y: e.clientY };
  renderer.domElement.setPointerCapture(e.pointerId);
  renderer.domElement.style.cursor = 'grabbing';
}
function moveDrag(e) {
  const d = dragging;
  if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return;
  const p = floorHit(e, d.plane);
  if (!p) return;
  if (!d.moved) { d.moved = true; if (S.selected !== d.obj) select(d.obj); }
  d.obj.mesh.position.x = p.x + d.off.x;
  d.obj.mesh.position.y = p.y + d.off.y;
  d.obj.mesh.updateMatrixWorld(true);
  // dragged past the last plate: a new plate appears there
  const b = bed(), st = stride(), w = worldBox(d.obj);
  const raw = Math.floor(((w.min.x + w.max.x) / 2 - b.x0 + (st - b.w) / 2) / st);
  if (raw === S.nPlates && S.nPlates < 99) { S.nPlates++; buildBed(); }
  checkBounds(true); // plate follows the model, red when it hangs off
  renderXf();
}
function endDrag() {
  const d = dragging;
  dragging = null;
  renderer.domElement.style.cursor = '';
  if (!d.moved) return false;
  pushUndo({ type: 'xf', obj: d.obj, m: d.start });
  checkBounds();
  if (d.obj.plate !== S.plate) setPlate(d.obj.plate); // the view follows the model
  else { renderPlateBar(); renderSide(); }
  return true;
}
async function onPointerDown(e) {
  if (e.target !== renderer.domElement || e.button !== 0) return;
  downAt = [e.clientX, e.clientY];
  if (S.mode === 'prepare') { startDrag(e); return; }
  if (S.mode !== 'paint') return;
  const h = hitAt(e);
  if (!h) return; // no model under the cursor: turn the view
  e.stopPropagation(); e.preventDefault();
  const o = h.object.userData.obj;
  if (S.selected !== o) { S.selected = o; renderSide(); }
  const ch = S.paint.ch;
  const value = e.shiftKey ? 0 : (ch === 'color' ? S.paint.filament : S.paint.mark);
  painting = { obj: o, ch, value, changed: new Map() };
  renderer.domElement.setPointerCapture(e.pointerId);
  if (DRAG_TOOLS.has(S.paint.tool)) applyTool(h);
  else { painting.once = true; await applyOnce(h); finishStroke(); }
}
function onPointerMove(e) {
  if (dragging) { moveDrag(e); return; }
  if (S.mode === 'prepare' && !tcontrols.dragging) {
    renderer.domElement.style.cursor = S.tool !== 'face' && e.buttons === 0 && hitAt(e) ? 'grab' : '';
    return;
  }
  if (S.mode !== 'paint') return;
  const h = hitAt(e);
  if (h) {
    showCursor(h, e.shiftKey);
    if (painting && DRAG_TOOLS.has(S.paint.tool) && h.object.userData.obj === painting.obj) applyTool(h);
  } else hideCursor();
  invalidate();
}
function onPointerUp(e) {
  if (painting) { if (!painting.once) finishStroke(); return; }
  if (dragging) { const moved = endDrag(); if (moved) { downAt = null; return; } }
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4 || tcontrols.dragging) { downAt = null; return; }
  downAt = null;
  if (S.mode === 'preview') { const pl = plateHitAt(e); if (pl != null && pl !== S.plate) setPlate(pl, false); return; }
  if (S.mode === 'paint') return;
  const h = hitAt(e);
  if (S.tool === 'face' && h) {
    const n = h.face.normal.clone().transformDirection(h.object.matrixWorld);
    layDown(h.object.userData.obj, n);
    return;
  }
  if (h) { const o = h.object.userData.obj; if (o.plate !== S.plate) setPlate(o.plate, false); select(o); return; }
  const pl = plateHitAt(e);
  if (pl != null && pl !== S.plate) setPlate(pl, false);
  select(null);
}
function finishStroke() {
  if (painting.changed.size) pushUndo({ type: 'paint', obj: painting.obj, ch: painting.ch, changed: painting.changed });
  painting = null;
  renderSide();
}
/** Alt + wheel: brush size (or band height); Ctrl + wheel: section view. */
function onWheel(e) {
  if (S.mode !== 'paint' || e.target !== renderer.domElement || !(e.altKey || e.ctrlKey)) return;
  e.preventDefault(); e.stopPropagation();
  const up = e.deltaY < 0;
  if (e.ctrlKey) { S.paint.clip = Math.max(0, Math.min(100, S.paint.clip + (up ? 2 : -2))); updateClip(); }
  else if (S.paint.tool === 'height') S.paint.height = Math.max(0.1, Math.min(50, +(S.paint.height * (up ? 1.15 : 0.87)).toFixed(2)));
  else S.paint.size = Math.max(0.3, Math.min(40, +(S.paint.size * (up ? 1.15 : 0.87)).toFixed(2)));
  renderSide();
}

function hideCursor() { cursorSphere.visible = cursorRing.visible = cursorBand.visible = false; }
function showCursor(h, erase) {
  hideCursor();
  const tool = S.paint.tool, col = erase ? 0xff6b6b : 0xffffff;
  for (const c of [cursorSphere, cursorRing, cursorBand]) c.material.color.setHex(col);
  if (tool === 'sphere') { cursorSphere.visible = true; cursorSphere.position.copy(h.point); cursorSphere.scale.setScalar(S.paint.size); }
  else if (tool === 'height') {
    const w = worldBox(h.object.userData.obj);
    cursorBand.visible = true;
    cursorBand.position.set((w.min.x + w.max.x) / 2, (w.min.y + w.max.y) / 2, h.point.z);
    cursorBand.scale.set(w.max.x - w.min.x + 6, w.max.y - w.min.y + 6, S.paint.height);
  } else {
    cursorRing.visible = true;
    cursorRing.position.copy(h.point);
    cursorRing.lookAt(camera.position);
    cursorRing.scale.setScalar(tool === 'circle' ? S.paint.size : 1.2);
  }
}

const fineTri = (geom, triIndex) => { const a = geom.index ? geom.index.getX(triIndex * 3) : triIndex * 3; return Math.floor(a / 3); };
/** Sets the stroke's value on the given fine triangles (below the section cut only). */
function setPaint(ids, valueOf) {
  const { obj: o, ch, changed } = painting;
  const arr = P.channel(o, ch, true);
  const cz = clipZ(), wz = cz === Infinity ? null : P.worldZ(o);
  let lo = Infinity, hi = -1;
  for (let i = 0; i < ids.length; i++) {
    const t = ids[i];
    if (wz && wz[t] > cz) continue;
    const v = valueOf ? valueOf(i) : painting.value;
    if (arr[t] === v) continue;
    if (!changed.has(t)) changed.set(t, arr[t]);
    arr[t] = v;
    if (t < lo) lo = t; if (t > hi) hi = t;
  }
  if (hi >= 0) { recolor(o, lo, hi + 1); markChanged(); }
}
function applyTool(h) {
  const o = painting.obj, tool = S.paint.tool;
  let ids;
  if (tool === 'sphere') ids = P.sphereTool(o, THREE, h.point, S.paint.size, INTERSECTED, NOT_INTERSECTED, CONTAINED, fineTri);
  else if (tool === 'circle') ids = P.circleTool(o, THREE, h.point, h.point.clone().sub(camera.position).normalize(), S.paint.size, INTERSECTED, NOT_INTERSECTED, fineTri);
  else if (tool === 'triangle') ids = P.triangleTool(o, fineTri(o.mesh.geometry, h.faceIndex));
  else if (tool === 'height') ids = P.heightTool(o, h.point.z, S.paint.height);
  if (ids) setPaint(ids);
}
async function applyOnce(h) {
  const o = painting.obj;
  if (!o.adj) { busy('Preparing the model…', 'Finding which surfaces touch (only the first time)', null); await new Promise((r) => setTimeout(r, 30)); P.adjacency(o); busy(null); }
  const arr = P.channel(o, painting.ch, true);
  if (S.paint.tool === 'fill') setPaint(P.fillTool(o, arr, fineTri(o.mesh.geometry, h.faceIndex), S.paint.smart ? S.paint.angle : null));
  else if (S.paint.tool === 'gap') {
    const pairs = P.gapFill(o, arr, S.paint.gap);
    setPaint(pairs.map((p) => p[0]), (i) => pairs[i][1]);
    F.toast(pairs.length ? 'Gaps filled.' : `No unpainted gaps smaller than ${S.paint.gap} mm² on this model.`);
  }
}
function markChanged() { /* the plate's slice is out of date (checked by plateKey) */ }

/** Whole-object paint actions (with undo). */
function paintWhole(o, ch, fn, filament) {
  if (!o) return;
  const arr = P.channel(o, ch, true);
  const changed = new Map();
  for (let t = 0; t < arr.length; t++) { const v = fn(arr[t], t); if (v !== arr[t]) { changed.set(t, arr[t]); arr[t] = v; } }
  pushUndo({ type: 'paint', obj: o, ch, changed, filament: o.filament });
  if (filament) o.filament = filament;
  recolor(o); renderSide();
}

// ================================================================== undo
function pushUndo(u) { S.undo.push(u); if (S.undo.length > 60) S.undo.shift(); }
function undo() {
  const u = S.undo.pop();
  if (!u) return;
  const restore = (obj, m) => { obj.mesh.matrix.copy(m); obj.mesh.matrix.decompose(obj.mesh.position, obj.mesh.quaternion, obj.mesh.scale); obj.mesh.updateMatrixWorld(true); };
  if (u.type === 'xf') restore(u.obj, u.m);
  if (u.type === 'many') for (const it of u.list) restore(it.obj, it.m);
  if (u.type === 'paint') { const arr = P.channel(u.obj, u.ch || 'color', true); for (const [t, v] of u.changed) arr[t] = v; if (u.filament) u.obj.filament = u.filament; recolor(u.obj); }
  if (u.type === 'remove') { objGroup.add(u.obj.mesh); S.objects.push(u.obj); }
  checkBounds(); buildBed(); renderSide(); invalidate();
}

function onKey(e) {
  if (!$('#view-slicer').classList.contains('active') || e.target.closest('input, select, textarea, dialog')) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if (S.mode === 'preview') {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); setLayer((S.layer || 1) + (e.key === 'ArrowUp' ? 1 : -1)); }
    return;
  }
  if (e.key === 'PageDown' || e.key === 'PageUp') { setPlate(S.plate + (e.key === 'PageDown' ? 1 : -1)); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && S.selected && S.mode === 'prepare') { removeObject(S.selected); return; }
  if (S.mode === 'paint') {
    if (/^[0-9]$/.test(e.key)) {
      const n = +e.key;
      if (S.paint.ch === 'color') { if (n <= S.filaments.length) S.paint.filament = n; } else if (n <= 2) S.paint.mark = n;
      renderSide(); return;
    }
    if (e.key === '[' || e.key === ']') { S.paint.size = Math.max(0.3, Math.min(40, +(S.paint.size * (e.key === ']' ? 1.25 : 0.8)).toFixed(2))); renderSide(); return; }
    const t = { c: 'circle', s: 'sphere', t: 'triangle', h: 'height', f: 'fill', g: 'gap' }[e.key.toLowerCase()];
    if (t) { S.paint.tool = t; renderSide(); }
    return;
  }
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
  circle: '<path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 2a7 7 0 1 1 0 14 7 7 0 0 1 0-14z"/>',
  sphere: '<path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 2a7 7 0 0 1 6.6 4.7C16.8 8.6 14.5 8 12 8s-4.8.6-6.6 1.7A7 7 0 0 1 12 5z"/>',
  triangle: '<path d="M12 3 2 20h20L12 3zm0 4 6.5 11h-13L12 7z"/>',
  height: '<path d="M3 9h18v6H3zM11 2h2v5h-2zm0 15h2v5h-2z"/>',
  fill: '<path d="M16.6 8.9 8.1.4 6.7 1.8l2.4 2.4-5.2 5.2a1.5 1.5 0 0 0 0 2.1l5.5 5.5a1.5 1.5 0 0 0 2.1 0l5.5-5.5a1.5 1.5 0 0 0 0-2.1zM5.2 10 10 5.2 14.8 10H5.2zM19 11.5s-2 2.2-2 3.5a2 2 0 0 0 4 0c0-1.3-2-3.5-2-3.5zM2 20h20v4H2z"/>',
  gap: '<path d="M4 4h6v6H4zm10 0h6v6h-6zM4 14h6v6H4zm10 0h6v6h-6z" opacity=".45"/><path d="M10 10h4v4h-4z"/>',
};
const ic = (n) => `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><g fill="currentColor">${ICON[n]}</g></svg>`;
const PAINT_TOOLS = [['circle', 'Circle', 'C'], ['sphere', 'Sphere', 'S'], ['triangle', 'Triangle', 'T'], ['height', 'Height range', 'H'], ['fill', 'Fill', 'F'], ['gap', 'Gap fill', 'G']];
function renderTools() {
  const t = $('#sl-tools');
  const sel = !!S.selected;
  if (S.mode === 'prepare') {
    t.innerHTML = `<div class="grp"><button data-sl="add" title="Add a model (STL, OBJ, 3MF)">${ic('add')}</button></div>
      <div class="grp">${[['move', 'Move (M)'], ['rotate', 'Rotate (R)'], ['scale', 'Scale (S)'], ['face', 'Lay on face (F): click the side that should be on the plate']].map(([k, tt]) => `<button data-tool="${k}" class="${S.tool === k ? 'active' : ''}" title="${tt}">${ic(k)}</button>`).join('')}</div>
      <div class="grp"><button data-sl="orient" title="Auto-orient: biggest flat side down" ${sel ? '' : 'disabled'}>${ic('orient')}</button>
        <button data-sl="arrange" title="Arrange this plate (what does not fit goes onto the next plate)" ${platesObjects(S.plate).length ? '' : 'disabled'}>${ic('arrange')}</button>
        <button data-sl="copy" title="Duplicate" ${sel ? '' : 'disabled'}>${ic('copy')}</button>
        <button data-sl="del" title="Delete (Del)" ${sel ? '' : 'disabled'}>${ic('del')}</button></div>
      <div class="grp"><button data-sl="undo" title="Undo (Ctrl+Z)" ${S.undo.length ? '' : 'disabled'}>${ic('undo')}</button><button data-sl="view" title="Show the whole plate">${ic('home')}</button></div>`;
  } else if (S.mode === 'paint') {
    t.innerHTML = `<div class="grp">${PAINT_TOOLS.map(([k, l, key]) => `<button data-ptool="${k}" class="${S.paint.tool === k ? 'active' : ''}" title="${l} (${key})">${ic(k)}</button>`).join('')}</div>
      <div class="grp"><button data-sl="undo" title="Undo (Ctrl+Z)" ${S.undo.length ? '' : 'disabled'}>${ic('undo')}</button><button data-sl="view" title="Show the whole plate">${ic('home')}</button></div>`;
  } else t.innerHTML = `<div class="grp"><button data-sl="view" title="Show the whole plate">${ic('home')}</button></div>`;
  const touch = matchMedia('(pointer: coarse)').matches;
  const ptip = {
    circle: 'Drag over a model to paint what you see inside the circle',
    sphere: 'Drag to paint everything inside the ball, also around corners',
    triangle: 'Drag over the model to paint whole model triangles',
    height: 'Drag to paint a horizontal band (stripes, colour changes by height)',
    fill: S.paint.smart ? 'Click a surface: fills it up to sharp edges' : 'Click: fills the whole connected area of the same colour',
    gap: 'Click a model: fills small unpainted gaps with the paint around them',
  }[S.paint.tool];
  const hints = {
    prepare: S.tool === 'face' ? 'Tap the side of a model that should lie on the plate' : (S.objects.length ? (touch ? 'Drag a model to move it (past the last plate makes a new one) · one finger on empty space turns the view · two fingers zoom and move' : 'Drag a model to move it, also onto another plate (past the last one makes a new plate) · drag empty space to turn the view · right-drag to pan · wheel to zoom') : ''),
    paint: touch ? ptip : `${ptip} · Shift = erase · Alt+wheel = size · Ctrl+wheel = section`,
    preview: '',
  };
  $('#sl-hint').textContent = S.objects.length || S.mode !== 'prepare' ? hints[S.mode] : '';
}

function applyMode() {
  const prev = S.mode === 'preview';
  objGroup.visible = !prev;
  previewGroup.visible = prev;
  hideCursor();
  $('#sl-layers').classList.toggle('hidden', !prev || !(S.res[S.plate] && S.res[S.plate].g));
  $('#sl-legend').classList.toggle('hidden', !prev || !(S.res[S.plate] && S.res[S.plate].g));
  if (S.mode !== 'prepare') tcontrols.detach(); else select(S.selected);
  updateClip();
  for (const o of S.objects) recolor(o);
  checkBounds();
  buildBed();
  renderTools(); renderSide();
  invalidate();
}

// ================================================================== side panel
function renderSide() {
  const side = $('#sl-side');
  if (!side || (!$('#view-slicer').classList.contains('active') && side.innerHTML)) return;
  if (S.loading) { side.innerHTML = '<div class="card"><p class="muted">Reading the printer profiles…</p><p class="small muted">The first time after an update or engine download this can take up to a minute.</p></div>'; return; }
  if (S.err) { side.innerHTML = `<div class="card"><div class="notice err">${esc(S.err)}</div><button class="btn small" data-sl="retry">Try again</button></div>`; return; }
  if (!S.info) { side.innerHTML = '<div class="card"><p class="muted">Add a printer first (Settings → Advanced → Printers).</p></div>'; return; }
  if (!S.info.known) {
    side.innerHTML = `<div class="card"><h2>Which printer is ${esc(S.info.name)}?</h2>
      <p class="muted small">The printer has not told the board its model yet (is it switched on?). Pick it once; only its own profiles are used.</p>
      <select data-set="model"><option value="">Choose…</option>${S.info.models.map((m) => `<option>${esc(m)}</option>`).join('')}</select></div>`;
    return;
  }
  const keep = side.scrollTop;
  if (S.mode === 'paint') side.innerHTML = paintPanel();
  else if (S.mode === 'preview') side.innerHTML = previewPanel();
  else side.innerHTML = preparePanel();
  side.scrollTop = keep;
  renderTools();
}

function printerCard() {
  const i = S.info;
  const nozzle = (n) => (/(\d\.\d+)\s*(HF\s*)?nozzle/i.exec(n) || [n, n])[0];
  const bedEnum = (S.schema || []).find((s) => s.key === 'curr_bed_type');
  return `<div class="card"><h2><span class="sl-printer">${esc(i.model)}</span>
      <span class="lock" title="Only profiles of the open printer can be used">🔒 ${esc(i.name)}</span></h2>
    <div class="row gap">
      <label class="field" style="flex:1"><span class="label">Nozzle</span><select data-set="machine">${i.nozzles.map((n) => `<option value="${esc(n)}" ${n === i.machine ? 'selected' : ''}>${esc(nozzle(n))}</option>`).join('')}</select></label>
      <label class="field" style="flex:1.4"><span class="label">Plate type</span><select data-set="bed">${(bedEnum ? bedEnum.enum : [{ value: S.bedType, label: S.bedType }]).map((e) => `<option value="${esc(e.value)}" ${e.value === S.bedType ? 'selected' : ''}>${esc(e.label)}</option>`).join('')}</select></label>
    </div></div>`;
}

function filamentsCard(withPresets = true) {
  const p = F.current();
  const heads = headCount();
  const many = S.filaments.length > 1;
  return `<div class="card"><h2>Filaments ${(p && p.slots && p.slots.length) ? '<button class="btn tiny" data-sl="loaded" title="Give filaments 1–' + p.slots.length + ' the spools loaded in the printer">Use loaded</button>' : ''}</h2>
    <div class="sl-fils">${S.filaments.map((f, i) => `<div class="sl-fil"><span class="n">${i + 1}</span>
      <input type="color" value="${esc(f.color)}" data-fil-color="${i}" title="Colour of filament ${i + 1}">
      ${withPresets ? `<select data-fil-preset="${i}">${S.info.filaments.map((x) => `<option ${x === f.preset ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>` : `<span class="small">${esc(f.preset.replace(/ @.*$/, ''))}</span>`}
      ${many ? `<button class="btn tiny ghost" data-fil-del="${i}" title="Remove filament ${i + 1} (its parts go to filament 1)">×</button>` : ''}</div>`).join('')}</div>
    <div class="row gap wrap" style="align-items:center;margin-top:6px">${S.filaments.length < MAX_FILAMENTS ? '<button class="btn tiny" data-sl="addfil">+ Add filament</button>' : ''}
      <span class="small muted">${S.filaments.length > heads ? `Each plate can use any ${heads} of these (the printer has ${heads} head${heads === 1 ? '' : 's'}); plates may use different ones.` : ''}</span></div></div>`;
}
/** Heads (tools / filament slots) the printer can print with in one go. */
function headCount() {
  const p = F.current();
  const slots = (p && p.id === S.printerId && p.slots && p.slots.length) || 0;
  const heads = (S.info && S.info.extruders) || 1;
  if (slots) return Math.max(heads, slots);
  return S.info && S.info.singleNozzleMulti ? Math.max(heads, 4) : heads;
}
function addFilament(render = true) {
  if (S.filaments.length >= MAX_FILAMENTS) return;
  const palette = ['#E8E8E8', '#202020', '#D32F2F', '#1E63D6', '#2E7D32', '#F9A825', '#8E24AA', '#EF6C00', '#00897B', '#6D4C41', '#C2185B', '#546E7A'];
  const color = palette.find((c) => !S.filaments.some((f) => f.color.toUpperCase() === c)) || '#888888';
  S.filaments.push({ color, preset: (S.filaments[0] && S.filaments[0].preset) || pickPreset('PLA') });
  savePrefs();
  if (render) renderSide();
}
function removeFilament(k) { // k: 1-based
  if (S.filaments.length <= 1) return;
  const fix = (v) => (v === k ? 1 : v > k ? v - 1 : v);
  for (const o of S.objects) {
    o.filament = fix(o.filament);
    const st = o.states;
    for (let i = 0; i < st.length; i++) if (st[i]) st[i] = fix(st[i]);
  }
  S.filaments.splice(k - 1, 1);
  if (S.infillFil) S.infillFil = S.infillFil === k ? 0 : S.infillFil > k ? S.infillFil - 1 : S.infillFil;
  if (S.paint.filament > S.filaments.length) S.paint.filament = 1;
  S.undo = S.undo.filter((u) => u.type !== 'paint'); // paint undo records use the old numbering
  savePrefs();
  for (const o of S.objects) recolor(o);
  renderSide(); invalidate();
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

const plateOptions = (cur) => Array.from({ length: S.nPlates }, (_, i) => `<option value="${i}" ${i === cur ? 'selected' : ''}>Plate ${i + 1}</option>`).join('') + `<option value="${S.nPlates}">New plate</option>`;
function preparePanel() {
  const byKey = new Map((S.schema || []).map((s) => [s.key, s]));
  const nChanged = Object.keys(S.overrides).filter((k) => k !== 'curr_bed_type').length;
  const sel = S.selected;
  const list = platesObjects(S.plate);
  return `${printerCard()}${filamentsCard()}
    <div class="card"><h2>Quality <button class="btn tiny" data-sl="all">All settings${nChanged ? ` (${nChanged} changed)` : ''}</button></h2>
      <label class="field"><span class="label">Profile</span><select data-set="process">${S.info.processes.map((p) => `<option ${p === S.process ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></label>
      ${SIMPLE.map(([k, l]) => byKey.has(k) ? settingRow(byKey.get(k), l) : '').join('')}
      <div class="sl-set ${S.infillFil ? 'changed' : ''}"><span class="nm" title="Print the inside of every model with one filament (for example cheap white), also on multi-colour prints. The outside keeps its colours as a skin about 3 mm thick."><span>Infill filament</span></span>
        <select data-set="infill"><option value="0">Same as the model</option>${S.filaments.map((f, k) => `<option value="${k + 1}" ${S.infillFil === k + 1 ? 'selected' : ''}>Filament ${k + 1}</option>`).join('')}</select></div>
    </div>
    <div class="card"><h2>Plate ${S.plate + 1}${S.nPlates > 1 ? ` <span class="muted small">of ${S.nPlates}</span>` : ''}
        <span class="row gap"><button class="btn tiny" data-sl="addplate" title="Add an empty plate">+ Plate</button>${S.nPlates > 1 ? '<button class="btn tiny ghost-danger" data-sl="delplate" title="Delete this plate">Delete</button>' : ''}</span></h2>
      ${list.length ? `<div class="sl-objs">${list.map((o) => `<div class="sl-obj ${o === sel ? 'sel' : ''}" data-obj="${o.id}">
        ${F.swatch(filColor(o.filament), 'sm')}<span class="nm" title="${esc(o.name)}">${esc(o.name)} ${o.outside ? '<span class="warn">off the plate</span>' : ''}</span>
        <select data-obj-fil="${o.id}" title="Filament">${S.filaments.map((_, i) => `<option value="${i + 1}" ${o.filament === i + 1 ? 'selected' : ''}>${i + 1}</option>`).join('')}</select>
        <button data-obj-del="${o.id}" title="Delete">✕</button></div>`).join('')}</div>
        ${sel && sel.plate === S.plate ? `${xfFields(sel)}<label class="field" style="margin-top:8px"><span class="label">Move to</span><select data-obj-plate="${sel.id}">${plateOptions(sel.plate)}</select></label>` : ''}`
        : `<p class="muted small">${S.objects.length ? 'This plate is empty. Drag a model here, or pick one on another plate and use "Move to".' : 'Nothing on the plate yet. Drop STL, OBJ or 3MF files on the 3D view.'}</p>`}
      <div class="row gap wrap" style="margin-top:8px"><button class="btn small" data-sl="add">Add model</button>${list.length ? '<button class="btn small" data-sl="arrange">Arrange</button><button class="btn small ghost-danger" data-sl="clear">Clear plate</button>' : ''}</div>
    </div>
    ${goButton()}`;
}
function xfFields(o) {
  const m = o.mesh, b = worldBox(o);
  const e = new THREE.Euler().setFromQuaternion(m.quaternion, 'XYZ');
  const deg = (r) => Math.round(THREE.MathUtils.radToDeg(r) * 10) / 10;
  const r1 = (v) => Math.round(v * 10) / 10;
  const px = plateX(o.plate);
  return `<div class="sl-xf" id="sl-xf">
    <label>X mm<input type="number" step="1" data-xf="x" value="${r1((b.min.x + b.max.x) / 2 - px)}"></label>
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
  const r = S.res[S.plate];
  const busyNow = r && r.job && r.job.state === 'slicing';
  const list = platesObjects(S.plate);
  const dis = !list.length || list.some((o) => o.outside) || busyNow;
  return `<div class="sl-go"><button class="btn primary big" data-sl="slice" ${dis ? 'disabled' : ''}>${busyNow ? 'Slicing…' : (S.nPlates > 1 ? `Slice plate ${S.plate + 1}` : 'Slice & preview')}</button>
    ${list.some((o) => o.outside) ? '<p class="hint" style="text-align:center">Move everything onto the plate first.</p>' : ''}
    <div class="sl-source">OrcaSlicer engine (AGPL-3.0) · <a href="https://github.com/Helio-Additive/slicer-cli" target="_blank" rel="noopener">source</a></div></div>`;
}

const contrast = (hex) => { const h = hex.replace('#', ''); const l = (0.299 * parseInt(h.substr(0, 2), 16) + 0.587 * parseInt(h.substr(2, 2), 16) + 0.114 * parseInt(h.substr(4, 2), 16)); return l > 150 ? '#111' : '#fff'; };
function slider(label, set, min, max, step, value, unit) {
  return `<label class="field"><span class="label">${label}: <b data-show="${set}">${value}${unit}</b></span><input type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-pset="${set}" data-unit="${unit}"></label>`;
}
function paintPanel() {
  const p = S.paint, o = S.selected && S.selected.plate === S.plate ? S.selected : null;
  const list = platesObjects(S.plate);
  if (!list.length) return `<div class="card"><h2>Paint</h2><p class="muted">There is nothing on plate ${S.plate + 1} to paint. Add a model in Prepare first.</p></div>`;
  const chTabs = `<div class="segmented sl-chs">${Object.entries(P.CHANNELS).map(([k, c]) => `<button data-pch="${k}" class="${p.ch === k ? 'active' : ''}">${c.label}</button>`).join('')}</div>`;
  const tools = `<div class="sl-ptools">${PAINT_TOOLS.map(([k, l, key]) => `<button data-ptool="${k}" class="${p.tool === k ? 'active' : ''}" title="${l} (${key})">${ic(k)}<span>${l}</span></button>`).join('')}</div>`;
  const pal = p.ch === 'color'
    ? `<div class="sl-pal">${S.filaments.map((f, i) => `<button data-pf="${i + 1}" class="${p.filament === i + 1 ? 'active' : ''}" style="background:${esc(f.color)};color:${contrast(f.color)}" title="Filament ${i + 1} (key ${i + 1})">${i + 1}</button>`).join('')}
        <button data-pf="0" class="erase ${p.filament === 0 ? 'active' : ''}" title="Eraser: back to the object's own filament (key 0, or hold Shift)">⌫</button></div>`
    : `<div class="sl-pal wide"><button data-pm="1" class="${p.mark === 1 ? 'active' : ''}" style="background:${ENFORCE};color:#fff">${p.ch === 'support' ? 'Enforce support' : 'Seam here'}</button>
        <button data-pm="2" class="${p.mark === 2 ? 'active' : ''}" style="background:${BLOCK};color:#fff">${p.ch === 'support' ? 'Block support' : 'No seam here'}</button>
        <button data-pm="0" class="erase ${p.mark === 0 ? 'active' : ''}" title="Eraser (or hold Shift)">⌫</button></div>`;
  let opts = '';
  if (p.tool === 'circle' || p.tool === 'sphere') opts = slider('Brush size', 'size', 0.3, 40, 0.1, p.size, ' mm');
  if (p.tool === 'height') opts = slider('Band height', 'height', 0.1, 50, 0.1, p.height, ' mm');
  if (p.tool === 'fill') opts = `<label class="check"><input type="checkbox" data-pbool="smart" ${p.smart ? 'checked' : ''}> Edge detection (smart fill): stop at sharp edges</label>${p.smart ? slider('Edge angle', 'angle', 0, 90, 1, p.angle, '°') : ''}`;
  if (p.tool === 'gap') opts = `${slider('Gap area', 'gap', 0.1, 50, 0.1, p.gap, ' mm²')}<button class="btn small" data-sl="gapnow" ${o ? '' : 'disabled'}>Fill gaps on ${o ? esc(o.name) : 'the model'}</button>`;
  const section = slider('Section view (cut from the top)', 'clip', 0, 100, 1, p.clip, '%');
  const supOff = String(valueOf('enable_support')) !== '1';
  const support = p.ch === 'support' ? `${supOff ? `<div class="notice warn">Supports are switched off, so painted supports do nothing yet. <button class="btn tiny" data-sl="supon">Switch on: only where painted</button></div>` : ''}<div class="card"><h2>Overhangs</h2>
      <label class="check"><input type="checkbox" data-pbool="overhang" ${p.overhang ? 'checked' : ''}> Highlight overhangs (orange)</label>
      ${slider('Overhang angle', 'ohAngle', 0, 90, 1, p.ohAngle, '°')}
      <button class="btn small" data-sl="enforceoh" ${o ? '' : 'disabled'}>Enforce support on all of them</button>
      <p class="hint">Painted supports are used when Supports is switched on (Prepare → Quality). With support type "Normal (manual)" or "Tree (manual)" only the painted areas get support; blockers always keep support away.</p></div>` : '';
  const seam = p.ch === 'seam' ? '<p class="hint">The seam (where each layer starts and ends) goes onto blue areas and never onto red ones.</p>' : '';
  const remap = p.ch === 'color' ? `<div class="row gap wrap" style="align-items:center"><span class="small">Change</span><select data-premap="from" style="width:auto">${S.filaments.map((_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('')}</select><span class="small">to</span><select data-premap="to" style="width:auto">${S.filaments.map((_, i) => `<option value="${i + 1}" ${i === 1 ? 'selected' : ''}>${i + 1}</option>`).join('')}</select><button class="btn tiny" data-sl="remap" ${o ? '' : 'disabled'}>Change</button></div>` : '';
  return `<div class="card"><h2>Paint ${chTabs}</h2>
      ${tools}${pal}${opts}${section}${seam}
    </div>
    ${support}
    <div class="card"><h2>Model</h2>
      <label class="field"><span class="label">Model on plate ${S.plate + 1}</span><select data-set="paintobj">${list.map((x) => `<option value="${x.id}" ${x === o ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
      <div class="row gap wrap">
        ${p.ch === 'color' ? `<button class="btn small" data-sl="fillobj" ${o ? '' : 'disabled'}>Whole model in filament ${p.filament || (o && o.filament) || 1}</button>` : ''}
        <button class="btn small ghost-danger" data-sl="clearpaint" ${o ? '' : 'disabled'}>Erase all ${P.CHANNELS[p.ch].label.toLowerCase()} paint</button>
      </div>
      ${remap}
    </div>
    ${filamentsCard(false)}
    <details class="card sl-keys"><summary>Mouse and keys</summary>
      <div class="kv small"><div>Left drag</div><div>Paint (on a model) / turn the view (next to it)</div><div>Shift + drag</div><div>Erase</div><div>Right drag</div><div>Move the view</div>
      <div>Alt + wheel</div><div>Brush size / band height</div><div>Ctrl + wheel</div><div>Section view</div><div>1–9 / 0</div><div>Pick filament / eraser</div>
      <div>C S T H F G</div><div>Circle, Sphere, Triangle, Height, Fill, Gap fill</div><div>[ ]</div><div>Smaller / bigger brush</div><div>Ctrl + Z</div><div>Undo</div></div></details>
    ${goButton()}`;
}

function previewPanel() {
  const r = S.res[S.plate], j = r && r.job;
  const list = platesObjects(S.plate);
  const others = Array.from({ length: S.nPlates }, (_, i) => i).filter((i) => platesObjects(i).length);
  const allBtn = others.length > 1 ? `<button class="btn small" data-sl="sliceall">Slice all ${others.length} plates</button>` : '';
  if (!list.length) return `<div class="card"><h2>Plate ${S.plate + 1}</h2><p class="muted">This plate is empty.</p><a class="btn" href="#slicer/prepare">Back to Prepare</a> ${allBtn}</div>`;
  if (!j) return `<div class="card"><h2>Plate ${S.plate + 1}</h2><p class="muted">Not sliced yet.</p><button class="btn primary" data-sl="slice">Slice plate ${S.plate + 1}</button> ${allBtn}</div>`;
  if (j.state === 'error') return `<div class="card"><h2>Slicing failed</h2><div class="notice err">${esc(j.error || j.message)}</div><a class="btn" href="#slicer/prepare">Back to Prepare</a> <button class="btn" data-sl="slice">Try again</button></div>`;
  if (j.state !== 'done') return `<div class="card"><h2>Plate ${S.plate + 1}</h2><p class="muted">${esc(j.message || 'Slicing…')}</p></div>`;
  const st = j.stats || {};
  const used = (st.grams || []).map((g, i) => [i, g, (st.meters || [])[i]]).filter((x) => x[1] > 0);
  const stale = r.key !== plateKey(S.plate);
  const fil = toolFilaments(S.plate);
  const mg = S.merge[S.plate];
  const mergeNote = mg && Object.keys(mg.map).length ? `<p class="small muted" style="margin-top:6px">${Object.entries(mg.map).map(([a, b]) => `Colour ${a} prints with filament ${b}`).join(' · ')} (the printer holds ${headCount()}). <button class="btn tiny" data-sl="remerge">Change</button></p>` : '';
  const q = `plate=${S.plate + 1}`;
  return `<div class="card"><h2>${esc(j.name.replace(/\.gcode(\.3mf)?$/, ''))}</h2>
      ${stale ? '<div class="notice warn">The plate changed since this slice. <button class="btn tiny" data-sl="slice">Slice again</button></div>' : ''}
      <div class="sl-stats"><div><span class="muted small">Print time</span><div class="big">${esc(st.time || '–')}</div></div>
      <div class="row gap wrap small muted"><span>${st.layers || 0} layers</span><span>${(st.totalGrams || 0).toFixed(1)} g</span>${st.changes ? `<span>${st.changes} filament changes</span>` : ''}</div></div>
      ${allBtn ? `<div style="margin-top:10px">${allBtn}</div>` : ''}
    </div>
    <div class="card"><h2>Filament use</h2>${used.map(([t, g, m]) => { const f = fil[t] || t + 1; return `<div class="sl-use">${F.swatch(filColor(f), 'sm')}<span>${f} · ${esc((S.filaments[f - 1] || {}).preset ? S.filaments[f - 1].preset.replace(/ @.*$/, '') : '')}</span><span>${g.toFixed(1)} g${m ? ` · ${m} m` : ''}</span></div>`; }).join('') || '<p class="muted small">–</p>'}
      ${mergeNote}${r.infill ? `<p class="small muted" style="margin-top:6px">The inside of the models is printed with filament ${r.infill}; their colours form a skin about 3 mm thick.</p>` : ''}${r.towerWall ? `<p class="small muted" style="margin-top:6px">The prime tower has ${r.towerWall === 'rib' ? 'ribbed' : 'plain'} walls on this plate: the usual cone-shaped one (it widens with the print height) does not fit beside the models.</p>` : ''}${r.noTower ? '<p class="small muted" style="margin-top:6px">No prime tower on this plate: the models leave no room for it. Each colour has its own nozzle, so it prints without one (a colour may leave a small string or blob where it starts).</p>' : ''}</div>
    ${(j.warnings || []).length ? `<div class="card"><h2>Check</h2>${j.warnings.map((w) => `<div class="notice warn small">${esc(w)}</div>`).join('')}</div>` : ''}
    <div class="card"><h2>Show</h2><div class="segmented"><button data-pc="tool" class="${S.previewColor === 'tool' ? 'active' : ''}">Filament</button><button data-pc="feature" class="${S.previewColor === 'feature' ? 'active' : ''}">Line type</button></div></div>
    <div class="sl-go"><div class="row gap"><a class="btn" href="/api/slicer/gcode?${q}&download=1" download title="Save the G-code (for a USB stick or another program)">G-code</a>${j.hasProject ? `<a class="btn" href="/api/slicer/gcode?${q}&download=3mf" download title="Save the sliced project (.gcode.3mf, opens in OrcaSlicer)">3MF</a>` : ''}<button class="btn primary big" style="flex:1" data-sl="print">Print${S.nPlates > 1 ? ` plate ${S.plate + 1}` : ''}…</button></div>
      <div class="sl-source">OrcaSlicer engine (AGPL-3.0) · <a href="https://github.com/Helio-Additive/slicer-cli" target="_blank" rel="noopener">source</a></div></div>`;
}

// ================================================================== events from the panel
async function onClick(e) {
  const b = e.target.closest('button, [data-obj]');
  if (!b) return;
  const act = b.dataset.sl;
  if (b.dataset.plate !== undefined && b.closest('#sl-plates')) { setPlate(+b.dataset.plate); return; }
  if (b.dataset.tool) { setTool(b.dataset.tool); return; }
  if (b.dataset.ptool) { S.paint.tool = b.dataset.ptool; renderSide(); return; }
  if (b.dataset.pch) { S.paint.ch = b.dataset.pch; for (const o of S.objects) recolor(o); renderSide(); return; }
  if (b.dataset.pf !== undefined) { S.paint.filament = +b.dataset.pf; renderSide(); return; }
  if (b.dataset.pm !== undefined) { S.paint.mark = +b.dataset.pm; renderSide(); return; }
  if (b.dataset.pc) { S.previewColor = b.dataset.pc; savePrefs(); colorPreview(); renderSide(); return; }
  if (b.dataset.feat !== undefined) { const f = +b.dataset.feat; S.hiddenFeatures.has(f) ? S.hiddenFeatures.delete(f) : S.hiddenFeatures.add(f); colorPreview(); return; }
  if (b.dataset.reset) { delete S.overrides[b.dataset.reset]; changed(); return; }
  if (b.dataset.filDel !== undefined) { const k = +b.dataset.filDel + 1; if (F.confirmBox) F.confirmBox(`Remove filament ${k}?`, 'Parts painted or set to it go to filament 1.', 'Remove').then((ok) => ok && removeFilament(k)); else removeFilament(k); return; }
  if (b.dataset.objDel) { removeObject(S.objects.find((o) => o.id === +b.dataset.objDel)); return; }
  if (b.dataset.obj && !e.target.closest('select, button')) { if (S.mode === 'prepare') select(S.objects.find((o) => o.id === +b.dataset.obj)); return; }
  const o = S.selected;
  switch (act) {
    case 'add': $('#sl-file').click(); break;
    case 'orient': autoOrient(o); break;
    case 'arrange': arrange(S.plate); break;
    case 'copy': duplicate(o); break;
    case 'del': removeObject(o); break;
    case 'undo': undo(); break;
    case 'view': frameObjects(); break;
    case 'addplate': addPlate(); break;
    case 'delplate': deletePlate(S.plate); break;
    case 'loaded': useLoaded(); break;
    case 'addfil': addFilament(); break;
    case 'remerge': delete S.merge[S.plate]; slice(S.plate); break;
    case 'all': renderAll(); $('#sl-all-dialog').showModal(); break;
    case 'slice': slice(S.plate); break;
    case 'sliceall': sliceAll(); break;
    case 'print': sendToPrinter(S.plate); break;
    case 'retry': loadPrinter(F.current().id); break;
    case 'fillobj': if (o) paintWhole(o, 'color', () => 0, S.paint.filament || o.filament); break;
    case 'clearpaint': if (o) paintWhole(o, S.paint.ch, () => 0); break;
    case 'remap': {
      const from = +$('[data-premap="from"]').value, to = +$('[data-premap="to"]').value;
      if (o) paintWhole(o, 'color', (v) => ((v || o.filament) === from ? to : v), o.filament === from ? to : 0);
      break;
    }
    case 'supon':
      S.overrides.enable_support = '1';
      if (!/manual/.test(String(valueOf('support_type')))) S.overrides.support_type = String(valueOf('support_type')).startsWith('tree') ? 'tree(manual)' : 'normal(manual)';
      changed(); F.toast('Supports on: only where you painted them (Prepare → Quality → Support type).'); break;
    case 'enforceoh': if (o) { const set = overhangSet(o); paintWhole(o, 'support', (v, t) => (set[t] && v === 0 ? 1 : v)); } break;
    case 'gapnow': if (o) { painting = { obj: o, ch: S.paint.ch, value: 0, changed: new Map() }; await applyOnce({ object: o.mesh, faceIndex: 0 }); finishStroke(); } break;
    case 'clear':
      if (!(await F.confirmBox(`Clear plate ${S.plate + 1}?`, 'All models on this plate are removed.', 'Clear'))) return;
      for (const x of platesObjects(S.plate)) objGroup.remove(x.mesh);
      S.objects = S.objects.filter((x) => x.plate !== S.plate); S.undo = []; select(null); delete S.res[S.plate]; buildBed(); break;
    default:
  }
}

function onInput(e) {
  const t = e.target;
  if (t.dataset.pset) {
    const v = +t.value;
    S.paint[t.dataset.pset] = v;
    const show = $(`[data-show="${t.dataset.pset}"]`);
    if (show) show.textContent = v + (t.dataset.unit || '');
    if (t.dataset.pset === 'clip') updateClip();
    if (t.dataset.pset === 'ohAngle' && S.paint.overhang) for (const o of platesObjects(S.plate)) recolor(o);
  }
  if (t.dataset.filColor !== undefined) {
    S.filaments[+t.dataset.filColor].color = t.value;
    for (const o of S.objects) recolor(o);
    if (S.res[S.plate] && S.res[S.plate].g) colorPreview();
  }
}

async function onChange(e) {
  const t = e.target;
  const set = t.dataset.set;
  if (set === 'model') { await loadPrinter(S.printerId, '&model=' + encodeURIComponent(t.value)); applyMode(); return; }
  if (set === 'machine') { savePrefsMachine(t.value); await loadPrinter(S.printerId); return; }
  if (set === 'bed') { S.bedType = t.value; changed(false); return; }
  if (set === 'infill') { S.infillFil = +t.value; changed(false); return; }
  if (set === 'process') { S.process = t.value; S.loading = true; renderSide(); await loadValues(); S.loading = false; changed(); return; }
  if (set === 'paintobj') { S.selected = S.objects.find((o) => o.id === +t.value) || null; renderSide(); return; }
  if (t.dataset.pbool) { S.paint[t.dataset.pbool] = t.checked; if (t.dataset.pbool === 'overhang') for (const o of S.objects) recolor(o); renderSide(); return; }
  if (t.dataset.filPreset !== undefined) { S.filaments[+t.dataset.filPreset].preset = t.value; changed(false); return; }
  if (t.dataset.filColor !== undefined) { savePrefs(); renderSide(); return; }
  if (t.dataset.objFil) { const o = S.objects.find((x) => x.id === +t.dataset.objFil); o.filament = +t.value; recolor(o); renderSide(); return; }
  if (t.dataset.objPlate) { const o = S.objects.find((x) => x.id === +t.dataset.objPlate); moveToPlate(o, +t.value); return; }
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
  if (k === 'x') m.position.x += v + plateX(o.plate) - (b.min.x + b.max.x) / 2;
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
  list.innerHTML = names.map((g) => `<h3>${esc(g)}</h3>${groups.get(g).sort((a, b) => (a.mode === 'simple' ? 0 : 1) - (b.mode === 'simple' ? 0 : 1) || a.label.localeCompare(b.label)).map((s) => settingRow(s, s.label, true)).join('')}`).join('')
    || '<p class="muted">No setting matches.</p>';
}

// ================================================================== slicing (one plate at a time)
function hashArr(a) { if (!a) return 0; let h = 0; for (let i = 0; i < a.length; i++) h = (h * 31 + a[i]) | 0; return h; }
/** Filament number -> how many paint pieces use it, for the models on plate i. */
/**
 * A free spot for the prime tower (purge block for colour changes) on plate i, from the models'
 * real outline on the bed (not their bounding box: round models leave the corners free).
 * Corners first, then anywhere; the deepest tower room that fits wins. Plate coordinates of the
 * tower's front-left corner, inside its brim. free: false when nothing fits.
 */
function towerSpot(i, tools = 2) {
  const b = bed(), px = plateX(i), G = 2;
  const nx = Math.ceil(b.w / G), ny = Math.ceil(b.d / G);
  const occ = new Uint8Array(nx * ny);
  const v = new THREE.Vector3();
  for (const o of platesObjects(i)) {
    const pos = o.mesh.geometry.attributes.position.array, m = o.mesh.matrixWorld;
    for (let t = 0; t < pos.length; t += 9) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = 0; k < 9; k += 3) {
        v.set(pos[t + k], pos[t + k + 1], pos[t + k + 2]).applyMatrix4(m);
        const x = v.x - px - b.x0, y = v.y - b.y0;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      const i0 = Math.max(0, Math.floor(x0 / G)), i1 = Math.min(nx - 1, Math.floor(x1 / G));
      const j0 = Math.max(0, Math.floor(y0 / G)), j1 = Math.min(ny - 1, Math.floor(y1 / G));
      for (let j = j0; j <= j1; j++) occ.fill(1, j * nx + i0, j * nx + i1 + 1);
    }
  }
  // How much room the tower takes (measured with the engine): its core is prime_tower_width wide and
  // grows ~10 mm deeper per extra colour; around it a 5 mm brim plus, depending on its walls, a cone
  // that widens with the print height (height x tan(apex / 2) on every side), ~10 mm ribs, or nothing.
  // Flashforge's profiles use the cone; when that does not fit, ribs, then plain walls are tried.
  let H = 0;
  for (const o of platesObjects(i)) H = Math.max(H, worldBox(o).max.z);
  const num = (k, d) => { const n = parseFloat(valueOf(k)); return Number.isFinite(n) ? n : d; };
  const width = num('prime_tower_width', 28), brim = num('prime_tower_brim_width', 5);
  const core = Math.min(45, 5 + 10 * Math.max(1, tools - 1));
  const current = String(valueOf('wipe_tower_wall_type') || 'cone');
  const walls = { cone: H * Math.tan((num('wipe_tower_cone_angle', 12) / 2) * Math.PI / 180), rib: num('wipe_tower_extra_rib_length', 10), rectangle: 0 };
  const order = [current, ...['cone', 'rib', 'rectangle'].filter((w) => w !== current)];
  const edge = 2, gap = 4;
  for (const wall of order) {
    const pad = brim + (walls[wall] || 0);
    const W = width + 2 * pad, D = core + 2 * pad;
    if (W > b.w - 2 * edge || D > b.d - 2 * edge) continue;
    const freeAt = (x, y) => {
      const i0 = Math.max(0, Math.floor((x - gap) / G)), i1 = Math.min(nx - 1, Math.floor((x + W + gap) / G));
      const j0 = Math.max(0, Math.floor((y - gap) / G)), j1 = Math.min(ny - 1, Math.floor((y + D + gap) / G));
      for (let j = j0; j <= j1; j++) for (let k = i0; k <= i1; k++) if (occ[j * nx + k]) return false;
      return true;
    };
    const spots = [];
    for (let x = edge; x <= b.w - edge - W; x += G) for (let y = edge; y <= b.d - edge - D; y += G) {
      const dc = Math.min(Math.hypot(x - edge, y - edge), Math.hypot(b.w - edge - W - x, y - edge), Math.hypot(x - edge, b.d - edge - D - y), Math.hypot(b.w - edge - W - x, b.d - edge - D - y));
      spots.push([dc, x, y]);
    }
    spots.sort((p, q) => p[0] - q[0]); // corners first
    for (const [, x, y] of spots) {
      if (freeAt(x, y)) return { x: +(b.x0 + x + pad).toFixed(1), y: +(b.y0 + y + pad).toFixed(1), free: true, wall: wall === current ? null : wall };
    }
  }
  return { x: 0, y: 0, free: false, wall: null };
}
/** Project filament number for each tool of plate i's slice (tool t -> fil[t]). */
function toolFilaments(i) { return (S.res[i] && S.res[i].tools) || S.filaments.map((_, k) => k + 1); }
function plateUse(i) {
  const n = new Float64Array(256);
  for (const o of platesObjects(i)) {
    const st = o.states;
    for (let t = 0; t < st.length; t++) n[st[t] || o.filament]++;
  }
  const m = new Map();
  n.forEach((c, f) => { if (c && f) m.set(f, c); });
  return m;
}
/** Plate i uses more filaments than the printer holds: which one prints each extra colour? */
function askMerge(i, use) {
  const heads = headCount();
  const byUse = [...use.keys()].sort((a, b) => use.get(b) - use.get(a));
  const keep = byUse.slice(0, heads).sort((a, b) => a - b), extra = byUse.slice(heads).sort((a, b) => a - b);
  const nearest = (f) => keep.reduce((b, k) => (F.colorDiff(S.filaments[k - 1].color, S.filaments[f - 1].color) < F.colorDiff(S.filaments[b - 1].color, S.filaments[f - 1].color) ? k : b), keep[0]);
  const sw = (f) => `${F.swatch(filColor(f), 'sm')} <b>${f}</b>`;
  const dlg = document.createElement('dialog');
  dlg.className = 'dialog';
  dlg.innerHTML = `<form method="dialog" class="dialog-body"><h2>Plate ${i + 1} uses ${use.size} colours</h2>
    <p>${esc(S.info.name || 'This printer')} prints ${heads} colour${heads === 1 ? '' : 's'} at a time, so ${extra.length === 1 ? 'one colour has' : `${extra.length} colours have`} to print with another filament on this plate.
      The ${heads} most used colours keep their filament (${keep.map(sw).join(' ')}).</p>
    ${extra.map((f) => `<div class="row gap" style="align-items:center;margin:8px 0"><span>Colour ${sw(f)} prints with</span>
      <select data-merge="${f}">${keep.map((k) => `<option value="${k}" ${k === nearest(f) ? 'selected' : ''}>filament ${k} (${esc(S.filaments[k - 1].color)})</option>`).join('')}</select></div>`).join('')}
    <p class="small muted">Only this plate's print changes; your painting is kept. To print the colours differently, cancel and repaint or move parts to another plate.</p>
    <div class="row gap" style="justify-content:flex-end"><button class="btn" value="cancel">Cancel</button><button class="btn primary" value="ok">Slice</button></div></form>`;
  document.body.appendChild(dlg);
  return new Promise((res) => {
    dlg.addEventListener('close', () => {
      const map = {};
      if (dlg.returnValue === 'ok') dlg.querySelectorAll('[data-merge]').forEach((sel) => { map[+sel.dataset.merge] = +sel.value; });
      dlg.remove();
      res(dlg.returnValue === 'ok' ? map : null);
    });
    dlg.showModal();
  });
}
function plateKey(i) {
  const px = plateX(i);
  return JSON.stringify([S.printerId, S.info && S.info.machine, S.process, S.bedType, S.filaments, S.overrides, S.merge[i] || null, S.infillFil || 0,
    platesObjects(i).map((o) => { const e = o.mesh.matrix.elements.map((x) => Math.round(x * 1000)); e[12] -= Math.round(px * 1000); return [o.id, o.filament, e, hashArr(o.states), hashArr(o.sup), hashArr(o.seam)]; })]);
}

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

/** World positions on the plate (plate i's own coordinates). */
function platePositions(o, i) {
  o.mesh.updateMatrixWorld(true);
  const m = o.mesh.matrixWorld.elements, p = o.orig, out = new Float32Array(p.length), dx = plateX(i);
  for (let k = 0; k < p.length; k += 3) {
    const x = p[k], y = p[k + 1], z = p[k + 2];
    out[k] = m[0] * x + m[4] * y + m[8] * z + m[12] - dx;
    out[k + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[k + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return out;
}
function codesOf(o, arr) {
  if (!arr) return null;
  const n = o.levels.length;
  let any = false;
  const codes = new Array(n);
  for (let t = 0; t < n; t++) { codes[t] = encodeTree(arr, o.start[t], o.levels[t]); if (codes[t]) any = true; }
  return any ? codes : null;
}

let pollTimer = null, queue = [];
async function slice(i = S.plate) {
  const list = platesObjects(i);
  if (!list.length) { F.toast(`Plate ${i + 1} is empty.`, true); return false; }
  checkBounds();
  if (list.some((o) => o.outside)) { F.toast(`Some models on plate ${i + 1} are off the plate. Move them onto it first.`, true); setPlate(i); location.hash = '#slicer/prepare'; return false; }
  const supOn = /^(1|true)$/.test(String(valueOf('enable_support')));
  if (!supOn && list.some((o) => o.sup && o.sup.includes(1))) F.toast('Painted supports are left out: Supports is switched off (switch it on under Paint → Supports).', true);
  // Only the filaments this plate uses are sent, as tools 1..n. More than the printer can hold
  // at once: ask which of the others prints each extra colour (or cancel and repaint).
  const use = plateUse(i);
  // Infill filament: the inside of every model in one filament (also for multi-colour prints).
  const infill = S.infillFil > 0 && S.infillFil <= S.filaments.length ? S.infillFil : 0;
  if (infill) use.set(infill, Infinity); // never merged away
  const U = [...use.keys()].sort((a, b) => a - b);
  let merge = {};
  if (U.length > headCount()) {
    const prev = S.merge[i];
    if (prev && prev.u === U.join()) merge = prev.map;
    else {
      merge = await askMerge(i, use);
      if (!merge) return false;
      S.merge[i] = { u: U.join(), map: merge };
    }
  } else delete S.merge[i];
  const toolFils = [...new Set(U.map((f) => merge[f] || f))].sort((a, b) => a - b);
  const toolOf = new Map(U.map((f) => [f, toolFils.indexOf(merge[f] || f) + 1]));
  if (S.mode !== 'preview') { history.replaceState(null, '', '#slicer/preview'); S.mode = 'preview'; $$('#mode-tabs a').forEach((a) => a.classList.toggle('active', a.dataset.mode === 'preview')); }
  if (S.plate !== i) { S.plate = i; buildBed(); }
  clearPreview();
  applyMode();
  busy(`Preparing plate ${i + 1}…`, 'Packing the models', 0, false);
  await new Promise((r) => setTimeout(r, 30));
  const key = plateKey(i);
  let blob;
  try {
    const data = export3mf(list.map((o) => {
      const st = new Uint8Array(o.states.length);
      // with an infill filament every surface is painted with its own colour: the engine then keeps
      // the colours as a skin and only the inside follows the infill filament (unpainted surfaces
      // would otherwise turn into the infill colour too).
      for (let t = 0; t < st.length; t++) st[t] = o.states[t] ? toolOf.get(o.states[t]) : (infill ? toolOf.get(o.filament) : 0);
      return { name: o.name, positions: platePositions(o, i), paint: { color: codesOf(o, st), supports: supOn ? codesOf(o, o.sup) : null, seam: codesOf(o, o.seam) }, filament: toolOf.get(o.filament) };
    }), plateName(i));
    blob = new Blob([data], { type: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml' });
  } catch (e) { busy(null); F.toast('Could not pack the plate: ' + e.message, true); return false; }
  const overrides = { ...S.overrides };
  if (S.bedType) overrides.curr_bed_type = S.bedType;
  if (infill) {
    overrides.sparse_infill_filament_id = String(toolOf.get(infill));
    if (overrides.mmu_segmented_region_max_width === undefined) overrides.mmu_segmented_region_max_width = '3';
  }
  const towerOn = !/^(0|false)$/.test(String(valueOf('enable_prime_tower')));
  let tower = toolFils.length > 1 && towerOn ? towerSpot(i, toolFils.length) : null, noTower = false, towerWall = null;
  // No free spot for the prime tower (the models fill the plate): a printer with a nozzle per
  // colour (Creator 5) prints fine without one; a single nozzle needs it, so it is kept.
  if (tower && !tower.free && (S.info.extruders || 1) > 1 && overrides.enable_prime_tower === undefined) {
    overrides.enable_prime_tower = '0'; tower = null; noTower = true;
    F.toast(`No room for the prime tower on plate ${i + 1}: printing without it (each colour has its own nozzle).`);
  }
  if (tower && tower.free && tower.wall && overrides.wipe_tower_wall_type === undefined) { overrides.wipe_tower_wall_type = tower.wall; towerWall = tower.wall; }
  if (tower) tower = { x: tower.x, y: tower.y };
  const opts = { printer: S.printerId, machine: S.info.machine, process: S.process, filaments: toolFils.map((f) => S.filaments[f - 1]), overrides, name: plateName(i), thumb: thumbnail(list), tower };
  const fd = new FormData();
  fd.append('options', JSON.stringify(opts));
  fd.append('model', blob, 'plate.3mf');
  const r = await new Promise((res) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/slicer/slice?plate=${i + 1}`);
    xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) busy(`Sending plate ${i + 1} to the board…`, `${(ev.loaded / 1e6).toFixed(1)} of ${(ev.total / 1e6).toFixed(1)} MB`, ev.loaded / ev.total * 100); };
    xhr.onload = () => { try { res(JSON.parse(xhr.responseText)); } catch (_) { res({ ok: false, message: 'The board gave no answer.' }); } };
    xhr.onerror = () => res({ ok: false, message: 'Lost the connection to the board.' });
    xhr.send(fd);
  });
  if (!r.ok) { busy(null); F.toast(r.message || 'Slicing could not start.', true); renderSide(); return false; }
  S.res[i] = { job: r.job, key, g: null, tools: toolFils, noTower, towerWall, infill };
  renderSide(); renderPlateBar();
  poll(i);
  return true;
}
function plateName(i) {
  const names = [...new Set(platesObjects(i).map((o) => o.name))];
  const base = (names.length === 1 ? names[0] : names.length ? `${names[0]} + ${names.length - 1} more` : 'Plate').slice(0, 52);
  return S.nPlates > 1 ? `${base} - plate ${i + 1}` : base;
}
async function poll(i) {
  clearTimeout(pollTimer);
  const r = await F.api(`slicer/job?plate=${i + 1}`);
  const j = r.job;
  if (!j) { busy(null); return; }
  S.res[i] = S.res[i] || { key: '', g: null };
  S.res[i].job = j;
  if (j.state === 'slicing') {
    busy(`Slicing plate ${i + 1} on the board…`, `${j.message || ''} (${j.seconds}s)${queue.length ? ` · ${queue.length} more plate(s) waiting` : ''}`, j.percent, true);
    pollTimer = setTimeout(() => poll(i), 700);
    return;
  }
  busy(null);
  renderPlateBar();
  if (j.state === 'done' && S.plate === i && S.mode === 'preview') await loadPreview(i);
  else if (j.state === 'error') F.toast(`Plate ${i + 1}: slicing failed: ${j.error || j.message}`, true);
  renderSide();
  if (queue.length) { const next = queue.shift(); await slice(next); }
}
async function sliceAll() {
  queue = Array.from({ length: S.nPlates }, (_, i) => i).filter((i) => platesObjects(i).length && !(S.res[i] && S.res[i].job && S.res[i].job.state === 'done' && S.res[i].key === plateKey(i)));
  if (!queue.length) { F.toast('Every plate is already sliced.'); return; }
  await slice(queue.shift());
}
async function cancelSlice() {
  queue = [];
  await F.api('slicer/job/cancel', { method: 'POST' });
  clearTimeout(pollTimer);
  busy(null);
  if (S.res[S.plate]) S.res[S.plate] = null;
  location.hash = '#slicer/prepare';
}

async function sendToPrinter(i) {
  const r = await F.api('slicer/send', { method: 'POST', body: { printer: S.printerId, plate: i + 1 } });
  if (!r.ok) { F.toast(r.message, true); return; }
  if (F.current().id !== S.printerId) { F.toast('Saved to ' + S.info.name + "'s files."); return; }
  F.printFile(r.file);
}

// ================================================================== preview
/** Shows plate i in the preview, slicing it first when it changed since its last slice. */
function previewPlate(i) {
  const r = S.res[i];
  clearPreview();
  if (!platesObjects(i).length) { renderSide(); return; }
  if (!r || !r.job || r.key !== plateKey(i)) {
    if (!(r && r.job && r.job.state === 'slicing')) { slice(i); return; }
  }
  if (r.job.state === 'done') { if (r.g) buildPreview(r.g, i); else loadPreview(i); }
  renderSide();
}
function clearPreview() {
  previewGroup.clear();
  segMesh = null;
  $('#sl-layers').classList.add('hidden');
  $('#sl-legend').classList.add('hidden');
  invalidate();
}
async function loadPreview(i) {
  busy('Loading the preview…', 'Reading the G-code', null);
  try {
    const res = await fetch(`/api/slicer/gcode?plate=${i + 1}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('The G-code could not be fetched.');
    const text = await res.text();
    await new Promise((r) => setTimeout(r, 20));
    const g = parseGcode(text);
    S.res[i].g = g;
    if (S.plate === i) buildPreview(g, i);
  } catch (e) {
    F.toast(e.message, true);
  } finally { busy(null); }
}
let segMesh = null;
function buildPreview(g, i) {
  previewGroup.clear();
  previewGroup.position.set(plateX(i), 0, 0);
  const n = g.count;
  if (!n) { F.toast('The G-code has no printed paths.', true); return; }
  segMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(), n);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), z = new THREE.Vector3(0, 0, 1);
  const seg = g.seg;
  for (let k = 0; k < n; k++) {
    const o = k * 7, x0 = seg[o], y0 = seg[o + 1], x1 = seg[o + 2], y1 = seg[o + 3], zz = seg[o + 4], h = Math.max(0.05, seg[o + 5]), w = Math.max(0.1, seg[o + 6]);
    const len = Math.hypot(x1 - x0, y1 - y0);
    p.set((x0 + x1) / 2, (y0 + y1) / 2, zz - h / 2);
    q.setFromAxisAngle(z, Math.atan2(y1 - y0, x1 - x0));
    s.set(len + w * 0.5, w, h * 0.9);
    m.compose(p, q, s);
    segMesh.setMatrixAt(k, m);
  }
  segMesh.instanceMatrix.needsUpdate = true;
  segMesh.frustumCulled = false;
  previewGroup.add(segMesh);
  S.previewG = g;
  colorPreview();
  const sl = $('#sl-layer');
  sl.max = String(g.layerEnd.length);
  setLayer(g.layerEnd.length);
  $('#sl-layers').classList.toggle('hidden', S.mode !== 'preview');
  $('#sl-legend').classList.toggle('hidden', S.mode !== 'preview');
  invalidate();
}
function colorPreview() {
  const g = S.previewG;
  if (!g || !segMesh) return;
  const c = new THREE.Color();
  const fil = toolFilaments(S.plate);
  const tools = fil.map((f) => new THREE.Color(filColor(f)));
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
  const used = byTool ? [...new Set(g.tool)].sort((a, b) => a - b) : [...new Set(g.feature)].sort((a, b) => a - b);
  $('#sl-legend').innerHTML = byTool
    ? used.map((t) => `<div class="li"><i style="background:${esc(filColor(fil[t] || t + 1))}"></i>Filament ${fil[t] || t + 1}</div>`).join('')
    : used.map((f) => `<button class="li ${S.hiddenFeatures.has(f) ? 'off' : ''}" data-feat="${f}" title="Show / hide"><i style="background:${FEATURES[f][1]}"></i>${FEATURES[f][0]}</button>`).join('');
  invalidate();
}
function setLayer(n) {
  const g = S.previewG;
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
function thumbnail(list) {
  try {
    const size = 300;
    thumbRenderer ??= new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    thumbRenderer.setSize(size, size, false);
    const box = new THREE.Box3();
    list.forEach((o) => box.union(worldBox(o)));
    const c = box.getCenter(new THREE.Vector3()), r = box.getSize(new THREE.Vector3()).length() / 2;
    const cam = new THREE.PerspectiveCamera(30, 1, 1, 5000);
    cam.up.set(0, 0, 1);
    cam.position.set(c.x + r * 1.6, c.y - r * 2.4, c.z + r * 2.0);
    cam.lookAt(c);
    const vis = S.objects.map((o) => o.mesh.visible);
    const was = [bedGroup.visible, previewGroup.visible, objGroup.visible, tcontrols.getHelper().visible];
    bedGroup.visible = false; previewGroup.visible = false; objGroup.visible = true; tcontrols.getHelper().visible = false; hideCursor();
    S.objects.forEach((o) => { o.mesh.visible = list.includes(o); o.mesh.material.emissive.setHex(0); o.mesh.material.clippingPlanes = null; });
    thumbRenderer.render(scene, cam);
    S.objects.forEach((o, k) => { o.mesh.visible = vis[k]; applyClip(o); });
    [bedGroup.visible, previewGroup.visible, objGroup.visible, tcontrols.getHelper().visible] = was;
    checkBounds();
    return thumbRenderer.domElement.toDataURL('image/png');
  } catch (_) { return ''; }
}
