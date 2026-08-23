// Minimal browser.* shim so the content scripts can run in a plain page under
// Playwright/WebKit. Translation goes to the real endpoint via the same code path
// background.js uses, so the harness exercises the actual request shaping.
(function () {
  const listeners = { runtime: [] };
  const store = Object.create(null);

  window.__mttCalls = { translate: 0, translateBatch: 0, texts: [] };

  async function realTranslate(texts, sl, tl) {
    window.__mttCalls.texts.push(...texts);
    const url = `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=${sl}&tl=${tl}` +
      texts.map(t => '&q=' + encodeURIComponent(t)).join('');
    const res = await fetch(url);
    const body = await res.text();
    if (!res.ok || body.startsWith('<')) return { results: texts.map(() => ({translated:'',lang:''})), error: 'rate-limited' };
    const data = JSON.parse(body);
    return {
      results: texts.map((_, i) => {
        const row = data[i];
        if (typeof row === 'string') return { translated: row, lang: '' };
        if (Array.isArray(row)) return { translated: row[0] || '', lang: row[1] || '' };
        return { translated: '', lang: '' };
      }),
      error: null
    };
  }

  window.browser = {
    runtime: {
      onMessage: { addListener: fn => listeners.runtime.push(fn) },
      async sendMessage(msg) {
        if (msg.type === 'translate') {
          window.__mttCalls.translate++;
          const { results, error } = await realTranslate([msg.text], msg.sl, msg.tl);
          return { ...results[0], error };
        }
        if (msg.type === 'translateBatch') {
          window.__mttCalls.translateBatch++;
          return await realTranslate(msg.texts, msg.sl, msg.tl);
        }
        return {};
      }
    },
    storage: {
      local: {
        get: keys => Promise.resolve(
          (Array.isArray(keys) ? keys : [keys]).reduce((a, k) => (k in store && (a[k] = store[k]), a), {})),
        set: obj => { Object.assign(store, obj); return Promise.resolve(); }
      }
    },
    tabs: { query: () => Promise.resolve([]), sendMessage: () => Promise.resolve() }
  };

  // Let tests push a message into the content scripts, the way the popup would.
  window.__mttSend = msg => listeners.runtime.forEach(fn => fn(msg));
  window.__mttStore = store;
})();
