document.getElementById('openSidePanel').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.sidePanel.open({ tabId: tab.id });
  window.close();
});

document.getElementById('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

// Check status
(async () => {
  const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });

  document.getElementById('popupGemini').textContent = status.geminiConfigured ? 'Connected' : 'Not set';
  document.getElementById('popupGemini').className = `badge ${status.geminiConfigured ? 'badge-green' : 'badge-red'}`;

  document.getElementById('popupActual').textContent = status.actualConfigured ? 'Connected' : 'Not set';
  document.getElementById('popupActual').className = `badge ${status.actualConfigured ? 'badge-green' : 'badge-red'}`;
})();
