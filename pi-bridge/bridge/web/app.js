// Flash Bridge – printer screen + settings (plain JavaScript, no build step).
// The slicer (Prepare / Paint / Preview) is a separate module, web/slicer/slicer.js, loaded on first use.
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } },
};

const state = { status: null, ai: null, view: 'home', tab: 'general', sub: 'printers', sel: store.get('ffb.sel', ''), scanned: [], pendingSeen: '' };

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api/' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  let data = {};
  try { data = await res.json(); } catch (_) { /* empty */ }
  if (!res.ok && data.ok === undefined) data.ok = false;
  return data;
}

function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (err ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 4500);
}
function notice(el, msg, kind = '') {
  el.classList.remove('hidden');
  el.className = 'notice' + (kind ? ' ' + kind : '');
  el.textContent = msg;
}
function confirmBox(title, text, yes = 'Yes') {
  const d = $('#confirm-dialog');
  $('#cf-title').textContent = title;
  $('#cf-text').textContent = text;
  $('#cf-yes').textContent = yes;
  d.returnValue = '';
  d.showModal();
  return new Promise((r) => d.addEventListener('close', () => r(d.returnValue === 'yes'), { once: true }));
}
document.addEventListener('click', (e) => {
  const c = e.target.closest('[data-close]');
  if (c) c.closest('dialog').close();
});

