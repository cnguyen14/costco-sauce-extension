const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

async function getCostcoTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url && tab.url.startsWith('https://www.costco.com/')) return tab;
  const [any] = await chrome.tabs.query({ url: 'https://www.costco.com/*' });
  return any || null;
}

function send(tabId, cmd, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { cmd, ...payload }, (resp) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp) return reject(new Error('No response from content script. Refresh the costco.com tab.'));
      if (!resp.ok && cmd !== 'ping') return reject(new Error(resp.error || 'Failed'));
      resolve(resp);
    });
  });
}

function setLogExpanded(el, expanded) {
  const toggle = document.querySelector(`.log-toggle[aria-controls="${el.id}"]`);
  el.classList.toggle('hidden', !expanded);
  if (toggle) {
    toggle.setAttribute('aria-expanded', String(expanded));
    const caret = toggle.querySelector('.caret');
    if (caret) caret.textContent = expanded ? '▼' : '▶';
  }
}

function logTo(targetSel, msg, cls = '') {
  const el = $(targetSel);
  if (!el) return;
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.appendChild(div);
  setLogExpanded(el, true);
  el.scrollTop = el.scrollHeight;
}
const mlog = (m, c) => logTo('#manageLog', m, c);

function setStatus(text, cls = '') {
  const s = $('#status');
  s.textContent = text;
  s.className = 'status ' + cls;
}

function getInitials(name, email) {
  const src = (name || '').trim();
  if (src) {
    const parts = src.split(/\s+/).slice(0, 2);
    return parts.map(p => p[0]).join('').toUpperCase();
  }
  if (email) return email[0].toUpperCase();
  return '?';
}

async function loadUser() {
  const card = $('#userCard');
  try {
    const tab = await getCostcoTab();
    if (!tab) { card.classList.add('hidden'); return; }
    const r = await send(tab.id, 'getUser');
    const u = (r && r.user) || {};
    if (!u.name && !u.email) { card.classList.add('hidden'); return; }
    $('#userAvatar').textContent = getInitials(u.name, u.email);
    $('#userName').textContent = u.name || '';
    $('#userEmail').textContent = u.email || '';
    $('#userTier').textContent = u.tier || '';
    card.classList.toggle('email-only', !u.name);
    card.classList.remove('hidden');
  } catch {
    card.classList.add('hidden');
  }
}

async function withTab(fn) {
  const tab = await getCostcoTab();
  if (!tab) {
    setStatus('Open and sign in to a costco.com tab first.', 'err');
    throw new Error('No costco.com tab found.');
  }
  return fn(tab.id);
}

async function checkStatus() {
  try {
    const tab = await getCostcoTab();
    if (!tab) {
      setStatus('Open and sign in to a costco.com tab first.', 'err');
      return;
    }
    const r = await send(tab.id, 'ping');
    if (!r.hasToken) setStatus('Not signed in. Sign in to costco.com.', 'err');
    else if (r.expired) setStatus('Token expired. Refresh the costco.com tab.', 'err');
    else if (!r.hasGdxHeaders) setStatus('Ready (visit any product page once to enable item names).', 'ok');
    else setStatus('Ready.', 'ok');
  } catch (e) {
    setStatus(e.message, 'err');
  }
}

/* ---------------- Manage tab ---------------- */

const expandedLists = new Set();

async function renderManageLists() {
  const root = $('#manageLists');
  root.innerHTML = '<div class="muted">Loading…</div>';
  try {
    await withTab(async (tabId) => {
      const r = await send(tabId, 'getLists');
      const lists = r.lists || [];
      if (!lists.length) {
        root.innerHTML = '<div class="muted">No lists yet.</div>';
        return;
      }
      root.innerHTML = '';
      for (const l of lists) {
        root.appendChild(renderListCard(l));
      }
      // Re-expand previously open lists
      for (const id of expandedLists) {
        const card = root.querySelector(`[data-list-id="${id}"]`);
        if (card) await expandList(card, id);
      }
    });
  } catch (e) {
    root.innerHTML = '';
    mlog(`Failed to load lists: ${e.message}`, 'err');
  }
}

