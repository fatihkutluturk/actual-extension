/**
 * Actual AI — Side Panel Controller
 *
 * Manages all UI interactions in the extension's side panel.
 */

import database from '../lib/database.js';
import gemini from '../lib/gemini.js';
import actualClient from '../lib/actual-client.js';
import pdfParser from '../lib/pdf-parser.js';
import pipeline from '../lib/pipeline.js';
import actionExecutor, { functionDeclarations } from '../lib/actions.js';

// ─── State ───
let categories = [];
let categoryGroups = [];
let accounts = [];
let currentStatementId = null;
let parsedTransactions = [];
let isProcessing = false;
let isNewBudget = false;
let chatHistory = [];
let pendingFunctionCall = null;
let uncategorizedTxs = [];
let categorizationResults = [];

const MAX_HISTORY_ENTRIES = 40;

function trimHistory() {
  if (chatHistory.length <= MAX_HISTORY_ENTRIES) return;
  chatHistory.splice(0, chatHistory.length - MAX_HISTORY_ENTRIES);
  while (chatHistory.length > 0 && chatHistory[0].role !== 'user') {
    chatHistory.shift();
  }
}

function resetChat() {
  chatHistory = [];
  pendingFunctionCall = null;
  const messages = document.getElementById('chatMessages');
  messages.innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'chat-empty';
  empty.id = 'chatEmpty';
  messages.appendChild(empty);
  renderChatEmpty();
}

// ─── Init ───
document.addEventListener('DOMContentLoaded', async () => {
  setupTabs();
  setupDropZone();
  setupEventListeners();
  await loadDefaultCurrency();
  await checkStatus();
});

// ─── Event Listeners ───
function setupEventListeners() {
  // Setup steps — open options page
  document.getElementById('setupGemini').addEventListener('click', () => openSettings());
  document.getElementById('setupActual').addEventListener('click', () => openSettings());

  // Gear icon in header — open options page
  document.getElementById('openSettingsBtn').addEventListener('click', () => openSettings());

  // Capture from tab — show confirm card first
  document.getElementById('captureTabBtn').addEventListener('click', () => showCaptureConfirm());
  document.getElementById('captureConfirmBtn').addEventListener('click', () => captureFromTab());
  document.getElementById('captureCancel').addEventListener('click', () => {
    document.getElementById('captureConfirmCard').classList.add('hidden');
  });
  document.getElementById('clearStartDateBtn').addEventListener('click', () => {
    document.getElementById('startDateInput').value = '';
  });

  // Review table controls
  document.getElementById('selectAllBtn').addEventListener('click', () => selectAllTx(true));
  document.getElementById('importBtn').addEventListener('click', () => importSelected());
  document.getElementById('selectAll').addEventListener('change', (e) => selectAllTx(e.target.checked));

  // Quick prompts — use event delegation on the chat messages container
  document.getElementById('chatMessages').addEventListener('click', (e) => {
    const btn = e.target.closest('.quick-prompt[data-question]');
    if (btn) askQuestion(btn.dataset.question);
  });

  // Chat
  document.getElementById('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
  });
  document.getElementById('chatSendBtn').addEventListener('click', () => sendChat());
  document.getElementById('newChatBtn').addEventListener('click', () => resetChat());

  // Auto-categorize
  document.getElementById('findUncatBtn').addEventListener('click', () => findAndCategorize());
  document.getElementById('catSelectAllBtn').addEventListener('click', () => catSelectAllTx(true));
  document.getElementById('catSelectAll').addEventListener('change', (e) => catSelectAllTx(e.target.checked));
  document.getElementById('applyCatBtn').addEventListener('click', () => applyCategorization());

  // Currency override toggle
  document.getElementById('changeCurrencyLink').addEventListener('click', (e) => {
    e.preventDefault();
    const override = document.getElementById('currencyOverride');
    override.classList.toggle('hidden');
  });
  document.getElementById('currencySelect').addEventListener('change', (e) => {
    document.getElementById('currencyLabel').textContent = e.target.value;
  });

  // Data management
  document.getElementById('exportMappingsBtn').addEventListener('click', () => exportMappings());
  document.getElementById('clearAllDataBtn').addEventListener('click', () => clearAllData());
}

// ─── Tab Navigation ───
function setupTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-page').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const page = document.querySelector(`[data-tab-page="${tab.dataset.tab}"]`);
      if (page) page.classList.add('active');
    });
  });
}

// ─── Status Check ───
async function checkStatus() {
  try {
    await gemini.init();
    await actualClient.init();

    const geminiOk = gemini.isConfigured();
    const actualOk = actualClient.isConfigured();

    // Update status dots
    const dot = document.getElementById('actualDot');
    const text = document.getElementById('actualStatusText');

    if (geminiOk && actualOk) {
      dot.className = 'status-dot connected';
      text.textContent = 'Connected';
      document.getElementById('onboarding').classList.add('hidden');
      document.getElementById('uploadSection').classList.remove('hidden');
      await loadAccounts();
      await loadCategories();
      await loadHistory();

      // Detect if budget is fresh/empty for onboarding
      const openAccounts = accounts.filter(a => !a.closed);
      isNewBudget = openAccounts.length === 0 || categories.length === 0;
      renderChatEmpty();
    } else {
      dot.className = 'status-dot disconnected';
      text.textContent = 'Setup needed';
      document.getElementById('onboarding').classList.remove('hidden');
      document.getElementById('uploadSection').classList.add('hidden');

      // Update setup steps
      if (geminiOk) document.getElementById('setupGemini').classList.add('done');
      if (actualOk) document.getElementById('setupActual').classList.add('done');
    }

  } catch (err) {
    console.error('Status check failed:', err);
  }
}

async function loadAccounts() {
  try {
    accounts = await actualClient.getAccounts();
    const select = document.getElementById('accountSelect');
    select.innerHTML = '<option value="">Select account...</option>';
    const catSelect = document.getElementById('catAccountSelect');
    catSelect.innerHTML = '<option value="all">All accounts</option>';
    for (const acct of accounts) {
      if (acct.closed) continue;
      const opt = document.createElement('option');
      opt.value = acct.id;
      opt.textContent = acct.name;
      select.appendChild(opt);

      // Only on-budget accounts in the categorize dropdown
      if (!acct.offbudget) {
        const catOpt = document.createElement('option');
        catOpt.value = acct.id;
        catOpt.textContent = acct.name;
        catSelect.appendChild(catOpt);
      }
    }
  } catch (err) {
    console.error('Failed to load accounts:', err);
  }
}

async function loadCategories() {
  try {
    [categories, categoryGroups] = await Promise.all([
      actualClient.getCategories(),
      actualClient.getCategoryGroups(),
    ]);
  } catch (err) {
    console.error('Failed to load categories:', err);
  }
}