const fmtTime = (s) => {
  s = Math.max(0, Math.round(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
};
const prettyName = (f) => String(f || '').split('/').pop().replace(/(\.gcode\.3mf|\.3mf\.gcode|\.3mf|\.gcode|\.gco|\.g)$/i, '');
const CLEAR_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M2 18h20v2H2zm7.6-3.4L5 10l1.4-1.4 3.2 3.2 7.9-7.9L19 5.3z"/></svg>';
const clearBtn = (primary) => `<button class="btn ${primary ? 'primary' : ''}" data-act="clear" title="Tells the printer the plate is empty, so the next print can start">${CLEAR_ICON}Clear platform</button>`;
const swatch = (hex, cls = '') => `<span class="swatch ${cls}" style="background:${esc(hex)}"></span>`;

// ---------------------------------------------------------------- colours (for live verdicts in the print dialog)
function lab(hex) {
  const h = String(hex).replace('#', '');
  const v = (i) => { const c = parseInt(h.substr(i, 2), 16) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const r = v(0), g = v(2), b = v(4);
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047), y = f(r * 0.2126 + g * 0.7152 + b * 0.0722), z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const colorDiff = (a, b) => { const p = lab(a), q = lab(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
const family = (m) => { const u = String(m).toUpperCase().replace(/[^A-Z0-9]/g, ''); return ['PETG', 'PLA', 'ABS', 'ASA', 'TPU', 'PA', 'PC', 'PVA', 'HIPS', 'PET'].find((f) => u.startsWith(f)) || u; };
function verdict(fil, slot) {
  if (fil.type && slot.material && family(fil.type) !== family(slot.material)) return ['err', 'Different material!'];
  const d = colorDiff(fil.color, slot.color);
  if (d <= 12) return ['ok', 'Match'];
  if (d <= 28) return ['warn', 'Close colour'];
  return ['warn', 'Different colour'];
}

// ---------------------------------------------------------------- routing
function route() {
  const parts = (location.hash.slice(1) || 'home').split('/');
  state.view = ['settings', 'help', 'slicer'].includes(parts[0]) ? parts[0] : 'home';
  if (state.view === 'slicer' && !slicerOn()) { location.hash = '#home'; return; }
  const mode = state.view === 'slicer' ? (['prepare', 'paint', 'preview'].includes(parts[1]) ? parts[1] : 'prepare') : (state.view === 'home' ? 'home' : '');
  $$('#mode-tabs a').forEach((a) => a.classList.toggle('active', a.dataset.mode === mode));
  document.documentElement.classList.toggle('in-slicer', state.view === 'slicer');
  if (state.view === 'help') showHelp(parts[1] || 'start');
  if (state.view === 'settings') {
    state.tab = ['general', 'network', 'advanced'].includes(parts[1]) ? parts[1] : 'general';
    if (state.tab === 'advanced') state.sub = ['printers', 'ai', 'mainsail', 'printernet', 'system'].includes(parts[2]) ? parts[2] : 'printers';
  }
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + state.view));
  $('#btn-settings').classList.toggle('active', state.view === 'settings');
  $('#btn-help').classList.toggle('active', state.view === 'help');
  $$('#settings-tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === state.tab));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + state.tab));
  $$('#adv-tabs a').forEach((a) => a.classList.toggle('active', a.dataset.sub === state.sub));
  $$('.subpage').forEach((t) => t.classList.toggle('active', t.id === 'sub-' + state.sub));
  if (state.view === 'home') { setCamera(); renderHome(); } else stopCamera();
  if (state.view === 'slicer') loadSlicer().then((m) => m && m.show(mode));
  else if (slicerMod) slicerMod.hide();
  if (state.view === 'settings') {
    if (state.tab === 'general') { loadSettings(); renderLayoutForm(); loadSlicerSettings(); }
    if (state.tab === 'network') loadNetwork(true);
    if (state.tab === 'advanced') {
      if (state.sub === 'printers') renderPrinterList();
      if (state.sub === 'ai') loadAi();
      if (state.sub === 'mainsail') renderMainsail();
      if (state.sub === 'printernet') loadPrinterNet();
      if (state.sub === 'system') { loadSystem(); loadLogs(); loadUpdate(); }
    }
  }
  if (state.view !== 'slicer') window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- slicer (lazy module)
let slicerMod = null, slicerLoading = null;
const slicerOn = () => !!(state.status && state.status.slicer && state.status.slicer.enabled);
function loadSlicer() {
  if (slicerMod) return Promise.resolve(slicerMod);
  slicerLoading ??= import('./slicer/slicer.js').then((m) => { slicerMod = m; m.init(window.FFB); return m; }).catch((e) => {
    slicerLoading = null;
    toast('The slicer could not be loaded: ' + e.message, true);
    return null;
  });
  return slicerLoading;
}
function showModeTabs() {
  $('#mode-tabs').classList.toggle('hidden', !slicerOn() || !printers().length);
}

// ---------------------------------------------------------------- help
let helpTopics = null;
async function showHelp(topic) {
  if (!helpTopics) {
    try {
      const res = await fetch('help/help.html', { cache: 'no-cache' });
      const box = document.createElement('div');
      box.innerHTML = await res.text();
      helpTopics = $$('section[data-topic]', box).map((sec) => ({ id: sec.dataset.topic, title: sec.dataset.title, group: sec.dataset.group || '', html: sec.innerHTML }));
    } catch (_) {
      $('#help-body').innerHTML = '<p class="muted">The help pages could not be loaded. Check the connection to the board.</p>';
      return;
    }
  }
  const t = helpTopics.find((x) => x.id === topic) || helpTopics[0];
  let lastGroup = '';
  $('#help-toc').innerHTML = helpTopics.map((x) => {
    const g = x.group !== lastGroup ? `<div class="toc-group">${esc(x.group)}</div>` : '';
    lastGroup = x.group;
    return `${g}<a href="#help/${x.id}" class="${x.id === t.id ? 'active' : ''}">${esc(x.title)}</a>`;
  }).join('');
  const i = helpTopics.indexOf(t);
  const prev = helpTopics[i - 1], next = helpTopics[i + 1];
  $('#help-body').innerHTML = `<h2 class="help-title">${esc(t.title)}</h2>${t.html}
    <div class="help-nav">${prev ? `<a class="btn" href="#help/${prev.id}">‹ ${esc(prev.title)}</a>` : '<span></span>'}${next ? `<a class="btn primary" href="#help/${next.id}">${esc(next.title)} ›</a>` : ''}</div>`;
  $('#help-toc a.active')?.scrollIntoView({ block: 'nearest', inline: 'center' });
}
window.addEventListener('hashchange', route);

// ---------------------------------------------------------------- status polling
async function refreshStatus() {
  try {
    const s = await api('status');
    if (!s.printers) return;
    state.status = s;
    renderTabs();
    showModeTabs();
    if (state.view === 'slicer' && !slicerOn()) location.hash = '#home';
    $('#update-dot').classList.toggle('hidden', !(s.update && s.update.available));
    if (state.view === 'home') renderHome();
    if (state.view === 'settings' && state.tab === 'advanced') {
      if (state.sub === 'printers') renderPrinterList(false);
      if (state.sub === 'ai') renderAiPrinters();
    }
  } catch (_) {
    $('#state-chip').innerHTML = '<span class="dot err"></span>Board not reachable…';
  }
}

const printers = () => (state.status ? state.status.printers : []);
function current() {
  const ps = printers();
  return ps.find((p) => p.id === state.sel) || ps[0] || null;
}
function jobStatus(p) {
  if (!p.enabled) return ['', 'Disabled'];
  if (!p.online) return ['err', 'Offline'];
  if (p.pending) return ['warn', 'Waiting for you'];
  switch (p.jobState) {
    case 'printing': return ['busy', `Printing ${Math.round(p.progress * 100)}%`];
    case 'paused': return ['warn', 'Paused'];
    case 'complete': return ['on', 'Finished'];
    case 'cancelled': return ['', 'Cancelled'];
    case 'error': return ['err', 'Error'];
    default: return ['on', 'Ready'];
  }
}

function renderTabs() {
  const ps = printers();
  const nav = $('#printer-tabs');
  const cur = current();
  // Tabs on wide screens; with 2+ printers, phones get a drop-down instead (tabs would be cut off).
  let html = ps.length > 1 || state.view === 'settings'
    ? ps.map((p) => { const [k] = jobStatus(p); return `<button data-p="${esc(p.id)}" class="${p.id === cur?.id ? 'active' : ''}"><span class="dot ${k}"></span>${esc(p.name)}</button>`; }).join('')
    : ps.map((p) => { const [k, t] = jobStatus(p); return `<button class="active" data-p="${esc(p.id)}"><span class="dot ${k}"></span>${esc(p.name)} <span class="muted small">${esc(t)}</span></button>`; }).join('');
  nav.classList.toggle('multi', ps.length > 1);
  if (ps.length > 1) {
    html += `<label class="printer-select"><span class="dot ${jobStatus(cur)[0]}"></span><select aria-label="Printer">${ps.map((p) =>
      `<option value="${esc(p.id)}" ${p.id === cur?.id ? 'selected' : ''}>${esc(p.name)} — ${esc(jobStatus(p)[1])}</option>`).join('')}</select></label>`;
  }
  // Only touch the DOM when something changed, so an open drop-down isn't closed by the 2-second refresh.
  if (nav.dataset.html !== html && !(document.activeElement && document.activeElement.closest('.printer-select'))) {
    nav.dataset.html = html;
    nav.innerHTML = html;
  }
}
function selectPrinter(id) {
  state.sel = id;
  store.set('ffb.sel', state.sel);
  if (state.view === 'slicer') { renderTabs(); if (slicerMod) slicerMod.printerChanged(); return; }
  if (state.view !== 'home') location.hash = '#home'; else { setCamera(); renderTabs(); renderHome(); }
}
$('#printer-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-p]');
  if (b) selectPrinter(b.dataset.p);
});
$('#printer-tabs').addEventListener('change', (e) => {
  if (e.target.matches('.printer-select select')) { e.target.blur(); selectPrinter(e.target.value); }
});

// ---------------------------------------------------------------- camera
const cam = $('#cam-img');
function setCamera(force = false) {
  const p = current();
  const want = p && p.hasCamera && p.online && !document.hidden ? `/api/printers/${encodeURIComponent(p.id)}/camera` : '';
  if (!want) {
    stopCamera();
    $('#cam-empty').classList.remove('hidden');
    $('#cam-empty-text').textContent = !p ? '' : !p.online ? 'Printer offline' : 'This printer has no camera';
    $('#btn-cam-retry').classList.toggle('hidden', !p || !p.online || !p.hasCamera);
    return;
  }
  if (!force && cam.dataset.src === want) return;
  cam.dataset.src = want;
  cam.src = want + '?t=' + Date.now();
  $('#cam-empty').classList.add('hidden');
}
function stopCamera() { cam.removeAttribute('src'); cam.dataset.src = ''; }
// Size the camera box to the camera's real picture shape (no black bars). Camera streams don't
// reliably fire 'load', so check the picture size a few times a second until it is known.
function applyCamShape(ar) { if (ar > 0.3 && ar < 4) document.documentElement.style.setProperty('--cam-ar', ar.toFixed(4)); }
try { applyCamShape(parseFloat(localStorage.getItem('ffb-cam-ar'))); } catch (_) {}
setInterval(() => {
  if (!cam.dataset.src || !cam.naturalWidth || !cam.naturalHeight) return;
  const ar = cam.naturalWidth / cam.naturalHeight;
  if (document.documentElement.style.getPropertyValue('--cam-ar') === ar.toFixed(4)) return;
  applyCamShape(ar);
  try { localStorage.setItem('ffb-cam-ar', ar.toFixed(4)); } catch (_) {}
}, 400);
cam.addEventListener('error', () => {
  if (!cam.dataset.src) return;
  cam.dataset.src = '';
  $('#cam-empty').classList.remove('hidden');
  $('#cam-empty-text').textContent = 'Camera not reachable';
  $('#btn-cam-retry').classList.remove('hidden');
});
$('#btn-cam-retry').addEventListener('click', () => setCamera(true));
document.addEventListener('visibilitychange', () => { if (state.view === 'home') setCamera(); });
$('#btn-fullscreen').addEventListener('click', () => {
  const c = $('#camera');
  if (document.fullscreenElement) document.exitFullscreen();
  else if (c.requestFullscreen) c.requestFullscreen();
  else if (cam.webkitEnterFullscreen) cam.webkitEnterFullscreen();
});

// ---------------------------------------------------------------- home
const aiChips = {
  watching: ['on', 'AI watching'], warning: ['warn', 'AI: possible failure'], paused: ['err', 'AI paused the print'],
  ignored: ['', 'AI muted for this print'], 'ai-offline': ['warn', 'AI starting'], idle: ['', 'AI ready'],
};

function renderHome() {
  const ps = printers();
  const p = current();
  $('#welcome').classList.toggle('hidden', !!p || !state.status);
  $('#printer-view').classList.toggle('hidden', !p);
  if (!p) { $('#pending-banner').classList.add('hidden'); $('#ai-banner').classList.add('hidden'); return; }
  if (state.sel !== p.id) { state.sel = p.id; setCamera(); }
  setCamera();
  const [k, label] = jobStatus(p);
  $('#state-chip').innerHTML = `<span class="dot ${k}"></span>${esc(label)}`;
  const ai = p.aiEnabled && aiChips[p.ai?.status];
  $('#ai-chip').innerHTML = ai ? `<span class="dot ${ai[0]}"></span>${esc(ai[1])}` : '';
  $('#btn-light').classList.toggle('on', !!p.light);
  $('#btn-light').classList.toggle('hidden', !p.online);

  // banners
  const pend = p.pending;
  $('#pending-banner').classList.toggle('hidden', !pend);
  if (pend) {
    $('#pending-text').textContent = `${prettyName(pend.file)} is waiting: check which filament goes in which slot.`;
    const key = p.id + '|' + pend.file;
    if (state.pendingSeen !== key && !$('#print-dialog').open) { state.pendingSeen = key; openPending(p); }
  }
  const pe = p.online && p.error;
  $('#err-banner').classList.toggle('hidden', !pe);
  if (pe) {
    $('#err-title').textContent = `Printer error ${pe.code}: ${pe.title}`;
    $('#err-fix').textContent = pe.fix;
    $('#err-link').href = pe.wikiUrl;
  }
  const a = p.ai || {};
  const alarm = p.aiEnabled && (a.status === 'warning' || a.status === 'paused');
  $('#ai-banner').classList.toggle('hidden', !alarm);
  if (alarm) $('#ai-banner-text').textContent = a.status === 'paused' ? 'The AI paused this print because it looks like it failed. Check the camera.' : (a.message || 'The AI thinks this print may be failing. Check the camera.');

  renderJob(p);
  renderSlots(p);
  renderTemps(p);
  renderControls(p);
}

function renderJob(p) {
  const active = p.jobState === 'printing' || p.jobState === 'paused';
  const done = p.jobState === 'complete' || p.jobState === 'cancelled';
  const thumb = $('#job-thumb');
  const tsrc = (active || done) && p.jobThumb ? p.jobThumb : '';
  if (thumb.dataset.src !== tsrc) { thumb.dataset.src = tsrc; if (tsrc) thumb.src = tsrc; else thumb.removeAttribute('src'); }
  thumb.classList.toggle('hidden', !tsrc);
  $('#job').classList.toggle('no-thumb', !tsrc);
  thumb.onerror = () => { thumb.classList.add('hidden'); $('#job').classList.add('no-thumb'); };
  let title, sub = '', stats = '', actions = '';
  if (!p.online) {
    title = p.enabled ? 'Printer offline' : 'Printer disabled';
    sub = p.error || p.stateMessage || '';
    actions = '<a class="btn" href="#settings/advanced/printers">Connection settings</a>';
  } else if (active) {
    title = prettyName(p.jobFile) || 'Printing';
    sub = p.jobState === 'paused' ? 'Paused' : (p.uploadStatus || 'Printing');
    const eta = new Date(Date.now() + p.remaining * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    stats = `<span><b>${Math.round(p.progress * 100)}%</b></span>` +
      (p.layers ? `<span>Layer <b>${p.layer}/${p.layers}</b></span>` : '') +
      `<span><b>${fmtTime(p.remaining)}</b> left</span><span>Done ~<b>${eta}</b></span><span>${fmtTime(p.elapsed)} elapsed</span>`;
    actions = (p.jobState === 'paused'
      ? '<button class="btn primary" data-act="resume">Resume</button>'
      : '<button class="btn" data-act="pause">Pause</button>') + '<button class="btn ghost-danger" data-act="cancel">Stop</button>';
  } else if (done) {
    title = prettyName(p.jobFile) || (p.jobState === 'complete' ? 'Print finished' : 'Print cancelled');
    sub = p.autoClearPlatform ? 'Finished — clearing the platform automatically…'
      : (p.jobState === 'complete' ? 'Finished — take the print off, then press Clear platform.' : 'Cancelled — press Clear platform before the next print.');
    actions = clearBtn(true) + '<button class="btn" data-act="files">Print a file</button>';
  } else {
    title = 'Ready to print';
    sub = p.uploadStatus || p.model || '';
    actions = '<button class="btn primary big" data-act="files">Print a file</button>' + clearBtn(false);
  }
  $('#job-title').textContent = title;
  $('#job-sub').textContent = sub;
  $('#job-progress').classList.toggle('hidden', !active);
  $('#job-bar').style.width = (active ? p.progress * 100 : 0) + '%';
  $('#job-stats').innerHTML = stats;
  const box = $('#job-actions');
  if (box.dataset.html !== actions) { box.dataset.html = actions; box.innerHTML = actions; }
}

$('#job-actions').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'files') return openFiles();
  if (act === 'clear') { const r = await control({ action: 'clear' }); if (r && r.ok) toast('Platform cleared — the printer is ready for the next print.'); return; }
  if (act === 'cancel' && !(await confirmBox('Stop this print?', 'The print is cancelled on the printer. This cannot be undone.', 'Stop print'))) return;
  control({ action: act });
});

async function control(body) {
  const p = current();
  if (!p) return;
  const r = await api(`printers/${encodeURIComponent(p.id)}/control`, { method: 'POST', body });
  if (!r.ok) toast(r.message || 'The printer did not accept that.', true);
  setTimeout(refreshStatus, 800);
  return r;
}

async function setAutoClear(el) {
  const p = current();
  if (el.checked && !(await confirmBox('Clear the platform automatically?',
    'A few seconds after every print ends, the bridge tells the printer the plate is clear. Only remotely started prints could then land on a plate that still has a part on it — so take finished prints off promptly.', 'Turn on'))) {
    el.checked = false;
    return;
  }
  const r = await api(`printers/${encodeURIComponent(p.id)}/option`, { method: 'POST', body: { autoClearPlatform: el.checked } });
  toast(r.ok ? (el.checked ? 'Auto clear platform is on.' : 'Auto clear platform is off.') : (r.message || 'Could not save'), !r.ok);
  refreshStatus();
}
$('#btn-light').addEventListener('click', () => { const p = current(); if (p) control({ action: 'light', on: !p.light }); });

function renderSlots(p) {
  const card = $('#slots').closest('.card');
  card.classList.toggle('hidden', !p.slots || !p.slots.length);
  if (!p.slots || !p.slots.length) return;
  $('#slots-hint').textContent = 'tap a slot to change it';
  $('#slots').innerHTML = p.slots.map((s) => `
    <button class="slot ${s.slotId === p.currentSlot && (p.jobState === 'printing' || p.jobState === 'paused') ? 'current' : ''}" data-slot="${s.slotId}">
      ${s.hasFilament ? swatch(s.color) : '<span class="swatch empty"></span>'}
      <span class="mat">${s.hasFilament ? esc(s.material || '?') : 'Empty'}</span>
      <span class="num">Slot ${s.slotId}</span>
    </button>`).join('');
}
$('#slots').addEventListener('click', (e) => { const b = e.target.closest('[data-slot]'); if (b) openSlot(+b.dataset.slot); });

function renderTemps(p) {
  const t = [];
  const tools = p.tools || [];
  tools.forEach((x, i) => t.push({ key: 'tool' + i, label: tools.length > 1 ? `Nozzle ${i + 1}` : 'Nozzle', ...x }));
  if (p.bed) t.push({ key: 'bed', label: 'Bed', ...p.bed });
  if (p.chamber) t.push({ key: 'chamber', label: 'Chamber', ...p.chamber });
  $('#temps').innerHTML = t.map((x) => `
    <button class="temp ${x.target > 0 && x.current < x.target - 2 ? 'heating' : ''}" data-temp="${x.key}" data-label="${esc(x.label)}" data-target="${Math.round(x.target || 0)}" ${p.online ? '' : 'disabled'}>
      <div class="t-label">${esc(x.label)}</div>
      <div class="t-val">${Math.round(x.current || 0)}°</div>
      <div class="t-target">${x.target > 0 ? '→ ' + Math.round(x.target) + '°' : 'off'}</div>
    </button>`).join('');
}
$('#temps').addEventListener('click', (e) => { const b = e.target.closest('[data-temp]'); if (b) openTemp(b.dataset.temp, b.dataset.label, +b.dataset.target); });

function renderControls(p) {
  const printing = p.jobState === 'printing' || p.jobState === 'paused';
  const key = [p.id, p.online, printing, p.hasFiltration].join('|');
  const box = $('#controls');
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    let h = `<div class="ctl"><span class="ctl-name">Light</span><label class="switch"><input type="checkbox" data-ctl="light"><span></span></label></div>
            <div class="ctl"><span class="ctl-name">Auto clear platform<small>Clears the "print finished" message on the printer by itself</small></span><label class="switch"><input type="checkbox" data-ctl="autoclear"><span></span></label></div>`;
    if (p.hasFiltration) {
      h += `<div class="ctl"><span class="ctl-name">Filtration – inside<small>Recirculates air through the filter</small></span><label class="switch"><input type="checkbox" data-ctl="fint"><span></span></label></div>
            <div class="ctl"><span class="ctl-name">Filtration – exhaust<small>Blows air out of the printer</small></span><label class="switch"><input type="checkbox" data-ctl="fext"><span></span></label></div>`;
    }
    if (printing) {
      h += `<div class="ctl"><span class="ctl-name">Print speed</span><div class="segmented" data-ctl="speed">
              <button data-v="50">50%</button><button data-v="100">100%</button><button data-v="125">125%</button><button data-v="150">150%</button></div></div>
            <div class="ctl"><span class="ctl-name">Z-offset<small>Squish the first layers more (−) or less (+)</small></span>
              <div class="stepper"><button data-z="-0.01" aria-label="Lower">−</button><output data-ctl="z"></output><button data-z="0.01" aria-label="Raise">+</button></div></div>
            <div class="ctl"><span class="ctl-name">Part cooling fan</span><input type="range" min="0" max="100" step="5" data-ctl="cool"></div>
            <div class="ctl"><span class="ctl-name">Chamber fan</span><input type="range" min="0" max="100" step="5" data-ctl="chamberfan"></div>`;
    } else {
      h += '<p class="hint">Speed, Z-offset and fans can be changed while a print is running.</p>';
    }
    box.innerHTML = h;
  }
  const set = (sel, fn) => { const el = $(sel, box); if (el && document.activeElement !== el) fn(el); };
  set('[data-ctl=light]', (el) => { el.checked = !!p.light; el.disabled = !p.online; });
  set('[data-ctl=autoclear]', (el) => { el.checked = !!p.autoClearPlatform; });
  set('[data-ctl=fint]', (el) => { el.checked = !!p.filtrationInternal; });
  set('[data-ctl=fext]', (el) => { el.checked = !!p.filtrationExternal; });
  $$('[data-ctl=speed] button', box).forEach((b) => b.classList.toggle('active', +b.dataset.v === p.speed));
  set('[data-ctl=z]', (el) => { el.textContent = (p.zOffset >= 0 ? '+' : '') + Number(p.zOffset || 0).toFixed(2) + ' mm'; });
  set('[data-ctl=cool]', (el) => { el.value = Math.round(p.coolingFan || 0); });
  set('[data-ctl=chamberfan]', (el) => { el.value = Math.round(p.chamberFan || 0); });
}
$('#controls').addEventListener('change', (e) => {
  const c = e.target.dataset.ctl;
  if (c === 'light') control({ action: 'light', on: e.target.checked });
  if (c === 'autoclear') setAutoClear(e.target);
  if (c === 'fint') control({ action: 'filtration', internal: e.target.checked });
  if (c === 'fext') control({ action: 'filtration', external: e.target.checked });
  if (c === 'cool') control({ action: 'fans', cooling: +e.target.value });
  if (c === 'chamberfan') control({ action: 'fans', chamber: +e.target.value });
});
$('#controls').addEventListener('click', (e) => {
  const sp = e.target.closest('[data-ctl=speed] button');
  if (sp) control({ action: 'speed', value: +sp.dataset.v });
  const z = e.target.closest('[data-z]');
  if (z) { const p = current(); control({ action: 'zoffset', value: Math.round(((p.zOffset || 0) + +z.dataset.z) * 100) / 100 }); }
});

