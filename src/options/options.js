async function load() {
  const d = await chrome.storage.local.get(['geminiApiKey','geminiChatModel','geminiParseModel','geminiModel','actualServerUrl','actualPassword','actualBudgetId','defaultCurrency','httpApiUrl','httpApiKey']);
  if (d.geminiApiKey) { document.getElementById('geminiKey').value = d.geminiApiKey; document.getElementById('geminiStatus').textContent = 'Connected'; document.getElementById('geminiStatus').className = 'badge badge-green'; }
  // Support legacy single-model setting for migration
  if (d.geminiChatModel || d.geminiModel) document.getElementById('geminiChatModel').value = d.geminiChatModel || d.geminiModel;
  if (d.geminiParseModel || d.geminiModel) document.getElementById('geminiParseModel').value = d.geminiParseModel || d.geminiModel;
  if (d.actualServerUrl) document.getElementById('actualUrl').value = d.actualServerUrl;
  if (d.actualPassword) { document.getElementById('actualPassword').value = d.actualPassword; document.getElementById('actualStatus').textContent = 'Connected'; document.getElementById('actualStatus').className = 'badge badge-green'; }
  if (d.httpApiUrl) document.getElementById('httpApiUrl').value = d.httpApiUrl;
  if (d.httpApiKey) { document.getElementById('httpApiKey').value = d.httpApiKey; document.getElementById('httpApiStatus').textContent = 'Configured'; document.getElementById('httpApiStatus').className = 'badge badge-green'; }
  if (d.defaultCurrency) document.getElementById('defaultCurrency').value = d.defaultCurrency;
}

document.getElementById('testGemini').onclick = async () => {
  const k = document.getElementById('geminiKey').value;
  if (!k) return alert('Enter key first.');
  const r = await chrome.runtime.sendMessage({ type: 'VALIDATE_GEMINI_KEY', payload: { apiKey: k } });
  alert(r.valid ? '✓ Valid!' : '✗ Invalid key.');
};

document.getElementById('saveGemini').onclick = async () => {
  await chrome.storage.local.set({
    geminiApiKey: document.getElementById('geminiKey').value,
    geminiChatModel: document.getElementById('geminiChatModel').value,
    geminiParseModel: document.getElementById('geminiParseModel').value,
  });
  document.getElementById('geminiStatus').textContent = 'Connected';
  document.getElementById('geminiStatus').className = 'badge badge-green';
  alert('Saved!');
};

document.getElementById('testActual').onclick = async () => {
  const u = document.getElementById('actualUrl').value.replace(/\/$/, '');
  const p = document.getElementById('actualPassword').value;
  if (!u || !p) return alert('Enter URL and password.');
  const r = await chrome.runtime.sendMessage({ type: 'TEST_CONNECTION', payload: { serverUrl: u, password: p } });
  if (r.success) {
    const s = document.getElementById('budgetSelect');
    s.disabled = false;
    s.innerHTML = '<option value="">Select...</option>';
    r.budgets.forEach(b => {
      const o = document.createElement('option');
      o.value = b.groupId;
      o.textContent = b.name || b.fileName || b.groupId;
      s.appendChild(o);
    });
    alert('✓ Connected!');
  } else {
    alert('✗ ' + r.error);
  }
};

document.getElementById('saveActual').onclick = async () => {
  await chrome.storage.local.set({
    actualServerUrl: document.getElementById('actualUrl').value.replace(/\/$/, ''),
    actualPassword: document.getElementById('actualPassword').value,
    actualBudgetId: document.getElementById('budgetSelect').value || null,
    httpApiUrl: document.getElementById('httpApiUrl').value.replace(/\/$/, ''),
    httpApiKey: document.getElementById('httpApiKey').value,
  });
  document.getElementById('actualStatus').textContent = 'Connected';
  document.getElementById('actualStatus').className = 'badge badge-green';
  if (document.getElementById('httpApiUrl').value && document.getElementById('httpApiKey').value) {
    document.getElementById('httpApiStatus').textContent = 'Configured';
    document.getElementById('httpApiStatus').className = 'badge badge-green';
  }
  alert('Saved!');
};

document.getElementById('testHttpApi').onclick = async () => {
  const url = document.getElementById('httpApiUrl').value.replace(/\/$/, '');
  const key = document.getElementById('httpApiKey').value;
  const budgetId = document.getElementById('budgetSelect').value;
  if (!url || !key) return alert('Enter HTTP API URL and API Key first.');
  if (!budgetId) return alert('Select a budget first by testing the sync server connection above.');
  try {
    const res = await fetch(`${url}/v1/budgets/${budgetId}/accounts`, {
      headers: { 'x-api-key': key },
    });
    if (res.ok) {
      const data = await res.json();
      const count = data.data ? data.data.length : 0;
      alert(`✓ HTTP API connected! Found ${count} account(s).`);
      document.getElementById('httpApiStatus').textContent = 'Connected';
      document.getElementById('httpApiStatus').className = 'badge badge-green';
    } else {
      alert(`✗ HTTP API returned ${res.status}`);
    }
  } catch (err) {
    alert(`✗ ${err.message}`);
  }
};

document.getElementById('savePrefs').onclick = async () => {
  await chrome.storage.local.set({ defaultCurrency: document.getElementById('defaultCurrency').value });
  alert('Saved!');
};

load();