// ─── File Upload & Drop Zone ───
function setupDropZone() {
  const zone = document.getElementById('dropZone');
  const input = document.getElementById('fileInput');

  zone.addEventListener('click', () => input.click());

  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('dragover');
  });

  zone.addEventListener('dragleave', () => {
    zone.classList.remove('dragover');
  });

  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file && file.type === 'application/pdf') {
      processFile(file);
    }
  });

  input.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) processFile(file);
    input.value = '';
  });
}

// ─── Process PDF ───
async function processFile(file) {
  if (isProcessing) return;

  const accountId = document.getElementById('accountSelect').value;
  if (!accountId) {
    alert('Please select a target account first.');
    return;
  }

  const currency = document.getElementById('currencySelect').value;
  const statementType = document.getElementById('statementTypeSelect').value;

  isProcessing = true;
  const progressCard = document.getElementById('progressCard');
  const reviewContainer = document.getElementById('reviewContainer');
  progressCard.classList.remove('hidden');
  reviewContainer.classList.add('hidden');

  // Progress callback
  pipeline.onProgress = ({ step, message, percent }) => {
    document.getElementById('progressTitle').textContent = message;
    document.getElementById('progressPercent').textContent = percent !== null ? `${percent}%` : '';
    document.getElementById('progressFill').style.width = `${percent || 0}%`;

    // Add step to pipeline view
    const steps = document.getElementById('pipelineSteps');
    const existing = steps.querySelector(`[data-step="${step}"]`);
    if (!existing && step !== 'error') {
      const div = document.createElement('div');
      div.className = `pipeline-step ${percent >= 100 ? 'done' : 'active'}`;
      div.dataset.step = step;
      div.innerHTML = `<span>${percent >= 100 ? '✓' : '◦'}</span> ${message}`;
      steps.appendChild(div);
    } else if (existing) {
      existing.className = `pipeline-step ${percent >= 100 ? 'done' : 'active'}`;
      existing.innerHTML = `<span>${percent >= 100 ? '✓' : '◦'}</span> ${message}`;
    }
  };

  try {
    const result = await pipeline.ingest(file, accountId, currency, statementType);
    currentStatementId = result.statementId;

    // Load parsed transactions for review
    parsedTransactions = await database.getAllByIndex(
      'parsedTransactions', 'statementId', currentStatementId
    );

    renderReviewTable();
    reviewContainer.classList.remove('hidden');
  } catch (err) {
    alert(`Import failed: ${err.message}`);
    console.error(err);
  } finally {
    isProcessing = false;
    setTimeout(() => {
      progressCard.classList.add('hidden');
      document.getElementById('pipelineSteps').innerHTML = '';
    }, 2000);
  }
}

// ─── Show Capture Confirm Card ───
async function showCaptureConfirm() {
  const accountId = document.getElementById('accountSelect').value;
  if (!accountId) {
    alert('Please select a target account first.');
    return;
  }

  // Auto-populate date from latest transaction
  const input = document.getElementById('startDateInput');
  const date = await getLatestTransactionDate(accountId);
  input.value = date || '';

  document.getElementById('captureConfirmCard').classList.remove('hidden');
}

// ─── Capture from Tab ───
async function captureFromTab() {
  if (isProcessing) return;

  const accountId = document.getElementById('accountSelect').value;
  if (!accountId) {
    alert('Please select a target account first.');
    return;
  }

  // Hide confirm card
  document.getElementById('captureConfirmCard').classList.add('hidden');

  const currency = document.getElementById('currencySelect').value;
  const statementType = document.getElementById('statementTypeSelect').value;

  isProcessing = true;
  const progressCard = document.getElementById('progressCard');
  const reviewContainer = document.getElementById('reviewContainer');
  progressCard.classList.remove('hidden');
  reviewContainer.classList.add('hidden');

  pipeline.onProgress = ({ step, message, percent }) => {
    document.getElementById('progressTitle').textContent = message;
    document.getElementById('progressPercent').textContent = percent !== null ? `${percent}%` : '';
    document.getElementById('progressFill').style.width = `${percent || 0}%`;

    const steps = document.getElementById('pipelineSteps');
    const existing = steps.querySelector(`[data-step="${step}"]`);
    if (!existing && step !== 'error') {
      const div = document.createElement('div');
      div.className = `pipeline-step ${percent >= 100 ? 'done' : 'active'}`;
      div.dataset.step = step;
      div.innerHTML = `<span>${percent >= 100 ? '✓' : '◦'}</span> ${message}`;
      steps.appendChild(div);
    } else if (existing) {
      existing.className = `pipeline-step ${percent >= 100 ? 'done' : 'active'}`;
      existing.innerHTML = `<span>${percent >= 100 ? '✓' : '◦'}</span> ${message}`;
    }
  };

  try {
    // Get cutoff date from the start date input
    const cutoffDate = document.getElementById('startDateInput').value || null;
    if (cutoffDate) {
      pipeline._emit('filter', `Will import transactions after ${cutoffDate}`, 5);
    }

    // Capture text from the active tab via service worker
    pipeline._emit('capture', 'Capturing text from tab...', 10);
    const response = await chrome.runtime.sendMessage({ type: 'CAPTURE_TAB_TEXT' });
    if (response.error) throw new Error(response.error);

    const result = await pipeline.ingestFromText(
      response.text, accountId, currency, statementType, cutoffDate
    );
    currentStatementId = result.statementId;

    // Load parsed transactions for review
    parsedTransactions = await database.getAllByIndex(
      'parsedTransactions', 'statementId', currentStatementId
    );

    renderReviewTable();
    reviewContainer.classList.remove('hidden');
  } catch (err) {
    alert(`Capture failed: ${err.message}`);
    console.error(err);
  } finally {
    isProcessing = false;
    setTimeout(() => {
      progressCard.classList.add('hidden');
      document.getElementById('pipelineSteps').innerHTML = '';
    }, 2000);
  }
}

async function getLatestTransactionDate(accountId) {
  try {
    // Query transactions from the last 6 months
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const startDate = sixMonthsAgo.toISOString().slice(0, 10);

    const transactions = await actualClient.getTransactions(accountId, startDate);
    if (!transactions || transactions.length === 0) return null;

    // Find the max date
    return transactions.reduce((max, tx) => tx.date > max ? tx.date : max, transactions[0].date);
  } catch (err) {
    console.warn('Could not determine latest transaction date:', err);
    return null;
  }
}

