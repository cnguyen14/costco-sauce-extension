const API = 'https://api.digital.costco.com';
const GDX_API = 'https://gdx-api.costco.com';
const CLIENT_ID = '4900eb1f-0c10-4bd9-99c3-c59e6c1ecebf';
const GDX_HEADERS_KEY = 'gdxHeaders';
const USER_CACHE_KEY = 'userInfoCache';
const NAME_CACHE_KEY = 'productNameCache';
const NAME_CACHE_TTL_MS = 7 * 24 * 3600 * 1000;

window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  const d = e.data;
  if (!d || d.source !== 'COSTCO_BULK_ADDER') return;
  if (d.type === 'gdxHeaders' && d.headers && d.headers['client-identifier']) {
    chrome.storage.local.set({ [GDX_HEADERS_KEY]: d.headers });
  }
});

function getAuthToken() {
  for (let i = 0; i < sessionStorage.length; i++) {
    const k = sessionStorage.key(i);
    if (k && k.startsWith('authToken_')) {
      const v = sessionStorage.getItem(k);
      if (v && v.length > 100) return v;
    }
  }
  return null;
}

function isExpired(jwt) {
  try {
    const payload = JSON.parse(atob(jwt.split('.')[1]));
    return !payload.exp || Date.now() / 1000 >= payload.exp;
  } catch { return true; }
}

function decodeJwtPayload(token) {
  try {
    const seg = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = seg + '='.repeat((4 - seg.length % 4) % 4);
    const bin = atob(padded);
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return JSON.parse(new TextDecoder('utf-8').decode(bytes));
  } catch { return null; }
}

function extractEmailFromJwt(token) {
  const p = decodeJwtPayload(token);
  if (!p) return '';
  const candidates = [p.email, p.preferred_username, p.upn];
  for (const c of candidates) {
    if (typeof c === 'string' && /@/.test(c)) return c;
  }
  return '';
}

function scrapeUserFromDom(root) {
  root = root || document;
  let name = '';
  let tier = '';

  const privateEls = root.querySelectorAll('[data-private="true"]');
  for (const el of privateEls) {
    const t = (el.textContent || '').trim();
    if (!name) {
      const m = t.match(/^Hello,\s*(.+?)!?\s*$/);
      if (m) name = m[1].trim();
    }
    if (!tier && /\bMember\b/i.test(t) && !/Member\s+Since/i.test(t)) {
      tier = t;
    }
  }

  return { name, tier };
}

function getStoredUserCache() {
  return new Promise((resolve) => {
    chrome.storage.local.get(USER_CACHE_KEY, (data) => {
      resolve((data && data[USER_CACHE_KEY]) || {});
    });
  });
}

function persistUserIfFound() {
  const dom = scrapeUserFromDom();
  if (!dom.name && !dom.tier) return false;
  const token = getAuthToken();
  const email = token ? extractEmailFromJwt(token) : '';
  const accountKey = email || 'unknown';
  chrome.storage.local.get(USER_CACHE_KEY, (data) => {
    const cache = (data && data[USER_CACHE_KEY]) || {};
    const prev = cache[accountKey] || {};
    if (prev.name === dom.name && prev.tier === dom.tier) return;
    cache[accountKey] = { name: dom.name, tier: dom.tier };
    chrome.storage.local.set({ [USER_CACHE_KEY]: cache });
  });
  return true;
}

