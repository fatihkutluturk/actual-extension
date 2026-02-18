/**
 * Actual AI — Background Service Worker
 *
 * Handles extension lifecycle, message passing between
 * popup/sidepanel/options, and long-running tasks.
 */

// Open side panel when extension icon is clicked
chrome.sidePanel?.setOptions({ enabled: true });

chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id });
});

// Handle messages from popup, sidepanel, options
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch(err => {
    sendResponse({ error: err.message });
  });
  return true; // async response
});

async function handleMessage(message) {
  switch (message.type) {
    case 'GET_STATUS':
      return getExtensionStatus();

    case 'TEST_CONNECTION':
      return testActualConnection(message.payload);

    case 'VALIDATE_GEMINI_KEY':
      return validateGeminiKey(message.payload.apiKey);

    default:
      return { error: `Unknown message type: ${message.type}` };
  }
}

async function getExtensionStatus() {
  const result = await chrome.storage.local.get([
    'geminiApiKey',
    'actualServerUrl',
    'actualPassword',
    'actualBudgetId',
    'httpApiUrl',
    'httpApiKey',
  ]);

  return {
    geminiConfigured: !!result.geminiApiKey,
    actualConfigured: !!(result.httpApiUrl && result.httpApiKey && result.actualBudgetId),
    budgetSelected: !!result.actualBudgetId,
  };
}

async function testActualConnection({ serverUrl, password }) {
  try {
    const res = await fetch(`${serverUrl}/account/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });

    if (!res.ok) return { success: false, error: `Server returned ${res.status}` };

    const data = await res.json();
    const token = data.data?.token;
    if (!token) return { success: false, error: 'No token received' };

    // Fetch budget list
    const budgetsRes = await fetch(`${serverUrl}/sync/list-user-files`, {
      headers: { 'X-ACTUAL-TOKEN': token },
    });

    const budgetsData = await budgetsRes.json();
    return {
      success: true,
      budgets: budgetsData.data || [],
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function validateGeminiKey(apiKey) {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Respond with just "ok"' }] }],
        generationConfig: { maxOutputTokens: 5 },
      }),
    });
    return { valid: res.ok };
  } catch {
    return { valid: false };
  }
}

console.log('Actual AI service worker loaded');
