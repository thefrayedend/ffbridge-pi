// FlashForge Bridge setup page (no framework, no build step).
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let state = { status: null, ai: null, page: 'home', scanned: [] };

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
  el.className = 'notice' + (kind ? ' ' + kind : '');
  el.textContent = msg;
}

const fmtTime = (s) => {
  s = Math.max(0, Math.round(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
};
const tempStr = (t) => (t ? `${Math.round(t.current)}°${t.target > 0 ? ' / ' + Math.round(t.target) + '°' : ''}` : '–');

// ---------------------------------------------------------------- navigation
function showPage(page) {
  if (!$('#page-' + page)) page = 'home';
  state.page = page;
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + page));
  $$('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.page === page));
  if (page === 'wifi') loadNetwork(true);
  if (page === 'settings') loadSettings();
  if (page === 'system') { loadSystem(); loadLogs(); }
  if (page === 'ai') loadAi();
  if (page === 'printers') renderPrinterList();
}
window.addEventListener('hashchange', () => showPage(location.hash.slice(1)));

// ---------------------------------------------------------------- status polling
async function refreshStatus() {
  try {
    const s = await api('status');
    if (!s.printers) return;
    state.status = s;
    const host = s.hostname || 'ffbridge';
    $('#hostline').textContent = `${host}.local${s.ips && s.ips.length ? ' · ' + s.ips[0] : ''}`;
    renderHome();
    if (state.page === 'printers') renderPrinterList(false);
    if (state.page === 'ai') renderAiPrinters();
  } catch (_) {
    $('#hostline').textContent = 'Connection to the board lost… retrying';
  }
}

function jobPill(p) {
  if (!p.enabled) return '<span class="pill">Disabled</span>';
  if (!p.online) return '<span class="pill err">Offline</span>';
  switch (p.jobState) {
    case 'printing': return '<span class="pill info">Printing</span>';
    case 'paused': return '<span class="pill warn">Paused</span>';
    case 'complete': return '<span class="pill ok">Finished</span>';
    case 'error': return '<span class="pill err">Error</span>';
    case 'cancelled': return '<span class="pill">Cancelled</span>';
    default: return '<span class="pill ok">Ready</span>';
  }
}

function aiPill(a, enabled) {
  if (!enabled || !a) return '';
  const map = {
    watching: ['ok', 'AI watching'], warning: ['warn', 'AI: possible failure'], paused: ['err', 'AI paused print'],
    ignored: ['', 'AI muted'], 'ai-offline': ['warn', 'AI starting'], 'no-camera': ['', 'No camera'],
  };
  const m = map[a.status];
  return m ? `<span class="pill ${m[0]}">${m[1]}</span>` : '';
}

const camTimers = {};
function renderHome() {
  const s = state.status;
  const ps = s.printers;
  $('#home-empty').classList.toggle('hidden', ps.length > 0);
  $('#orca-help').classList.toggle('hidden', ps.length === 0);
  if (ps.length) {
    $('#orca-host').textContent = ps[0].orcaHost;
    $('#orca-host-name').textContent = ps[0].orcaHostName;
  }
  const grid = $('#home-printers');
  const ids = ps.map((p) => p.id).join(',');
  if (grid.dataset.ids !== ids) {
    grid.dataset.ids = ids;
    grid.innerHTML = ps.map((p) => `
      <div class="card" id="hp-${p.id}">
        <div class="row between"><h2 class="hp-name"></h2><div class="hp-pills row gap wrap"></div></div>
        <div class="cam"><img alt="Camera" class="hidden"><div class="empty">Camera picture appears here</div></div>
        <div class="hp-job muted"></div>
        <div class="progress"><div></div></div>
        <div class="temps"></div>
        <div class="hp-msg hint"></div>
        <div class="row gap wrap" style="margin-top:10px">
          <a class="btn primary hp-mainsail" target="_blank" rel="noopener">Open Mainsail</a>
          <a class="btn" href="#ai">AI Watch</a>
        </div>
      </div>`).join('');
  }
  for (const p of ps) {
    const el = $('#hp-' + p.id);
    if (!el) continue;
    $('.hp-name', el).textContent = p.name + (p.model ? ' · ' + p.model : '');
    $('.hp-pills', el).innerHTML = jobPill(p) + aiPill(p.ai, p.aiEnabled);
    const active = p.jobState === 'printing' || p.jobState === 'paused';
    $('.hp-job', el).innerHTML = active
      ? `<b>${esc(p.jobFile)}</b><br>${Math.round(p.progress * 100)}% · layer ${p.layer}/${p.layers} · ${fmtTime(p.remaining)} left`
      : (p.online ? 'Idle' : esc(p.stateMessage));
    $('.progress > div', el).style.width = (active ? p.progress * 100 : 0) + '%';
    const t = [];
    (p.tools || []).forEach((x, i) => { if (x.target > 0 || i === 0) t.push(`Nozzle${p.tools.length > 1 ? ' ' + (i + 1) : ''} <b>${tempStr(x)}</b>`); });
    if (p.bed) t.push(`Bed <b>${tempStr(p.bed)}</b>`);
    if (p.chamber) t.push(`Chamber <b>${tempStr(p.chamber)}</b>`);
    $('.temps', el).innerHTML = t.join('');
    $('.hp-msg', el).textContent = p.error || p.uploadStatus || '';
    $('.hp-mainsail', el).href = p.mainsailUrl;
    // camera: refresh a still picture every 5 s while the page is visible
    if (p.hasCamera && !camTimers[p.id]) {
      const img = $('.cam img', el);
      const load = () => {
        if (document.hidden || state.page !== 'home') return;
        const n = new Image();
        n.onload = () => { img.src = n.src; img.classList.remove('hidden'); $('.cam .empty', el)?.classList.add('hidden'); };
        n.src = `/api/printers/${p.id}/snapshot?t=${Date.now()}`;
      };
      load();
      camTimers[p.id] = setInterval(load, 5000);
    }
  }
}

// ---------------------------------------------------------------- printers
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
  list.innerHTML = s.printers.map((p) => `
    <div class="list-item" data-id="${p.id}" role="button" tabindex="0">
      <div>
        <div><b>${esc(p.name)}</b> ${p.model ? '· ' + esc(p.model) : ''} ${jobPill(p)}</div>
        <div class="sub">${esc(p.ip)} · Mainsail / OrcaSlicer: <code>${esc(p.orcaHost)}</code></div>
        ${p.online || !p.enabled ? '' : `<div class="sub">${esc(p.error || p.stateMessage)}</div>`}
      </div>
      <div class="row gap">
        <button class="btn tiny" data-edit="${p.id}">Edit</button>
        <button class="btn tiny danger" data-del="${p.id}">Remove</button>
      </div>
    </div>`).join('');
}