function watchUserGreeting() {
  if (persistUserIfFound()) return;
  const obs = new MutationObserver(() => {
    if (persistUserIfFound()) obs.disconnect();
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => obs.disconnect(), 30000);
}

watchUserGreeting();

let iframeBootstrapPromise = null;

async function scrapeViaHiddenIframe() {
  if (iframeBootstrapPromise) return iframeBootstrapPromise;

  iframeBootstrapPromise = (async () => {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.setAttribute('tabindex', '-1');
    iframe.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1024px;height:768px;border:0;visibility:hidden;pointer-events:none;';
    iframe.src = `https://www.costco.com/myaccount/#/app/${CLIENT_ID}/ordersandpurchases`;
    document.documentElement.appendChild(iframe);

    let scraped = null;
    try {
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 200));
        let doc = null;
        try { doc = iframe.contentDocument; } catch { break; }
        if (!doc) continue;
        const dom = scrapeUserFromDom(doc);
        if (dom.name) { scraped = dom; break; }
      }
    } finally {
      iframe.remove();
    }

    if (scraped) {
      const tk = getAuthToken();
      const email = tk ? extractEmailFromJwt(tk) : '';
      const accountKey = email || 'unknown';
      const cache = await getStoredUserCache();
      cache[accountKey] = { name: scraped.name, tier: scraped.tier };
      chrome.storage.local.set({ [USER_CACHE_KEY]: cache });
    }
    return scraped;
  })();

  return iframeBootstrapPromise;
}

async function bootstrapUserSilently() {
  if (window !== window.top) return;
  if (location.hash.includes('ordersandpurchases')) return;

  const tk = getAuthToken();
  if (!tk || isExpired(tk)) return;

  const dom = scrapeUserFromDom();
  if (dom.name) { persistUserIfFound(); return; }

  const email = extractEmailFromJwt(tk);
  const accountKey = email || 'unknown';
  const cache = await getStoredUserCache();
  if (cache[accountKey] && cache[accountKey].name) return;

  await scrapeViaHiddenIframe();
}

bootstrapUserSilently();

function headers(token) {
  return {
    'authorization': token,
    'client-id': CLIENT_ID,
    'content-type': 'application/json',
    'accept': 'application/json'
  };
}

async function fetchLists(token) {
  const r = await fetch(`${API}/baskets/lists/`, { headers: headers(token) });
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`GET /baskets/lists/ → ${r.status}`);
  const data = await r.json();
  return Array.isArray(data) ? data : (data.items || data.lists || []);
}

async function fetchList(token, id) {
  const r = await fetch(`${API}/baskets/lists/${id}`, { headers: headers(token) });
  if (!r.ok) throw new Error(`GET /baskets/lists/${id} → ${r.status}`);
  return await r.json();
}

async function createList(token, title) {
  const r = await fetch(`${API}/baskets/lists/`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ description: '', title, type: 'WishList' })
  });
  if (!r.ok) throw new Error(`POST /baskets/lists/ → ${r.status}`);
  return await r.json();
}

async function renameList(token, id, title, description = '') {
  const r = await fetch(`${API}/baskets/lists/${id}`, {
    method: 'PATCH',
    headers: headers(token),
    body: JSON.stringify({ title, description })
  });
  if (!r.ok) throw new Error(`PATCH /baskets/lists/${id} → ${r.status}`);
  return await r.json();
}

async function deleteList(token, id) {
  const r = await fetch(`${API}/baskets/lists/${id}`, {
    method: 'DELETE',
    headers: headers(token)
  });
  if (!r.ok) throw new Error(`DELETE /baskets/lists/${id} → ${r.status}`);
  return await r.json().catch(() => ({ id }));
}

async function addEntry(token, listId, itemNumber, quantity = 1) {
  const r = await fetch(`${API}/baskets/lists/${listId}/entries`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({
      comment: '',
      itemNumber: String(itemNumber),
      quantity: String(quantity),
      type: 'CostcoItemListEntry'
    })
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Add ${itemNumber} → ${r.status} ${text.slice(0, 80)}`);
  }
  return await r.json();
}

async function deleteEntry(token, listId, lineItemId) {
  const r = await fetch(`${API}/baskets/lists/${listId}/entries/${lineItemId}`, {
    method: 'DELETE',
    headers: headers(token)
  });
  if (!r.ok) throw new Error(`DELETE entry ${lineItemId} → ${r.status}`);
  return await r.json().catch(() => ({ id: lineItemId }));
}

async function upcToItemNumber(upc) {
  const r = await fetch(
    `https://www.costco.com/CatalogSearch?dept=All&keyword=${encodeURIComponent(upc)}`,
    { credentials: 'include', redirect: 'follow' }
  );
  const isPdp = /\/p\/.+\/\d+(\?|$)/.test(r.url);
  if (!isPdp) return null;
  const html = await r.text();
  const m = html.match(/AddToListButtonAddToList_(\d+)/);
  return m ? m[1] : null;
}

