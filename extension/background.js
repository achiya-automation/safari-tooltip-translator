// Background service worker - handles translation requests
// This runs outside the page context, so it's NOT subject to page CSP

browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'fetchSubTrack') {
    fetch(request.url)
      .then(r => r.json())
      .then(data => sendResponse({ data }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (request.type === 'translate') {
    const { text, sl, tl } = request;
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&dt=ld&q=${encodeURIComponent(text)}`;

    fetch(url)
      .then(r => r.json())
      .then(data => {
        let translated = '';
        if (data && data[0]) {
          for (let i = 0; i < data[0].length; i++) {
            if (data[0][i] && data[0][i][0]) translated += data[0][i][0];
          }
        }
        sendResponse({
          translated: translated.trim(),
          lang: data && data[2] ? data[2] : ''
        });
      })
      .catch(err => {
        sendResponse({ error: err.message });
      });

    return true; // Keep message channel open for async response
  }
});