function renderListCard(list) {
  const card = document.createElement('div');
  card.className = 'list-card';
  card.dataset.listId = list.id;

  const head = document.createElement('div');
  head.className = 'list-head';

  const caret = document.createElement('span');
  caret.className = 'caret';
  caret.textContent = '▶';

  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = list.title;

  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = `(${(list.items || []).length})`;

  const actions = document.createElement('span');
  actions.className = 'actions';

  const renameBtn = document.createElement('button');
  renameBtn.className = 'icon';
  renameBtn.title = 'Rename';
  renameBtn.textContent = '✎';
  renameBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    onRenameList(list);
  });

  const delBtn = document.createElement('button');
  delBtn.className = 'icon danger';
  delBtn.title = 'Delete list';
  delBtn.textContent = '🗑';
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    onDeleteList(list);
  });

  actions.appendChild(renameBtn);
  actions.appendChild(delBtn);

  head.appendChild(caret);
  head.appendChild(title);
  head.appendChild(count);
  head.appendChild(actions);

  const body = document.createElement('div');
  body.className = 'list-body hidden';

  head.addEventListener('click', () => {
    if (body.classList.contains('hidden')) {
      expandList(card, list.id);
    } else {
      collapseList(card, list.id);
    }
  });

  card.appendChild(head);
  card.appendChild(body);
  return card;
}

function collapseList(card, listId) {
  card.querySelector('.list-body').classList.add('hidden');
  card.querySelector('.caret').textContent = '▶';
  expandedLists.delete(listId);
}

async function expandList(card, listId) {
  const body = card.querySelector('.list-body');
  const caret = card.querySelector('.caret');
  body.classList.remove('hidden');
  caret.textContent = '▼';
  expandedLists.add(listId);
  body.innerHTML = '<div class="muted">Loading items…</div>';
  try {
    await withTab(async (tabId) => {
      const r = await send(tabId, 'getList', { id: listId });
      const items = (r.list && r.list.items) || [];
      if (!items.length) {
        body.innerHTML = '<div class="muted">Empty list.</div>';
        return;
      }
      const itemNumbers = items.map(it => String(it.itemNumber)).filter(Boolean);
      let nameMap = {};
      try {
        const np = await send(tabId, 'getProductNames', { itemNumbers });
        nameMap = np.products || {};
      } catch { /* fallback: render with "Item <SKU>" */ }
      body.innerHTML = '';
      for (const it of items) {
        body.appendChild(renderItemRow(listId, it, nameMap[String(it.itemNumber)]));
      }
    });
  } catch (e) {
    body.innerHTML = '';
    mlog(`Failed to load items: ${e.message}`, 'err');
  }
}

function getLineItemId(item) {
  if (!item) return null;
  return item.id || item.lineItemId || item.entryId || item.entryUid
    || (item.entry && (item.entry.id || item.entry.lineItemId))
    || null;
}

function renderItemRow(listId, item, info) {
  const row = document.createElement('div');
  row.className = 'item-row';

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = (info && info.name) ? info.name : `Item ${item.itemNumber}`;
  name.title = name.textContent;

  const sku = document.createElement('span');
  sku.className = 'sku';
  sku.textContent = `#${item.itemNumber}`;

  const lineItemId = getLineItemId(item);

  const delBtn = document.createElement('button');
  delBtn.className = 'icon danger';
  delBtn.title = 'Remove from list';
  delBtn.textContent = '🗑';
  delBtn.addEventListener('click', () => onDeleteEntry(listId, item, lineItemId, name.textContent));

  row.appendChild(name);
  row.appendChild(sku);
  row.appendChild(delBtn);
  return row;
}

async function onRenameList(list) {
  const next = prompt('New name for the list:', list.title);
  if (next === null) return;
  const trimmed = next.trim();
  if (!trimmed || trimmed === list.title) return;
  try {
    await withTab(async (tabId) => {
      await send(tabId, 'renameList', { id: list.id, title: trimmed, description: list.description || '' });
      mlog(`Renamed "${list.title}" → "${trimmed}".`, 'ok');
      await renderManageLists();
    });
  } catch (e) { mlog(`Rename failed: ${e.message}`, 'err'); }
}

async function onDeleteList(list) {
  const ok = confirm(`Delete list "${list.title}"? This cannot be undone.`);
  if (!ok) return;
  try {
    await withTab(async (tabId) => {
      await send(tabId, 'deleteList', { id: list.id });
      mlog(`Deleted list "${list.title}".`, 'ok');
      expandedLists.delete(list.id);
      await renderManageLists();
    });
  } catch (e) { mlog(`Delete failed: ${e.message}`, 'err'); }
}

