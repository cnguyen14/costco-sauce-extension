(() => {
  const TAG = 'COSTCO_BULK_ADDER';
  const GDX_HOST = 'gdx-api.costco.com';
  const WANTED = ['client-identifier', 'client-id', 'costco-env'];

  const post = (headers) => {
    if (!headers || !headers['client-identifier']) return;
    window.postMessage({ source: TAG, type: 'gdxHeaders', headers }, '*');
  };

  const collect = (headersInit) => {
    const out = {};
    if (!headersInit) return out;
    if (headersInit instanceof Headers) {
      for (const w of WANTED) {
        const v = headersInit.get(w);
        if (v) out[w] = v;
      }
      return out;
    }
    if (Array.isArray(headersInit)) {
      for (const [k, v] of headersInit) {
        const lk = String(k).toLowerCase();
        if (WANTED.includes(lk)) out[lk] = v;
      }
      return out;
    }
    if (typeof headersInit === 'object') {
      for (const k of Object.keys(headersInit)) {
        const lk = k.toLowerCase();
        if (WANTED.includes(lk)) out[lk] = headersInit[k];
      }
    }
    return out;
  };

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.includes(GDX_HOST)) {
        let h = {};
        if (init && init.headers) h = collect(init.headers);
        if ((!h['client-identifier']) && input instanceof Request) {
          for (const w of WANTED) {
            const v = input.headers.get(w);
            if (v) h[w] = v;
          }
        }
        post(h);
      }
    } catch (_) { /* ignore */ }
    return origFetch.apply(this, arguments);
  };

  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__costcoUrl = url;
    this.__costcoHdrs = {};
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      if (typeof name === 'string' && this.__costcoUrl && String(this.__costcoUrl).includes(GDX_HOST)) {
        const lk = name.toLowerCase();
        if (WANTED.includes(lk)) {
          this.__costcoHdrs[lk] = value;
          if (lk === 'client-identifier') post(this.__costcoHdrs);
        }
      }
    } catch (_) { /* ignore */ }
    return origSetHeader.apply(this, arguments);
  };
})();
