const SERVER_URL = atob('aHR0cHM6Ly9jb3N0Y28tc2F1Y2UuY3RrLmhvbWVz');
const HEARTBEAT_ALARM = 'remote-heartbeat';
const POLL_ALARM = 'remote-poll-keepalive';
const REQUEST_CHECK_ALARM = 'remote-request-check';
const CLEANUP_ALARM = 'remote-cleanup-pass';
const HEARTBEAT_PERIOD_MIN = 1;
const POLL_KEEPALIVE_MIN = 0.5;
const REQUEST_CHECK_PERIOD_MIN = 0.25; // 15s
const CLEANUP_PERIOD_MIN = 1;
const CLEANUP_DELAY_MIN_MS = 60_000;
const CLEANUP_DELAY_MAX_MS = 90_000;
const CLEANUP_RETRY_BACKOFF_MS = 300_000;
const CLEANUP_MAX_ATTEMPTS = 5;
const POLL_TIMEOUT_MS = 25000;

let pollInFlight = false;
let cleanupInFlight = false;

function uuid() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

async function getConfig() {
  const { remoteConfig } = await chrome.storage.local.get('remoteConfig');
  return remoteConfig || null;
}

async function saveConfig(patch) {
  const cur = (await getConfig()) || {};
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ remoteConfig: next });
  return next;
}

async function clearConfig() {
  await chrome.storage.local.remove('remoteConfig');
}

function phaseOf(cfg) {
  if (!cfg) return 'unregistered';
  if (cfg.clientToken) return 'registered';
  if (cfg.requestToken) return 'pending';
  return 'unregistered';
}

function decodeJwtExp(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return null;
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    const claims = JSON.parse(json);
    if (typeof claims.exp === 'number') return claims.exp * 1000;
    return null;
  } catch { return null; }
}

async function purgeExpiredClientToken() {
  const cfg = await getConfig();
  if (!cfg || !cfg.clientToken) return false;
  const exp = decodeJwtExp(cfg.clientToken);
  if (!exp || exp > Date.now()) return false;
  await chrome.storage.local.remove('remoteConfig');
  await chrome.storage.local.remove('pendingCleanups');
  await chrome.alarms.clear(HEARTBEAT_ALARM);
  await chrome.alarms.clear(POLL_ALARM);
  await chrome.alarms.clear(REQUEST_CHECK_ALARM);
  await chrome.alarms.clear(CLEANUP_ALARM);
  await refreshBadge();
  return true;
}

async function refreshBadge() {
  const cfg = await getConfig();
  const phase = phaseOf(cfg);
  if (phase === 'unregistered') {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }
  if (phase === 'pending') {
    await chrome.action.setBadgeText({ text: '…' });
    await chrome.action.setBadgeBackgroundColor({ color: '#F59E0B' });
    return;
  }
  if (cfg.paused) {
    await chrome.action.setBadgeText({ text: '⏸' });
    await chrome.action.setBadgeBackgroundColor({ color: '#6B7280' });
    return;
  }
  if (cfg.lastError) {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#C8102E' });
    return;
  }
  await chrome.action.setBadgeText({ text: '' });
}

async function findCostcoTab() {
  const tabs = await chrome.tabs.query({ url: 'https://www.costco.com/*' });
  return tabs[0] || null;
}

function sendToTab(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(resp || null);
    });
  });
}

async function readCostcoState() {
  const tab = await findCostcoTab();
  if (!tab) return { signedIn: false, hasTab: false };
  const ping = await sendToTab(tab.id, { cmd: 'ping' });
  const user = await sendToTab(tab.id, { cmd: 'getUser' });
  const u = (user && user.user) || {};
  return {
    hasTab: true,
    signedIn: !!(ping && ping.hasToken && !ping.expired),
    name: u.name || null,
    email: u.email || null,
    tier: u.tier || null,
  };
}