function isUpc(s) {
  return /^\d{12,14}$/.test(s);
}

async function resolveItem(id) {
  const trimmed = id.trim();
  if (isUpc(trimmed)) {
    const sku = await upcToItemNumber(trimmed);
    return { itemNumber: sku, original: trimmed, resolvedFrom: 'UPC' };
  }
  return { itemNumber: trimmed, original: trimmed, resolvedFrom: 'SKU' };
}

async function getStoredGdxHeaders() {
  return new Promise((resolve) => {
    chrome.storage.local.get(GDX_HEADERS_KEY, (data) => {
      resolve(data && data[GDX_HEADERS_KEY] ? data[GDX_HEADERS_KEY] : null);
    });
  });
}

let gdxBootstrapPromise = null;
async function ensureGdxHeaders(timeoutMs = 12000) {
  const existing = await getStoredGdxHeaders();
  if (existing && existing['client-identifier']) return existing;
  if (gdxBootstrapPromise) return gdxBootstrapPromise;

  gdxBootstrapPromise = new Promise((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.setAttribute('tabindex', '-1');
    iframe.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1024px;height:768px;border:0;visibility:hidden;pointer-events:none;';
    iframe.src = 'https://www.costco.com/';
    document.documentElement.appendChild(iframe);

    const cleanup = (val) => {
      try { chrome.storage.onChanged.removeListener(onChange); } catch {}
      clearTimeout(timer);
      try { iframe.remove(); } catch {}
      gdxBootstrapPromise = null;
      resolve(val);
    };
    const onChange = (changes, area) => {
      if (area !== 'local') return;
      const c = changes[GDX_HEADERS_KEY];
      if (c && c.newValue && c.newValue['client-identifier']) cleanup(c.newValue);
    };
    chrome.storage.onChanged.addListener(onChange);
    const timer = setTimeout(() => cleanup(null), timeoutMs);
  });
  return gdxBootstrapPromise;
}

async function loadNameCache() {
  return new Promise((resolve) => {
    chrome.storage.local.get(NAME_CACHE_KEY, (data) => resolve(data[NAME_CACHE_KEY] || {}));
  });
}

async function saveNameCache(cache) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [NAME_CACHE_KEY]: cache }, resolve);
  });
}

async function fetchProductNameFromHtml(itemNumber) {
  try {
    const r = await fetch(
      `https://www.costco.com/CatalogSearch?dept=All&keyword=${encodeURIComponent(itemNumber)}`,
      { credentials: 'include', redirect: 'follow' }
    );
    if (!r.ok) return null;
    if (!/\/p\/.+\/\d+(\?|$)/.test(r.url)) return null;
    const html = await r.text();
    let m = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
    if (!m) m = html.match(/<title>([^<]+)<\/title>/i);
    if (!m) return null;
    const decoded = m[1]
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    return decoded.replace(/\s*\|\s*Costco\s*$/i, '').trim() || null;
  } catch { return null; }
}

