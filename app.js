import { FinesseClient } from './finesse-client.js';

const $ = (sel) => document.querySelector(sel);
const SETTINGS_KEY = 'finesse-spike-settings';
const SAVED_FIELDS = ['host', 'restPort', 'xmppPort', 'reverseProxy', 'agentId', 'authId', 'extension', 'mode', 'transport'];
const CALL_ACTIONS = ['ANSWER', 'HOLD', 'RETRIEVE', 'DROP'];

let client = null;

$('#origin').textContent = location.origin;

// The local proxy only exists when the page is served by server.js on this machine.
const LOCAL = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
if (!LOCAL) {
  const proxyOpt = $('#cfg').elements.mode.querySelector('option[value="proxy"]');
  proxyOpt.disabled = true;
  proxyOpt.textContent += ' — only when run locally';
}

// ---- Settings (never stores the password) ---------------------------------

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    for (const f of SAVED_FIELDS) {
      const el = $('#cfg').elements[f];
      if (el.type === 'checkbox') el.checked = !!saved[f];
      else if (saved[f]) el.value = saved[f];
    }
  } catch {
    /* storage unavailable */
  }
}

function readSettings() {
  const els = $('#cfg').elements;
  const cfg = {};
  for (const f of [...SAVED_FIELDS, 'password']) cfg[f] = els[f].type === 'checkbox' ? els[f].checked : els[f].value.trim();
  if (!LOCAL) cfg.mode = 'direct';
  cfg.host = cfg.host.replace(/^https?:\/\//, '').replace(/[:/].*$/, '');
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(Object.fromEntries(SAVED_FIELDS.map((f) => [f, cfg[f]]))));
  } catch {
    /* storage unavailable */
  }
  return cfg;
}

// ---- Log -----------------------------------------------------------------

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function addLog(level, message, data) {
  const line = document.createElement('div');
  line.className = `line ${level}`;
  const t = new Date().toLocaleTimeString();
  let html = `<span class="t">${t}</span><span class="lvl">[${level}]</span> ${esc(message)}`;
  if (data) html += `<details><summary>details</summary>${esc(data)}</details>`;
  line.innerHTML = html;
  const log = $('#log');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.appendChild(line);
  if (atBottom) log.scrollTop = log.scrollHeight;
}

$('#show-raw').addEventListener('change', (e) => $('#log').classList.toggle('show-raw', e.target.checked));
$('#clear-log').addEventListener('click', () => ($('#log').innerHTML = ''));
$('#copy-log').addEventListener('click', async () => {
  const lines = [...$('#log').querySelectorAll('.line')]
    .filter((l) => !l.classList.contains('raw') || $('#show-raw').checked)
    .map((l) => l.innerText);
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    addLog('info', 'Log copied to clipboard (passwords are never logged).');
  } catch {
    addLog('error', 'Clipboard not available — select the log text manually.');
  }
});

// ---- Checklist -----------------------------------------------------------

function setCheck(step, state, detail = '') {
  const li = $(`#checklist li[data-step="${step}"]`);
  const pill = li.querySelector('.pill');
  pill.className = `pill ${state}`;
  pill.textContent = { ok: 'PASS', bad: 'FAIL', run: '…', '': '—' }[state];
  const d = li.querySelector('.detail');
  d.textContent = detail;
  d.classList.toggle('bad', state === 'bad');
}

function resetChecks() {
  for (const step of ['rest', 'auth', 'xmpp', 'event']) setCheck(step, '');
}

// ---- Rendering -----------------------------------------------------------

function renderUser(u) {
  if (!u) return;
  $('#a-name').textContent = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.loginName || '—';
  const st = $('#a-state');
  st.textContent = u.state + (u.pendingState ? ` → ${u.pendingState}` : '');
  st.className = `state ${u.state}`;
  $('#a-reason').textContent = u.reasonCode ? `(${u.reasonCode})` : '';
  $('#a-ext').textContent = u.extension || '—';
  $('#a-team').textContent = u.teamName || '—';
}

function renderDialogs(dialogs) {
  const box = $('#dialogs');
  if (!dialogs.length) {
    box.innerHTML = '<p class="muted">No active calls.</p>';
    return;
  }
  const ext = client?.cfg.extension;
  box.innerHTML = '';
  for (const d of dialogs) {
    const me = d.participants.find((p) => p.mediaAddress === ext);
    const allowed = me && me.actions.length ? CALL_ACTIONS.filter((a) => me.actions.includes(a)) : CALL_ACTIONS;
    const vars = d.callVariables.filter((v) => v.value).map((v) => `${v.name}=${v.value}`);
    const el = document.createElement('div');
    el.className = 'dialog';
    el.innerHTML = `
      <div class="head"><span>${esc(d.fromAddress || '?')} → ${esc(d.toAddress || '?')}</span>
        <span class="muted">${esc(d.state)}${me ? ` · me: ${esc(me.state)}` : ''}</span></div>
      <div class="vars">id=${esc(d.id)} · type=${esc(d.callType || '-')} · DNIS=${esc(d.dnis || '-')}${
        vars.length ? '<br>' + vars.map(esc).join(' · ') : ''
      }</div>
      <div class="row">
        ${allowed.map((a) => `<button data-dialog="${esc(d.id)}" data-call="${a}">${a[0] + a.slice(1).toLowerCase()}</button>`).join('')}
        <input class="dtmf" placeholder="DTMF" size="6" />
        <button data-dialog="${esc(d.id)}" data-call="DTMF">Send</button>
      </div>`;
    box.appendChild(el);
  }
}