$('#printer-list').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    const p = state.status.printers.find((x) => x.id === del.dataset.del);
    if (!confirm(`Remove ${p ? p.name : 'this printer'}? Its job history on this board is kept.`)) return;
    await api('printers/' + del.dataset.del, { method: 'DELETE' });
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
    if (!state.scanned.length) {
      $('#scan-results').innerHTML = `<div class="notice warn">No printer answered. Check that it is switched on and connected to the same network as this board, then try again, or use <b>Add manually</b> with the IP address shown on the printer.</div>`;
    } else {
      $('#scan-results').innerHTML = '<h3>Found on your network</h3>' + state.scanned.map((f, i) => `
        <button class="list-item" data-found="${i}">
          <div><b>${esc(f.name)}</b> · ${esc(f.model)}<div class="sub">${esc(f.ip)} · serial ${esc(f.serial || 'unknown')}</div></div>
          <span class="btn tiny ${f.alreadyAdded ? '' : 'primary'}">${f.alreadyAdded ? 'Added' : 'Add'}</span>
        </button>`).join('');
    }
  } finally {
    b.disabled = false;
    b.textContent = 'Scan network';
  }
});

$('#scan-results').addEventListener('click', (e) => {
  const it = e.target.closest('[data-found]');
  if (!it) return;
  const f = state.scanned[+it.dataset.found];
  const existing = state.status.printers.find((p) => p.ip === f.ip);
  openPrinterDialog(existing || null, f);
});
$('#btn-add-manual').addEventListener('click', () => openPrinterDialog(null));

