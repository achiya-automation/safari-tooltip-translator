// Live caption translation.
//
// Scope note — verified on Safari 26 / WebKit before writing this:
//   Transcribing a page's AUDIO is not possible from a Safari extension.
//   HTMLMediaElement.captureStream() does not exist in WebKit; routing a media
//   element through AudioContext.createMediaElementSource() yields pure silence
//   for any cross-origin resource (measured peak 0.00000 on a playing YouTube
//   video, vs 0.12878 for same-origin media); Safari has no tabCapture, and
//   getDisplayMedia gives video only. SpeechRecognition exists but is
//   microphone-only and takes no MediaStream.
//
// So this translates captions that ALREADY EXIST, which covers the real cases:
//   1. YouTube          — drive its own caption translator (zero latency).
//   2. TextTrack cues   — any <track>/HLS/DASH/video.js player. The whole cue
//                         list is translated up front, so playback never waits.
//   3. On-screen text   — Netflix, Meet, Teams, Zoom, Udemy and friends paint
//                         captions into the DOM; watch that node and translate.
(function () {
  'use strict';

  function boot() {
    const MTT = window.MTT;
    if (!MTT) return;
    const { CONFIG, translate, translateMany, notify, isMostlyTargetLang, isRTL } = MTT;

    let captionsOn = false;
    let overlay = null;
    const attached = new WeakSet();

    browser.storage.local.get('captions').then(d => {
      if (d.captions === true) enable();
    }).catch(() => {});

    // ── Overlay ─────────────────────────────────────────────────────────────

    function ensureOverlay() {
      if (overlay && overlay.isConnected) return overlay;
      overlay = document.createElement('div');
      overlay.className = 'mtt-cap';
      overlay.setAttribute('aria-live', 'polite');
      document.body.appendChild(overlay);
      return overlay;
    }

    function showCaption(text) {
      const o = ensureOverlay();
      if (!text) { o.classList.remove('v'); return; }
      o.textContent = text;
      o.setAttribute('dir', isRTL(text) ? 'rtl' : 'ltr');
      o.classList.add('v');
      positionOverlay();
    }

    // Sit just above the player when there is one, otherwise near the viewport
    // bottom — so the translation does not cover the source subtitles.
    function positionOverlay() {
      if (!overlay) return;
      const v = biggestVideo();
      if (v) {
        const r = v.getBoundingClientRect();
        if (r.width > 100 && r.height > 60) {
          overlay.style.left = (r.left + r.width / 2) + 'px';
          overlay.style.bottom = Math.max(12, window.innerHeight - r.bottom + r.height * 0.14) + 'px';
          overlay.style.maxWidth = Math.min(r.width * 0.9, 900) + 'px';
          return;
        }
      }
      overlay.style.left = '50%';
      overlay.style.bottom = '10%';
      overlay.style.maxWidth = 'min(900px, 90vw)';
    }

    function biggestVideo() {
      let best = null, area = 0;
      for (const v of document.querySelectorAll('video')) {
        const r = v.getBoundingClientRect();
        const a = r.width * r.height;
        if (a > area) { area = a; best = v; }
      }
      return best;
    }

    // ── 1. YouTube: use its own translator ──────────────────────────────────
    // Injected into page context because the player API lives on the page object.
    // Guarded: a strict CSP will refuse the inline script, which is harmless —
    // the TextTrack and DOM paths below still run.

    function injectYouTube() {
      if (!location.hostname.includes('youtube.com')) return;
      if (document.getElementById('mtt-yt-sub')) return;
      try {
        const s = document.createElement('script');
        s.id = 'mtt-yt-sub';
        s.textContent = `(function(){
          var T = ${JSON.stringify(CONFIG.targetLang)};
          function apply(){
            var p = document.getElementById('movie_player');
            if (!p || !p.getOption || !p.setOption) return;
            try { if (!p.isSubtitlesOn()) return; } catch(e) { return; }
            var track = null;
            try { track = p.getOption('captions','track'); } catch(e) {}
            if (!track || !track.languageCode) return;
            if (track.languageCode === T) return;
            if (track.translationLanguage && track.translationLanguage.languageCode === T) return;
            try {
              p.setOption('captions','track',{
                languageCode: track.languageCode,
                translationLanguage: { languageCode: T }
              });
            } catch(e) {}
          }
          setInterval(apply, 3000);
          window.addEventListener('yt-navigate-finish', function(){ setTimeout(apply, 3000); });
        })();`;
        (document.head || document.documentElement).appendChild(s);
      } catch (_) {}
    }

    // ── 2. TextTrack cues ───────────────────────────────────────────────────
    // Translate the entire cue list once, then swap text on cuechange. Waiting
    // per-cue would put a visible gap on every line.

    const cueMap = new WeakMap();   // TextTrack → Map(cueText → translation)

    async function primeTrack(track) {
      const cues = track.cues;
      if (!cues || !cues.length) return;
      const texts = [];
      const seen = new Set();
      for (const cue of cues) {
        const t = (cue.text || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        if (!t || seen.has(t) || isMostlyTargetLang(t)) continue;
        seen.add(t);
        texts.push(t);
      }
      if (!texts.length) return;

      notify(`🔄 מתרגם ${texts.length} שורות כתוביות…`, 3000);
      const results = await translateMany(texts, CONFIG.sourceLang, CONFIG.targetLang);
      const map = cueMap.get(track) || new Map();
      texts.forEach((t, i) => {
        if (results[i] && results[i].translated) map.set(t, results[i].translated);
      });
      cueMap.set(track, map);
      notify(`✅ כתוביות מתורגמות (${map.size} שורות)`);
    }

    function watchTrack(track) {
      if (attached.has(track)) return;
      attached.add(track);
      // 'hidden' keeps cues flowing without the browser painting them, so the
      // original subtitles do not sit on top of ours.
      if (track.mode === 'disabled') return;

      const onCueChange = async () => {
        if (!captionsOn) return;
        const active = track.activeCues;
        if (!active || !active.length) { showCaption(''); return; }
        const raw = Array.from(active)
          .map(c => (c.text || '').replace(/<[^>]+>/g, '').trim())
          .join(' ').replace(/\s+/g, ' ').trim();
        if (!raw) { showCaption(''); return; }
        if (isMostlyTargetLang(raw)) { showCaption(raw); return; }

        const map = cueMap.get(track);
        if (map && map.has(raw)) { showCaption(map.get(raw)); return; }
        const r = await translate(raw, CONFIG.sourceLang, CONFIG.targetLang);
        if (r && r.translated) {
          if (map) map.set(raw, r.translated);
          showCaption(r.translated);
        }
      };

      track.addEventListener('cuechange', onCueChange);
      primeTrack(track);
    }

    function scanTracks() {
      for (const v of document.querySelectorAll('video, audio')) {
        const tracks = v.textTracks;
        if (!tracks) continue;
        for (const t of tracks) {
          if (t.kind === 'subtitles' || t.kind === 'captions') watchTrack(t);
        }
        if (!v.__mttTrackWatch) {
          v.__mttTrackWatch = true;
          tracks.addEventListener('addtrack', e => {
            if (e.track && (e.track.kind === 'subtitles' || e.track.kind === 'captions')) {
              setTimeout(() => watchTrack(e.track), 300);
            }
          });
        }
      }
    }

    // ── 3. Captions painted into the DOM ────────────────────────────────────

    const DOM_CAPTION_SELECTORS = [
      '.player-timedtext',                             // Netflix
      '[data-purpose="captions-cue-text"]',            // Udemy
      '.vjs-text-track-display',                       // video.js
      '.shaka-text-container',                         // Shaka Player
      '.ytp-caption-window-container',                 // YouTube (fallback)
      '[jsname="tgaKEf"]',                             // Google Meet
      '.ui-provider [data-tid="closed-caption-text"]', // Teams
      '.closed-caption-text',
      '#live-transcript-subtitle',                     // Zoom web
      '[class*="captionText"]', '[class*="caption-text"]'
    ];

    let domObserver = null;
    let lastDomText = '';

    function watchDomCaptions() {
      if (domObserver) return;
      domObserver = new MutationObserver(() => {
        if (!captionsOn) return;
        clearTimeout(watchDomCaptions._t);
        watchDomCaptions._t = setTimeout(readDomCaptions, 120);
      });
      const root = document.body;
      if (root) domObserver.observe(root, { childList: true, subtree: true, characterData: true });
    }

    async function readDomCaptions() {
      let node = null;
      for (const sel of DOM_CAPTION_SELECTORS) {
        try { node = document.querySelector(sel); } catch (_) { continue; }
        if (node && (node.innerText || '').trim()) break;
        node = null;
      }
      if (!node) return;
      const raw = (node.innerText || '').replace(/\s+/g, ' ').trim();
      if (!raw || raw === lastDomText) return;
      lastDomText = raw;
      if (isMostlyTargetLang(raw)) return;
      const r = await translate(raw, CONFIG.sourceLang, CONFIG.targetLang);
      if (r && r.translated && raw === lastDomText) showCaption(r.translated);
    }

    // ── Wiring ──────────────────────────────────────────────────────────────

    function enable() {
      if (captionsOn) return;
      captionsOn = true;
      browser.storage.local.set({ captions: true });
      ensureOverlay();          // build it now, not on the first cue — avoids a
                                // layout hitch mid-playback
      injectYouTube();
      scanTracks();
      watchDomCaptions();
      window.addEventListener('resize', positionOverlay, { passive: true });
      scanTimer = setInterval(scanTracks, 4000);
      const hasMedia = document.querySelector('video, audio');
      notify(hasMedia ? '🎬 כתוביות מתורגמות פעילות' : '🎬 כתוביות פעילות — אין מדיה בעמוד', 2600);
    }

    function disable() {
      captionsOn = false;
      browser.storage.local.set({ captions: false });
      clearInterval(scanTimer);
      showCaption('');
      notify('כתוביות מתורגמות כבויות');
    }

    let scanTimer = null;

    window.addEventListener('keydown', e => {
      if (!CONFIG.enabled) return;
      // Alt+K — captions on/off.
      if (e.altKey && (e.key === 'k' || e.key === '˚')) {
        e.preventDefault();
        captionsOn ? disable() : enable();
      }
    }, true);

    browser.runtime.onMessage.addListener(msg => {
      if (msg.type === 'command' && msg.command === 'captions') {
        captionsOn ? disable() : enable();
      }
    });

    window.MTT.captions = { enable, disable, isOn: () => captionsOn };
  }

  if (window.MTT) boot();
  else document.addEventListener('mtt-ready', boot, { once: true });
})();