async function apiAuthFetch(path, opts = {}) {
  const cfg = await getConfig();
  if (!cfg || !cfg.clientToken) throw new Error('not_registered');
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.clientToken}`,
    ...(opts.headers || {}),
  };
  const ctrl = new AbortController();
  const timeout = opts.timeout || 30000;
  const tid = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(`${SERVER_URL}${path}`, { ...opts, headers, signal: ctrl.signal });
    if (r.status === 401 || r.status === 403) {
      // Server may have revoked us — drop creds and force re-request.
      await chrome.storage.local.remove('remoteConfig');
      await chrome.alarms.clear(HEARTBEAT_ALARM);
      await chrome.alarms.clear(POLL_ALARM);
      await refreshBadge();
      throw new Error('auth_revoked');
    }
    return r;
  } finally {
    clearTimeout(tid);
  }
}

async function createRegistrationRequest({ name, email, tier }) {
  const cfg = await getConfig();
  if (cfg && cfg.clientToken) {
    return { ok: true, alreadyRegistered: true };
  }
  if (cfg && cfg.requestToken) {
    return { ok: true, alreadyPending: true };
  }
  const clientUuid = (cfg && cfg.clientUuid) || uuid();
  const r = await fetch(`${SERVER_URL}/api/client/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientUuid,
      name: name || null,
      email: email || null,
      tier: tier || null,
      userAgent: navigator.userAgent,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.requestToken) {
    throw new Error((j && j.error) || `HTTP ${r.status}`);
  }
  await saveConfig({
    serverUrl: SERVER_URL,
    clientUuid,
    requestToken: j.requestToken,
    requestExpiresAt: j.expiresAt,
    requestCreatedAt: j.createdAt,
    consentedAt: Date.now(),
    paused: false,
    lastCursor: 0,
    lastError: null,
    lastHeartbeatAt: null,
    lastHeartbeatOk: false,
  });
  await chrome.alarms.create(REQUEST_CHECK_ALARM, {
    delayInMinutes: 0.05,
    periodInMinutes: REQUEST_CHECK_PERIOD_MIN,
  });
  await refreshBadge();
  return { ok: true, requestToken: j.requestToken, expiresAt: j.expiresAt };
}

async function cancelRegistrationRequest() {
  await chrome.storage.local.remove('remoteConfig');
  await chrome.alarms.clear(REQUEST_CHECK_ALARM);
  await chrome.alarms.clear(HEARTBEAT_ALARM);
  await chrome.alarms.clear(POLL_ALARM);
  await refreshBadge();
}

async function checkRequestStatus() {
  const cfg = await getConfig();
  if (!cfg || !cfg.requestToken || cfg.clientToken) {
    await chrome.alarms.clear(REQUEST_CHECK_ALARM);
    return null;
  }
  try {
    const r = await fetch(
      `${SERVER_URL}/api/client/check?token=${encodeURIComponent(cfg.requestToken)}`,
      { method: 'GET' },
    );
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      // 404 means token was deleted server-side; treat as denied.
      if (r.status === 404) {
        await saveConfig({ requestStatus: 'not_found', lastError: 'request_not_found' });
      } else {
        await saveConfig({ lastError: `check_${r.status}` });
      }
      await refreshBadge();
      return j;
    }
    if (j.status === 'approved' && j.clientToken) {
      await saveConfig({
        clientToken: j.clientToken,
        clientId: j.clientId,
        requestStatus: 'approved',
        approvedAt: j.decidedAt,
        // Keep requestToken for audit; main loop will ignore it once clientToken is set.
        lastError: null,
      });
      await chrome.alarms.clear(REQUEST_CHECK_ALARM);
      await scheduleAlarms();
      pollLoop().catch(() => {});
      heartbeatOnce().catch(() => {});
    } else if (j.status === 'denied') {
      await saveConfig({ requestStatus: 'denied' });
    } else if (j.status === 'expired') {
      await saveConfig({ requestStatus: 'expired' });
      await chrome.alarms.clear(REQUEST_CHECK_ALARM);
    } else {
      await saveConfig({ requestStatus: 'pending', lastError: null });
    }
    await refreshBadge();
    return j;
  } catch (e) {
    await saveConfig({ lastError: e.message || 'check_fail' });
    await refreshBadge();
    return null;
  }
}

async function unregisterClient() {
  const cfg = await getConfig();
  if (cfg && cfg.clientToken) {
    try {
      await apiAuthFetch('/api/client/me', { method: 'DELETE' });
    } catch { /* ignore */ }
  }
  await clearConfig();
  await chrome.storage.local.remove('pendingCleanups');
  await chrome.alarms.clear(HEARTBEAT_ALARM);
  await chrome.alarms.clear(POLL_ALARM);
  await chrome.alarms.clear(REQUEST_CHECK_ALARM);
  await chrome.alarms.clear(CLEANUP_ALARM);
  await refreshBadge();
}

async function setPaused(paused) {
  await saveConfig({ paused: !!paused });
  await refreshBadge();
  await heartbeatOnce();
}