// ─── Review Table ───
function renderReviewTable() {
  const body = document.getElementById('reviewBody');
  const count = document.getElementById('reviewCount');
  body.innerHTML = '';
  count.textContent = `${parsedTransactions.length} transactions`;

  for (const tx of parsedTransactions) {
    const row = document.createElement('tr');
    const isDebit = tx.amount < 0;
    const amountDisplay = formatAmount(tx.amount);

    row.innerHTML = `
      <td class="check-col">
        <input type="checkbox" data-tx-id="${tx.id}" checked>
      </td>
      <td style="white-space:nowrap; font-size:11px; color:var(--text-secondary);">
        ${tx.date}
      </td>
      <td>
        <div style="font-weight:500; font-size:12px;" class="truncate" style="max-width:160px;">
          ${tx.cleanPayee || tx.rawDescription}
        </div>
        ${tx.cleanPayee ? `<div class="text-muted" style="font-size:10px;" class="truncate">${tx.rawDescription}</div>` : ''}
      </td>
      <td class="amount ${isDebit ? 'debit' : 'credit'}" style="text-align:right;">
        ${amountDisplay}
      </td>
      <td>
        <select class="category-select" data-tx-id="${tx.id}">
          <option value="">Uncategorized</option>
          ${categories.map(c => `
            <option value="${c.id}" ${c.id === tx.suggestedCategoryId ? 'selected' : ''}>
              ${c.name}
            </option>
          `).join('')}
        </select>
        ${tx.confidence ? `<div class="text-muted" style="font-size:10px; margin-top:2px;">
          ${Math.round(tx.confidence * 100)}% match
        </div>` : ''}
      </td>
    `;
    body.appendChild(row);

    // Attach change listener to the select
    const select = row.querySelector('.category-select');
    select.addEventListener('change', () => updateCategory(tx.id, select.value));
  }
}