async function onDeleteEntry(listId, item, lineItemId, displayName) {
  if (!lineItemId) {
    mlog(`Remove failed: no entry id on item (keys: ${Object.keys(item).join(',')})`, 'err');
    return;
  }
  const ok = confirm(`Remove "${displayName}" (#${item.itemNumber}) from this list?`);
  if (!ok) return;
  try {
    await withTab(async (tabId) => {
      await send(tabId, 'deleteEntry', { listId, lineItemId });
      mlog(`Removed "${displayName}".`, 'ok');
      await renderManageLists();
    });
  } catch (e) { mlog(`Remove failed: ${e.message}`, 'err'); }
}

/* ---------------- Remote tab ---------------- */

let remotePollTimer = null;

function fmtAge(ts) {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

function fmtRemaining(targetIso) {
  if (!targetIso) return '—';
  const ms = new Date(targetIso).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const s = Math.floor(ms / 1000);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h left`;
  if (hours > 0) return `${hours}h ${mins}m left`;
  if (mins > 0) return `${mins}m left`;
  return `${s}s left`;
}

function fmtExpiry(target) {
  if (!target) return '—';
  const t = typeof target === 'number' ? target : new Date(target).getTime();
  if (!t || Number.isNaN(t)) return '—';
  const ms = t - Date.now();
  const date = new Date(t).toLocaleDateString('en-US', { day: '2-digit', month: '2-digit', year: 'numeric' });
  if (ms <= 0) return `${date} (expired)`;
  return `${date} (${fmtRemaining(t)})`;
}

function reqStatusLabel(s) {
  return ({
    pending: 'Waiting for admin approval',
    approved: 'Approved',
    denied: 'Denied',
    expired: 'Token expired',
    not_found: 'Request not found',
  })[s] || (s || '—');
}

function setDot(el, color) {
  el.style.background = color;
}

function showRemoteSection(name) {
  for (const id of ['remoteUnregistered', 'remotePending', 'remoteRegistered', 'remoteControls']) {
    $(`#${id}`).classList.add('hidden');
  }
  if (name === 'unregistered') $('#remoteUnregistered').classList.remove('hidden');
  if (name === 'pending') $('#remotePending').classList.remove('hidden');
  if (name === 'registered') {
    $('#remoteRegistered').classList.remove('hidden');
    $('#remoteControls').classList.remove('hidden');
  }
}

function startRemotePoll() {
  if (remotePollTimer) clearInterval(remotePollTimer);
  remotePollTimer = setInterval(loadRemoteStatus, 1000);
}

function stopRemotePoll() {
  if (remotePollTimer) clearInterval(remotePollTimer);
  remotePollTimer = null;
}

async function loadRemoteStatus() {
  let status;
  try {
    status = await chrome.runtime.sendMessage({ cmd: 'remote.getStatus' });
  } catch (e) {
    return;
  }
  if (!status) return;

  const phase = status.phase || (status.registered ? 'registered' : 'unregistered');

  if (phase === 'unregistered') {
    stopRemotePoll();
    showRemoteSection('unregistered');
    return;
  }

  if (phase === 'pending') {
    showRemoteSection('pending');
    $('#pendingToken').textContent = status.requestToken || '—';
    $('#pendingExpiry').textContent = fmtRemaining(status.requestExpiresAt);
    $('#pendingState').textContent = reqStatusLabel(status.requestStatus);
    startRemotePoll();
    return;
  }

  // registered
  // Keep polling briefly until first heartbeat lands so the dot flips green automatically.
  if (status.lastHeartbeatOk || status.lastError) {
    stopRemotePoll();
  } else {
    startRemotePoll();
  }
  showRemoteSection('registered');

  $('#remoteUuid').textContent = status.clientUuid || '—';

  const dot = $('#remoteStatusDot');
  const text = $('#remoteStatusText');
  if (status.paused) {
    setDot(dot, '#6B7280');
    text.textContent = 'Paused';
  } else if (status.lastError) {
    setDot(dot, '#C8102E');
    text.textContent = `Error: ${status.lastError}`;
  } else if (status.lastHeartbeatOk) {
    setDot(dot, '#16A34A');
    text.textContent = 'Connected';
  } else {
    setDot(dot, '#F59E0B');
    text.textContent = 'Awaiting refresh';
  }

  $('#remoteCostco').textContent = status.signedInOnCostco
    ? '✓ Signed in'
    : (status.hasCostcoTab ? 'Not signed in' : 'No costco.com tab');

  $('#remoteHeartbeat').textContent = fmtAge(status.lastHeartbeatAt);
  $('#remoteTokenExpires').textContent = fmtExpiry(status.clientTokenExpiresAt);
  $('#pauseToggle').checked = !!status.paused;
}

async function onPauseChange(e) {
  await chrome.runtime.sendMessage({ cmd: 'remote.setPaused', paused: e.target.checked });
  await loadRemoteStatus();
}