async function heartbeatOnce() {
  const cfg = await getConfig();
  if (!cfg || !cfg.clientToken) return;
  const state = await readCostcoState();
  try {
    const r = await apiAuthFetch('/api/client/heartbeat', {
      method: 'POST',
      body: JSON.stringify({
        signedIn: state.signedIn,
        paused: !!cfg.paused,
        name: state.name,
        email: state.email,
        tier: state.tier,
      }),
      timeout: 10000,
    });
    if (r.ok) {
      await saveConfig({ lastHeartbeatAt: Date.now(), lastHeartbeatOk: true, lastError: null });
    } else {
      await saveConfig({ lastHeartbeatAt: Date.now(), lastHeartbeatOk: false, lastError: `hb_${r.status}` });
    }
  } catch (e) {
    await saveConfig({ lastHeartbeatAt: Date.now(), lastHeartbeatOk: false, lastError: e.message || 'hb_fail' });
  }
  await refreshBadge();
}

async function reportDelivery({ deliveryId, status, error, items }) {
  try {
    const body = { deliveryId, status };
    if (error) body.error = String(error).slice(0, 500);
    if (Array.isArray(items) && items.length) body.items = items;
    const r = await apiAuthFetch('/api/client/report', {
      method: 'POST',
      body: JSON.stringify(body),
      timeout: 15000,
    });
    return r.ok;
  } catch (e) {
    console.warn('[remote] report failed', deliveryId, e.message || e);
    return false;
  }
}

async function dispatchCommand(c) {
  const deliveryId = c.deliveryId;
  if (!deliveryId || !c.payload) {
    await reportDelivery({ deliveryId, status: 'failed', error: 'malformed_command' });
    return;
  }
  const cfg = await getConfig();
  if (cfg && cfg.paused) {
    await reportDelivery({ deliveryId, status: 'paused' });
    return;
  }
  const tab = await findCostcoTab();
  if (!tab) {
    await reportDelivery({ deliveryId, status: 'failed', error: 'no_costco_tab' });
    return;
  }
  const ping = await sendToTab(tab.id, { cmd: 'ping' });
  if (!ping || !ping.hasToken || ping.expired) {
    await reportDelivery({ deliveryId, status: 'failed', error: 'auth_expired' });
    return;
  }
  await reportDelivery({ deliveryId, status: 'running' });

  const resp = await sendToTab(tab.id, {
    cmd: 'addEntriesBatch',
    listName: c.payload.listName,
    items: Array.isArray(c.payload.items) ? c.payload.items : [],
    decoySkus: Array.isArray(c.decoySkus) ? c.decoySkus : [],
    quantity: c.payload.quantity || 1,
    perItemDelayMs: [1500, 5000],
  });

  if (!resp || !resp.ok) {
    await reportDelivery({
      deliveryId,
      status: 'failed',
      error: (resp && resp.error) || 'no_response_from_tab',
    });
    return;
  }
  const items = Array.isArray(resp.results) ? resp.results : [];
  const anyFailed = items.some((it) => it.status === 'failed');
  await reportDelivery({
    deliveryId,
    status: anyFailed && items.every((it) => it.status === 'failed') ? 'failed' : 'done',
    items,
  });

  const decoysToClean = items
    .filter((it) => it.isDecoy && it.status === 'success' && it.lineItemId)
    .map((it) => ({ itemNumber: String(it.itemNumber), lineItemId: String(it.lineItemId) }));
  if (decoysToClean.length && resp.listId) {
    await enqueueCleanup({
      deliveryId,
      listId: String(resp.listId),
      items: decoysToClean,
    });
  }
}

async function enqueueCleanup({ deliveryId, listId, items }) {
  const { pendingCleanups } = await chrome.storage.local.get('pendingCleanups');
  const list = Array.isArray(pendingCleanups) ? pendingCleanups : [];
  if (list.find((c) => c.deliveryId === deliveryId)) return;
  const delay = Math.floor(CLEANUP_DELAY_MIN_MS + Math.random() * (CLEANUP_DELAY_MAX_MS - CLEANUP_DELAY_MIN_MS));
  list.push({
    deliveryId,
    listId,
    items,
    runAfter: Date.now() + delay,
    attempts: 0,
  });
  await chrome.storage.local.set({ pendingCleanups: list });
  await chrome.alarms.create(CLEANUP_ALARM, { delayInMinutes: 0.05, periodInMinutes: CLEANUP_PERIOD_MIN });
}

async function reportCleanup(deliveryId, results) {
  try {
    const r = await apiAuthFetch('/api/client/cleanup', {
      method: 'POST',
      body: JSON.stringify({ deliveryId, items: results }),
      timeout: 15000,
    });
    return r.ok;
  } catch (e) {
    console.warn('[remote] cleanup report failed', deliveryId, e.message || e);
    return false;
  }
}