$('#btn-pending-open').addEventListener('click', () => { const p = current(); if (p && p.pending) openPending(p); });
$('#btn-ai-ignore').addEventListener('click', async () => {
  const p = current();
  if (!p) return;
  await api(`ai/${encodeURIComponent(p.id)}/ignore`, { method: 'POST' });
  toast('OK — no more AI alerts for this print.');
  refreshStatus();
});
$('#btn-welcome-add').addEventListener('click', () => { location.hash = '#settings/advanced/printers'; setTimeout(() => $('#btn-scan').click(), 50); });

// ---------------------------------------------------------------- temperature dialog
let tempTarget = '';
function openTemp(key, label, target) {
  tempTarget = key;
  $('#td-title').textContent = label;
  $('#td-value').value = target || '';
  const presets = key === 'bed' ? [['Off', 0], ['PLA', 60], ['PETG', 80], ['ABS', 100]]
    : key === 'chamber' ? [['Off', 0], ['40°', 40], ['50°', 50], ['60°', 60]]
      : [['Off', 0], ['PLA', 210], ['PETG', 240], ['ABS', 260]];
  $('#td-presets').innerHTML = presets.map(([n, v]) => `<button type="button" class="btn small" data-v="${v}">${n}${v ? ' ' + v + '°' : ''}</button>`).join('');
  $('#temp-dialog').showModal();
  setTimeout(() => $('#td-value').select(), 30);
}
$('#td-presets').addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (b) { $('#td-value').value = b.dataset.v; $('#temp-form').requestSubmit(); } });
$('#temp-form').addEventListener('submit', () => control({ action: 'temp', target: tempTarget, value: Math.max(0, +$('#td-value').value || 0) }));