function nextPort() {
  const used = new Set((state.status?.printers || []).map((p) => p.port));
  let p = 7125;
  while (used.has(p)) p++;
  return p;
}

function openPrinterDialog(p, found) {
  const d = $('#printer-dialog');
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
  $('#pd-enabled').checked = p ? p.enabled : true;
  $('#pd-msg').classList.add('hidden');
  d.showModal();
  setTimeout(() => ($('#pd-ip').value ? $('#pd-code') : $('#pd-ip')).focus(), 50);
}

function dialogValues() {
  return {
    id: $('#pd-id').value,
    name: $('#pd-name').value.trim(),
    ip: $('#pd-ip').value.trim(),
    serial: $('#pd-serial').value.trim(),
    checkCode: $('#pd-code').value.trim(),
    port: parseInt($('#pd-port').value, 10) || nextPort(),
    cameraUrl: $('#pd-camera').value.trim(),
    levelBeforePrint: $('#pd-level').checked,
    enabled: $('#pd-enabled').checked,
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
  toast(`Saved. Mainsail / OrcaSlicer address: ${r.printer.orcaHost}`);
  await refreshStatus();
  renderPrinterList();
  $('#scan-results').innerHTML = '';
});

// ---------------------------------------------------------------- AI
async function loadAi() {
  state.ai = await api('ai');
  const a = state.ai.settings;
  $('#ai-enabled').checked = a.enabled;
  $$('#ai-action button').forEach((b) => b.classList.toggle('on', b.dataset.v === a.action));
  $$('#ai-sens button').forEach((b) => b.classList.toggle('on', b.dataset.v === a.sensitivity));
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
  warning: 'Possible failure! Please check the printer.', paused: 'The AI paused this print. Check it, then resume or cancel in Mainsail or on the printer.',
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
      <div class="card" id="ai-${p.id}">
        <div class="row between">
          <h2>${esc(p.name)}</h2>
          <label class="switch" title="Use AI on this printer"><input type="checkbox" data-ai-toggle="${p.id}"><span></span></label>
        </div>
        <div class="cam"><img alt="Last analysed picture" class="hidden"><canvas></canvas><div class="empty">The last picture the AI looked at appears here.</div></div>
        <div class="label">Failure risk</div>
        <div class="progress risk"><div></div></div>
        <div class="ai-msg"></div>
        <div class="hint ai-meta"></div>
        <div class="row gap wrap" style="margin-top:10px">
          <button class="btn" data-ai-test="${p.id}">Test now</button>
          <button class="btn" data-ai-ignore="${p.id}">Not a failure</button>
        </div>
      </div>`).join('') : '<div class="card muted">Add a printer first.</div>';
  }
  for (const p of s.printers) {
    const el = $('#ai-' + p.id);
    if (!el) continue;
    const a = p.ai || {};
    $('[data-ai-toggle]', el).checked = p.aiEnabled;
    $('.risk > div', el).style.width = Math.round(a.risk || 0) + '%';
    const kind = a.status === 'warning' ? 'warn' : a.status === 'paused' ? 'err' : a.status === 'watching' ? 'ok' : '';
    const msg = $('.ai-msg', el);
    notice(msg, a.message || aiStatusText[a.status] || '', kind);
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
  const img = $('.cam img', el);
  const canvas = $('.cam canvas', el);
  const n = new Image();
  n.onload = () => {
    img.src = n.src;
    img.classList.remove('hidden');
    $('.cam .empty', el).classList.add('hidden');
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
  n.src = `/api/ai/${id}/image?t=${Date.now()}`;
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
    const r = await api(`ai/${test.dataset.aiTest}/test`, { method: 'POST' });
    test.disabled = false; test.textContent = 'Test now';
    toast(r.message || (r.ok ? 'Done' : 'Failed'), !r.ok);
    if (r.ok && r.state) drawAiImage($('#ai-' + test.dataset.aiTest), test.dataset.aiTest, r.state);
  }
  if (ign) {
    await api(`ai/${ign.dataset.aiIgnore}/ignore`, { method: 'POST' });
    toast('OK, no more AI alerts for this print.');
    refreshStatus();
  }
});

// ---------------------------------------------------------------- network
async function loadNetwork(scan) {
  const n = await api('network');
  const kv = [];
  if (n.ok === false && n.message) kv.push(['Status', n.message]);
  if (n.hostname) { kv.push(['Board name', n.hostname + '.local']); $('#hn-current').textContent = n.hostname; $('#hn-input').placeholder = n.hostname; }
  if (n.ethernet) kv.push(['Ethernet', n.ethernet.connected ? `Connected · ${n.ethernet.ip}` : 'Not plugged in']);
  if (n.wifi) kv.push(['Wi-Fi', n.wifi.connected ? `${n.wifi.ssid} · ${n.wifi.ip}${n.wifi.signal ? ' · signal ' + n.wifi.signal + '%' : ''}` : (n.wifi.present === false ? 'No Wi-Fi hardware found' : 'Not connected')]);
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
  msg.classList.remove('hidden');
  const hotspot = (state.status?.ips || []).some((ip) => ip.startsWith('10.42.'));
  notice(msg, hotspot
    ? 'Joining your Wi-Fi… Your phone will lose this hotspot now. Reconnect your phone to your home Wi-Fi, then open http://' + (state.status?.hostname || 'ffbridge') + '.local'
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
  const m = $('#hn-msg');
  m.classList.remove('hidden');
  notice(m, r.ok ? `Renamed. From now on open http://${v.toLowerCase()}.local` : (r.message || 'Failed'), r.ok ? 'ok' : 'err');
});