function formatAmount(cents) {
  const value = Math.abs(cents) / 100;
  const sign = cents < 0 ? '-' : '+';
  return `${sign}${value.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
}

// ─── Import Actions ───
window.selectAllTx = function (checked) {
  document.querySelectorAll('#reviewBody input[type="checkbox"]').forEach(cb => {
    cb.checked = checked;
  });
  document.getElementById('selectAll').checked = checked;
};

window.updateCategory = async function (txId, categoryId) {
  const tx = parsedTransactions.find(t => t.id === txId);
  if (tx) {
    tx.suggestedCategoryId = categoryId || null;
    const cat = categories.find(c => c.id === categoryId);
    tx.suggestedCategory = cat ? cat.name : null;
    await database.put('parsedTransactions', tx);
  }
};

window.importSelected = async function () {
  const checkboxes = document.querySelectorAll('#reviewBody input[type="checkbox"]:checked');
  const selectedIds = Array.from(checkboxes).map(cb => cb.dataset.txId);

  if (selectedIds.length === 0) {
    alert('No transactions selected.');
    return;
  }

  const accountId = document.getElementById('accountSelect').value;

  try {
    document.getElementById('importBtn').disabled = true;
    document.getElementById('importBtn').textContent = 'Importing...';

    const result = await pipeline.importToActual(currentStatementId, accountId, selectedIds);

    document.getElementById('reviewContainer').classList.add('hidden');
    showImportResult(selectedIds.length, result.balanceDiscrepancy, accountId, currentStatementId);
    currentStatementId = null;
    parsedTransactions = [];
    await loadHistory();
  } catch (err) {
    alert(`Import failed: ${err.message}`);
  } finally {
    document.getElementById('importBtn').disabled = false;
    document.getElementById('importBtn').textContent = 'Import Selected';
  }
};

// ─── Import Result UI ───

function showImportResult(txCount, balanceDiscrepancy, accountId, statementId) {
  const card = document.getElementById('importResultCard');
  const content = document.getElementById('importResultContent');
  const fmt = (cents) => {
    const val = Math.abs(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return cents < 0 ? `-${val}` : val;
  };

  let html = `
    <div class="flex items-center gap-2 mb-3">
      <span style="font-size:18px;">&#10003;</span>
      <span style="font-weight:600; font-size:14px;">Imported ${txCount} transactions</span>
    </div>
  `;

  if (balanceDiscrepancy) {
    const d = balanceDiscrepancy;
    const type = d.isCreditCard ? 'Credit card' : 'Account';
    const diffColor = d.adjustment < 0 ? 'var(--accent-red)' : 'var(--accent-green)';

    html += `
      <div style="background:var(--accent-amber-soft); border:1px solid rgba(245,166,35,0.25); border-radius:var(--radius-sm); padding:12px; margin-bottom:12px;">
        <div style="font-weight:500; font-size:12px; color:var(--accent-amber); margin-bottom:8px;">${type} balance mismatch</div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px 16px; font-size:12px;">
          <span class="text-muted">Statement closing</span>
          <span class="text-mono" style="text-align:right;">${fmt(d.closingBalance)}</span>
          <span class="text-muted">Actual balance</span>
          <span class="text-mono" style="text-align:right;">${fmt(d.actualBalance)}</span>
          ${d.isCreditCard ? `
            <span class="text-muted">Expected (negated)</span>
            <span class="text-mono" style="text-align:right;">${fmt(d.expectedBalance)}</span>
          ` : ''}
          <span class="text-muted">Difference</span>
          <span class="text-mono" style="text-align:right; color:${diffColor}; font-weight:600;">${fmt(d.adjustment)}</span>
        </div>
      </div>
      <div class="flex gap-2">
        <button class="btn btn-sm btn-primary" id="adjustBalanceBtn">Adjust Balance</button>
        <button class="btn btn-sm btn-secondary" id="dismissResultBtn">Dismiss</button>
      </div>
    `;
  } else {
    html += `
      <div class="text-muted" style="font-size:12px;">All transactions imported successfully.</div>
      <button class="btn btn-sm btn-secondary mt-3" id="dismissResultBtn">OK</button>
    `;
  }

  content.innerHTML = html;
  card.classList.remove('hidden');

  const dismissBtn = document.getElementById('dismissResultBtn');
  if (dismissBtn) {
    dismissBtn.addEventListener('click', () => card.classList.add('hidden'));
  }

  const adjustBtn = document.getElementById('adjustBalanceBtn');
  if (adjustBtn && balanceDiscrepancy) {
    adjustBtn.addEventListener('click', async () => {
      adjustBtn.disabled = true;
      adjustBtn.textContent = 'Adjusting...';
      try {
        const stmt = await database.get('statements', statementId);
        await pipeline.applyBalanceAdjustment(accountId, balanceDiscrepancy.adjustment, stmt?.periodEnd);
        content.innerHTML = `
          <div class="flex items-center gap-2">
            <span style="font-size:18px;">&#10003;</span>
            <span style="font-weight:600; font-size:14px;">Imported ${txCount} transactions</span>
          </div>
          <div class="text-muted mt-2" style="font-size:12px;">Balance adjustment applied.</div>
          <button class="btn btn-sm btn-secondary mt-3" id="dismissResultBtn">OK</button>
        `;
        document.getElementById('dismissResultBtn').addEventListener('click', () => card.classList.add('hidden'));
      } catch (err) {
        adjustBtn.disabled = false;
        adjustBtn.textContent = 'Adjust Balance';
        alert('Failed to adjust balance: ' + err.message);
      }
    });
  }
}

// ─── Auto-Categorize Uncategorized Transactions ───

function setCatProgress(title, detail, percent) {
  const card = document.getElementById('catProgressCard');
  card.classList.remove('hidden');
  document.getElementById('catProgressTitle').textContent = title;
  document.getElementById('catProgressDetail').textContent = detail || '';
  document.getElementById('catProgressPercent').textContent = percent != null ? `${percent}%` : '';
  document.getElementById('catProgressFill').style.width = `${percent || 0}%`;
}

window.findAndCategorize = async function () {
  if (isProcessing) return;

  const accountFilter = document.getElementById('catAccountSelect').value;
  const monthCount = parseInt(document.getElementById('catMonthsSelect').value, 10);

  isProcessing = true;
  document.getElementById('findUncatBtn').disabled = true;
  document.getElementById('catReviewContainer').classList.add('hidden');
  uncategorizedTxs = [];
  categorizationResults = [];

  try {
    // Step 1: Build month range
    setCatProgress('Scanning transactions...', 'Building date range', 10);
    const now = new Date();
    const monthsToScan = [];
    for (let i = 0; i < monthCount; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      monthsToScan.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }

    // Step 2: Determine which accounts to scan (exclude off-budget)
    const onBudgetAccounts = accounts.filter(a => !a.closed && !a.offbudget);
    const targetAccounts = accountFilter === 'all'
      ? onBudgetAccounts
      : onBudgetAccounts.filter(a => a.id === accountFilter);

    // Build payee lookup
    let payeeMap = {};
    try {
      const payees = await actualClient.getPayees();
      for (const p of payees) payeeMap[p.id] = p.name;
    } catch { /* proceed without payee names */ }

    // Step 3: Fetch transactions and filter uncategorized
    setCatProgress('Fetching transactions...', `Scanning ${targetAccounts.length} account(s) over ${monthCount} month(s)`, 20);
    const allUncategorized = [];

    for (let mi = 0; mi < monthsToScan.length; mi++) {
      const monthStr = monthsToScan[mi];
      const startDate = `${monthStr}-01`;
      const [y, m] = monthStr.split('-').map(Number);
      const lastDay = new Date(y, m, 0).getDate();
      const endDate = `${monthStr}-${String(lastDay).padStart(2, '0')}`;

      for (const acct of targetAccounts) {
        try {
          const txs = await actualClient.getTransactions(acct.id, startDate, endDate);
          for (const t of txs) {
            // Skip transfers and already-categorized transactions
            if (t.transfer_id) continue;
            if (t.category) continue;

            allUncategorized.push({
              id: t.id,
              date: t.date,
              payee: payeeMap[t.payee] || t.imported_payee || 'Unknown',
              description: t.imported_payee || payeeMap[t.payee] || t.notes || 'Unknown',
              amount: t.amount,
              account: acct.name,
              accountId: acct.id,
            });
          }
        } catch (err) {
          console.warn(`Failed to fetch transactions for ${acct.name} in ${monthStr}:`, err);
        }
      }

      const scanPercent = 20 + Math.round(((mi + 1) / monthsToScan.length) * 30);
      setCatProgress('Fetching transactions...', `Scanned ${mi + 1}/${monthsToScan.length} months — ${allUncategorized.length} uncategorized so far`, scanPercent);
    }

    uncategorizedTxs = allUncategorized;

    if (allUncategorized.length === 0) {
      setCatProgress('No uncategorized transactions found', 'All transactions already have categories assigned.', 100);
      document.getElementById('uncatBadge').style.display = 'inline';
      document.getElementById('uncatBadge').textContent = '0 found';
      document.getElementById('uncatBadge').className = 'badge badge-green';
      setTimeout(() => document.getElementById('catProgressCard').classList.add('hidden'), 2500);
      return;
    }

    document.getElementById('uncatBadge').style.display = 'inline';
    document.getElementById('uncatBadge').textContent = `${allUncategorized.length} found`;
    document.getElementById('uncatBadge').className = 'badge badge-amber';

    // Step 4: Categorize with AI in batches
    const BATCH_SIZE = 40;
    const allResults = [];
    const totalBatches = Math.ceil(allUncategorized.length / BATCH_SIZE);

    for (let bi = 0; bi < totalBatches; bi++) {
      const batch = allUncategorized.slice(bi * BATCH_SIZE, (bi + 1) * BATCH_SIZE);
      const batchPercent = 50 + Math.round(((bi + 1) / totalBatches) * 45);

      setCatProgress(
        'AI categorizing...',
        `Batch ${bi + 1}/${totalBatches} (${batch.length} transactions)`,
        batchPercent
      );

      try {
        const results = await gemini.categorizeTransactions(
          batch.map(t => ({
            id: t.id,
            rawDescription: t.description,
            description: t.payee,
            amount: t.amount / 100,
            date: t.date,
          })),
          categories,
          categoryGroups
        );
        allResults.push(...results);
      } catch (err) {
        console.error(`Categorization batch ${bi + 1} failed:`, err);
        // Still continue with other batches
      }
    }

    // Step 5: Merge results with transaction data
    categorizationResults = allUncategorized.map(tx => {
      const match = allResults.find(r => r.transactionId === tx.id);
      return {
        ...tx,
        suggestedCategoryId: match?.categoryId || null,
        suggestedCategoryName: match?.categoryName || null,
        cleanPayee: match?.cleanPayee || null,
        confidence: match?.confidence || 0,
      };
    });

    // Sort: high confidence first, then by date descending
    categorizationResults.sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return b.date > a.date ? 1 : -1;
    });

    setCatProgress('Done!', `Categorized ${allResults.length}/${allUncategorized.length} transactions`, 100);

    // Step 6: Show review table
    renderCatReviewTable();
    document.getElementById('catReviewContainer').classList.remove('hidden');

    setTimeout(() => document.getElementById('catProgressCard').classList.add('hidden'), 1500);
  } catch (err) {
    setCatProgress('Error', err.message, 0);
    console.error('Auto-categorize failed:', err);
  } finally {
    isProcessing = false;
    document.getElementById('findUncatBtn').disabled = false;
  }
};

function renderCatReviewTable() {
  const body = document.getElementById('catReviewBody');
  const count = document.getElementById('catReviewCount');
  body.innerHTML = '';

  // Only show transactions that got a suggestion
  const withSuggestion = categorizationResults.filter(r => r.suggestedCategoryId);
  count.textContent = `${withSuggestion.length} of ${categorizationResults.length} categorized`;

  for (const tx of categorizationResults) {
    const row = document.createElement('tr');
    const isDebit = tx.amount < 0;
    const amountDisplay = formatAmount(tx.amount);

    row.innerHTML = `
      <td class="check-col">
        <input type="checkbox" data-cat-tx-id="${tx.id}" ${tx.suggestedCategoryId ? 'checked' : ''}>
      </td>
      <td style="white-space:nowrap; font-size:11px; color:var(--text-secondary);">
        ${tx.date}
      </td>
      <td>
        <div style="font-weight:500; font-size:12px;" class="truncate" style="max-width:160px;">
          ${escapeHtml(tx.cleanPayee || tx.payee)}
        </div>
        <div class="text-muted" style="font-size:10px;">${escapeHtml(tx.account)}</div>
      </td>
      <td class="amount ${isDebit ? 'debit' : 'credit'}" style="text-align:right;">
        ${amountDisplay}
      </td>
      <td>
        <select class="category-select" data-cat-tx-id="${tx.id}">
          <option value="">Skip</option>
          ${categories.map(c => `
            <option value="${c.id}" ${c.id === tx.suggestedCategoryId ? 'selected' : ''}>
              ${escapeHtml(c.name)}
            </option>
          `).join('')}
        </select>
        ${tx.confidence ? `<div class="text-muted" style="font-size:10px; margin-top:2px;">
          ${Math.round(tx.confidence * 100)}% match
        </div>` : ''}
      </td>
    `;
    body.appendChild(row);

    // Update result when user changes category
    const select = row.querySelector('.category-select');
    select.addEventListener('change', () => {
      const result = categorizationResults.find(r => r.id === tx.id);
      if (result) {
        result.suggestedCategoryId = select.value || null;
        const cat = categories.find(c => c.id === select.value);
        result.suggestedCategoryName = cat ? cat.name : null;
      }
    });

  }
}

window.catSelectAllTx = function (checked) {
  document.querySelectorAll('#catReviewBody input[type="checkbox"]').forEach(cb => {
    cb.checked = checked;
  });
  document.getElementById('catSelectAll').checked = checked;
};

window.applyCategorization = async function () {
  const checkboxes = document.querySelectorAll('#catReviewBody input[type="checkbox"]:checked');
  const selectedIds = new Set(Array.from(checkboxes).map(cb => cb.dataset.catTxId));

  // Get the selected category for each checked transaction
  const toApply = categorizationResults.filter(r =>
    selectedIds.has(r.id) && r.suggestedCategoryId
  );

  if (toApply.length === 0) {
    alert('No transactions selected with categories to apply.');
    return;
  }

  const btn = document.getElementById('applyCatBtn');
  btn.disabled = true;
  btn.textContent = `Applying 0/${toApply.length}...`;

  let applied = 0;
  let failed = 0;

  for (const tx of toApply) {
    try {
      await actualClient.updateTransaction(tx.id, {
        category: tx.suggestedCategoryId,
      });
      applied++;
    } catch (err) {
      console.error(`Failed to update transaction ${tx.id}:`, err);
      failed++;
    }
    btn.textContent = `Applying ${applied + failed}/${toApply.length}...`;
  }

  btn.disabled = false;
  btn.textContent = 'Apply Selected';

  const msg = failed > 0
    ? `Categorized ${applied} transaction(s). ${failed} failed.`
    : `Successfully categorized ${applied} transaction(s)!`;
  alert(msg);

  // Update badge
  const remaining = uncategorizedTxs.length - applied;
  if (remaining <= 0) {
    document.getElementById('uncatBadge').textContent = 'All done';
    document.getElementById('uncatBadge').className = 'badge badge-green';
    document.getElementById('catReviewContainer').classList.add('hidden');
  } else {
    document.getElementById('uncatBadge').textContent = `${remaining} remaining`;
  }

  // Clear applied transactions from the review table
  categorizationResults = categorizationResults.filter(r => !selectedIds.has(r.id) || !r.suggestedCategoryId);
  if (categorizationResults.length > 0) {
    renderCatReviewTable();
  } else {
    document.getElementById('catReviewContainer').classList.add('hidden');
  }
};

// ─── Chat Empty State ───
function renderChatEmpty() {
  const container = document.getElementById('chatEmpty');
  if (!container) return;

  if (isNewBudget) {
    container.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
      </svg>
      <div>
        <div style="font-weight:500; color:var(--text-primary); margin-bottom:4px;">Welcome! Let's set up your budget</div>
        <div style="font-size:12px;">I'll walk you through the basics step by step. Pick a prompt below or just tell me what you'd like to do.</div>
      </div>
      <div class="quick-prompts">
        <button class="quick-prompt" data-question="Help me set up my budget from scratch">Help me set up my budget from scratch</button>
        <button class="quick-prompt" data-question="Create a Checking account">Step 1: Create a Checking account</button>
        <button class="quick-prompt" data-question="I'd like personalized categories. Let me tell you about myself.">Step 2: Set up personalized categories</button>
        <button class="quick-prompt" data-question="Budget 1000 for Rent this month">Step 3: Set my first budget amount</button>
      </div>
    `;
  } else {
    container.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M12 6V2m0 20v-4M6 12H2m20 0h-4m1.3-5.3-2.8 2.8M7.5 16.5l-2.8 2.8M16.5 16.5l2.8 2.8M7.5 7.5 4.7 4.7"/>
      </svg>
      <div>
        <div style="font-weight:500; color:var(--text-primary); margin-bottom:4px;">Ask questions or manage your budget</div>
        <div style="font-size:12px;">I can answer questions, set budgets, create categories, add transactions, and more.</div>
      </div>
      <div class="quick-prompts">
        <button class="quick-prompt" data-question="What are my top spending categories this month?">What are my top spending categories?</button>
        <button class="quick-prompt" data-question="Budget 2000 for Rent this month">Budget 2000 for Rent this month</button>
        <button class="quick-prompt" data-question="Create a Subscriptions category in Bills">Create a Subscriptions category</button>
        <button class="quick-prompt" data-question="Add a 50 lunch expense at Starbucks today">Add a lunch expense</button>
        <button class="quick-prompt" data-question="How much is left in my food budget?">How much is left in my food budget?</button>
        <button class="quick-prompt" data-question="Am I spending more than I earn?">Am I spending more than I earn?</button>
      </div>
    `;
  }
}

function getNextStepSuggestion(completedAction) {
  const openAccts = accounts.filter(a => !a.closed);
  if (openAccts.length === 0) {
    return { label: 'Create a Checking account', question: 'Create a Checking account' };
  }
  if (categories.length === 0 || completedAction === 'create_account') {
    return { label: 'Set up personalized categories', question: 'I\'d like personalized categories. Let me tell you about myself.' };
  }
  if (completedAction === 'setup_budget_categories') {
    return { label: 'Set budget amounts', question: 'Help me set budget amounts for this month' };
  }
  if (completedAction === 'create_category_group') {
    return { label: 'Add categories to groups', question: 'Create categories: Rent in Bills, Groceries in Food, Gas in Transport, Subscriptions in Bills' };
  }
  if (completedAction === 'create_category') {
    return { label: 'Set budget amounts', question: 'Help me set budget amounts for this month' };
  }
  if (completedAction === 'set_budget_amount') {
    return { label: 'Add a transaction', question: 'Help me add my first transaction' };
  }
  return null;
}

function renderNextStepPrompt(completedAction) {
  if (!isNewBudget) return;
  const suggestion = getNextStepSuggestion(completedAction);
  if (!suggestion) return;

  const messages = document.getElementById('chatMessages');
  const wrapper = document.createElement('div');
  wrapper.className = 'next-step-prompt';
  wrapper.innerHTML = `
    <span class="next-step-label">Suggested next step:</span>
    <button class="quick-prompt" data-question="${escapeHtml(suggestion.question)}">${escapeHtml(suggestion.label)}</button>
  `;
  messages.appendChild(wrapper);
  messages.scrollTop = messages.scrollHeight;
}

// ─── Chat ───
window.askQuestion = function (question) {
  document.getElementById('chatInput').value = question;
  sendChat();
};

function addChatBubble(className, html) {
  const messages = document.getElementById('chatMessages');
  const bubble = document.createElement('div');
  bubble.className = className;
  bubble.innerHTML = html;
  messages.appendChild(bubble);
  messages.scrollTop = messages.scrollHeight;
  return bubble;
}

function addTypingIndicator() {
  const messages = document.getElementById('chatMessages');
  const typing = document.createElement('div');
  typing.className = 'chat-typing';
  typing.innerHTML = '<span></span><span></span><span></span>';
  messages.appendChild(typing);
  messages.scrollTop = messages.scrollHeight;
  return typing;
}

window.sendChat = async function () {
  const input = document.getElementById('chatInput');
  const question = input.value.trim();
  if (!question) return;

  input.value = '';
  document.getElementById('chatEmpty')?.remove();

  // Auto-resolve any pending function call before starting a new turn
  if (pendingFunctionCall) {
    chatHistory.push({
      role: 'user',
      parts: [{ functionResponse: { name: pendingFunctionCall.name, response: { cancelled: true, reason: 'User sent a new message' } } }],
    });
    chatHistory.push({
      role: 'model',
      parts: [{ text: 'Previous action was skipped.' }],
    });
    pendingFunctionCall = null;
  }

  // Add user message to conversation history
  chatHistory.push({ role: 'user', parts: [{ text: question }] });
  trimHistory();

  addChatBubble('chat-bubble user', escapeHtml(question));
  const typing = addTypingIndicator();

  try {
    const context = await buildFinancialContext();

    const response = await gemini.chatWithActions(context, functionDeclarations, chatHistory);

    typing.remove();

    if (response.type === 'text') {
      chatHistory.push({ role: 'model', parts: [{ text: response.text }] });
      addChatBubble('chat-bubble assistant', formatMarkdown(response.text));
      saveChatMessage('user', question);
      saveChatMessage('assistant', response.text);
    } else if (response.type === 'functionCall') {
      const { name: fnName, args: fnArgs } = response;

      // Record the model's function call in history
      chatHistory.push({ role: 'model', parts: [{ functionCall: { name: fnName, args: fnArgs } }] });

      if (actionExecutor.isReadOnly(fnName)) {
        const readTyping = addTypingIndicator();
        try {
          const result = await actionExecutor.execute(fnName, fnArgs);

          // Record function response in history
          chatHistory.push({ role: 'user', parts: [{ functionResponse: { name: fnName, response: result } }] });

          // For lookup_merchant, use chatWithActions so the AI can follow up
          // with update_payee/update_transaction in the same turn
          if (fnName === 'lookup_merchant') {
            const freshContext = await buildFinancialContext();
            const followUp = await gemini.chatWithActions(freshContext, functionDeclarations, chatHistory);

            readTyping.remove();

            if (followUp.type === 'text') {
              chatHistory.push({ role: 'model', parts: [{ text: followUp.text }] });
              addChatBubble('chat-bubble assistant', formatMarkdown(followUp.text));
              saveChatMessage('user', question);
              saveChatMessage('assistant', followUp.text);
            } else if (followUp.type === 'functionCall') {
              chatHistory.push({ role: 'model', parts: [{ functionCall: { name: followUp.name, args: followUp.args } }] });
              pendingFunctionCall = { name: followUp.name, args: followUp.args };
              saveChatMessage('user', question);
              showConfirmationCard(followUp.name, followUp.args, freshContext);
            }
          } else {
            const summary = await gemini.sendFunctionResult(context, chatHistory);
            chatHistory.push({ role: 'model', parts: [{ text: summary }] });

            readTyping.remove();
            addChatBubble('chat-bubble assistant', formatMarkdown(summary));
            saveChatMessage('user', question);
            saveChatMessage('assistant', summary);
          }
        } catch (err) {
          readTyping.remove();
          addChatBubble('chat-bubble assistant', `<span style="color:var(--accent-red);">Error: ${escapeHtml(err.message)}</span>`);
        }
      } else {
        // Write actions need confirmation — mark as pending
        pendingFunctionCall = { name: fnName, args: fnArgs };
        showConfirmationCard(fnName, fnArgs, context);
        saveChatMessage('user', question);
      }
    }
  } catch (err) {
    typing.remove();
    addChatBubble('chat-bubble assistant', `<span style="color:var(--accent-red);">Error: ${escapeHtml(err.message)}</span>`);
  }
};

function showConfirmationCard(fnName, fnArgs, context) {
  const messages = document.getElementById('chatMessages');
  const isDestructive = actionExecutor.isDestructive(fnName);
  const description = actionExecutor.describeAction(fnName, fnArgs, context);

  const card = document.createElement('div');
  card.className = `action-card${isDestructive ? ' destructive' : ''}`;

  card.innerHTML = `
    <div class="action-card-header">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        ${isDestructive
      ? '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'
      : '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>'}
      </svg>
      <span>${isDestructive ? 'Confirm Destructive Action' : 'Confirm Action'}</span>
    </div>
    <div class="action-card-body">${formatMarkdown(description)}</div>
    <div class="action-card-buttons">
      <button class="btn btn-sm btn-secondary action-cancel-btn">Cancel</button>
      <button class="btn btn-sm ${isDestructive ? 'btn-danger' : 'btn-primary'} action-confirm-btn">
        ${isDestructive ? 'Delete' : 'Confirm'}
      </button>
    </div>
  `;

  messages.appendChild(card);
  messages.scrollTop = messages.scrollHeight;

  // Cancel handler
  card.querySelector('.action-cancel-btn').addEventListener('click', () => {
    card.querySelector('.action-card-buttons').remove();
    card.querySelector('.action-card-body').innerHTML = '<span class="text-muted">Action cancelled.</span>';
    card.classList.add('cancelled');

    // Record cancellation in conversation history
    chatHistory.push({
      role: 'user',
      parts: [{ functionResponse: { name: fnName, response: { cancelled: true } } }],
    });
    chatHistory.push({
      role: 'model',
      parts: [{ text: 'Action cancelled by user.' }],
    });
    pendingFunctionCall = null;

    saveChatMessage('assistant', 'Action cancelled by user.');
  });

  // Confirm handler
  card.querySelector('.action-confirm-btn').addEventListener('click', async () => {
    const buttonsDiv = card.querySelector('.action-card-buttons');
    buttonsDiv.innerHTML = '<div class="action-loading"><span></span><span></span><span></span> Executing...</div>';

    try {
      const result = await actionExecutor.execute(fnName, fnArgs);

      // Record function response in conversation history
      chatHistory.push({
        role: 'user',
        parts: [{ functionResponse: { name: fnName, response: result } }],
      });
      pendingFunctionCall = null;

      // Rebuild context with fresh data for the summary
      const freshContext = await buildFinancialContext();
      const summary = await gemini.sendFunctionResult(freshContext, chatHistory);
      chatHistory.push({ role: 'model', parts: [{ text: summary }] });

      card.querySelector('.action-card-body').innerHTML = formatMarkdown(description);
      buttonsDiv.innerHTML = `<div class="action-result success">Done</div>`;
      card.classList.add('completed');

      addChatBubble('chat-bubble assistant', formatMarkdown(summary));
      saveChatMessage('assistant', summary);

      // Refresh sidebar data after successful write
      await loadAccounts();
      await loadCategories();

      // Re-evaluate onboarding state
      const openAccts = accounts.filter(a => !a.closed);
      isNewBudget = openAccts.length === 0 || categories.length === 0;

      // Show next-step prompt during onboarding
      renderNextStepPrompt(fnName);
    } catch (err) {
      buttonsDiv.innerHTML = `<div class="action-result error">${escapeHtml(err.message)}</div>`;
      card.classList.add('failed');
    }
  });
}

async function saveChatMessage(role, content) {
  try {
    await database.put('chatMessages', {
      id: crypto.randomUUID(), role, content, createdAt: new Date().toISOString(),
    });
  } catch { /* ignore save failures */ }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function buildFinancialContext() {
  const context = {
    accounts: [],
    months: [],
    categories: [],
    budgetMonths: [],
    summary: '',
    isNewBudget,
  };

  try {
    // ── Fetch reference data ──
    // Use allSettled so a single endpoint failure doesn't kill the whole context
    const [acctResult, catResult, payeeResult] = await Promise.allSettled([
      actualClient.getAccounts(),
      actualClient.getCategories(),
      actualClient.getPayees(),
    ]);

    const rawAccounts = acctResult.status === 'fulfilled' ? acctResult.value : [];
    const rawCategories = catResult.status === 'fulfilled' ? catResult.value : [];
    const rawPayees = payeeResult.status === 'fulfilled' ? payeeResult.value : [];

    if (acctResult.status === 'rejected') console.warn('Failed to fetch accounts:', acctResult.reason);
    if (catResult.status === 'rejected') console.warn('Failed to fetch categories:', catResult.reason);
    if (payeeResult.status === 'rejected') console.warn('Failed to fetch payees:', payeeResult.reason);

    // Build lookup maps for resolving UUIDs to human-readable names
    const categoryMap = {};
    for (const c of rawCategories) categoryMap[c.id] = c.name;
    const payeeMap = {};
    for (const p of rawPayees) payeeMap[p.id] = p.name;
    const accountMap = {};
    for (const a of rawAccounts) accountMap[a.id] = a.name;

    // ── Accounts with balances ──
    // The balance endpoint returns { data: <integer> } where the integer
    // is already in minor units (cents/kuruş). Our _fetch helper unwraps
    // the response, so getAccountBalance returns a plain integer.
    const openAccounts = rawAccounts.filter(a => !a.closed);
    for (const acct of openAccounts) {
      try {
        const bal = await actualClient.getAccountBalance(acct.id);
        // bal is an integer in minor units (e.g. 250000 = 2500.00)
        const balanceValue = typeof bal === 'number' ? bal : (bal?.balance ?? 0);
        context.accounts.push({
          name: acct.name,
          offbudget: !!acct.offbudget,
          balance: balanceValue,
        });
      } catch {
        context.accounts.push({ name: acct.name, offbudget: !!acct.offbudget, balance: 0 });
      }
    }

    // ── Categories ──
    context.categories = rawCategories
      .filter(c => !c.hidden)
      .map(c => ({ name: c.name, is_income: !!c.is_income, group_id: c.group_id }));

    // ── Determine which months to include ──
    // Include current month + previous 2 months so there's always data context
    const now = new Date();
    const monthsToFetch = [];
    for (let i = 0; i < 3; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      monthsToFetch.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }

    // Also check further back: scan 6 months back if the recent ones are empty
    const extendedMonths = [];
    for (let i = 3; i < 6; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      extendedMonths.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }

    // ── Helper: fetch and enrich transactions for a month ──
    const fetchMonth = async (monthStr) => {
      const startDate = `${monthStr}-01`;
      // Calculate actual last day of the month to avoid invalid dates (e.g. Feb-31)
      const [y, m] = monthStr.split('-').map(Number);
      const lastDay = new Date(y, m, 0).getDate();
      const endDate = `${monthStr}-${String(lastDay).padStart(2, '0')}`;
      const allTxs = [];

      for (const acct of openAccounts) {
        try {
          const txs = await actualClient.getTransactions(acct.id, startDate, endDate);
          for (const t of txs) {
            // Skip internal transfers (they have a transfer_id and would
            // double-count when both sides of the transfer are included)
            const isTransfer = !!t.transfer_id;

            allTxs.push({
              id: t.id,
              date: t.date,
              payee: payeeMap[t.payee] || t.imported_payee || 'Unknown',
              category: categoryMap[t.category] || (isTransfer ? 'Transfer' : 'Uncategorized'),
              amount: t.amount,  // integer in minor units (cents/kuruş)
              account: acct.name,
              notes: t.notes || null,
              is_transfer: isTransfer,
            });
          }
        } catch (err) {
          console.warn(`Failed to fetch transactions for ${acct.name} in ${monthStr}:`, err);
        }
      }

      return allTxs;
    };

    // ── Helper: build month summary from transactions ──
    const buildMonthEntry = (monthStr, txs) => {
      const nonTransferTxs = txs.filter(t => !t.is_transfer);
      const income = nonTransferTxs.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0);
      const expenses = nonTransferTxs.filter(t => t.amount < 0).reduce((s, t) => s + t.amount, 0);
      return {
        month: monthStr,
        transactionCount: txs.length,
        totalIncome: income,
        totalExpenses: expenses,
        net: income + expenses,
        transactions: txs,
      };
    };

    // ── Fetch primary months ──
    let hasData = false;
    for (const monthStr of monthsToFetch) {
      try {
        const txs = await fetchMonth(monthStr);
        if (txs.length > 0) hasData = true;
        context.months.push(buildMonthEntry(monthStr, txs));
      } catch (err) {
        console.warn(`Failed to fetch month ${monthStr}:`, err);
        context.months.push(buildMonthEntry(monthStr, []));
      }
    }

    // ── If recent months are empty, scan further back ──
    if (!hasData) {
      for (const monthStr of extendedMonths) {
        try {
          const txs = await fetchMonth(monthStr);
          if (txs.length > 0) {
            context.months.push(buildMonthEntry(monthStr, txs));
          }
        } catch (err) {
          console.warn(`Failed to fetch extended month ${monthStr}:`, err);
        }
      }
    }

    // ── Fetch budget month data for richer context ──
    // Budget months include budgeted/spent/balance per category group,
    // totalIncome, totalSpent, totalBalance, and toBudget.
    const monthsWithData = context.months.filter(m => m.transactionCount > 0).map(m => m.month);
    for (const monthStr of monthsWithData) {
      try {
        const budgetData = await actualClient.getBudgetMonth(monthStr);
        if (budgetData) {
          context.budgetMonths.push({
            month: monthStr,
            totalIncome: budgetData.totalIncome,
            totalSpent: budgetData.totalSpent,
            totalBudgeted: budgetData.totalBudgeted,
            totalBalance: budgetData.totalBalance,
            toBudget: budgetData.toBudget,
            incomeAvailable: budgetData.incomeAvailable,
            categoryGroups: (budgetData.categoryGroups || []).map(cg => ({
              name: cg.name,
              is_income: cg.is_income,
              budgeted: cg.budgeted,
              spent: cg.spent,
              balance: cg.balance,
            })),
          });
        }
      } catch (err) {
        console.warn(`Failed to fetch budget data for ${monthStr}:`, err);
      }
    }

    // ── Build a text summary for quick reference ──
    // All values in the context are in minor units (cents/kuruş).
    // The summary should also use minor units for consistency.
    const totalBal = context.accounts.reduce((s, a) => s + (a.balance || 0), 0);
    const onBudgetBal = context.accounts.filter(a => !a.offbudget).reduce((s, a) => s + (a.balance || 0), 0);
    const offBudgetBal = context.accounts.filter(a => a.offbudget).reduce((s, a) => s + (a.balance || 0), 0);

    context.summary = [
      `${context.accounts.length} open account(s).`,
      `Total balance: ${totalBal} (on-budget: ${onBudgetBal}, off-budget: ${offBudgetBal}).`,
      `Data for months: ${monthsWithData.join(', ') || 'none'}.`,
      `ALL amounts (balances, transactions, budgets) are integers in minor units (cents/kuruş). Divide by 100 to display.`,
    ].join(' ');

  } catch (err) {
    console.error('Failed to build financial context:', err);
  }

  return context;
}

function formatMarkdown(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code style="background:var(--bg-hover);padding:1px 4px;border-radius:3px;font-family:var(--font-mono);font-size:11px;">$1</code>')
    .replace(/\n/g, '<br>');
}

// ─── History ───
async function loadHistory() {
  const list = document.getElementById('historyList');
  const statements = await database.getAll('statements');

  if (statements.length === 0) {
    list.innerHTML = '<div class="text-muted" style="text-align:center; padding:40px;">No statements imported yet.</div>';
    return;
  }

  statements.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  list.innerHTML = statements.map(stmt => {
    const statusBadge = {
      parsed: 'badge-amber',
      imported: 'badge-green',
      failed: 'badge-red',
      parsing: 'badge-blue',
      pending: 'badge-muted',
    }[stmt.parseStatus] || 'badge-muted';

    return `
      <div class="card mb-2" style="padding:12px;">
        <div class="flex items-center justify-between">
          <div style="flex:1; min-width:0;">
            <div style="font-weight:500; font-size:13px;">${stmt.fileName}</div>
            <div class="text-muted" style="font-size:11px;">
              ${stmt.bankName || 'Unknown bank'} · ${stmt.transactionCount || 0} transactions
              ${stmt.periodStart ? ` · ${stmt.periodStart} → ${stmt.periodEnd}` : ''}
            </div>
          </div>
          <div class="flex items-center gap-2">
            <span class="badge ${statusBadge}">${stmt.parseStatus}</span>
            <button class="delete-stmt-btn" data-stmt-id="${stmt.id}" title="Delete statement" style="background:none; border:none; cursor:pointer; color:var(--text-muted); padding:4px; border-radius:var(--radius-sm); font-size:14px; line-height:1;">&times;</button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  list.querySelectorAll('.delete-stmt-btn').forEach(btn => {
    btn.addEventListener('mouseenter', () => btn.style.color = 'var(--red-500, #ef4444)');
    btn.addEventListener('mouseleave', () => btn.style.color = 'var(--text-muted)');
    btn.addEventListener('click', () => deleteStatement(btn.dataset.stmtId));
  });
}