// ---------------------------------------------------------------- slot dialog
let slotSel = { slot: 0, color: '' };
function openSlot(id) {
  const p = current();
  const s = (p.slots || []).find((x) => x.slotId === id);
  if (!s) return;
  slotSel = { slot: id, color: '' };
  $('#sd-title').textContent = `Slot ${id}`;
  const mats = p.materials || ['PLA', 'PETG', 'ABS', 'ASA', 'TPU'];
  const cur = s.material && !mats.includes(s.material) ? [s.material, ...mats] : mats;
  $('#sd-material').innerHTML = cur.map((m) => `<option ${m === s.material ? 'selected' : ''}>${esc(m)}</option>`).join('');
  const pal = p.slotPalette || [];
  let best = '', bestD = Infinity;
  pal.forEach(([, hex]) => { const d = colorDiff(hex, s.color || '#FFFFFF'); if (d < bestD) { bestD = d; best = hex; } });
  slotSel.color = best;
  $('#sd-palette').innerHTML = pal.map(([name, hex]) => `<button type="button" title="${esc(name)}" data-hex="${esc(hex)}" style="background:${esc(hex)}" class="${hex === best ? 'sel' : ''}"></button>`).join('');
  $('#sd-ad5x').innerHTML = p.kind === 'ad5x'
    ? '<button type="button" class="btn small" data-op="load">Load filament</button><button type="button" class="btn small" data-op="unload">Unload filament</button>' : '';
  $('#slot-dialog').showModal();
}
$('#sd-palette').addEventListener('click', (e) => {
  const b = e.target.closest('[data-hex]');
  if (!b) return;
  slotSel.color = b.dataset.hex;
  $$('#sd-palette button').forEach((x) => x.classList.toggle('sel', x === b));
});
$('#sd-ad5x').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-op]');
  if (!b) return;
  const p = current();
  const r = await api(`printers/${encodeURIComponent(p.id)}/slot`, { method: 'POST', body: { slot: slotSel.slot, op: b.dataset.op } });
  toast(r.message, !r.ok);
  $('#slot-dialog').close();
});
$('#slot-form').addEventListener('submit', async () => {
  const p = current();
  const r = await api(`printers/${encodeURIComponent(p.id)}/slot`, { method: 'POST', body: { slot: slotSel.slot, material: $('#sd-material').value, color: slotSel.color } });
  toast(r.message, !r.ok);
  setTimeout(refreshStatus, 900);
});

