// Selective in-page translation: pick paragraphs, get the Hebrew rendered right
// under the original, keep the rest of the page untouched.
//
// The interaction follows what the established bilingual translators do
// (Immersive Translate, DeepL): hold a modifier and click a paragraph to translate
// just that one, or switch into a picking mode where every text block highlights
// on hover and one click translates it.
(function () {
  'use strict';

  function boot() {
    const MTT = window.MTT;
    if (!MTT) return;
    const { CONFIG, translateMany, notify, isMostlyTargetLang, isRTL, isOurs } = MTT;

    const MARK = 'mttTranslated';      // dataset flag on an already-handled block
    const translated = new Set();      // blocks currently showing a translation
    let pickMode = false;
    let hovered = null;

    // ── Which element counts as "a paragraph" ────────────────────────────────
    // Walk up from the pointer to the nearest block-level box that owns real text.
    // Stopping at the first block-level ancestor picks up the <span> wrapper's
    // parent <p>; requiring direct text keeps us off pure layout wrappers.

    const SKIP_TAGS = new Set(['HTML', 'BODY', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'HEAD',
      'IMG', 'VIDEO', 'CANVAS', 'SVG', 'INPUT', 'TEXTAREA', 'SELECT', 'IFRAME']);
    const MAX_BLOCK_CHARS = 5000;

    function hasDirectText(el) {
      for (const n of el.childNodes) {
        if (n.nodeType === 3 && n.textContent.trim().length >= 2) return true;
      }
      return false;
    }

    function isBlockLevel(el) {
      const d = getComputedStyle(el).display;
      return d !== 'inline' && d !== 'contents' && d !== 'none';
    }

    function findBlock(el) {
      let cur = el, firstBlock = null, depth = 0;
      while (cur && cur !== document.body && depth < 12) {
        if (!SKIP_TAGS.has(cur.tagName) && !isOurs(cur) && !cur.isContentEditable && isBlockLevel(cur)) {
          const text = (cur.innerText || '').trim();
          if (text.length >= 2 && text.length <= MAX_BLOCK_CHARS) {
            if (!firstBlock) firstBlock = cur;
            if (hasDirectText(cur)) return cur;
          }
        }
        cur = cur.parentElement;
        depth++;
      }
      return firstBlock;
    }

    function blockText(el) {
      // Read the original only — never re-translate our own output.
      const clone = el.cloneNode(true);
      clone.querySelectorAll('.mtt-tr').forEach(n => n.remove());
      return (clone.innerText || '').replace(/\s+/g, ' ').trim();
    }

    // ── Rendering ────────────────────────────────────────────────────────────
    // Appended inside the block rather than after it: a sibling <div> would break
    // out of an <li> or <td> and wreck the list or table it belongs to.

    function renderInto(el, text) {
      let node = el.querySelector(':scope > .mtt-tr');
      if (!node) {
        node = document.createElement('div');
        node.className = 'mtt-tr';
        el.appendChild(node);
      }
      // Set direction on every render — the placeholder node from renderPending()
      // has none, and reusing it would leave an RTL translation laid out LTR.
      node.setAttribute('dir', isRTL(text) ? 'rtl' : 'ltr');
      node.textContent = text;
      node.dataset.style = CONFIG.blockStyle || 'under';
      el.dataset[MARK] = '1';
      translated.add(el);
    }

    function renderPending(el) {
      let node = el.querySelector(':scope > .mtt-tr');
      if (!node) {
        node = document.createElement('div');
        node.className = 'mtt-tr';
        el.appendChild(node);
      }
      node.textContent = '…';
      node.classList.add('pending');
    }

    function clearPending(el) {
      const node = el.querySelector(':scope > .mtt-tr');
      if (node) node.classList.remove('pending');
    }

    function removeFrom(el) {
      const node = el.querySelector(':scope > .mtt-tr');
      if (node) node.remove();
      delete el.dataset[MARK];
      translated.delete(el);
    }

    function clearAll() {
      for (const el of Array.from(translated)) removeFrom(el);
      document.querySelectorAll('.mtt-tr').forEach(n => n.remove());
      translated.clear();
      notify('🧹 התרגומים הוסרו');
    }

    // ── Translating a set of blocks in one round trip ────────────────────────

    async function translateBlocks(els) {
      const targets = [];
      for (const el of els) {
        if (!el || translated.has(el)) continue;
        const text = blockText(el);
        if (!text || text.length < 2 || isMostlyTargetLang(text)) continue;
        targets.push({ el, text });
      }
      if (!targets.length) return 0;

      targets.forEach(t => renderPending(t.el));
      const results = await translateMany(
        targets.map(t => t.text), CONFIG.sourceLang, CONFIG.targetLang);

      let done = 0;
      targets.forEach((t, i) => {
        const r = results[i];
        if (r && r.translated && r.translated !== t.text) {
          clearPending(t.el);
          renderInto(t.el, r.translated);
          done++;
        } else {
          removeFrom(t.el);
        }
      });
      return done;
    }

    function toggleBlock(el) {
      if (!el) return;
      if (translated.has(el)) { removeFrom(el); return; }
      translateBlocks([el]);
    }

    // ── Visible-area translation ─────────────────────────────────────────────
    // "Translate what I can see" — the middle ground between one paragraph and the
    // whole document, and the thing most people actually want on a long article.
    //
    // Naively sweeping every <p>/<li> in the viewport spends the whole batch on
    // site chrome: on a first pass over Wikipedia and BBC it returned "Donate",
    // "Log in", "Sport" — the nav bar — and never reached the article. So prefer
    // the semantic content root, and drop anything that reads as navigation.

    const CONTENT_ROOTS = ['article', 'main', '[role="main"]', '#content',
      '.post-content', '.entry-content', '.article-body', '#mw-content-text'];
    const CHROME_SEL = 'nav, header, footer, aside, form, ' +
      '[role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"], ' +
      '[role="search"], [role="menu"], [role="menubar"], [role="tablist"]';
    const BLOCK_SEL = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, dd, dt, figcaption, td, th, summary';

    function contentRoot() {
      for (const sel of CONTENT_ROOTS) {
        let el;
        try { el = document.querySelector(sel); } catch (_) { continue; }
        if (el && (el.innerText || '').trim().length > 200) return el;
      }
      return document.body;
    }

    // A short block that is essentially just links — a menu entry, a tag list, a
    // breadcrumb. Real prose has text outside its links.
    function looksLikeNavItem(el) {
      const text = (el.innerText || '').trim();
      if (text.length > 80) return false;
      const links = el.querySelectorAll('a');
      if (!links.length) return false;
      const linkText = Array.from(links).map(a => (a.innerText || '').trim()).join(' ');
      return linkText.length >= text.length * 0.8;
    }

    // Prefer the innermost block. querySelectorAll walks outside-in, so without
    // this an outer container always wins: on a table-built page like Hacker News
    // the whole story list came back as one <td>, translated as a single blob.
    // An element is a container — not a paragraph — when most of its text lives
    // inside block children rather than in the element itself. Counting children,
    // or looking for one dominant child, both misjudge: Hacker News spreads a
    // story list over ~30 small cells (no dominant child), while GitHub nests
    // blocks several deep around real text (many children, still a leaf).
    function isContainer(el, textLen) {
      const kids = el.querySelectorAll(BLOCK_SEL);
      if (!kids.length) return false;              // fast path: a genuine leaf
      let inChildren = 0;
      for (const c of kids) {
        // Count first-level block children only, or nesting double-counts.
        if (!c.parentElement || c.parentElement.closest(BLOCK_SEL) !== el) continue;
        inChildren += (c.innerText || '').trim().length;
      }
      return inChildren >= textLen * 0.7;
    }

    function collect(root, { strict }) {
      const vh = window.innerHeight, out = [], covered = new Set();
      let candidates;
      try { candidates = root.querySelectorAll(BLOCK_SEL); } catch (_) { return out; }
      for (const el of candidates) {
        if (isOurs(el) || el.dataset[MARK] || el.isContentEditable) continue;
        if (covered.has(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.bottom < 0 || r.top > vh || r.height === 0 || r.width === 0) continue;
        const text = (el.innerText || '').trim();
        if (text.length < 2 || text.length > MAX_BLOCK_CHARS) continue;
        if (isMostlyTargetLang(text)) continue;
        if (isContainer(el, text.length)) continue;
        if (strict) {
          if (el.closest(CHROME_SEL)) continue;
          if (looksLikeNavItem(el)) continue;
        }
        out.push(el);
        // Don't also translate this block's own sub-blocks.
        el.querySelectorAll(BLOCK_SEL).forEach(c => covered.add(c));
      }
      return out;
    }

    function visibleBlocks() {
      const root = contentRoot();
      let blocks = collect(root, { strict: true });
      // Pages without semantic structure (apps, dashboards) would come back empty
      // and read as "the extension does nothing" — fall back to the wide sweep.
      if (!blocks.length && root !== document.body) blocks = collect(document.body, { strict: true });
      if (!blocks.length) blocks = collect(document.body, { strict: false });
      return blocks;
    }

    async function translateVisible() {
      const blocks = visibleBlocks();
      if (!blocks.length) { notify('אין טקסט לתרגום במסך'); return; }
      notify(`🔄 מתרגם ${blocks.length} קטעים…`, 4000);
      const n = await translateBlocks(blocks);
      notify(n ? `✅ ${n} קטעים תורגמו` : '⚠️ התרגום לא הצליח');
    }

    // ── Picking mode ─────────────────────────────────────────────────────────

    function setHovered(el) {
      if (hovered === el) return;
      if (hovered) hovered.classList.remove('mtt-pick');
      hovered = el;
      if (hovered) hovered.classList.add('mtt-pick');
    }

    function setPickMode(on) {
      pickMode = on;
      document.documentElement.classList.toggle('mtt-picking', on);
      if (!on) setHovered(null);
      notify(on ? '🎯 בחירת קטעים — לחץ על קטע לתרגום, Esc ליציאה' : 'יצאת ממצב בחירה', on ? 3000 : 1600);
    }

    document.addEventListener('mousemove', e => {
      if (!pickMode || !CONFIG.enabled) return;
      if (isOurs(e.target)) return;
      setHovered(findBlock(e.target));
    }, { passive: true });

    // Alt+click on any paragraph, or a plain click while picking.
    document.addEventListener('click', e => {
      if (!CONFIG.enabled) return;
      if (isOurs(e.target)) return;

      if (pickMode) {
        const el = findBlock(e.target);
        if (!el) return;
        e.preventDefault();
        e.stopPropagation();
        toggleBlock(el);
        return;
      }
      if (e.altKey) {
        const el = findBlock(e.target);
        if (!el) return;
        e.preventDefault();
        e.stopPropagation();
        toggleBlock(el);
      }
    }, true);

    window.addEventListener('keydown', e => {
      if (!CONFIG.enabled) return;

      if (e.key === 'Escape' && pickMode) { setPickMode(false); return; }

      // macOS emits a different e.key when Option is held, so match both.
      const alt = e.altKey;
      if (!alt) return;

      if (e.key === 's' || e.key === 'ß') { e.preventDefault(); setPickMode(!pickMode); }
      if (e.key === 'a' || e.key === 'å') { e.preventDefault(); translateVisible(); }
      if (e.key === 'c' || e.key === 'ç') { e.preventDefault(); clearAll(); }
    }, true);

    browser.runtime.onMessage.addListener(msg => {
      if (msg.type !== 'command') return;
      if (msg.command === 'translateVisible') translateVisible();
      if (msg.command === 'clearAll') clearAll();
      if (msg.command === 'pickMode') setPickMode(!pickMode);
    });

    window.MTT.blocks = { translateVisible, clearAll, setPickMode, toggleBlock, findBlock };
  }

  if (window.MTT) boot();
  else document.addEventListener('mtt-ready', boot, { once: true });
})();