// ---- Wiring --------------------------------------------------------------

async function run(label, fn) {
  if (!client) {
    addLog('error', 'Run the connectivity check first.');
    return;
  }
  try {
    await fn();
  } catch (err) {
    addLog('error', `${label}: ${err.message}`);
  }
}

function createClient(cfg) {
  if (client) client.disconnectEvents();
  client = new FinesseClient(cfg);
  client.addEventListener('log', (e) => addLog(e.detail.level, e.detail.message, e.detail.data));
  client.addEventListener('user', (e) => renderUser(e.detail));
  client.addEventListener('dialogs', (e) => renderDialogs(e.detail));
  client.addEventListener('notification', (e) => {
    const n = e.detail;
    addLog('event', `${n.event} ${n.source || n.node}`, n.raw);
    setCheck('event', 'ok', `${n.event} on ${n.source || n.node}`);
  });
  client.addEventListener('xmpp-raw', (e) => {
    const line = document.createElement('div');
    line.className = 'line raw';
    line.textContent = `${e.detail.dir === 'in' ? '<<' : '>>'} ${e.detail.data}`;
    $('#log').appendChild(line);
  });
  client.addEventListener('xmpp-status', (e) => {
    if (e.detail.status === 'DISCONNECTED') setCheck('xmpp', 'bad', 'Disconnected');
  });
}

async function connectivityCheck(cfg) {
  if (cfg.reverseProxy && cfg.mode === 'proxy') {
    addLog('info', 'Reverse Proxy mode needs WebSocket, which the local proxy does not carry — switching to Direct.');
    cfg.mode = 'direct';
    $('#cfg').elements.mode.value = 'direct';
  }
  if (cfg.reverseProxy) {
    cfg.transport = 'websocket';
    $('#cfg').elements.transport.value = 'websocket';
  }
  if (cfg.mode === 'proxy' && cfg.transport === 'websocket') {
    addLog('info', 'Proxy mode supports BOSH only — using BOSH.');
    cfg.transport = 'bosh';
    $('#cfg').elements.transport.value = 'bosh';
  }
  resetChecks();
  createClient(cfg);
  addLog(
    'info',
    `Mode=${cfg.mode}, transport=${cfg.transport}, reverseProxy=${cfg.reverseProxy}, REST=${client.restBase}, events=${client.xmppUrl}, origin=${location.origin}`
  );

  setCheck('rest', 'run');
  try {
    const info = await client.getSystemInfo();
    setCheck('rest', 'ok', `status=${info.status}, deployment=${info.deploymentType}, xmppDomain=${info.xmppDomain}, nodes=${[info.primaryNode, info.secondaryNode].filter(Boolean).join(' / ')}`);
  } catch (err) {
    setCheck('rest', 'bad', err.message);
    if (err.kind === 'network') return; // nothing else will work
  }

  setCheck('auth', 'run');
  try {
    const u = await client.getUser();
    setCheck('auth', 'ok', `${u.loginName || u.loginId}: state=${u.state}${u.extension ? `, ext=${u.extension}` : ''}`);
  } catch (err) {
    setCheck('auth', 'bad', err.status === 401 ? 'HTTP 401 — wrong Agent ID / login name / password.' : err.message);
    return;
  }

  try {
    const codes = await client.getReasonCodes('NOT_READY');
    $('#nr-reason').innerHTML =
      '<option value="">No reason</option>' + codes.map((c) => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join('');
  } catch {
    /* reason codes are optional for the spike */
  }

  setCheck('xmpp', 'run');
  try {
    await client.connectEvents();
    setCheck('xmpp', 'ok', `Connected via ${client.xmppUrl}`);
    setCheck('event', 'run', 'Waiting… click Ready / Not Ready, or call your extension.');
    await client.getDialogs();
  } catch (err) {
    setCheck('xmpp', 'bad', err.message);
  }
}

$('#cfg').addEventListener('submit', (e) => {
  e.preventDefault();
  connectivityCheck(readSettings());
});

$('#disconnect').addEventListener('click', () => {
  client?.disconnectEvents();
  addLog('info', 'Event channel disconnected.');
});

document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act], button[data-call]');
  if (!btn) return;

  const act = btn.dataset.act;
  if (act === 'login') run('Login', () => client.login());
  else if (act === 'ready') run('Ready', () => client.setState('READY'));
  else if (act === 'notready') run('Not Ready', () => client.setState('NOT_READY', $('#nr-reason').value || undefined));
  else if (act === 'logout') run('Logout', () => client.logout());
  else if (act === 'refresh') run('Refresh', async () => { await client.getUser(); await client.getDialogs(); });
  else if (act === 'dial') {
    const to = $('#dial').value.trim();
    if (to) run('Make call', () => client.makeCall(to));
  }

  const call = btn.dataset.call;
  if (call) {
    const id = btn.dataset.dialog;
    if (call === 'DTMF') {
      const digits = btn.parentElement.querySelector('.dtmf').value.trim();
      if (digits) run('DTMF', () => client.sendDtmf(id, digits));
    } else {
      run(call, () => client.dialogAction(id, call));
    }
  }
});

window.addEventListener('beforeunload', () => client?.disconnectEvents());

loadSettings();
addLog('info', 'Ready. Fill in the connection form and click "Run connectivity check".');