// ---------------------------------------------------------------- files
async function openFiles() {
  const p = current();
  if (!p) return;
  $('#files-dialog').showModal();
  await loadFiles();
}
async function loadFiles() {
  const p = current();
  const box = $('#file-list');
  box.innerHTML = '<p class="muted">Loading…</p>';
  const r = await api(`printers/${encodeURIComponent(p.id)}/files`);
  state.files = r.files || [];
  if (!state.files.length) { box.innerHTML = '<p class="muted">No files yet. Upload one above, or send one from OrcaSlicer.</p>'; return; }
  box.innerHTML = state.files.map((f, i) => `
    <div class="file">
      ${f.thumb ? `<img src="${esc(f.thumb)}" alt="" loading="lazy">` : '<div class="noimg"></div>'}
      <div style="min-width:0">
        <div class="f-name" title="${esc(f.file)}">${esc(f.name)}</div>
        <div class="f-meta">
          ${f.estimatedTime ? `<span>${fmtTime(f.estimatedTime)}</span>` : ''}
          ${f.filaments && f.filaments.length ? `<span class="colors">${f.filaments.map((x) => swatch(x.color, 'sm')).join('')}</span>` : (f.filamentType ? `<span>${esc(f.filamentType)}</span>` : '')}
          <span>${f.local ? 'on this board' : 'on the printer'}</span>
        </div>
      </div>
      <div class="f-actions">
        ${f.local ? `<button class="btn tiny" data-del="${i}" title="Delete from this board">Delete</button>` : ''}
        <button class="btn primary small" data-print="${i}">Print</button>
      </div>
    </div>`).join('');
}
$('#file-list').addEventListener('click', async (e) => {
  const pr = e.target.closest('[data-print]');
  if (pr) { $('#files-dialog').close(); openPrint(state.files[+pr.dataset.print]); return; }
  const del = e.target.closest('[data-del]');
  if (del) {
    const f = state.files[+del.dataset.del];
    if (!(await confirmBox('Delete this file?', `${f.name} is removed from this board.`, 'Delete'))) return;
    const r = await api(`printers/${encodeURIComponent(current().id)}/delete-file`, { method: 'POST', body: { file: f.file } });
    if (!r.ok) toast(r.message, true);
    $('#files-dialog').showModal();
    loadFiles();
  }
});
function uploadFile(file) {
  const p = current();
  if (!p || !file) return;
  const prog = $('#upload-progress');
  prog.classList.remove('hidden');
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/printers/${encodeURIComponent(p.id)}/upload`);
  xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) $('#upload-bar').style.width = (ev.loaded / ev.total * 100) + '%'; };
  xhr.onload = async () => {
    prog.classList.add('hidden');
    $('#upload-bar').style.width = '0';
    let r = {};
    try { r = JSON.parse(xhr.responseText); } catch (_) { /* */ }
    if (!r.ok) { toast(r.message || 'Upload failed', true); return; }
    await loadFiles();
    const f = (state.files || []).find((x) => x.file === r.file);
    if (f) { $('#files-dialog').close(); openPrint(f); }
  };
  xhr.onerror = () => { prog.classList.add('hidden'); toast('Upload failed', true); };
  const fd = new FormData();
  fd.append('file', file, file.name);
  xhr.send(fd);
}
$('#file-input').addEventListener('change', (e) => { uploadFile(e.target.files[0]); e.target.value = ''; });
const drop = $('#drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => uploadFile(e.dataTransfer.files[0]));

// ---------------------------------------------------------------- print dialog (incl. colour mapping)
let printCtx = null;
async function openPrint(f) {
  const p = current();
  printCtx = { mode: 'new', file: f.file, plan: null, slots: {} };
  fillPrintHeader(f.name, f.thumb, [f.estimatedTime ? fmtTime(f.estimatedTime) : '', f.local ? 'on this board' : 'on the printer'].filter(Boolean).join(' · '));
  $('#pr-title').textContent = 'Print';
  $('#pr-cancel').textContent = 'Cancel';
  $('#pr-level').checked = !!p.levelBeforePrint;
  $('#pr-level').closest('label').classList.remove('hidden');
  $('#pr-mapping').innerHTML = (p.slots || []).length ? '<p class="muted">Checking filaments…</p>' : '';
  $('#pr-msg').classList.add('hidden');
  $('#pr-start').disabled = false;
  $('#print-dialog').showModal();
  if ((p.slots || []).length) {
    const r = await api(`printers/${encodeURIComponent(p.id)}/plan`, { method: 'POST', body: { file: f.file } });
    printCtx.plan = r.plan;
    renderMapping();
  }
}
function openPending(p) {
  const pend = p.pending;
  printCtx = { mode: 'pending', file: pend.file, plan: pend, slots: {} };
  fillPrintHeader(prettyName(pend.file), `/api/printers/${encodeURIComponent(p.id)}/thumb?file=${encodeURIComponent(pend.file)}`, 'Sent from your slicer — check the filaments, then start.');
  $('#pr-title').textContent = 'Waiting to print';
  $('#pr-cancel').textContent = 'Cancel this print';
  $('#pr-level').closest('label').classList.add('hidden');
  $('#pr-msg').classList.add('hidden');
  $('#pr-start').disabled = false;
  renderMapping();
  if (!$('#print-dialog').open) $('#print-dialog').showModal();
}
function fillPrintHeader(name, thumb, meta) {
  $('#pr-name').textContent = name;
  $('#pr-meta').textContent = meta;
  const img = $('#pr-thumb');
  img.classList.toggle('hidden', !thumb);
  if (thumb) { img.src = thumb; img.onerror = () => img.classList.add('hidden'); }
}
function renderMapping() {
  const plan = printCtx.plan;
  const box = $('#pr-mapping');
  if (!plan) { box.innerHTML = ''; return; }
  for (const l of plan.lines) if (printCtx.slots[l.filament] === undefined) printCtx.slots[l.filament] = l.slot;
  const allOk = plan.lines.every((l) => verdict(l, plan.slots.find((s) => s.slotId === printCtx.slots[l.filament]) || {})[0] === 'ok');
  box.innerHTML = `
    <div class="map-head"><h2 style="margin:0">Filaments</h2>
      <span class="small ${allOk ? 'verdict ok' : 'verdict warn'}">${allOk ? 'Everything matches' : 'Check the highlighted rows'}</span></div>
    ${plan.lines.map((l) => {
      const chosen = plan.slots.find((s) => s.slotId === printCtx.slots[l.filament]) || plan.slots[0];
      const [vk, vt] = verdict(l, chosen);
      return `<div class="map-row">
        <div class="map-fil">${swatch(l.color)}<div class="txt"><b>Filament ${l.filament + 1}</b><span>${esc(l.type || '')} · ${esc(l.colorName || '')}</span></div></div>
        <div class="map-arrow">→</div>
        <div><div class="slot-pick">${plan.slots.map((s) => `<button type="button" class="${s.slotId === chosen.slotId ? 'sel' : ''}" data-fil="${l.filament}" data-slot="${s.slotId}" title="${esc(s.colorName)} ${esc(s.material)}">${swatch(s.color, 'sm')}${s.slotId} · ${esc(s.material || '?')}</button>`).join('')}</div>
          <div class="verdict ${vk}">${esc(vt)}</div></div>
      </div>`;
    }).join('')}`;
}
$('#pr-mapping').addEventListener('click', (e) => {
  const b = e.target.closest('[data-fil]');
  if (!b) return;
  printCtx.slots[+b.dataset.fil] = +b.dataset.slot;
  renderMapping();
});
$('#pr-start').addEventListener('click', async () => {
  const p = current();
  const msg = $('#pr-msg');
  $('#pr-start').disabled = true;
  notice(msg, 'Starting…');
  const body = printCtx.mode === 'pending'
    ? { action: 'start', slots: printCtx.plan ? printCtx.slots : undefined }
    : { file: printCtx.file, slots: printCtx.plan ? printCtx.slots : undefined, level: $('#pr-level').checked };
  const r = await api(`printers/${encodeURIComponent(p.id)}/${printCtx.mode === 'pending' ? 'pending' : 'print'}`, { method: 'POST', body });
  $('#pr-start').disabled = false;
  if (!r.ok) { notice(msg, r.message || 'Could not start the print.', 'err'); return; }
  $('#print-dialog').close();
  toast(r.message || 'Print started');
  setTimeout(refreshStatus, 1000);
});
$('#pr-cancel').addEventListener('click', async () => {
  if (printCtx && printCtx.mode === 'pending') {
    if (!(await confirmBox('Cancel this print?', 'The file stays on the printer; the print does not start.', 'Cancel print'))) { $('#print-dialog').showModal(); return; }
    await api(`printers/${encodeURIComponent(current().id)}/pending`, { method: 'POST', body: { action: 'cancel' } });
    refreshStatus();
  }
  $('#print-dialog').close();
});

// ---------------------------------------------------------------- settings: printers
function renderPrinterList(force = true) {
  const s = state.status;
  if (!s) return;
  const list = $('#printer-list');
  if (!s.printers.length) {
    list.innerHTML = '<p class="muted">No printer yet. Press <b>Scan network</b> above.</p>';
    $('#lan-howto').open = true;
    return;
  }
  if (!force && $('#printer-dialog').open) return;
  list.innerHTML = s.printers.map((p) => {
    const [k, t] = jobStatus(p);
    return `<div class="list-item" data-id="${esc(p.id)}" role="button" tabindex="0">
      <div>
        <div><b>${esc(p.name)}</b> ${p.model ? '· ' + esc(p.model) : ''} <span class="pill ${k === 'on' ? 'ok' : k === 'err' ? 'err' : k === 'warn' ? 'warn' : k === 'busy' ? 'info' : ''}">${esc(t)}</span></div>
        <div class="sub">${esc(p.ip)} · OrcaSlicer / Mainsail: <code>${esc(p.orcaHost)}</code></div>
        ${p.online || !p.enabled ? '' : `<div class="sub">${esc(p.error || p.stateMessage)}</div>`}
      </div>
      <div class="row gap">
        <button class="btn tiny" data-edit="${esc(p.id)}">Edit</button>
        <button class="btn tiny ghost-danger" data-del="${esc(p.id)}">Remove</button>
      </div>
    </div>`;
  }).join('');
}
$('#printer-list').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    const p = state.status.printers.find((x) => x.id === del.dataset.del);
    if (!(await confirmBox(`Remove ${p ? p.name : 'this printer'}?`, 'Its job history on this board is kept.', 'Remove'))) return;
    await api('printers/' + encodeURIComponent(del.dataset.del), { method: 'DELETE' });
    toast('Printer removed');
    await refreshStatus();
    renderPrinterList();
    return;
  }
  const item = e.target.closest('[data-edit], .list-item');
  if (!item) return;
  const id = item.dataset.edit || item.dataset.id;
  openPrinterDialog(state.status.printers.find((x) => x.id === id));
});
$('#btn-scan').addEventListener('click', async () => {
  const b = $('#btn-scan');
  b.disabled = true;
  b.textContent = 'Scanning…';
  $('#scan-results').innerHTML = '<p class="muted">Looking for FlashForge printers on your network (5 seconds)…</p>';
  try {
    const r = await api('printers/scan', { method: 'POST' });
    state.scanned = r.found || [];
    $('#scan-results').innerHTML = !state.scanned.length
      ? '<div class="notice warn">No printer answered. Check that it is switched on and on the same network as this board, then try again — or use <b>Add manually</b> with the IP address shown on the printer.</div>'
      : '<h3>Found on your network</h3>' + state.scanned.map((f, i) => `
        <button class="list-item" data-found="${i}">
          <div><b>${esc(f.name)}</b> · ${esc(f.model)}<div class="sub">${esc(f.ip)} · serial ${esc(f.serial || 'unknown')}</div></div>
          <span class="btn tiny ${f.alreadyAdded ? '' : 'primary'}">${f.alreadyAdded ? 'Added' : 'Add'}</span>
        </button>`).join('');
  } finally {
    b.disabled = false;
    b.textContent = 'Scan network';
  }
});
$('#scan-results').addEventListener('click', (e) => {
  const it = e.target.closest('[data-found]');
  if (!it) return;
  const f = state.scanned[+it.dataset.found];
  openPrinterDialog(state.status.printers.find((p) => p.ip === f.ip) || null, f);
});
$('#btn-add-manual').addEventListener('click', () => openPrinterDialog(null));
function nextPort() {
  const used = new Set(printers().map((p) => p.port));
  let p = 7125;
  while (used.has(p)) p++;
  return p;
}
function openPrinterDialog(p, found) {
  $('#pd-title').textContent = p ? 'Edit printer' : 'Add printer';
  $('#pd-id').value = p ? p.id : '';
  $('#pd-name').value = p ? p.name : (found ? found.name : '');
  $('#pd-ip').value = p ? p.ip : (found ? found.ip : '');
  $('#pd-serial').value = p ? p.serial : (found ? found.serial : '');
  $('#pd-code').value = '';
  $('#pd-code').placeholder = p && p.hasCheckCode ? '(saved – leave empty to keep)' : '8 characters shown on the printer';
  $('#pd-port').value = p ? p.port : nextPort();
  $('#pd-camera').value = p ? p.cameraUrl : '';
  $('#pd-level').checked = p ? p.levelBeforePrint : false;
  $('#pd-autoclear').checked = p ? !!p.autoClearPlatform : false;
  $('#pd-enabled').checked = p ? p.enabled : true;
  $('#pd-msg').classList.add('hidden');
  $('#printer-dialog').showModal();
  setTimeout(() => ($('#pd-ip').value ? $('#pd-code') : $('#pd-ip')).focus(), 50);
}
function dialogValues() {
  return {
    id: $('#pd-id').value, name: $('#pd-name').value.trim(), ip: $('#pd-ip').value.trim(), serial: $('#pd-serial').value.trim(),
    checkCode: $('#pd-code').value.trim(), port: parseInt($('#pd-port').value, 10) || nextPort(), cameraUrl: $('#pd-camera').value.trim(),
    levelBeforePrint: $('#pd-level').checked, autoClearPlatform: $('#pd-autoclear').checked, enabled: $('#pd-enabled').checked,
  };
}
$('#pd-cancel').addEventListener('click', () => $('#printer-dialog').close());
$('#pd-test').addEventListener('click', async () => {
  const msg = $('#pd-msg');
  notice(msg, 'Testing the connection…');
  const r = await api('printers/test', { method: 'POST', body: dialogValues() });
  notice(msg, (r.ok ? '✔ ' : '✘ ') + (r.message || ''), r.ok ? 'ok' : 'err');
  if (r.ok) {
    if (!$('#pd-name').value.trim() && r.name) $('#pd-name').value = r.name;
    if (r.serial) $('#pd-serial').value = r.serial;
  }
});
$('#pd-save').addEventListener('click', async () => {
  const msg = $('#pd-msg');
  notice(msg, 'Saving…');
  const r = await api('printers', { method: 'POST', body: dialogValues() });
  if (!r.ok) { notice(msg, '✘ ' + (r.message || 'Could not save'), 'err'); return; }
  $('#printer-dialog').close();
  state.sel = r.printer.id;
  store.set('ffb.sel', state.sel);
  toast('Printer saved.');
  await refreshStatus();
  renderPrinterList();
  $('#scan-results').innerHTML = '';
  if (printers().length === 1) location.hash = '#home';
});

// ---------------------------------------------------------------- settings: AI
async function loadAi() {
  state.ai = await api('ai');
  const a = state.ai.settings;
  $('#ai-enabled').checked = a.enabled;
  $$('#ai-action button').forEach((b) => b.classList.toggle('active', b.dataset.v === a.action));
  $$('#ai-sens button').forEach((b) => b.classList.toggle('active', b.dataset.v === a.sensitivity));
  renderAiService();
  renderAiPrinters(true);
}
function renderAiService() {
  const sv = (state.status && state.status.aiService) || (state.ai && state.ai.service) || {};
  const el = $('#ai-service');
  if (sv.ready) notice(el, `AI model loaded (${sv.backend || 'CPU'}). One check takes about ${sv.avgMs ? Math.round(sv.avgMs) + ' ms' : 'a second'}.`, 'ok');
  else if (sv.reachable) notice(el, 'The AI model is loading. This can take a minute after the board starts.', 'warn');
  else notice(el, 'The AI service is not running yet. If this does not change after a few minutes, restart the board.', 'warn');
}
async function saveAi(patch) {
  state.ai = await api('ai', { method: 'POST', body: patch });
  toast('AI settings saved');
  loadAi();
}
$('#ai-enabled').addEventListener('change', (e) => saveAi({ enabled: e.target.checked }));
$('#ai-action').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) saveAi({ action: b.dataset.v }); });
$('#ai-sens').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) saveAi({ sensitivity: b.dataset.v }); });
const aiStatusText = {
  off: 'Switched off for this printer.', idle: 'Waiting for a print to start.', watching: 'Watching the print.',
  warning: 'Possible failure! Please check the printer.', paused: 'The AI paused this print. Check it, then resume or stop it on the printer screen.',
  ignored: 'Alerts muted for the rest of this print.', 'no-camera': 'No camera found for this printer.', 'ai-offline': 'The AI service is starting…',
};
function renderAiPrinters(force = false) {
  const s = state.status;
  if (!s) return;
  renderAiService();
  const box = $('#ai-printers');
  const ids = s.printers.map((p) => p.id).join(',');
  if (force || box.dataset.ids !== ids) {
    box.dataset.ids = ids;
    box.innerHTML = s.printers.length ? s.printers.map((p) => `
      <div class="card" id="ai-${esc(p.id)}">
        <div class="card-head"><h2>${esc(p.name)}</h2>
          <label class="switch" title="Use AI on this printer"><input type="checkbox" data-ai-toggle="${esc(p.id)}"><span></span></label></div>
        <div class="ai-cam"><img alt="Last analysed picture" class="hidden"><canvas></canvas><div class="empty muted small">The last picture the AI looked at appears here.</div></div>
        <div class="label">Failure risk</div>
        <div class="progress risk"><div></div></div>
        <div class="ai-msg notice"></div>
        <div class="hint ai-meta"></div>
        <div class="row gap wrap" style="margin-top:10px">
          <button class="btn small" data-ai-test="${esc(p.id)}">Test now</button>
          <button class="btn small" data-ai-ignore="${esc(p.id)}">Not a failure</button>
        </div>
      </div>`).join('') : '<div class="card muted">Add a printer first.</div>';
  }
  for (const p of s.printers) {
    const el = document.getElementById('ai-' + p.id);
    if (!el) continue;
    const a = p.ai || {};
    $('[data-ai-toggle]', el).checked = p.aiEnabled;
    $('.risk > div', el).style.width = Math.round(a.risk || 0) + '%';
    const kind = a.status === 'warning' ? 'warn' : a.status === 'paused' ? 'err' : a.status === 'watching' ? 'ok' : '';
    notice($('.ai-msg', el), a.message || aiStatusText[a.status] || '', kind);
    $('.ai-meta', el).textContent = a.lastCheck
      ? `Last check ${new Date(a.lastCheck).toLocaleTimeString()} · ${a.inferenceMs} ms${a.frames < a.warmupFrames && a.status === 'watching' ? ` · warming up ${a.frames}/${a.warmupFrames}` : ''}`
      : '';
    $('[data-ai-ignore]', el).classList.toggle('hidden', !(a.status === 'warning' || a.status === 'paused' || a.status === 'watching'));
    if (a.hasImage && el.dataset.img !== a.lastCheck) {
      el.dataset.img = a.lastCheck;
      drawAiImage(el, p.id, a);
    }
  }
}
function drawAiImage(el, id, a) {
  const img = $('.ai-cam img', el);
  const canvas = $('.ai-cam canvas', el);
  const n = new Image();
  n.onload = () => {
    img.src = n.src;
    img.classList.remove('hidden');
    $('.ai-cam .empty', el).classList.add('hidden');
    const rect = img.getBoundingClientRect();
    canvas.width = rect.width; canvas.height = rect.height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const iw = a.imageWidth || n.naturalWidth, ih = a.imageHeight || n.naturalHeight;
    const scale = Math.min(rect.width / iw, rect.height / ih);
    const ox = (rect.width - iw * scale) / 2, oy = (rect.height - ih * scale) / 2;
    for (const d of a.detections || []) {
      const x = ox + (d.xc - d.w / 2) * scale, y = oy + (d.yc - d.h / 2) * scale;
      ctx.strokeStyle = d.confidence > 0.5 ? '#ff3b30' : '#ffb300';
      ctx.lineWidth = 3;
      ctx.strokeRect(x, y, d.w * scale, d.h * scale);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.font = 'bold 13px system-ui';
      ctx.fillText(Math.round(d.confidence * 100) + '%', x + 4, Math.max(14, y - 4));
    }
  };
  n.src = `/api/ai/${encodeURIComponent(id)}/image?t=${Date.now()}`;
}
$('#ai-printers').addEventListener('change', (e) => {
  const t = e.target.closest('[data-ai-toggle]');
  if (t) saveAi({ printers: { [t.dataset.aiToggle]: t.checked } });
});
$('#ai-printers').addEventListener('click', async (e) => {
  const test = e.target.closest('[data-ai-test]');
  const ign = e.target.closest('[data-ai-ignore]');
  if (test) {
    test.disabled = true; test.textContent = 'Checking…';
    const r = await api(`ai/${encodeURIComponent(test.dataset.aiTest)}/test`, { method: 'POST' });
    test.disabled = false; test.textContent = 'Test now';
    toast(r.message || (r.ok ? 'Done' : 'Failed'), !r.ok);
    if (r.ok && r.state) drawAiImage(document.getElementById('ai-' + test.dataset.aiTest), test.dataset.aiTest, r.state);
  }
  if (ign) {
    await api(`ai/${encodeURIComponent(ign.dataset.aiIgnore)}/ignore`, { method: 'POST' });
    toast('OK — no more AI alerts for this print.');
    refreshStatus();
  }
});

// ---------------------------------------------------------------- settings: Mainsail / OrcaSlicer
function renderMainsail() {
  const ps = printers();
  if (ps.length) {
    $('#orca-host').textContent = ps[0].orcaHost;
    $('#orca-host-name').textContent = ps[0].orcaHostName;
  }
  $('#mainsail-links').innerHTML = ps.length
    ? ps.map((p) => `<a class="list-item" href="${esc(p.mainsailUrl)}" target="_blank" rel="noopener"><div><b>${esc(p.name)}</b><div class="sub">${esc(p.mainsailUrl)}</div></div><span class="btn tiny">Open Mainsail ↗</span></a>`).join('')
    : '<p class="muted">Add a printer first.</p>';
}

// ---------------------------------------------------------------- settings: network
async function loadNetwork(scan) {
  const n = await api('network');
  const kv = [];
  if (n.ok === false && n.message) kv.push(['Status', n.message]);
  if (n.hostname) { kv.push(['Board name', n.hostname + '.local']); $('#hn-current').textContent = n.hostname; $('#hn-input').placeholder = n.hostname; }
  if (n.ethernet) kv.push(['Ethernet', n.ethernet.connected ? `Connected · ${n.ethernet.ip}` : 'Not plugged in']);
  if (n.wifi) kv.push(['Wi-Fi', n.wifi.connected ? `${n.wifi.ssid} · ${n.wifi.ip}${n.wifi.signal ? ' · signal ' + n.wifi.signal + '%' : ''}` : (n.wifi.present === false ? 'No Wi-Fi hardware found' : 'Not connected')]);
  if (n.wifi && !n.wifi.connected && n.wifi.problem) {
    kv.push([`Saved Wi-Fi "${n.wifi.savedSsid}"`, n.wifi.problem]);
    kv.push(['What to do', n.wifi.fix || '']);
  }
  const pn = await api('printer-network').catch(() => ({}));
  if (pn.enabled) kv.push(['Printer network', `On: the board's Wi-Fi is the printer network "${pn.ssid}". Wi-Fi changes here are saved for when you switch it off (Advanced → Printer network).`]);
  if (n.hotspot && n.hotspot.active) kv.push(['Setup hotspot', `On: "${n.hotspot.ssid}" (password ${n.hotspot.password})`]);
  $('#net-status').innerHTML = kv.map(([k, v]) => `<div>${esc(k)}</div><div>${esc(v)}</div>`).join('');
  if (scan) wifiScan();
}
async function wifiScan() {
  const list = $('#wifi-list');
  list.innerHTML = '<p class="muted">Searching for Wi-Fi networks…</p>';
  const r = await api('network/scan', { method: 'POST' });
  const nets = r.networks || [];
  if (!nets.length) { list.innerHTML = `<p class="muted">${esc(r.message || 'No networks found. You can still type the name below.')}</p>`; return; }
  list.innerHTML = nets.map((w) => `
    <button class="list-item" data-ssid="${esc(w.ssid)}">
      <div><b>${esc(w.ssid)}</b><div class="sub">${w.security ? 'Secured' : 'Open'}${w.inUse ? ' · connected' : ''}</div></div>
      <span class="pill ${w.signal > 60 ? 'ok' : w.signal > 30 ? 'warn' : 'err'}">${w.signal}%</span>
    </button>`).join('');
}
$('#btn-wifi-scan').addEventListener('click', wifiScan);
$('#wifi-list').addEventListener('click', (e) => {
  const it = e.target.closest('[data-ssid]');
  if (!it) return;
  $('#wifi-ssid').value = it.dataset.ssid;
  $('#wifi-pass').focus();
});
$('#wifi-show').addEventListener('change', (e) => { $('#wifi-pass').type = e.target.checked ? 'text' : 'password'; });
$('#wifi-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#wifi-msg');
  const hotspot = (state.status?.ips || []).some((ip) => ip.startsWith('10.42.'));
  notice(msg, hotspot
    ? 'Joining your Wi-Fi… Your phone will lose this hotspot now. Reconnect your phone to your home Wi-Fi, then open http://' + (state.status?.hostname || 'ffbridge') + '.local' +
      ' — If the "FlashForge-Bridge" hotspot comes back after about a minute, the Wi-Fi details were wrong: connect to it again and this page shows what went wrong.'
    : 'Connecting… this can take up to a minute.');
  let r;
  try {
    r = await api('network/connect', { method: 'POST', body: { ssid: $('#wifi-ssid').value, password: $('#wifi-pass').value } });
  } catch (_) {
    if (hotspot) return; // expected: the phone just lost the hotspot
    notice(msg, 'Lost the connection to the board. Wait a minute, then open http://' + (state.status?.hostname || 'ffbridge') + '.local again.', 'warn');
    return;
  }
  notice(msg, (r.ok ? '✔ ' : '✘ ') + (r.message || ''), r.ok ? 'ok' : 'err');
  loadNetwork(false);
});
$('#hn-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = $('#hn-input').value.trim();
  if (!v) return;
  const r = await api('network/hostname', { method: 'POST', body: { hostname: v } });
  notice($('#hn-msg'), r.ok ? `Renamed. From now on open http://${v.toLowerCase()}.local` : (r.message || 'Failed'), r.ok ? 'ok' : 'err');
});

