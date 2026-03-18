const toggle = document.getElementById('enabled');

// Load saved state
browser.storage.local.get('enabled').then(data => {
  toggle.checked = data.enabled !== false;
});

toggle.addEventListener('change', () => {
  browser.storage.local.set({ enabled: toggle.checked });
  // Notify all tabs
  browser.tabs.query({}).then(tabs => {
    tabs.forEach(tab => {
      browser.tabs.sendMessage(tab.id, { type: 'toggle', enabled: toggle.checked }).catch(() => {});
    });
  });
});