async function processCleanupEntry(entry) {
  const cfg = await getConfig();
  if (!cfg || !cfg.clientToken) return { keep: true, backoff: true };
  if (cfg.paused) return { keep: true, backoff: true };

  const tab = await findCostcoTab();
  if (!tab) return { keep: true, backoff: true };
  const ping = await sendToTab(tab.id, { cmd: 'ping' });
  if (!ping || !ping.hasToken || ping.expired) return { keep: true, backoff: true };

  const resp = await sendToTab(tab.id, {
    cmd: 'cleanupDecoys',
    listId: entry.listId,
    items: entry.items,
    perItemDelayMs: [1000, 5000],
  });

  if (!resp || !resp.ok) {
    return { keep: true, backoff: true };
  }
  const results = Array.isArray(resp.results) ? resp.results : [];
  await reportCleanup(entry.deliveryId, results);
  const remaining = results
    .filter((r) => r.status === 'failed' && r.lineItemId)
    .map((r) => ({ itemNumber: String(r.itemNumber || ''), lineItemId: String(r.lineItemId) }));
  if (!remaining.length) return { keep: false };
  return { keep: true, backoff: true, items: remaining };
}

async function cleanupTick() {
  if (cleanupInFlight) return;
  cleanupInFlight = true;
  try {
    const { pendingCleanups } = await chrome.storage.local.get('pendingCleanups');
    let list = Array.isArray(pendingCleanups) ? pendingCleanups : [];
    if (!list.length) {
      await chrome.alarms.clear(CLEANUP_ALARM);
      return;
    }
    const now = Date.now();
    const due = list.filter((e) => e.runAfter <= now);
    if (!due.length) return;
    for (const entry of due) {
      const out = await processCleanupEntry(entry);
      if (!out.keep) {
        list = list.filter((e) => e.deliveryId !== entry.deliveryId);
        continue;
      }
      const nextAttempts = (entry.attempts || 0) + 1;
      if (nextAttempts >= CLEANUP_MAX_ATTEMPTS) {
        const failed = (out.items || entry.items).map((it) => ({
          itemNumber: String(it.itemNumber || ''),
          lineItemId: it.lineItemId ? String(it.lineItemId) : null,
          status: 'failed',
          error: 'max_attempts',
        }));
        await reportCleanup(entry.deliveryId, failed);
        list = list.filter((e) => e.deliveryId !== entry.deliveryId);
        continue;
      }
      const idx = list.findIndex((e) => e.deliveryId === entry.deliveryId);
      if (idx >= 0) {
        list[idx] = {
          ...entry,
          items: out.items || entry.items,
          attempts: nextAttempts,
          runAfter: now + CLEANUP_RETRY_BACKOFF_MS,
        };
      }
    }
    await chrome.storage.local.set({ pendingCleanups: list });
    if (!list.length) await chrome.alarms.clear(CLEANUP_ALARM);
  } finally {
    cleanupInFlight = false;
  }
}

async function pollLoop() {
  if (pollInFlight) return;
  const cfg = await getConfig();
  if (!cfg || !cfg.clientToken) return;
  if (cfg.paused) return;
  pollInFlight = true;
  try {
    const cursor = cfg.lastCursor || 0;
    const r = await apiAuthFetch(`/api/client/poll?cursor=${cursor}`, { method: 'GET', timeout: POLL_TIMEOUT_MS + 5000 });
    if (!r.ok) {
      await saveConfig({ lastError: `poll_${r.status}` });
      return;
    }
    const j = await r.json().catch(() => ({}));
    const newCursor = j.cursor || cursor;
    if (Array.isArray(j.commands) && j.commands.length) {
      for (const c of j.commands) {
        await dispatchCommand(c);
      }
    }
    await saveConfig({ lastCursor: newCursor, lastError: null });
  } catch (e) {
    if (e.name !== 'AbortError') {
      await saveConfig({ lastError: e.message || 'poll_fail' });
    }
  } finally {
    pollInFlight = false;
    await refreshBadge();
    setTimeout(() => { pollLoop().catch(() => {}); }, 250);
  }
}