// ---------------------------------------------------------------- settings: general
// ---------------------------------------------------------------- settings: slicer
let slicerPoll = null;
async function loadSlicerSettings() {
  const r = await api('slicer');
  if (r.ok === false && r.enabled === undefined) { $('#slicer-card').classList.add('hidden'); return; }
  $('#sl-enabled').checked = !!r.enabled;
  const box = $('#sl-engine');
  const inst = r.install || {};
  const busy = inst.state === 'downloading' || inst.state === 'unpacking';
  let html = '';
  if (r.installed) {
    html = `<div class="row between wrap gap"><span><span class="pill ok">Engine installed</span> <span class="muted small">OrcaSlicer engine ${esc(r.engine)}</span></span>
      <span class="row gap"><a class="btn small" href="#slicer/prepare">Open the slicer</a><button class="btn small ghost-danger" type="button" id="sl-remove">Remove engine</button></span></div>`;
  } else if (!r.supported) {
    html = '<div class="notice warn">The slicer engine runs on the board (64-bit ARM) only.</div>';
  } else if (busy) {
    html = `<div class="notice">${esc(inst.message || 'Downloading…')}</div><div class="progress"><div style="width:${inst.percent || 0}%"></div></div>`;
  } else {
    html = `<p class="small">The engine is downloaded once from GitHub (about 35 MB; 90 MB on the SD card).</p>
      ${inst.state === 'error' ? `<div class="notice err">${esc(inst.message)}</div>` : ''}
      <button class="btn primary" type="button" id="sl-install">Download the slicer engine</button>`;
  }
  html += `<p class="hint">Engine: <a href="${esc(r.source)}" target="_blank" rel="noopener">OrcaSlicer engine by Helio Additive (slicer-cli), AGPL-3.0 — source code</a>.</p>`;
  box.innerHTML = html;
  clearTimeout(slicerPoll);
  if (busy && state.view === 'settings' && state.tab === 'general') slicerPoll = setTimeout(loadSlicerSettings, 1000);
  else if (inst.state === 'done') refreshStatus();
}
$('#sl-enabled').addEventListener('change', async (e) => {
  const r = await api('slicer/settings', { method: 'POST', body: { enabled: e.target.checked } });
  toast(r.enabled ? 'The slicer is shown in the top bar.' : 'The slicer is hidden.');
  await refreshStatus();
  loadSlicerSettings();
});
$('#sl-engine').addEventListener('click', async (e) => {
  if (e.target.id === 'sl-install') {
    e.target.disabled = true;
    const r = await api('slicer/install', { method: 'POST' });
    if (!r.ok) toast(r.message, true);
    loadSlicerSettings();
  }
  if (e.target.id === 'sl-remove') {
    if (!(await confirmBox('Remove the slicer engine?', 'It frees about 90 MB. You can download it again any time.', 'Remove'))) return;
    const r = await api('slicer/remove', { method: 'POST' });
    toast(r.message, !r.ok);
    refreshStatus();
    loadSlicerSettings();
  }
});

