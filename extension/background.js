// Background service worker — the single translation gateway for the whole extension.
// Runs outside page context, so it is not subject to page CSP.
//
// Why clients5 and not translate.googleapis.com/gtx:
//   gtx rate-limits hard (429 → an HTML "Sorry..." page, not JSON) and it does not
//   accept multiple q= params. clients5/dict-chrome-ex survives bursts, returns
//   [[text, srcLang], ...] and batches up to ~100 strings / ~8000 chars per call.
//   gtx stays as a fallback only.

const ENDPOINTS = [
  {
    name: 'clients5',
    batch: true,
    url: (texts, sl, tl) =>
      `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=${sl}&tl=${tl}` +
      texts.map(t => '&q=' + encodeURIComponent(t)).join(''),
    // [["translated","src"], ...]  — or  ["translated", ...] when sl is explicit
    parse: (data, texts) => {
      if (!Array.isArray(data)) return null;
      return texts.map((_, i) => {
        const row = data[i];
        if (typeof row === 'string') return { translated: row, lang: '' };
        if (Array.isArray(row)) return { translated: row[0] || '', lang: row[1] || '' };
        return { translated: '', lang: '' };
      });
    }
  },
  {
    name: 'gtx',
    batch: false,
    url: (texts, sl, tl) =>
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=` +
      encodeURIComponent(texts[0]),
    parse: (data) => {
      if (!data || !data[0]) return null;
      let s = '';
      for (const seg of data[0]) if (seg && seg[0]) s += seg[0];
      return [{ translated: s.trim(), lang: data[2] || '' }];
    }
  }
];

// ── Request budget ───────────────────────────────────────────────────────────
// Google throttles by IP. The old build fired one request per hover tick and
// tripped 429 within a minute of normal browsing; every failure then surfaced as
// silence. A token bucket keeps us under the line, and a cooldown after a 429
// stops us from hammering a host that already said no.

const RATE = { tokens: 8, max: 8, refillMs: 700, last: Date.now() };
const cooldown = {};        // endpoint name → timestamp until which it is skipped
const MAX_CHARS = 7000;     // per request, below the observed ~8000 ceiling
const MAX_ITEMS = 80;

function takeToken() {
  const now = Date.now();
  const gained = Math.floor((now - RATE.last) / RATE.refillMs);
  if (gained > 0) {
    RATE.tokens = Math.min(RATE.max, RATE.tokens + gained);
    RATE.last = now;
  }
  if (RATE.tokens <= 0) return false;
  RATE.tokens--;
  return true;
}

function waitForToken() {
  return new Promise(resolve => {
    const tick = () => (takeToken() ? resolve() : setTimeout(tick, 150));
    tick();
  });
}

async function callEndpoint(ep, texts, sl, tl) {
  if (cooldown[ep.name] && Date.now() < cooldown[ep.name]) {
    throw new Error('cooldown');
  }
  const res = await fetch(ep.url(texts, sl, tl));
  if (res.status === 429 || res.status === 403) {
    cooldown[ep.name] = Date.now() + 60000;   // sit this one out for a minute
    const e = new Error('rate-limited');
    e.rateLimited = true;
    throw e;
  }
  if (!res.ok) throw new Error('http-' + res.status);
  // A throttled Google answers with an HTML page — .json() would throw an opaque
  // SyntaxError, so check the shape of the body ourselves.
  const body = await res.text();
  if (body.startsWith('<')) {
    cooldown[ep.name] = Date.now() + 60000;
    const e = new Error('rate-limited');
    e.rateLimited = true;
    throw e;
  }
  const parsed = ep.parse(JSON.parse(body), texts);
  if (!parsed) throw new Error('unparseable');
  return parsed;
}

// Split a list of strings into calls that respect both the char and item ceiling.
function chunk(texts) {
  const out = [];
  let cur = [], chars = 0;
  for (const t of texts) {
    const len = t.length + 8;
    if (cur.length && (chars + len > MAX_CHARS || cur.length >= MAX_ITEMS)) {
      out.push(cur); cur = []; chars = 0;
    }
    cur.push(t); chars += len;
  }
  if (cur.length) out.push(cur);
  return out;
}

async function translateBatch(texts, sl, tl) {
  const results = new Array(texts.length);
  let lastError = null;

  for (const ep of ENDPOINTS) {
    const groups = ep.batch ? chunk(texts) : texts.map(t => [t]);
    let offset = 0, allOk = true;

    for (const group of groups) {
      // Skip groups already filled by a previous endpoint attempt.
      const needed = group.some((_, i) => !results[offset + i]);
      if (!needed) { offset += group.length; continue; }
      try {
        await waitForToken();
        const got = await callEndpoint(ep, group, sl, tl);
        got.forEach((r, i) => { if (r && r.translated) results[offset + i] = r; });
      } catch (err) {
        lastError = err;
        allOk = false;
        if (err.rateLimited || err.message === 'cooldown') break;  // try next endpoint
      }
      offset += group.length;
    }
    if (allOk && results.every(Boolean)) break;
  }

  const missing = results.some(r => !r);
  return {
    results: results.map(r => r || { translated: '', lang: '' }),
    error: missing ? (lastError && lastError.rateLimited ? 'rate-limited' : 'failed') : null
  };
}

browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'fetchSubTrack') {
    fetch(request.url)
      .then(r => r.text())
      .then(text => sendResponse({ data: text }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  // Single string — kept for the hover tooltip path.
  if (request.type === 'translate') {
    translateBatch([request.text], request.sl, request.tl)
      .then(({ results, error }) => sendResponse({ ...results[0], error }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  // Many strings in one round trip — used by block translation and captions.
  if (request.type === 'translateBatch') {
    translateBatch(request.texts, request.sl, request.tl)
      .then(({ results, error }) => sendResponse({ results, error }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
});
