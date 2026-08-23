// Popup: reflects stored settings and forwards commands to the active tab.

const $ = id => document.getElementById(id);

async function activeTab() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function send(msg) {
  const tab = await activeTab();
  if (!tab) return;
  try { await browser.tabs.sendMessage(tab.id, msg); } catch (_) {}
  window.close();
}

// Settings live in storage; the content scripts also read them there, so a change
// made here reaches every open tab without broadcasting to each one.
function setSetting(key, value) {
  browser.storage.local.set({ [key]: value });
  browser.tabs.query({}).then(tabs => {
    tabs.forEach(t => browser.tabs.sendMessage(t.id, { type: 'setting', key, value }).catch(() => {}));
  });
}

browser.storage.local.get(['enabled', 'hoverMode', 'targetLang', 'captions']).then(d => {
  $('enabled').checked = d.enabled !== false;
  const hover = d.hoverMode || 'always';
  document.querySelectorAll('[data-hover]').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.hover === hover));
  });
  $('lang').value = d.targetLang || 'he';
  $('captionsLabel').textContent = d.captions ? 'כתוביות מתורגמות — פעיל' : 'כתוביות מתורגמות';
});

$('enabled').addEventListener('change', e => {
  const enabled = e.target.checked;
  browser.storage.local.set({ enabled });
  browser.tabs.query({}).then(tabs => {
    tabs.forEach(t => browser.tabs.sendMessage(t.id, { type: 'toggle', enabled }).catch(() => {}));
  });
});

$('visible').addEventListener('click', () => send({ type: 'command', command: 'translateVisible' }));
$('pick').addEventListener('click', () => send({ type: 'command', command: 'pickMode' }));
$('clear').addEventListener('click', () => send({ type: 'command', command: 'clearAll' }));
$('captions').addEventListener('click', () => send({ type: 'command', command: 'captions' }));

document.querySelectorAll('[data-hover]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-hover]').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
    setSetting('hoverMode', btn.dataset.hover);
  });
});

$('lang').addEventListener('change', e => setSetting('targetLang', e.target.value));