async function loadSettings() {
  const s = await api('settings');
  $('#s-discord').value = s.discordWebhook || '';
  $('#s-interval').value = s.discordIntervalMinutes || 0;
  $('#s-snap').checked = s.discordSnapshot;
  $('#s-start').checked = s.notifyOnStart;
  $('#s-complete').checked = s.notifyOnComplete;
  $('#s-pause').checked = s.notifyOnPause;
  $('#s-error').checked = s.notifyOnError;
  $('#s-spoolman').value = s.spoolmanUrl || '';
  $$('input[name=s-map]').forEach((r) => { r.checked = r.value === (s.mappingMode || 'auto'); });
}
$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await api('settings', {
    method: 'POST',
    body: {
      discordWebhook: $('#s-discord').value.trim(), discordIntervalMinutes: parseInt($('#s-interval').value, 10) || 0,
      discordSnapshot: $('#s-snap').checked, notifyOnStart: $('#s-start').checked, notifyOnComplete: $('#s-complete').checked,
      notifyOnPause: $('#s-pause').checked, notifyOnError: $('#s-error').checked, spoolmanUrl: $('#s-spoolman').value.trim(),
      mappingMode: ($('input[name=s-map]:checked') || {}).value || 'auto',
    },
  });
  toast(r.ok ? 'Settings saved' : (r.message || 'Could not save'), !r.ok);
});
$('#btn-test-discord').addEventListener('click', async () => {
  const r = await api('settings/test-discord', { method: 'POST', body: { url: $('#s-discord').value.trim() } });
  toast(r.message, !r.ok);
});
$('#btn-test-spoolman').addEventListener('click', async () => {
  const r = await api('settings/test-spoolman', { method: 'POST', body: { url: $('#s-spoolman').value.trim() } });
  toast(r.message, !r.ok);
});

// ---------------------------------------------------------------- settings: system
async function loadSystem() {
  const s = state.status || (await api('status'));
  const info = await api('system/info');
  const rows = [['Bridge version', s.version], ['Board name', (s.hostname || '') + '.local'], ['IP address', (s.ips || []).join(', ') || '–']];
  if (info && info.ok !== false) {
    if (info.model) rows.push(['Board', info.model]);
    if (info.os) rows.push(['System', info.os]);
    if (info.uptime) rows.push(['Running for', info.uptime]);
    if (info.temp) rows.push(['CPU temperature', info.temp]);
    if (info.memory) rows.push(['Memory', info.memory]);
    if (info.disk) rows.push(['SD card', info.disk]);
  }
  $('#sys-info').innerHTML = rows.map(([k, v]) => `<div>${esc(k)}</div><div>${esc(v)}</div>`).join('');
}
// ---------------------------------------------------------------- updates
async function loadUpdate(after) {
  const u = await api('update');
  const box = $('#update-box');
  const inst = u.install || {};
  const busy = ['starting', 'downloading', 'installing', 'rolling-back'].includes(inst.state);
  let h = `<div class="kv"><div>This version</div><div>${esc(u.current)}</div>`;
  if (u.latest) h += `<div>Newest version</div><div>${esc(u.latest)}${u.built ? ' (' + esc(u.built) + ')' : ''}</div>`;
  if (u.checkedAt) h += `<div>Last checked</div><div>${new Date(u.checkedAt).toLocaleString()}</div>`;
  h += '</div>';
  if (!u.configured) h += '<p class="hint">This copy was built without an update source (local test build).</p>';
  else if (busy) h += `<div class="notice">${esc(inst.message || 'Updating…')} The page reloads when it's done.</div>`;
  else if (u.available && u.imageRequired) {
    h += `<div class="notice warn">Version ${esc(u.latest)} changes system parts, so it needs a new SD card image. Download your backup below first, then flash the <a href="${esc(u.imageUrl)}" target="_blank" rel="noopener">latest image</a>.</div>`;
  } else if (u.available) {
    h += `<div class="notice ok"><b>Version ${esc(u.latest)} is available.</b>${u.notes ? '<div class="update-notes">' + esc(u.notes) + '</div>' : ''}</div>
      <div class="row gap"><button class="btn primary" id="btn-update-install">Install update</button></div>
      <p class="hint">Takes about a minute; prints keep running. If the new version doesn't start, the board goes back to this one by itself.</p>`;
  } else if (u.checkError) h += `<p class="hint">${esc(u.checkError)}</p>`;
  else if (u.latest) h += '<p class="hint">You have the newest version.</p>';
  if (!busy && inst.state && ['failed', 'rolled-back', 'image-required'].includes(inst.state)) h += `<div class="notice warn">Last update: ${esc(inst.message)}</div>`;
  if (!busy && inst.state === 'done' && after) h += `<div class="notice ok">${esc(inst.message)}</div>`;
  box.innerHTML = h;
  if (busy) setTimeout(() => waitForUpdate(u.current), 3000);
}
async function waitForUpdate(oldVersion) {
  try {
    const u = await api('update');
    const st = (u.install || {}).state;
    if (u.current !== oldVersion || ['done', 'failed', 'rolled-back', 'image-required'].includes(st)) { location.reload(); return; }
    if (state.view === 'settings' && state.sub === 'system') loadUpdate();
    else setTimeout(() => waitForUpdate(oldVersion), 3000);
  } catch (_) { setTimeout(() => waitForUpdate(oldVersion), 3000); } // bridge restarting
}
$('#btn-update-check').addEventListener('click', async (e) => {
  e.target.disabled = true; e.target.textContent = 'Checking…';
  await api('update/check', { method: 'POST' });
  e.target.disabled = false; e.target.textContent = 'Check now';
  loadUpdate();
});
$('#update-box').addEventListener('click', async (e) => {
  if (!e.target.closest('#btn-update-install')) return;
  if (!(await confirmBox('Install the update?', 'The bridge restarts for about a minute. Running prints are not affected.', 'Install'))) return;
  const r = await api('update/install', { method: 'POST' });
  if (!r.ok) { toast(r.message || 'Could not start the update.', true); return; }
  toast('Updating… the page reloads when it\'s done.');
  setTimeout(() => loadUpdate(), 1500);
});