async function deleteStatement(statementId) {
  if (!confirm('Delete this statement and its transactions? You will be able to re-upload the file.')) return;

  const txns = await database.getAllByIndex('parsedTransactions', 'statementId', statementId);
  for (const txn of txns) {
    await database.delete('parsedTransactions', txn.id);
  }

  await database.delete('statements', statementId);
  await loadHistory();
}

// ─── Settings ───
window.openSettings = function () {
  chrome.runtime.openOptionsPage();
};

async function loadDefaultCurrency() {
  try {
    const result = await chrome.storage.local.get(['defaultCurrency']);
    const currency = result.defaultCurrency || 'TRY';
    document.getElementById('currencySelect').value = currency;
    document.getElementById('currencyLabel').textContent = currency;
  } catch { /* use defaults */ }
}

window.exportMappings = async function () {
  const mappings = await database.getAll('merchantMappings');
  const blob = new Blob([JSON.stringify(mappings, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'actual-ai-mappings.json';
  a.click();
  URL.revokeObjectURL(url);
};

window.clearAllData = async function () {
  if (!confirm('This will delete all parsed statements, merchant mappings, and chat history. Are you sure?')) return;

  await database.clear('statements');
  await database.clear('parsedTransactions');
  await database.clear('merchantMappings');
  await database.clear('summaries');
  await database.clear('chatMessages');
  await loadHistory();
  alert('All data cleared.');
};