// ---------------------------------------------------------------- settings
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
}
$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await api('settings', {
    method: 'POST',
    body: {
      discordWebhook: $('#s-discord').value.trim(),
      discordIntervalMinutes: parseInt($('#s-interval').value, 10) || 0,
      discordSnapshot: $('#s-snap').checked,
      notifyOnStart: $('#s-start').checked,
      notifyOnComplete: $('#s-complete').checked,
      notifyOnPause: $('#s-pause').checked,
      notifyOnError: $('#s-error').checked,
      spoolmanUrl: $('#s-spoolman').value.trim(),
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

// ---------------------------------------------------------------- system
async function loadSystem() {
  const s = state.status || (await api('status'));
  const info = await api('system/info');
  const rows = [
    ['Bridge version', s.version],
    ['Board name', (s.hostname || '') + '.local'],
    ['IP address', (s.ips || []).join(', ') || '–'],
  ];
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
async function loadLogs() {
  const r = await api('logs');
  const pre = $('#logs');
  pre.textContent = (r.lines || []).join('\n');
  pre.scrollTop = pre.scrollHeight;
}
$('#btn-logs').addEventListener('click', loadLogs);
$('#btn-reboot').addEventListener('click', async () => {
  if (!confirm('Restart the bridge board? Running prints are NOT affected, but Mainsail is unavailable for about a minute.')) return;
  const r = await api('system/reboot', { method: 'POST' });
  toast(r.message || 'Restarting…');
});
$('#btn-shutdown').addEventListener('click', async () => {
  if (!confirm('Shut the board down? You will need to unplug and re-plug its power to start it again.')) return;
  const r = await api('system/shutdown', { method: 'POST' });
  toast(r.message || 'Shutting down…');
});
$('#pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await api('system/password', { method: 'POST', body: { password: $('#pw-input').value } });
  toast(r.message, !r.ok);
  $('#pw-input').value = '';
});

// copy buttons
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  const text = $('#' + b.dataset.copy).textContent;
  (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast('Copied'), () => toast(text));
});

// ---------------------------------------------------------------- start
(async () => {
  await refreshStatus();
  const first = location.hash.slice(1) || (state.status && !state.status.printers.length ? 'printers' : 'home');
  showPage(first);
  setInterval(refreshStatus, 3000);
})();