// ---------------------------------------------------------------- backup
$('#restore-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  if (!(await confirmBox('Restore these settings?', `Your current printers and settings are replaced with the ones in ${f.name}. The bridge restarts.`, 'Restore'))) return;
  const msg = $('#restore-msg');
  notice(msg, 'Restoring…');
  let r = {};
  try {
    const res = await fetch('/api/backup/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: await f.text() });
    r = await res.json();
  } catch (_) { r = { ok: false, message: 'Could not reach the board.' }; }
  notice(msg, r.message || (r.ok ? 'Restored.' : 'Restore failed.'), r.ok ? 'ok' : 'err');
  if (r.ok && r.restarting) setTimeout(() => location.reload(), 8000);
});

async function loadLogs() {
  const r = await api('logs');
  const pre = $('#logs');
  pre.textContent = (r.lines || []).join('\n');
  pre.scrollTop = pre.scrollHeight;
}
$('#btn-logs').addEventListener('click', loadLogs);
$('#btn-reboot').addEventListener('click', async () => {
  if (!(await confirmBox('Restart the bridge board?', 'Running prints are not affected, but this page is unavailable for about a minute.', 'Restart'))) return;
  const r = await api('system/reboot', { method: 'POST' });
  toast(r.message || 'Restarting…');
});
$('#btn-shutdown').addEventListener('click', async () => {
  if (!(await confirmBox('Shut the board down?', 'You will need to unplug and re-plug its power to start it again.', 'Shut down'))) return;
  const r = await api('system/shutdown', { method: 'POST' });
  toast(r.message || 'Shutting down…');
});
$('#pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await api('system/password', { method: 'POST', body: { password: $('#pw-input').value } });
  toast(r.message, !r.ok);
  $('#pw-input').value = '';
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  const text = $('#' + b.dataset.copy).textContent;
  (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast('Copied'), () => toast(text));
});

// ---------------------------------------------------------------- settings: screen layout (per browser)
const LAYOUT_DEFAULT = { share: 70, side: 'right', job: 'under', fit: false };
function getLayout() {
  try { return { ...LAYOUT_DEFAULT, ...JSON.parse(localStorage.getItem('ffb-layout') || '{}') }; } catch (_) { return { ...LAYOUT_DEFAULT }; }
}
function applyLayout(lo = getLayout()) {
  const root = document.documentElement;
  const share = Math.min(85, Math.max(50, Number(lo.share) || 70));
  root.style.setProperty('--cam-fr', share + 'fr');
  root.style.setProperty('--side-fr', (100 - share) + 'fr');
  root.style.setProperty('--cam-pct', share + '%');
  root.classList.toggle('lo-left', lo.side === 'left');
  root.classList.toggle('lo-below', lo.side === 'below');
  root.classList.toggle('lo-fit', !!lo.fit);
  const job = $('#job');
  if (lo.job === 'side') $('.col-side').prepend(job); else $('.col-main').append(job);
}
function saveLayout(lo) {
  try { localStorage.setItem('ffb-layout', JSON.stringify(lo)); } catch (_) {}
  applyLayout(lo);
}
function renderLayoutForm() {
  const lo = getLayout();
  $('#lo-share').value = lo.share;
  $('#lo-share-val').textContent = lo.share + '%';
  $$('input[name="lo-side"]').forEach((r) => { r.checked = r.value === lo.side; });
  $$('input[name="lo-job"]').forEach((r) => { r.checked = r.value === lo.job; });
  $('#lo-fit').checked = !!lo.fit;
}
$('#layout-card').addEventListener('input', () => {
  const lo = {
    share: Number($('#lo-share').value),
    side: ($('input[name="lo-side"]:checked') || {}).value || 'right',
    job: ($('input[name="lo-job"]:checked') || {}).value || 'under',
    fit: $('#lo-fit').checked,
  };
  $('#lo-share-val').textContent = lo.share + '%';
  saveLayout(lo);
});
$('#btn-layout-reset').addEventListener('click', () => {
  try { localStorage.removeItem('ffb-layout'); } catch (_) {}
  applyLayout(); renderLayoutForm(); toast('Layout back to default');
});
applyLayout();

// ---------------------------------------------------------------- settings: printer network (router mode)
let pnTimer = null;
async function loadPrinterNet() {
  clearTimeout(pnTimer);
  const n = await api('printer-network');
  const kv = [];
  if (n.ok === false) {
    $('#pn-status').innerHTML = `<div>Status</div><div>${esc(n.message || 'Not available')}</div>`;
    ['#pn-on', '#pn-internet', '#pn-setup', '#pn-off-card'].forEach((id) => $(id).classList.add('hidden'));
    return;
  }
  const pill = $('#pn-pill');
  pill.textContent = n.enabled ? (n.active ? 'On' : 'Starting…') : 'Off';
  pill.className = 'pill ' + (n.enabled ? (n.active ? 'ok' : 'warn') : '');
  if (n.enabled) {
    kv.push(['Printer Wi-Fi', `${n.ssid}${n.active ? '' : ' (starting…)'}`]);
    kv.push(['Board on the printer network', n.address]);
  }
  kv.push(['Board on your home network', n.ethernetIp ? `Ethernet · ${n.ethernetIp}` : 'No network cable connected']);
  if (!n.wifiPresent) kv.push(['Wi-Fi', 'No Wi-Fi hardware found on this board']);
  $('#pn-status').innerHTML = kv.map(([k, v]) => `<div>${esc(k)}</div><div>${esc(v)}</div>`).join('');
  ['#pn-on', '#pn-internet', '#pn-off-card'].forEach((id) => $(id).classList.toggle('hidden', !n.enabled));
  $('#pn-setup').classList.toggle('hidden', n.enabled);
  if (n.enabled) {
    const printers = state.status?.printers || [];
    const clients = n.clients || [];
    $('#pn-clients').innerHTML = clients.length ? clients.map((c) => {
      const p = printers.find((x) => x.ip === c.ip);
      return `<div class="list-item"><div><b>${esc(p ? p.name : (c.name || 'Device'))}</b><div class="sub">${esc(c.ip)}${p ? '' : ' · not one of your saved printers (yet)'}</div></div>
        <span class="pill ${p && p.online ? 'ok' : 'warn'}">${p ? (p.online ? 'Connected' : 'Connecting…') : 'Joined'}</span></div>`;
    }).join('') : '<p class="muted">No printer has joined yet. On the printer\'s screen, connect its Wi-Fi to <b>' + esc(n.ssid) + '</b>.</p>';
    const ni = n.internet || {};
    notice($('#pn-net-state'), !ni.allowed ? 'Blocked. The printers can only talk to this board.'
      : ni.until === -1 ? 'Allowed until you turn it off.'
      : `Allowed for about ${ni.minutesLeft} more minute${ni.minutesLeft === 1 ? '' : 's'}, then blocked again by itself.`, ni.allowed ? 'warn' : 'ok');
    if (!n.firewall) notice($('#pn-net-state'), 'Blocked. (This board has no firewall tool, so internet can\'t be allowed for the printers.)', 'ok');
  } else if (!$('#pn-ssid').value) {
    $('#pn-ssid').value = n.ssid || 'FFBridge-Printers';
  }
  if (state.view === 'settings' && state.sub === 'printernet') pnTimer = setTimeout(loadPrinterNet, 10000);
}
$('#pn-show').addEventListener('change', (e) => { $('#pn-pass').type = e.target.checked ? 'text' : 'password'; });
$('#pn-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#pn-msg');
  const ssid = $('#pn-ssid').value.trim(), password = $('#pn-pass').value;
  if (!confirm(`Switch on the printer network "${ssid}"?\n\nThe board's Wi-Fi will be used for the printers only. The board stays on your home network through the cable. Your printers go offline until you connect them to "${ssid}" on their screens.`)) return;
  notice(msg, 'Switching on…');
  const r = await api('printer-network', { method: 'POST', body: { action: 'enable', ssid, password } });
  notice(msg, (r.ok ? '✔ ' : '✘ ') + (r.message || ''), r.ok ? 'ok' : 'err');
  if (r.ok) { $('#pn-pass').value = ''; setTimeout(loadPrinterNet, 3000); }
});
$('#pn-internet').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-pn-min]');
  if (!b) return;
  const r = await api('printer-network', { method: 'POST', body: { action: 'internet', minutes: Number(b.dataset.pnMin) } });
  toast(r.message || (r.ok ? 'Done' : 'Failed'), !r.ok);
  loadPrinterNet();
});
$('#btn-pn-off').addEventListener('click', async () => {
  if (!confirm('Switch off the printer network? The printers go offline until you connect them to your home Wi-Fi again.')) return;
  const b = $('#btn-pn-off');
  b.disabled = true; b.textContent = 'Switching off…';
  const r = await api('printer-network', { method: 'POST', body: { action: 'disable' } }).catch(() => ({ ok: false, message: 'Lost the connection to the board. Reload the page in a minute.' }));
  b.disabled = false; b.textContent = 'Switch off printer network';
  toast(r.message || (r.ok ? 'Switched off' : 'Failed'), !r.ok);
  loadPrinterNet();
});

// ---------------------------------------------------------------- start
(async () => {
  await refreshStatus();
  if (!location.hash && state.status && !state.status.printers.length) location.hash = '#home';
  route();
  setInterval(() => { if (!document.hidden) refreshStatus(); }, 2000);
})();

// ---------------------------------------------------------------- shared with the slicer module
async function printFile(file) {
  await loadFiles();
  const f = (state.files || []).find((x) => x.file === file);
  if (!f) { toast('The sliced file was not found on the board.', true); return; }
  openPrint(f);
}
window.FFB = { api, toast, notice, confirmBox, esc, swatch, current, printers, printFile, colorDiff, family, fmtTime, state, refreshStatus };
