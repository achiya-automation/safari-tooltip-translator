// Content script - runs in every page, handles hover detection + tooltip display
// Translation requests are sent to background.js via browser.runtime.sendMessage
(function () {
  'use strict';
  if (window.__mttActive) return;
  window.__mttActive = true;

  const CONFIG = {
    targetLang: 'he',
    sourceLang: 'auto',
    tooltipDelay: 500,
    enabled: true,
    wordMode: false   // F8: word mode vs sentence mode
  };

  // Load saved state
  browser.storage.local.get(['enabled', 'wordMode']).then(data => {
    if (data.enabled === false) CONFIG.enabled = false;
    if (data.wordMode === true) CONFIG.wordMode = true;
  }).catch(() => {});

  // Listen for toggle from popup
  browser.runtime.onMessage.addListener(msg => {
    if (msg.type === 'toggle') {
      CONFIG.enabled = msg.enabled;
      if (!CONFIG.enabled) hide();
    }
  });

  // ── Language helpers ────────────────────────────────────────────────────────

  function isMostlyHebrew(text) {
    const heb = (text.match(/[\u0590-\u05FF]/g) || []).length;
    const all = (text.match(/\p{L}/gu) || []).length;
    return all > 0 && heb / all >= 0.5;
  }

  function isMostlyTargetLang(text) {
    const heb = (text.match(/[\u0590-\u05FF]/g) || []).length;
    const arb = (text.match(/[\u0600-\u06FF]/g) || []).length;
    const all = (text.match(/\p{L}/gu) || []).length;
    if (all === 0) return true;
    return (heb + arb) / all >= 0.7;
  }

  function isMixed(text) {
    const heb = (text.match(/[\u0590-\u05FF]/g) || []).length;
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
    return /[\u0590-\u05FF\u0600-\u06FF]/.test(text);
  }

  // ── DOM helpers ──────────────────────────────────────────────────────────────

  function deepElementFromPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  function isBlockElement(el) {
    if (!el || el === document.body) return false;
    const tag = el.tagName;
    if (['P','LI','TD','TH','DD','DT','BLOCKQUOTE','H1','H2','H3','H4','H5','H6',
         'FIGCAPTION','SUMMARY','DIV','SECTION','ARTICLE'].includes(tag)) return true;
    const disp = window.getComputedStyle(el).display;
    return disp === 'block' || disp === 'list-item' || disp === 'table-cell';
  }

  // ── Text extraction ──────────────────────────────────────────────────────────

  // Extract word at caret position from a text node
  function getWordAtCaret(caretRange) {
    if (!caretRange || caretRange.startContainer.nodeType !== 3) return '';
    const text = caretRange.startContainer.textContent;
    const offset = caretRange.startOffset;
    let start = offset, end = offset;
    while (start > 0 && /[\p{L}\p{N}]/u.test(text[start - 1])) start--;
    while (end < text.length && /[\p{L}\p{N}]/u.test(text[end])) end++;
    return text.substring(start, end).trim();
  }

  // Main text getter: selection > word/sentence under cursor
  function getText(e) {
    // 1. User has text selected → use it
    const sel = window.getSelection();
    if (sel && sel.type === 'Range') {
      const t = sel.toString().trim();
      if (t.length > 1) return t.substring(0, 1000);
    }

    const el = deepElementFromPoint(e.clientX, e.clientY);
    if (!el) return '';
    const tag = el.tagName;
    if (['INPUT','TEXTAREA','SELECT'].includes(tag) || el.isContentEditable) return '';
    if (el.id === 'mtt-tip' || el.id === 'mtt-n') return '';
    if (el.closest && (el.closest('#mtt-tip') || el.closest('#mtt-n'))) return '';
    if (['SCRIPT','STYLE','NOSCRIPT','IMG','SVG','VIDEO','CANVAS','BR','HR'].includes(tag)) return '';

    const caretRange = document.caretRangeFromPoint?.(e.clientX, e.clientY);
    if (caretRange && caretRange.startContainer.nodeType === 3) {
      const textNode = caretRange.startContainer;

      // Verify cursor is actually over the text node
      const testRange = document.createRange();
      testRange.selectNodeContents(textNode);
      const rects = testRange.getClientRects();
      let onText = false;
      for (const rect of rects) {
        if (e.clientX >= rect.left - 2 && e.clientX <= rect.right + 2 &&
            e.clientY >= rect.top - 2 && e.clientY <= rect.bottom + 2) {
          onText = true; break;
        }
      }
      if (!onText) return '';

      // Word mode: return just the word under cursor
      if (CONFIG.wordMode) {
        return getWordAtCaret(caretRange);
      }

      // Sentence mode: walk up to block element
      let block = textNode.parentElement;
      if (block && ['A','BUTTON','LABEL'].includes(block.tagName)) {
        const t = (block.innerText || '').trim();
        if (t.length >= 2 && t.length <= 300) return t;
      }
      while (block && !isBlockElement(block)) block = block.parentElement;
      if (block && block !== document.body) {
        return (block.innerText || '').trim().substring(0, 1000);
      }
    }

    return '';
  }

  // ── Tooltip ─────────────────────────────────────────────────────────────────

  let tip, notif;
  function attachToDOM() {
    if (!document.body) { document.addEventListener('DOMContentLoaded', attachToDOM); return; }
    tip = document.createElement('div'); tip.id = 'mtt-tip';
    tip.setAttribute('role', 'tooltip');
    tip.setAttribute('data-v', '5');  // version marker
    document.body.appendChild(tip);
    notif = document.createElement('div'); notif.id = 'mtt-n';
    notif.setAttribute('aria-live', 'polite');
    document.body.appendChild(notif);
  }
  attachToDOM();

  function notify(msg) {
    if (!notif) return;
    notif.textContent = msg;
    notif.classList.add('v');
    setTimeout(() => notif.classList.remove('v'), 1500);
  }

  function show(trans, lang, isReverse) {
    if (!tip) return;
    while (tip.firstChild) tip.removeChild(tip.firstChild);

    const rtl = isRTL(trans);
    tip.style.direction = rtl ? 'rtl' : 'ltr';

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
    tip.style.left = '-9999px'; tip.style.top = '-9999px';
    tip.style.visibility = 'hidden';
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.visibility = '';

    const margin = 10, dist = 20;
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = mx + dist, top = my + dist;
    if (left + tw > vw - margin) left = mx - tw - dist;
    if (top + th > vh - margin) top = my - th - dist;
    left = Math.max(margin, left);
    top = Math.max(margin, top);
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';

    requestAnimationFrame(() => tip.classList.add('v'));
    vis = true;
  }

  function hide() {
    if (tip) tip.classList.remove('v');
    vis = false;
  }

  // ── Cache ────────────────────────────────────────────────────────────────────

  const cache = new Map();
  const CACHE_MAX = 200;
  function cacheSet(k, v) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(k, v);
  }
  function cacheGet(k) { return cache.get(k); }

  // ── Core translate function ──────────────────────────────────────────────────

  let timer = null, lastT = '', vis = false, mx = 0, my = 0, requestId = 0;

  function translateAndShow(text, isReverse) {
    if (isSkippable(text)) return;
    if (!isReverse && isMostlyTargetLang(text)) return;

    const tl = isReverse ? 'en' : CONFIG.targetLang;
    const sl = (!isReverse && isMixed(text)) ? 'en' : CONFIG.sourceLang;
    const ck = sl + '|' + tl + '|' + text;
    const cached = cacheGet(ck);

    if (cached) { show(cached.translated, cached.lang, isReverse); return; }
    if (!isReverse && text === lastT) return;
    lastT = text;

    const thisRequest = ++requestId;
    browser.runtime.sendMessage({ type: 'translate', text, sl, tl })
      .then(r => {
        if (requestId !== thisRequest) return;
        if (!r.translated) return;
        if (r.translated.toLowerCase() === text.toLowerCase()) return;
        if (isSameWords(r.translated, text)) return;
        cacheSet(ck, r);
        show(r.translated, r.lang, isReverse);
      }).catch(err => console.warn('MTT:', err));
  }

  // ── Hover translation ────────────────────────────────────────────────────────

  document.addEventListener('mousemove', e => {
    mx = e.clientX; my = e.clientY;
    if (!CONFIG.enabled) return;
    if (timer) { clearTimeout(timer); timer = null; }
    if (vis) hide();
    timer = setTimeout(() => {
      const text = getText(e);
      translateAndShow(text, false);
    }, CONFIG.tooltipDelay);
  }, { passive: true });

  // ── Selection translation (mouseup) ─────────────────────────────────────────

  document.addEventListener('mouseup', e => {
    if (!CONFIG.enabled) return;
    // Small delay to let selection finalize
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.type !== 'Range') return;
      const text = sel.toString().trim();
      if (text.length < 2) return;

      // Position tooltip near end of selection
      try {
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        mx = rect.right;
        my = rect.bottom;
      } catch (_) {}

      if (timer) { clearTimeout(timer); timer = null; }
      translateAndShow(text, false);
    }, 50);
  }, { passive: true });

  // ── Input translation (Option key) ───────────────────────────────────────────

  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  function getActiveInput() {
    let el = document.activeElement;
    if (!el) return null;

    // If focus is inside a same-origin iframe (Gmail compose, etc.),
    // reach into it to find the actual editable element
    if (el.tagName === 'IFRAME') {
      try {
        const iframeDoc = el.contentDocument || el.contentWindow?.document;
        if (iframeDoc) {
          let inner = iframeDoc.activeElement;
          if (inner && inner.tagName === 'BODY' && inner.isContentEditable) {
            return { el: inner, doc: iframeDoc, iframe: true };
          }
          if (inner && inner.isContentEditable) {
            return { el: inner, doc: iframeDoc, iframe: true };
          }
          // Try finding contentEditable in iframe body
          const editable = iframeDoc.querySelector('[contenteditable="true"]');
          if (editable) {
            return { el: editable, doc: iframeDoc, iframe: true };
          }
        }
      } catch (_) {
        // Cross-origin iframe — can't access
      }
      return null;
    }

    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.activeElement;
      if (!inner) break;
      el = inner;
    }
    if (el.tagName === 'TEXTAREA') return { el, doc: document, iframe: false };
    if (el.tagName === 'INPUT' && !['checkbox','radio','file','submit','button','reset','image'].includes(el.type || '')) return { el, doc: document, iframe: false };
    if (el.isContentEditable) return { el, doc: document, iframe: false };
    // Also check role=textbox and spellcheck elements (Discord, Slack, etc.)
    if (el.getAttribute && (el.getAttribute('role') === 'textbox' || el.getAttribute('spellcheck') === 'true')) return { el, doc: document, iframe: false };
    return null;
  }

  async function translateInput(target) {
    const el = target.el;
    const doc = target.doc;
    const win = doc.defaultView || window;

    // Refocus element in case Alt key caused blur
    el.focus();
    await delay(30);

    // Select all text in the field
    doc.execCommand('selectAll', false, null);
    await delay(50);

    // Get selected text
    let text = '';
    if (el.isContentEditable) {
      text = (win.getSelection() || '').toString().trim();
    } else {
      // For input/textarea, execCommand selectAll may not work — fallback to .value
      const selText = (win.getSelection() || '').toString().trim();
      text = selText || (el.value || '').trim();
      if (!selText && text) {
        el.select(); // ensure text is selected for replacement
        await delay(30);
      }
    }

    if (!text || text.length < 2) return;

    const isHeb = isMostlyHebrew(text);
    const tl = isHeb ? 'en' : CONFIG.targetLang;
    const thisRequest = ++requestId;

    browser.runtime.sendMessage({ type: 'translate', text, sl: 'auto', tl })
      .then(async r => {
        if (requestId !== thisRequest) return;
        if (!r.translated || r.translated.toLowerCase() === text.toLowerCase()) return;

        // Refocus and select all again before replacing
        el.focus();
        await delay(20);
        doc.execCommand('selectAll', false, null);
        await delay(20);

        // Try execCommand insertText first (works on most elements)
        const inserted = doc.execCommand('insertText', false, r.translated);
        if (!inserted) {
          // Fallback: synthetic paste event
          const dt = new DataTransfer();
          dt.setData('text/plain', r.translated);
          el.dispatchEvent(new ClipboardEvent('paste', {
            clipboardData: dt, data: r.translated,
            dataType: 'text/plain', bubbles: true, cancelable: true
          }));
        }

        // Final fallback for input/textarea: direct value set
        if (!el.isContentEditable && el.value === text) {
          const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, r.translated);
          else el.value = r.translated;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }).catch(err => console.warn('MTT:', err));
  }

  // ── Keyboard ─────────────────────────────────────────────────────────────────

  // Track key state: only trigger translate on Alt release without other keys
  let altDown = false, otherKeyDuringAlt = false;

  // Try ALL event targets: document (capture+bubble) and window (capture+bubble)
  function setupKeyListeners(target, phase) {
    target.addEventListener('keydown', e => {
      if (e.key === 'Alt') {
        altDown = true;
        otherKeyDuringAlt = false;
        return;
      }
      if (altDown) otherKeyDuringAlt = true;

      // Escape → hide tooltip
      if (e.key === 'Escape') { hide(); lastT = ''; }

      // Alt+T → toggle extension on/off
      if (e.altKey && (e.key === 't' || e.key === '†')) {
        otherKeyDuringAlt = true;
        CONFIG.enabled = !CONFIG.enabled;
        browser.storage.local.set({ enabled: CONFIG.enabled });
        notify(CONFIG.enabled ? '✅ Translator ON' : '❌ Translator OFF');
      }

      // F8 → toggle word/sentence mode
      if (e.key === 'F8') {
        CONFIG.wordMode = !CONFIG.wordMode;
        browser.storage.local.set({ wordMode: CONFIG.wordMode });
        notify(CONFIG.wordMode ? '📝 מצב מילה' : '📄 מצב משפט');
        hide(); lastT = '';
      }
    }, phase);

    target.addEventListener('keyup', e => {
      if (e.key === 'Alt') {
        if (altDown && !otherKeyDuringAlt && CONFIG.enabled) {
          const t = getActiveInput();
          if (t) translateInput(t);
        }
        altDown = false;
        otherKeyDuringAlt = false;
      }
    }, phase);
  }

  // Register on all possible targets and phases
  setupKeyListeners(document, true);   // capture
  setupKeyListeners(document, false);  // bubble
  setupKeyListeners(window, true);     // capture
  setupKeyListeners(window, false);    // bubble

  // Also: periodic check if Alt key was recently pressed via DOM flag
  // Injected script in page context that sets a DOM attribute
  const helperScript = document.createElement('script');
  helperScript.textContent = `
    document.addEventListener('keyup', function(e) {
      if (e.key === 'Alt' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        document.documentElement.setAttribute('data-mtt-alt', Date.now());
      }
    }, true);
  `;
  (document.head || document.documentElement).appendChild(helperScript);

  // Watch for the page-context Alt signal
  const altObserver = new MutationObserver(mutations => {
    for (const m of mutations) {
      if (m.attributeName === 'data-mtt-alt' && CONFIG.enabled) {
        const t = getActiveInput();
        if (t) translateInput(t);
        document.documentElement.removeAttribute('data-mtt-alt');
      }
    }
  });
  altObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mtt-alt'] });

  // ── Auto subtitle translation (YouTube) ─────────────────────────────────────
  // Uses YouTube's built-in auto-translate via Player API (injected into page context)
  // This is instant — YouTube renders Hebrew captions natively, no flicker

  function injectYouTubeAutoTranslate() {
    if (!location.hostname.includes('youtube.com')) return;
    if (document.getElementById('mtt-yt-sub')) return;

    const script = document.createElement('script');
    script.id = 'mtt-yt-sub';
    script.textContent = `
      (function() {
        var TARGET_LANG = 'he';
        var translating = false;

        function ensureHebrewCaptions() {
          var player = document.getElementById('movie_player');
          if (!player || !player.getOption || !player.setOption) return;

          // Only translate if user has CC on — don't force it
          try {
            if (!player.isSubtitlesOn()) return;
          } catch(e) { return; }

          // Check current track
          var track = null;
          try { track = player.getOption('captions', 'track'); } catch(e) {}
          if (!track || !track.languageCode) return;

          // Already Hebrew? Done
          if (track.translationLanguage && track.translationLanguage.languageCode === TARGET_LANG) return;
          if (track.languageCode === TARGET_LANG) return;

          // Apply translation
          try {
            player.setOption('captions', 'track', {
              languageCode: track.languageCode,
              translationLanguage: { languageCode: TARGET_LANG }
            });
          } catch(e) {}
        }

        setInterval(ensureHebrewCaptions, 3000);

        window.addEventListener('yt-navigate-finish', function() {
          setTimeout(ensureHebrewCaptions, 3000);
        });
      })();
    `;
    (document.head || document.documentElement).appendChild(script);
  }

  function startSubtitles() {
    if (location.hostname.includes('youtube.com')) {
      injectYouTubeAutoTranslate();
    }
  }

  startSubtitles();

})();