async function getProductSummaries(itemNumbers) {
  const ids = Array.from(new Set((itemNumbers || []).map(String).filter(Boolean)));
  if (!ids.length) return {};

  const cache = await loadNameCache();
  const now = Date.now();
  const map = {};
  const missing = [];
  for (const id of ids) {
    const c = cache[id];
    if (c && (now - c.t) < NAME_CACHE_TTL_MS) {
      map[id] = { name: c.name, imageName: c.image || '' };
    } else {
      missing.push(id);
    }
  }
  if (!missing.length) return map;

  let stillMissing = missing.slice();
  const gdx = await ensureGdxHeaders();
  if (gdx && gdx['client-identifier']) {
    try {
      const url = `${GDX_API}/catalog/product/product-api/v1/products/summary/`
        + `?clientId=${encodeURIComponent(gdx['client-id'] || CLIENT_ID)}`
        + `&items=${missing.join(',')}`
        + `&whsNumber=847&locales=en-us`;
      const r = await fetch(url, { headers: {
        'accept': 'application/json',
        'client-identifier': gdx['client-identifier'],
        'client-id': gdx['client-id'] || CLIENT_ID,
        'costco-env': gdx['costco-env'] || 'prd',
      }});
      if (r.ok) {
        const data = await r.json();
        const arr = data.productData || data.products || [];
        const got = new Set();
        for (const p of arr) {
          const item = String(p.itemNumber || p.itemId || p.id || '');
          if (!item) continue;
          let name = '';
          if (p.descriptions && p.descriptions[0]) {
            const d0 = p.descriptions[0];
            name = (d0.object && d0.object.shortDescription) || d0.shortDescription || d0.name || '';
          }
          if (!name) name = p.shortDescription || p.name || p.title || '';
          const image = p.imageName || (p.images && p.images[0] && p.images[0].url) || '';
          if (name) {
            map[item] = { name, imageName: image };
            cache[item] = { name, image, t: now };
            got.add(item);
          }
        }
        stillMissing = missing.filter(id => !got.has(id));
      }
    } catch { /* fall through to HTML scrape */ }
  }

  if (stillMissing.length) {
    const results = await Promise.all(stillMissing.map(fetchProductNameFromHtml));
    stillMissing.forEach((id, idx) => {
      const name = results[idx];
      if (name) {
        map[id] = { name, imageName: '' };
        cache[id] = { name, image: '', t: now };
      }
    });
  }

  await saveNameCache(cache);
  return map;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.cmd === 'ping') {
        const token = getAuthToken();
        const gdx = await getStoredGdxHeaders();
        return sendResponse({
          ok: true,
          hasToken: !!token,
          expired: token ? isExpired(token) : null,
          hasGdxHeaders: !!(gdx && gdx['client-identifier'])
        });
      }

      const token = getAuthToken();
      if (!token) throw new Error('Auth token not found. Sign in to costco.com and refresh the page.');
      if (isExpired(token)) throw new Error('Token expired (~15 min lifetime). Refresh the costco.com tab to renew.');

      switch (msg.cmd) {
        case 'getLists': {
          const lists = await fetchLists(token);
          return sendResponse({ ok: true, lists });
        }
        case 'getList': {
          const list = await fetchList(token, msg.id);
          return sendResponse({ ok: true, list });
        }
        case 'createList': {
          const list = await createList(token, msg.title);
          return sendResponse({ ok: true, list });
        }
        case 'renameList': {
          const list = await renameList(token, msg.id, msg.title, msg.description || '');
          return sendResponse({ ok: true, list });
        }
        case 'deleteList': {
          const result = await deleteList(token, msg.id);
          return sendResponse({ ok: true, result });
        }
        case 'resolveItem': {
          const r = await resolveItem(msg.id);
          return sendResponse({ ok: !!r.itemNumber, ...r });
        }
        case 'addEntry': {
          const result = await addEntry(token, msg.listId, msg.itemNumber, msg.quantity || 1);
          return sendResponse({ ok: true, result });
        }
        case 'deleteEntry': {
          const result = await deleteEntry(token, msg.listId, msg.lineItemId);
          return sendResponse({ ok: true, result });
        }
        case 'addEntriesBatch': {
          const listName = String(msg.listName || '').trim();
          if (!listName) throw new Error('listName required');
          const items = Array.isArray(msg.items) ? msg.items : [];
          const decoys = Array.isArray(msg.decoySkus) ? msg.decoySkus : [];
          if (!items.length && !decoys.length) throw new Error('no items');
          const qty = Math.max(1, parseInt(msg.quantity, 10) || 1);
          const [dmin, dmax] = Array.isArray(msg.perItemDelayMs) && msg.perItemDelayMs.length === 2
            ? msg.perItemDelayMs
            : [3000, 15000];

          const lists = await fetchLists(token);
          let list = lists.find((l) => (l.title || '').trim().toLowerCase() === listName.toLowerCase());
          if (!list) list = await createList(token, listName);

          const all = [];
          for (const raw of items) {
            const r = await resolveItem(String(raw));
            all.push({ original: String(raw), itemNumber: r.itemNumber, isDecoy: false });
          }
          for (const sku of decoys) {
            all.push({ original: String(sku), itemNumber: String(sku), isDecoy: true });
          }
          for (let i = all.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [all[i], all[j]] = [all[j], all[i]];
          }

          const results = [];
          for (let idx = 0; idx < all.length; idx++) {
            const it = all[idx];
            if (idx > 0) {
              const delay = Math.floor(dmin + Math.random() * Math.max(0, dmax - dmin));
              await new Promise((r) => setTimeout(r, delay));
            }
            if (!it.itemNumber) {
              results.push({ itemNumber: it.original, isDecoy: it.isDecoy, status: 'failed', error: 'unresolved_upc' });
              continue;
            }
            try {
              const res = await addEntry(token, list.id, it.itemNumber, qty);
              const lineItemId =
                (res && (res.id || res.entryId || res.lineItemId
                  || (res.entry && (res.entry.id || res.entry.lineItemId)))) || null;
              results.push({
                itemNumber: String(it.itemNumber),
                isDecoy: it.isDecoy,
                status: 'success',
                lineItemId: lineItemId ? String(lineItemId) : null,
              });
            } catch (e) {
              results.push({
                itemNumber: String(it.itemNumber),
                isDecoy: it.isDecoy,
                status: 'failed',
                error: String((e && e.message) || e).slice(0, 200),
              });
            }
          }
          return sendResponse({ ok: true, listId: list.id, listTitle: list.title, results });
        }
        case 'cleanupDecoys': {
          const listId = msg.listId;
          const items = Array.isArray(msg.items) ? msg.items : [];
          if (!listId) throw new Error('listId required');
          const [dmin, dmax] = Array.isArray(msg.perItemDelayMs) && msg.perItemDelayMs.length === 2
            ? msg.perItemDelayMs
            : [1000, 5000];
          const results = [];
          for (let idx = 0; idx < items.length; idx++) {
            const it = items[idx];
            if (idx > 0) {
              const delay = Math.floor(dmin + Math.random() * Math.max(0, dmax - dmin));
              await new Promise((r) => setTimeout(r, delay));
            }
            if (!it.lineItemId) {
              results.push({
                itemNumber: String(it.itemNumber || ''),
                lineItemId: null,
                status: 'failed',
                error: 'missing_line_item_id',
              });
              continue;
            }
            try {
              await deleteEntry(token, listId, it.lineItemId);
              results.push({
                itemNumber: String(it.itemNumber || ''),
                lineItemId: String(it.lineItemId),
                status: 'cleaned',
              });
            } catch (e) {
              results.push({
                itemNumber: String(it.itemNumber || ''),
                lineItemId: String(it.lineItemId),
                status: 'failed',
                error: String((e && e.message) || e).slice(0, 200),
              });
            }
          }
          return sendResponse({ ok: true, results });
        }
        case 'getProductNames': {
          const map = await getProductSummaries(msg.itemNumbers);
          return sendResponse({ ok: true, products: map });
        }
        case 'getUser': {
          const email = extractEmailFromJwt(token);
          const accountKey = email || 'unknown';
          let { name, tier } = scrapeUserFromDom();
          if (name || tier) {
            persistUserIfFound();
          } else {
            const cache = await getStoredUserCache();
            const cached = cache[accountKey] || {};
            if (cached.name) {
              name = cached.name;
              tier = cached.tier || '';
            } else {
              const bootstrapped = await scrapeViaHiddenIframe();
              if (bootstrapped) {
                name = bootstrapped.name;
                tier = bootstrapped.tier;
              }
            }
          }
          return sendResponse({ ok: true, user: { name, tier, email } });
        }
        default:
          sendResponse({ ok: false, error: 'Unknown cmd: ' + msg.cmd });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;
});
