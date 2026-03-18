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
    enabled: true
  };

  const TARGET_CODES = ['he', 'iw'];

  function isMostlyTargetLang(text) {
    const heb = (text.match(/[\u0590-\u05FF]/g) || []).length;
    const arb = (text.match(/[\u0600-\u06FF]/g) || []).length;
    const all = (text.match(/\p{L}/gu) || []).length;
    if (all === 0) return true;
    return (heb + arb) / all > 0.5;
  }

  function isSkippable(text) {
    if (!text || text.length < 3) return true;
    if (/^[\d\s\p{P}\p{S}]+$/u.test(text)) return true;
    if (/^https?:\/\//.test(text)) return true;
    if (/^[\w.+-]+@[\w.-]+$/.test(text)) return true;
    return false;
  }

  // Create tooltip elements
  const tip = document.createElement('div'); tip.id = 'mtt-tip'; document.body.appendChild(tip);
  const notif = document.createElement('div'); notif.id = 'mtt-n'; document.body.appendChild(notif);

  function notify(msg) {
    notif.textContent = msg;
    notif.classList.add('v');
    setTimeout(() => notif.classList.remove('v'), 1500);
  }

  const cache = {};
  let timer = null, lastT = '', vis = false, mx = 0, my = 0;

  // Text extraction: selection > paragraph under cursor
  function getText(e) {
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length > 2) {
      return sel.toString().trim().substring(0, 1000);
    }

    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el) return '';
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return '';
    if (el.id === 'mtt-tip' || el.id === 'mtt-n') return '';
    if (el.closest && (el.closest('#mtt-tip') || el.closest('#mtt-n'))) return '';
    if (['SCRIPT','STYLE','NOSCRIPT','IMG','SVG','VIDEO','CANVAS','BR','HR'].includes(tag)) return '';

    // Try caretRangeFromPoint for precise text detection
    const range = document.caretRangeFromPoint?.(e.clientX, e.clientY);
    let textNode = null;

    if (range && range.startContainer && range.startContainer.nodeType === 3) {
      textNode = range.startContainer;
      // Verify cursor is on text bounding box
      const testRange = document.createRange();
      testRange.selectNodeContents(textNode);
      const rects = testRange.getClientRects();
      let onText = false;
      for (const rect of rects) {
        if (e.clientX >= rect.left - 3 && e.clientX <= rect.right + 3 &&
            e.clientY >= rect.top - 3 && e.clientY <= rect.bottom + 3) {
          onText = true; break;
        }
      }
      if (!onText) textNode = null;
    }

    // Fallback: if element itself has short text (links, buttons, spans)
    if (!textNode) {
      const directText = (el.innerText || el.textContent || '').trim();
      if (directText.length >= 2 && directText.length <= 500) {
        return directText;
      }
      return '';
    }

    // Find paragraph-level block
    let block = textNode.parentElement;
    const blockTags = ['P','LI','TD','TH','DD','DT','BLOCKQUOTE','H1','H2','H3','H4','H5','H6','FIGCAPTION','LABEL','SUMMARY','A','SPAN','BUTTON','STRONG','EM','B','I'];
    while (block && block !== document.body) {
      if (blockTags.includes(block.tagName)) break;
      const disp = window.getComputedStyle(block).display;
      if (disp === 'block' || disp === 'list-item' || disp === 'table-cell') break;
      block = block.parentElement;
    }
    if (!block || block === document.body) return '';

    // For inline elements (A, SPAN, etc.), go up to find the paragraph
    const inlineTags = ['A','SPAN','STRONG','EM','B','I','BUTTON'];
    if (inlineTags.includes(block.tagName)) {
      let parent = block.parentElement;
      const parentBlockTags = ['P','LI','TD','TH','DD','DT','BLOCKQUOTE','H1','H2','H3','H4','H5','H6','DIV'];
      while (parent && parent !== document.body) {
        if (parentBlockTags.includes(parent.tagName)) { block = parent; break; }
        const disp = window.getComputedStyle(parent).display;
        if (disp === 'block' || disp === 'list-item' || disp === 'table-cell') { block = parent; break; }
        parent = parent.parentElement;
      }
    }

    const text = (block.innerText || '').trim();
    return text.length > 1000 ? text.substring(0, 1000) : text;
  }

  // Translate via background script (bypasses CSP!)
  function tr(text) {
    return new Promise((resolve, reject) => {
      const ck = CONFIG.sourceLang + '|' + CONFIG.targetLang + '|' + text;
      if (cache[ck]) { resolve(cache[ck]); return; }

      browser.runtime.sendMessage({
        type: 'translate',
        text: text,
        sl: CONFIG.sourceLang,
        tl: CONFIG.targetLang
      }).then(result => {
        if (result.error) { reject(result.error); return; }
        cache[ck] = result;
        resolve(result);
      }).catch(reject);
    });
  }

  function show(trans, lang) {
    while (tip.firstChild) tip.removeChild(tip.firstChild);
    const td = document.createElement('div'); td.className = 't'; td.textContent = trans; tip.appendChild(td);
    if (lang) {
      const ld = document.createElement('div'); ld.className = 'l';
      ld.textContent = lang + ' → ' + CONFIG.targetLang;
      tip.appendChild(ld);
    }

    // Measure
    tip.style.cssText = '';
    tip.classList.remove('v');
    tip.style.left = '-9999px'; tip.style.top = '-9999px';
    tip.style.visibility = 'hidden';
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.visibility = '';

    const m = 10, vw = window.innerWidth, vh = window.innerHeight;
    let left = mx + m, top = my + m;
    if (left + tw > vw - m) left = mx - tw - m;
    if (top + th > vh - m) top = my - th - m;
    left = Math.max(m, left);
    top = Math.max(m, top);
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
    requestAnimationFrame(() => tip.classList.add('v'));
    vis = true;
  }

  function hide() { tip.classList.remove('v'); vis = false; }

  document.addEventListener('mousemove', e => {
    mx = e.clientX; my = e.clientY;
    if (!CONFIG.enabled) return;
    if (timer) { clearTimeout(timer); timer = null; }
    if (vis) hide();
    timer = setTimeout(() => {
      const text = getText(e);
      if (isSkippable(text)) return;
      if (isMostlyTargetLang(text)) return;
      const ck = CONFIG.sourceLang + '|' + CONFIG.targetLang + '|' + text;
      if (text === lastT && cache[ck]) { show(cache[ck].translated, cache[ck].lang); return; }
      lastT = text;
      tr(text).then(r => {
        if (!r.translated) return;
        if (TARGET_CODES.includes(r.lang)) return;
        if (r.translated.toLowerCase() === text.toLowerCase()) return;
        show(r.translated, r.lang);
      }).catch(err => console.warn('MTT:', err));
    }, CONFIG.tooltipDelay);
  }, { passive: true });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { hide(); lastT = ''; }
    if (e.altKey && e.key === 't') {
      CONFIG.enabled = !CONFIG.enabled;
      notify(CONFIG.enabled ? 'Translator ON' : 'Translator OFF');
    }
  });

  notify('Tooltip Translator ✓');
})();
