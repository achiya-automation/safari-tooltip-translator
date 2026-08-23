// Core content script: settings, the translation call, text extraction, the hover
// tooltip, selection handling and keyboard. Exposes window.MTT for blocks.js and
// captions.js, which load after this file.
(function () {
  'use strict';
  if (window.__mttActive) return;
  window.__mttActive = true;

  const DEFAULTS = {
    targetLang: 'he',
    sourceLang: 'auto',
    tooltipDelay: 450,
    enabled: true,
    wordMode: false,      // F8: word under cursor vs. whole sentence
    hoverMode: 'always',  // 'always' | 'shift' | 'off' — when the tooltip may appear
    blockStyle: 'under'   // how block translations render (see blocks.js)
  };
  const CONFIG = Object.assign({}, DEFAULTS);

  const STORED = ['enabled', 'wordMode', 'hoverMode', 'targetLang', 'blockStyle'];
  browser.storage.local.get(STORED).then(data => {
    for (const k of STORED) if (data[k] !== undefined) CONFIG[k] = data[k];
  }).catch(() => {});

  // ── Language helpers ────────────────────────────────────────────────────────

  function isMostlyHebrew(text) {
    const heb = (text.match(/[֐-׿]/g) || []).length;
    const all = (text.match(/\p{L}/gu) || []).length;
    return all > 0 && heb / all >= 0.5;
  }

  // Already in the target language (or close enough) → nothing to translate.
  function isMostlyTargetLang(text) {
    const heb = (text.match(/[֐-׿]/g) || []).length;
    const arb = (text.match(/[؀-ۿ]/g) || []).length;
    const all = (text.match(/\p{L}/gu) || []).length;
    if (all === 0) return true;
    return (heb + arb) / all >= 0.7;
  }

  function isMixed(text) {
    const heb = (text.match(/[֐-׿]/g) || []).length;
    const latin = (text.match(/[a-zA-Z]/g) || []).length;
    const all = (text.match(/\p{L}/gu) || []).length;
    if (all === 0) return false;
    return heb > 0 && latin > 0 && heb / all < 0.7;
  }

  function isSameWords(a, b) {
    const normalize = s => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ' ').trim().split(/\s+/).sort().join(' ');
    return normalize(a) === normalize(b);
  }

  function isSkippable(text) {
    if (!text || text.length < 2) return true;
    if (/^[\d\s\p{P}\p{S}]+$/u.test(text)) return true;
    if (/^https?:\/\//.test(text)) return true;
    if (/^[\w.+-]+@[\w.-]+$/.test(text)) return true;
    return false;
  }

  function isRTL(text) {
    return /[֐-׿؀-ۿ]/.test(text);
  }

  // ── Translation gateway ─────────────────────────────────────────────────────

  const cache = new Map();
  const CACHE_MAX = 400;
  function cacheKey(text, sl, tl) { return sl + '|' + tl + '|' + text; }
  function cacheSet(k, v) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(k, v);
  }

  // A 429 used to surface as nothing at all — the tooltip simply never appeared
  // and the extension read as broken. Report it once, then stay quiet.
  let lastErrorNotice = 0;
  function reportError(err) {
    if (!err) return;
    const now = Date.now();
    if (now - lastErrorNotice < 20000) return;
    lastErrorNotice = now;
    notify(err === 'rate-limited'
      ? '⏳ גוגל חוסמת זמנית — כמה שניות והתרגום חוזר'
      : '⚠️ התרגום לא זמין כרגע');
  }

  // Translate one string. Returns {translated, lang} or null.
  async function translate(text, sl, tl) {
    const key = cacheKey(text, sl, tl);
    if (cache.has(key)) return cache.get(key);
    const r = await browser.runtime.sendMessage({ type: 'translate', text, sl, tl });
    if (!r || r.error) { reportError(r && r.error); if (!r || !r.translated) return null; }
    if (!r.translated) return null;
    const out = { translated: r.translated, lang: r.lang || '' };
    cacheSet(key, out);
    return out;
  }

  // Translate many strings in one round trip. Returns an array aligned with input;
  // entries may be null. Cached items never leave the page.
  async function translateMany(texts, sl, tl) {
    const out = new Array(texts.length);
    const pending = [], pendingIdx = [];
    texts.forEach((t, i) => {
      const key = cacheKey(t, sl, tl);
      if (cache.has(key)) out[i] = cache.get(key);
      else { pending.push(t); pendingIdx.push(i); }
    });
    if (!pending.length) return out;

    const r = await browser.runtime.sendMessage({ type: 'translateBatch', texts: pending, sl, tl });
    if (!r || r.error) reportError(r && r.error ? r.error : 'failed');
    if (r && r.results) {
      r.results.forEach((res, j) => {
        if (!res || !res.translated) return;
        const i = pendingIdx[j];
        const val = { translated: res.translated, lang: res.lang || '' };
        cacheSet(cacheKey(texts[i], sl, tl), val);
        out[i] = val;
      });
    }
    return out;
  }

  // ── DOM helpers ─────────────────────────────────────────────────────────────

  function deepElementFromPoint(x, y, doc) {
    const d = doc || document;
    let el = d.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  function isSvgElement(el) {
    return el && el.namespaceURI === 'http://www.w3.org/2000/svg';
  }

  function isOurs(el) {
    if (!el) return false;
    if (el.id && el.id.startsWith('mtt-')) return true;
    return !!(el.closest && el.closest('#mtt-tip, #mtt-n, #mtt-sel, .mtt-tr, .mtt-cap'));
  }

  // True only when the cursor visually sits on a direct (non-nested) text-node
  // child. Prevents grabbing a whole container's text just because it wraps some.
  function cursorOverDirectText(el, x, y, doc) {
    if (!el || !el.childNodes) return false;
    const d = doc || document;
    for (const node of el.childNodes) {
      if (node.nodeType !== 3) continue;
      if (!node.textContent.trim()) continue;
      try {
        const range = d.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          if (x >= rect.left - 2 && x <= rect.right + 2 &&
              y >= rect.top - 2 && y <= rect.bottom + 2) return true;
        }
      } catch (_) {}
    }
    return false;
  }

  function rectsAtPoint(node, x, y, doc) {
    try {
      const range = (doc || document).createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (x >= rect.left - 2 && x <= rect.right + 2 &&
            y >= rect.top - 2 && y <= rect.bottom + 2) return rect;
      }
    } catch (_) {}
    return null;
  }

  // ── Text extraction ─────────────────────────────────────────────────────────

  function getWordAtCaret(caretRange) {
    if (!caretRange || caretRange.startContainer.nodeType !== 3) return '';
    const text = caretRange.startContainer.textContent;
    const offset = caretRange.startOffset;
    let start = offset, end = offset;
    while (start > 0 && /[\p{L}\p{N}]/u.test(text[start - 1])) start--;
    while (end < text.length && /[\p{L}\p{N}]/u.test(text[end])) end++;
    return text.substring(start, end).trim();
  }

  // Returns {text, rect} — rect is the area the text occupies, so the tooltip can
  // stay put while the pointer moves inside it.
  function getTextAt(x, y, doc) {
    const d = doc || document;
    const el = deepElementFromPoint(x, y, d);
    if (!el) return null;
    const tag = el.tagName;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || el.isContentEditable) return null;
    if (isOurs(el)) return null;
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'IMG', 'SVG', 'VIDEO', 'CANVAS', 'BR', 'HR'].includes(tag)) return null;
    if (isSvgElement(el)) return null;

    const caretRange = d.caretRangeFromPoint ? d.caretRangeFromPoint(x, y) : null;
    if (caretRange && caretRange.startContainer.nodeType === 3) {
      const textNode = caretRange.startContainer;
      const rect = rectsAtPoint(textNode, x, y, d);
      if (!rect) return null;

      if (CONFIG.wordMode) {
        const w = getWordAtCaret(caretRange);
        return w ? { text: w, rect } : null;
      }

      // Sentence mode: keep the largest ancestor whose text still fits MAX. Stop
      // the moment one exceeds it, or we swallow sibling content from big wrappers
      // (the n8n canvas wraps every node label in one shared parent).
      const MAX = 350;
      let best = '', cur = textNode.parentElement, depth = 0, bestEl = null;
      while (cur && cur !== d.body && depth < 5) {
        const ct = (cur.innerText || '').trim();
        if (ct.length > MAX) break;
        if (ct.length >= 2) { best = ct; bestEl = cur; }
        cur = cur.parentElement;
        depth++;
      }
      if (best) return { text: best, rect: bestEl.getBoundingClientRect() };
      const nt = textNode.textContent.trim();
      return nt.length >= 2 ? { text: nt.substring(0, MAX), rect } : null;
    }

    // caretRangeFromPoint failed (Shadow DOM, user-select:none, chat widgets).
    if (CONFIG.wordMode) {
      if (cursorOverDirectText(el, x, y, d)) {
        const ft = (el.innerText || el.textContent || '').trim();
        if (ft.length >= 2 && ft.length <= 50) return { text: ft, rect: el.getBoundingClientRect() };
      }
      return null;
    }
    let candidate = el;
    for (let hops = 0; hops < 4 && candidate && candidate !== d.body; hops++) {
      if (cursorOverDirectText(candidate, x, y, d)) {
        const t = (candidate.innerText || candidate.textContent || '').trim();
        if (t.length >= 2) return { text: t.substring(0, 350), rect: candidate.getBoundingClientRect() };
      }
      candidate = candidate.parentElement ||
        (candidate.getRootNode instanceof Function && candidate.getRootNode() instanceof ShadowRoot
          ? candidate.getRootNode().host : null);
    }
    return null;
  }

  // ── Tooltip + toast ─────────────────────────────────────────────────────────

  let tip, notif;
  function attachToDOM() {
    if (!document.body) { document.addEventListener('DOMContentLoaded', attachToDOM); return; }
    tip = document.createElement('div');
    tip.id = 'mtt-tip';
    tip.setAttribute('role', 'tooltip');
    document.body.appendChild(tip);
    notif = document.createElement('div');
    notif.id = 'mtt-n';
    notif.setAttribute('aria-live', 'polite');
    document.body.appendChild(notif);
  }
  attachToDOM();

  function notify(msg, ms) {
    if (!notif) return;
    notif.textContent = msg;
    notif.classList.add('v');
    clearTimeout(notify._t);
    notify._t = setTimeout(() => notif.classList.remove('v'), ms || 1600);
  }

  let vis = false, mx = 0, my = 0;
  let holdRect = null;   // area the tooltip belongs to; leaving it hides the tip

  function show(trans, lang, isReverse, anchorRect) {
    if (!tip) return;
    // Keep the tooltip last in body so it paints above iframes.
    if (tip.nextSibling) document.body.appendChild(tip);
    if (notif && notif.nextSibling) document.body.appendChild(notif);
    while (tip.firstChild) tip.removeChild(tip.firstChild);

    tip.style.direction = isRTL(trans) ? 'rtl' : 'ltr';

    const td = document.createElement('div');
    td.className = 't';
    td.textContent = trans;
    tip.appendChild(td);

    if (lang) {
      const ld = document.createElement('div');
      ld.className = 'l';
      ld.textContent = lang + ' → ' + (isReverse ? 'en' : CONFIG.targetLang);
      tip.appendChild(ld);
    }

    tip.classList.remove('v');
    tip.style.left = '-9999px';
    tip.style.top = '-9999px';
    tip.style.visibility = 'hidden';
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.visibility = '';

    const margin = 10, dist = 18;
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = mx + dist, top = my + dist;
    if (left + tw > vw - margin) left = mx - tw - dist;
    if (top + th > vh - margin) top = my - th - dist;
    tip.style.left = Math.max(margin, left) + 'px';
    tip.style.top = Math.max(margin, top) + 'px';

    requestAnimationFrame(() => tip.classList.add('v'));
    vis = true;
    holdRect = anchorRect || null;
  }

  function hide() {
    if (tip) tip.classList.remove('v');
    vis = false;
    holdRect = null;
  }

  // Grace area: the text's own box, padded, so small pointer jitter — or moving
  // toward the tooltip — does not blank the translation the moment it appears.
  function insideHold(x, y) {
    if (!holdRect) return false;
    const pad = 28;
    return x >= holdRect.left - pad && x <= holdRect.right + pad &&
           y >= holdRect.top - pad && y <= holdRect.bottom + pad;
  }

  // ── Hover flow ──────────────────────────────────────────────────────────────

  let timer = null, lastT = '', requestId = 0;

  async function translateAndShow(text, isReverse, anchorRect) {
    if (isSkippable(text)) return;
    if (!isReverse && isMostlyTargetLang(text)) return;

    const tl = isReverse ? 'en' : CONFIG.targetLang;
    const sl = (!isReverse && isMixed(text)) ? 'en' : CONFIG.sourceLang;
    if (!isReverse && text === lastT && vis) return;
    lastT = text;

    const thisRequest = ++requestId;
    const r = await translate(text, sl, tl);
    if (requestId !== thisRequest || !r) return;
    if (r.translated.toLowerCase() === text.toLowerCase()) return;
    if (isSameWords(r.translated, text)) return;
    show(r.translated, r.lang, isReverse, anchorRect);
  }

  let shiftDown = false;
  function hoverAllowed(e) {
    if (!CONFIG.enabled) return false;
    if (CONFIG.hoverMode === 'off') return false;
    if (CONFIG.hoverMode === 'shift') return e.shiftKey || shiftDown;
    return true;
  }

  function onMove(e, doc, offsetX, offsetY) {
    mx = e.clientX + (offsetX || 0);
    my = e.clientY + (offsetY || 0);
    if (!hoverAllowed(e)) { if (vis) hide(); return; }
    // Only drop the tooltip once the pointer actually leaves the text it belongs
    // to. The old build hid on every single mousemove, so any nudge blanked it.
    if (vis && !insideHold(mx, my)) { hide(); lastT = ''; }
    if (timer) clearTimeout(timer);
    const cx = e.clientX, cy = e.clientY;
    timer = setTimeout(() => {
      const hit = getTextAt(cx, cy, doc);
      if (!hit) return;
      const rect = doc === document ? hit.rect : offsetRect(hit.rect, offsetX, offsetY);
      translateAndShow(hit.text, false, rect);
    }, CONFIG.tooltipDelay);
  }

  function offsetRect(r, dx, dy) {
    return { left: r.left + (dx || 0), right: r.right + (dx || 0),
             top: r.top + (dy || 0), bottom: r.bottom + (dy || 0) };
  }

  document.addEventListener('mousemove', e => onMove(e, document, 0, 0), { passive: true });

  // ── Selection → floating button (DeepL / Google Translate pattern) ───────────

  let selBtn = null;
  function ensureSelBtn() {
    if (selBtn || !document.body) return selBtn;
    selBtn = document.createElement('button');
    selBtn.id = 'mtt-sel';
    selBtn.type = 'button';
    selBtn.textContent = 'תרגם';
    selBtn.setAttribute('aria-label', 'תרגם את הטקסט המסומן');
    selBtn.addEventListener('mousedown', ev => ev.preventDefault());
    selBtn.addEventListener('click', ev => {
      ev.stopPropagation();
      const t = selBtn.dataset.text || '';
      hideSelBtn();
      if (t) translateAndShow(t, false, null);
    });
    document.body.appendChild(selBtn);
    return selBtn;
  }

  function hideSelBtn() { if (selBtn) selBtn.classList.remove('v'); }

  function showSelBtn(text, rect) {
    const b = ensureSelBtn();
    if (!b) return;
    if (b.nextSibling) document.body.appendChild(b);
    b.dataset.text = text;
    b.style.left = Math.min(window.innerWidth - 70, Math.max(8, rect.right - 20)) + 'px';
    b.style.top = Math.min(window.innerHeight - 40, rect.bottom + 6) + 'px';
    b.classList.add('v');
    mx = rect.right; my = rect.bottom;
  }

  function onMouseUp(e, doc, offX, offY) {
    if (!CONFIG.enabled) return;
    setTimeout(() => {
      const sel = (doc || document).getSelection();
      if (!sel || sel.type !== 'Range') { hideSelBtn(); return; }
      const text = sel.toString().trim();
      if (text.length < 2 || isMostlyTargetLang(text)) { hideSelBtn(); return; }
      let rect;
      try {
        const r = sel.getRangeAt(0).getBoundingClientRect();
        rect = offsetRect(r, offX, offY);
      } catch (_) { hideSelBtn(); return; }
      if (timer) { clearTimeout(timer); timer = null; }
      showSelBtn(text.substring(0, 4000), rect);
    }, 40);
  }

  document.addEventListener('mouseup', e => {
    if (isOurs(e.target)) return;
    onMouseUp(e, document, 0, 0);
  }, { passive: true });

  document.addEventListener('mousedown', e => {
    if (!isOurs(e.target)) hideSelBtn();
  }, { passive: true });

  document.addEventListener('scroll', () => { hideSelBtn(); if (vis) hide(); }, { passive: true, capture: true });

  // ── Input translation (tap Alt) ─────────────────────────────────────────────

  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  function getActiveInput() {
    let el = document.activeElement;
    if (!el) return null;

    // Focus inside a same-origin iframe (Gmail compose, rich editors).
    if (el.tagName === 'IFRAME') {
      try {
        const iframeDoc = el.contentDocument || (el.contentWindow && el.contentWindow.document);
        if (iframeDoc) {
          const inner = iframeDoc.activeElement;
          if (inner && inner.isContentEditable) return { el: inner, doc: iframeDoc };
          const editable = iframeDoc.querySelector('[contenteditable="true"]');
          if (editable) return { el: editable, doc: iframeDoc };
        }
      } catch (_) {}   // cross-origin
      return null;
    }

    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.activeElement;
      if (!inner) break;
      el = inner;
    }
    if (el.tagName === 'TEXTAREA') return { el, doc: document };
    if (el.tagName === 'INPUT' &&
        !['checkbox', 'radio', 'file', 'submit', 'button', 'reset', 'image'].includes(el.type || ''))
      return { el, doc: document };
    if (el.isContentEditable) return { el, doc: document };
    if (el.getAttribute &&
        (el.getAttribute('role') === 'textbox' || el.getAttribute('spellcheck') === 'true'))
      return { el, doc: document };
    return null;
  }

  async function translateInput(target) {
    const el = target.el, doc = target.doc;
    const win = doc.defaultView || window;

    el.focus();
    await delay(30);
    doc.execCommand('selectAll', false, null);
    await delay(50);

    let text = '';
    if (el.isContentEditable) {
      text = String(win.getSelection() || '').trim();
    } else {
      const selText = String(win.getSelection() || '').trim();
      text = selText || (el.value || '').trim();
      if (!selText && text) { el.select(); await delay(30); }
    }
    if (!text || text.length < 2) return;

    const tl = isMostlyHebrew(text) ? 'en' : CONFIG.targetLang;
    const thisRequest = ++requestId;
    const r = await translate(text, 'auto', tl);
    if (requestId !== thisRequest || !r) return;
    if (r.translated.toLowerCase() === text.toLowerCase()) return;

    el.focus();
    await delay(20);
    doc.execCommand('selectAll', false, null);
    await delay(20);

    const inserted = doc.execCommand('insertText', false, r.translated);
    if (!inserted) {
      const dt = new DataTransfer();
      dt.setData('text/plain', r.translated);
      el.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: dt, bubbles: true, cancelable: true
      }));
    }
    // Last resort for input/textarea: React-safe value set.
    if (!el.isContentEditable && el.value === text) {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, r.translated);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  // ── Keyboard ────────────────────────────────────────────────────────────────
  // Registered ONCE. The old build registered the same handlers on document and
  // window, in both capture and bubble — four calls per keypress, so every toggle
  // fired an even number of times and landed back where it started. That is why
  // Alt+T and F8 appeared dead.

  let altDown = false, otherKeyDuringAlt = false;

  window.addEventListener('keydown', e => {
    if (e.key === 'Shift') shiftDown = true;
    if (e.key === 'Alt') { altDown = true; otherKeyDuringAlt = false; return; }
    if (altDown) otherKeyDuringAlt = true;

    if (e.key === 'Escape') { hide(); hideSelBtn(); lastT = ''; }

    // Alt+T — on/off.  ('†' is what macOS sends for Option+T.)
    if (e.altKey && (e.key === 't' || e.key === '†')) {
      CONFIG.enabled = !CONFIG.enabled;
      browser.storage.local.set({ enabled: CONFIG.enabled });
      if (!CONFIG.enabled) { hide(); hideSelBtn(); }
      notify(CONFIG.enabled ? '✅ התרגום פעיל' : '❌ התרגום כבוי');
    }

    // Alt+H — cycle when the hover tooltip may appear.
    if (e.altKey && (e.key === 'h' || e.key === '˙')) {
      const order = ['always', 'shift', 'off'];
      CONFIG.hoverMode = order[(order.indexOf(CONFIG.hoverMode) + 1) % order.length];
      browser.storage.local.set({ hoverMode: CONFIG.hoverMode });
      hide();
      notify({ always: '🖱️ ריחוף: תמיד',
               shift: '⇧ ריחוף: רק עם Shift',
               off: '🚫 ריחוף: כבוי' }[CONFIG.hoverMode]);
    }

    // F8 — word vs. sentence.
    if (e.key === 'F8') {
      CONFIG.wordMode = !CONFIG.wordMode;
      browser.storage.local.set({ wordMode: CONFIG.wordMode });
      notify(CONFIG.wordMode ? '📝 מצב מילה' : '📄 מצב משפט');
      hide(); lastT = '';
    }
  }, true);

  window.addEventListener('keyup', e => {
    if (e.key === 'Shift') shiftDown = false;
    if (e.key === 'Alt') {
      // Alt tapped alone → translate the focused field in place.
      if (altDown && !otherKeyDuringAlt && CONFIG.enabled) {
        const t = getActiveInput();
        if (t) translateInput(t);
      }
      altDown = false;
      otherKeyDuringAlt = false;
    }
  }, true);

  browser.runtime.onMessage.addListener(msg => {
    if (msg.type === 'toggle') {
      CONFIG.enabled = msg.enabled;
      if (!CONFIG.enabled) { hide(); hideSelBtn(); }
    }
    if (msg.type === 'setting') {
      CONFIG[msg.key] = msg.value;
      if (msg.key === 'hoverMode') hide();
    }
  });

  // ── Same-origin iframes (chat widgets: Intercom, Drift, about:blank frames) ──
  // Those frames get no content script of their own, so drive them from here.

  function setupIframe(iframe) {
    let iDoc;
    try {
      iDoc = iframe.contentDocument;
      if (!iDoc || !iDoc.body || iDoc.__mttIframe) return;
      iDoc.__mttIframe = true;
    } catch (_) { return; }   // cross-origin

    const off = () => iframe.getBoundingClientRect();
    iDoc.addEventListener('mousemove', e => {
      const r = off();
      onMove(e, iDoc, r.left, r.top);
    }, { passive: true });
    iDoc.addEventListener('mouseup', e => {
      const r = off();
      onMouseUp(e, iDoc, r.left, r.top);
    }, { passive: true });
    iDoc.addEventListener('keyup', e => {
      if (e.key !== 'Alt' || !CONFIG.enabled) return;
      const t = getActiveInput();
      if (t) translateInput(t);
    }, true);

    if (!iframe.__mttLoad) {
      iframe.__mttLoad = true;
      iframe.addEventListener('load', () => {
        try {
          if (iframe.contentDocument) {
            delete iframe.contentDocument.__mttIframe;
            setTimeout(() => setupIframe(iframe), 400);
          }
        } catch (_) {}
      });
    }
  }

  // Touching contentDocument on a cross-origin frame logs a security error to the
  // page console even inside try/catch, which is pure noise on ad-heavy sites.
  // Check the URL first and only reach into frames that can actually be reached.
  function sameOriginFrame(f) {
    const src = f.getAttribute('src');
    if (!src || src === 'about:blank' || src.startsWith('javascript:')) return true;
    try { return new URL(src, location.href).origin === location.origin; }
    catch (_) { return false; }
  }

  function scanIframes() {
    for (const f of document.querySelectorAll('iframe')) {
      if (!sameOriginFrame(f)) continue;
      try { if (f.contentDocument && f.contentDocument.body) setupIframe(f); } catch (_) {}
    }
  }

  // The old observer watched every childList mutation in the subtree and queued a
  // full-document iframe scan for each one, with no debounce — on any live app
  // (Chatwoot, n8n, Facebook) that is thousands of scans a second. Only react when
  // an iframe actually appears, and coalesce.
  let scanQueued = false;
  const iframeObserver = new MutationObserver(records => {
    if (scanQueued) return;
    for (const rec of records) {
      for (const node of rec.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === 'IFRAME' || (node.querySelector && node.querySelector('iframe'))) {
          scanQueued = true;
          setTimeout(() => { scanQueued = false; scanIframes(); }, 700);
          return;
        }
      }
    }
  });
  if (document.documentElement) {
    iframeObserver.observe(document.documentElement, { childList: true, subtree: true });
  }
  setTimeout(scanIframes, 1200);
  setTimeout(scanIframes, 4000);

  // ── Shared surface for blocks.js / captions.js ───────────────────────────────

  window.MTT = {
    CONFIG, DEFAULTS,
    translate, translateMany,
    notify, isSkippable, isMostlyTargetLang, isRTL, isOurs,
    deepElementFromPoint,
    hideTooltip: hide
  };
  document.dispatchEvent(new CustomEvent('mtt-ready'));
})();