async function scheduleAlarms() {
  await chrome.alarms.clear(HEARTBEAT_ALARM);
  await chrome.alarms.clear(POLL_ALARM);
  await chrome.alarms.create(HEARTBEAT_ALARM, { delayInMinutes: 0.05, periodInMinutes: HEARTBEAT_PERIOD_MIN });
  await chrome.alarms.create(POLL_ALARM, { delayInMinutes: 0.05, periodInMinutes: POLL_KEEPALIVE_MIN });
  const { pendingCleanups } = await chrome.storage.local.get('pendingCleanups');
  if (Array.isArray(pendingCleanups) && pendingCleanups.length) {
    await chrome.alarms.create(CLEANUP_ALARM, { delayInMinutes: 0.05, periodInMinutes: CLEANUP_PERIOD_MIN });
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  const cfg = await getConfig();
  if (cfg && cfg.clientToken) {
    await scheduleAlarms();
    pollLoop().catch(() => {});
  } else if (cfg && cfg.requestToken) {
    await chrome.alarms.create(REQUEST_CHECK_ALARM, {
      delayInMinutes: 0.05, periodInMinutes: REQUEST_CHECK_PERIOD_MIN,
    });
  }
  await refreshBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  const cfg = await getConfig();
  if (cfg && cfg.clientToken) {
    await scheduleAlarms();
    pollLoop().catch(() => {});
  } else if (cfg && cfg.requestToken) {
    await chrome.alarms.create(REQUEST_CHECK_ALARM, {
      delayInMinutes: 0.05, periodInMinutes: REQUEST_CHECK_PERIOD_MIN,
    });
  }
  await refreshBadge();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === HEARTBEAT_ALARM) {
    await heartbeatOnce();
  } else if (alarm.name === POLL_ALARM) {
    if (!pollInFlight) pollLoop().catch(() => {});
  } else if (alarm.name === REQUEST_CHECK_ALARM) {
    await checkRequestStatus();
  } else if (alarm.name === CLEANUP_ALARM) {
    cleanupTick().catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg && msg.cmd === 'remote.getStatus') {
        await purgeExpiredClientToken();
        const cfg = await getConfig();
        // Throttled re-validate: only fire if last heartbeat was > 10s ago, to avoid
        // a feedback loop with the popup's storage.onChanged listener.
        if (cfg && cfg.clientToken) {
          const last = cfg.lastHeartbeatAt || 0;
          if (Date.now() - last > 10000) {
            heartbeatOnce().catch(() => {});
          }
        }
        const tabState = await readCostcoState();
        sendResponse({
          ok: true,
          phase: phaseOf(cfg),
          serverUrl: SERVER_URL,
          clientUuid: cfg && cfg.clientUuid,
          // pending fields
          requestToken: cfg && cfg.requestToken,
          requestExpiresAt: cfg && cfg.requestExpiresAt,
          requestStatus: cfg && cfg.requestStatus,
          // registered fields
          paused: !!(cfg && cfg.paused),
          consentedAt: cfg && cfg.consentedAt,
          lastHeartbeatAt: cfg && cfg.lastHeartbeatAt,
          lastHeartbeatOk: !!(cfg && cfg.lastHeartbeatOk),
          lastError: cfg && cfg.lastError,
          clientTokenExpiresAt: cfg && cfg.clientToken ? decodeJwtExp(cfg.clientToken) : null,
          // costco state
          signedInOnCostco: tabState.signedIn,
          hasCostcoTab: tabState.hasTab,
          scrapedName: tabState.name,
          scrapedEmail: tabState.email,
          scrapedTier: tabState.tier,
        });
      } else if (msg && msg.cmd === 'remote.createRequest') {
        const r = await createRegistrationRequest(msg);
        sendResponse(r);
      } else if (msg && msg.cmd === 'remote.cancelRequest') {
        await cancelRegistrationRequest();
        sendResponse({ ok: true });
      } else if (msg && msg.cmd === 'remote.checkNow') {
        const j = await checkRequestStatus();
        sendResponse({ ok: true, result: j });
      } else if (msg && msg.cmd === 'remote.unregister') {
        await unregisterClient();
        sendResponse({ ok: true });
      } else if (msg && msg.cmd === 'remote.setPaused') {
        await setPaused(!!msg.paused);
        sendResponse({ ok: true });
      } else if (msg && msg.cmd === 'remote.heartbeatNow') {
        await heartbeatOnce();
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: 'unknown_cmd' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  })();
  return true;
});

// On SW wake-up, kick off whichever loop matches our phase.
(async () => {
  await purgeExpiredClientToken();
  const cfg = await getConfig();
  if (cfg && cfg.clientToken) {
    await scheduleAlarms();
    pollLoop().catch(() => {});
  } else if (cfg && cfg.requestToken) {
    await chrome.alarms.create(REQUEST_CHECK_ALARM, {
      delayInMinutes: 0.05, periodInMinutes: REQUEST_CHECK_PERIOD_MIN,
    });
  }
  await refreshBadge();
})();