async function onHeartbeatNow() {
  $('#heartbeatNow').disabled = true;
  await chrome.runtime.sendMessage({ cmd: 'remote.heartbeatNow' });
  await loadRemoteStatus();
  $('#heartbeatNow').disabled = false;
}

async function onReset() {
  if (!confirm('Reset registration? The current token will be removed and a new request will be sent to the admin for re-approval.')) return;
  const btn = $('#resetBtn');
  btn.disabled = true;
  try {
    await chrome.runtime.sendMessage({ cmd: 'remote.unregister' });
    const tab = await getCostcoTab();
    let user = {};
    if (tab) {
      try {
        const r = await send(tab.id, 'getUser');
        user = (r && r.user) || {};
      } catch { /* ignore */ }
    }
    await chrome.runtime.sendMessage({
      cmd: 'remote.createRequest',
      name: user.name || null,
      email: user.email || null,
      tier: user.tier || null,
    });
    await loadRemoteStatus();
  } finally {
    btn.disabled = false;
  }
}

async function onRegister() {
  const btn = $('#registerBtn');
  const err = $('#registerError');
  err.classList.add('hidden');
  err.textContent = '';
  btn.disabled = true;
  try {
    const tab = await getCostcoTab();
    if (!tab) throw new Error('Open and sign in to costco.com first.');
    const r = await send(tab.id, 'getUser');
    const u = (r && r.user) || {};
    if (!u.name && !u.email) throw new Error('No signed-in costco.com account detected. Refresh the costco tab and try again.');
    const resp = await chrome.runtime.sendMessage({
      cmd: 'remote.createRequest',
      name: u.name || null,
      email: u.email || null,
      tier: u.tier || null,
    });
    if (!resp || !resp.ok) throw new Error(resp?.error || 'Unknown error');
    await loadRemoteStatus();
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
}

async function onRefreshPending() {
  const btn = $('#refreshPending');
  btn.disabled = true;
  try {
    await chrome.runtime.sendMessage({ cmd: 'remote.checkNow' });
    await loadRemoteStatus();
  } finally {
    btn.disabled = false;
  }
}

async function onCopyPendingToken() {
  const tok = $('#pendingToken').textContent;
  if (!tok || tok === '—') return;
  try {
    await navigator.clipboard.writeText(tok);
    const btn = $('#copyPendingToken');
    const orig = btn.textContent;
    btn.textContent = 'Copied ✓';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  } catch (e) { /* ignore */ }
}

async function onCancelPending() {
  if (!confirm('Cancel the request? The token will be removed; you will need to create a new request and send the new token to the admin.')) return;
  await chrome.runtime.sendMessage({ cmd: 'remote.cancelRequest' });
  await loadRemoteStatus();
}

/* ---------------- Tab nav ---------------- */

function switchTab(name) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tab-panel').forEach(p => p.classList.toggle('hidden', p.dataset.panel !== name));
  if (name === 'manage') renderManageLists();
  if (name === 'remote') loadRemoteStatus();
  else stopRemotePoll();
}

document.addEventListener('DOMContentLoaded', async () => {
  $('#refreshManage').addEventListener('click', renderManageLists);
  $('#registerBtn').addEventListener('click', onRegister);
  $('#refreshPending').addEventListener('click', onRefreshPending);
  $('#copyPendingToken').addEventListener('click', onCopyPendingToken);
  $('#cancelPending').addEventListener('click', onCancelPending);
  $('#pauseToggle').addEventListener('change', onPauseChange);
  $('#heartbeatNow').addEventListener('click', onHeartbeatNow);
  $('#resetBtn').addEventListener('click', onReset);
  $$('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  $$('.log-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.getAttribute('aria-controls'));
      if (!target) return;
      setLogExpanded(target, target.classList.contains('hidden'));
    });
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !('remoteConfig' in changes)) return;
    const before = changes.remoteConfig.oldValue || {};
    const after = changes.remoteConfig.newValue || {};
    const phaseChanged =
      !!before.clientToken !== !!after.clientToken ||
      !!before.requestToken !== !!after.requestToken ||
      before.requestStatus !== after.requestStatus ||
      !!before.paused !== !!after.paused;
    if (!phaseChanged) return;
    const panel = document.querySelector('.tab-panel[data-panel="remote"]');
    if (panel && !panel.classList.contains('hidden')) loadRemoteStatus();
  });
  await checkStatus();
  await loadUser();
  await loadRemoteStatus();
});
