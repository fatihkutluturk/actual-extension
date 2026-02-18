/**
 * Actual AI — Actual Budget API Client
 *
 * Communicates with the Actual Budget HTTP API bridge:
 *   https://github.com/jhonderson/actual-http-api
 *
 * All data endpoints go through the HTTP API (default port 5007).
 * Budget listing / connection testing still uses the Actual sync server directly.
 */

class ActualBudgetClient {
  constructor() {
    this.serverUrl = null;   // Actual sync server (e.g. http://localhost:5006)
    this.password = null;
    this.token = null;
    this.budgetSyncId = null;
    this.httpApiUrl = null;  // actual-http-api (e.g. http://localhost:5007)
    this.httpApiKey = null;
  }

  async init() {
    const result = await chrome.storage.local.get([
      'actualServerUrl',
      'actualPassword',
      'actualBudgetId',
      'httpApiUrl',
      'httpApiKey',
    ]);
    this.serverUrl = result.actualServerUrl || null;
    this.password = result.actualPassword || null;
    this.budgetSyncId = result.actualBudgetId || null;
    this.httpApiUrl = result.httpApiUrl || null;
    this.httpApiKey = result.httpApiKey || null;
  }

  isConfigured() {
    return !!(this.httpApiUrl && this.httpApiKey && this.budgetSyncId);
  }

  // ─── Authentication (sync server — used only for listing budgets) ───

  async login() {
    const res = await fetch(`${this.serverUrl}/account/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: this.password }),
    });

    if (!res.ok) throw new Error(`Login failed: ${res.status}`);

    const data = await res.json();
    this.token = data.data?.token;

    if (!this.token) throw new Error('No token received from Actual server');

    await chrome.storage.local.set({ actualToken: this.token });
    return this.token;
  }

  async _ensureSyncAuth() {
    if (!this.token) {
      const stored = await chrome.storage.local.get('actualToken');
      this.token = stored.actualToken;
    }
    if (!this.token) {
      await this.login();
    }
  }

  // ─── HTTP API fetch helper ───

  async _fetch(path, options = {}) {
    const url = `${this.httpApiUrl}/v1/budgets/${this.budgetSyncId}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.httpApiKey,
        ...options.headers,
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Actual HTTP API error ${res.status}: ${text}`);
    }

    const contentType = res.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      return res.json();
    }
    return res.text();
  }

  // ─── Budget Files (via sync server) ───

  async listBudgets() {
    await this._ensureSyncAuth();
    const res = await fetch(`${this.serverUrl}/sync/list-user-files`, {
      headers: { 'X-ACTUAL-TOKEN': this.token },
    });
    if (!res.ok) throw new Error(`Failed to list budgets: ${res.status}`);
    const data = await res.json();
    return data.data || [];
  }

  async selectBudget(budgetSyncId) {
    this.budgetSyncId = budgetSyncId;
    await chrome.storage.local.set({ actualBudgetId: budgetSyncId });
  }

  // ─── Accounts ───

  async getAccounts() {
    const data = await this._fetch('/accounts');
    return data?.data || [];
  }

  async getAccountBalance(accountId) {
    // API returns { data: <integer> } where data is the balance in minor units.
    // _fetch parses JSON, so we get the full response object.
    const response = await this._fetch(`/accounts/${accountId}/balance`);
    // Handle both { data: 2000 } and raw number responses
    const balance = response?.data ?? response;
    return typeof balance === 'number' ? balance : 0;
  }

  // ─── Transactions ───

  async getTransactions(accountId, startDate, endDate) {
    let url = `/accounts/${accountId}/transactions?since_date=${startDate}`;
    if (endDate) url += `&until_date=${endDate}`;
    const data = await this._fetch(url);
    return data?.data || [];
  }

  async importTransactions(accountId, transactions) {
    const data = await this._fetch(`/accounts/${accountId}/transactions/import`, {
      method: 'POST',
      body: JSON.stringify({ transactions }),
    });
    return data?.data || data;
  }

  // ─── Categories ───

  async getCategories() {
    const data = await this._fetch('/categories');
    return data?.data || [];
  }

  async getCategoryGroups() {
    const data = await this._fetch('/categorygroups');
    return data?.data || [];
  }

  // ─── Payees ───

  async getPayees() {
    const data = await this._fetch('/payees');
    return data?.data || [];
  }

  // ─── Accounts (write) ───

  async createAccount(account) {
    // POST /accounts — body: { account: { name, offbudget } }
    const response = await this._fetch('/accounts', {
      method: 'POST',
      body: JSON.stringify({ account }),
    });
    return response?.data ?? response;
  }

  async closeAccount(accountId, transferAccountId, transferCategoryId) {
    // PUT /accounts/:id/close — body: { transfer: { transferAccountId, transferCategoryId } }
    const transfer = {};
    if (transferAccountId) transfer.transferAccountId = transferAccountId;
    if (transferCategoryId) transfer.transferCategoryId = transferCategoryId;
    const response = await this._fetch(`/accounts/${accountId}/close`, {
      method: 'PUT',
      body: JSON.stringify({ transfer }),
    });
    return response?.message ?? response;
  }

  async reopenAccount(accountId) {
    // PUT /accounts/:id/reopen
    const response = await this._fetch(`/accounts/${accountId}/reopen`, {
      method: 'PUT',
    });
    return response?.message ?? response;
  }

  // ─── Transactions (write) ───

  async addTransaction(accountId, transaction) {
    // POST /accounts/:id/transactions — body: { transaction, learnCategories, runTransfers }
    const response = await this._fetch(`/accounts/${accountId}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ transaction, learnCategories: true, runTransfers: true }),
    });
    return response?.data ?? response?.message ?? response;
  }

  async updateTransaction(transactionId, transaction) {
    // PATCH /transactions/:id — body: { transaction }
    const response = await this._fetch(`/transactions/${transactionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ transaction }),
    });
    return response?.message ?? response;
  }

  async deleteTransaction(transactionId) {
    // DELETE /transactions/:id
    const response = await this._fetch(`/transactions/${transactionId}`, {
      method: 'DELETE',
    });
    return response?.message ?? response;
  }

  // ─── Categories (write) ───

  async createCategory(category) {
    // POST /categories — body: { category: { name, group_id, is_income, hidden } }
    const response = await this._fetch('/categories', {
      method: 'POST',
      body: JSON.stringify({ category }),
    });
    return response?.data ?? response;
  }

  async updateCategory(categoryId, category) {
    // PATCH /categories/:id — body: { category }
    const response = await this._fetch(`/categories/${categoryId}`, {
      method: 'PATCH',
      body: JSON.stringify({ category }),
    });
    return response?.message ?? response;
  }

  async deleteCategory(categoryId, transferCategoryId) {
    // DELETE /categories/:id?transfer_category_id=...
    let url = `/categories/${categoryId}`;
    if (transferCategoryId) url += `?transfer_category_id=${transferCategoryId}`;
    const response = await this._fetch(url, { method: 'DELETE' });
    return response?.message ?? response;
  }

  async createCategoryGroup(categoryGroup) {
    // POST /categorygroups — body: { category_group: { name, is_income } }
    const response = await this._fetch('/categorygroups', {
      method: 'POST',
      body: JSON.stringify({ category_group: categoryGroup }),
    });
    return response?.data ?? response;
  }

  // ─── Payees (write) ───

  async createPayee(payee) {
    // POST /payees — body: { payee: { name } }
    const response = await this._fetch('/payees', {
      method: 'POST',
      body: JSON.stringify({ payee }),
    });
    return response?.data ?? response;
  }

  async updatePayee(payeeId, payee) {
    // PATCH /payees/:id — body: { payee }
    const response = await this._fetch(`/payees/${payeeId}`, {
      method: 'PATCH',
      body: JSON.stringify({ payee }),
    });
    return response?.message ?? response;
  }

  async deletePayee(payeeId) {
    // DELETE /payees/:id
    const response = await this._fetch(`/payees/${payeeId}`, {
      method: 'DELETE',
    });
    return response?.message ?? response;
  }

  // ─── Budget Data ───

  async getBudgetMonth(month) {
    // API returns { data: { month, incomeAvailable, totalBudgeted, totalSpent,
    // totalBalance, toBudget, totalIncome, categoryGroups: [...], ... } }
    // All monetary values are integers in minor units.
    const response = await this._fetch(`/months/${month}`);
    return response?.data ?? response;
  }

  async updateBudgetAmount(month, categoryId, budgeted) {
    // PATCH /months/:month/categories/:categoryId — body: { category: { budgeted } }
    const response = await this._fetch(`/months/${month}/categories/${categoryId}`, {
      method: 'PATCH',
      body: JSON.stringify({ category: { budgeted } }),
    });
    return response?.message ?? response;
  }

  async transferBudget(month, fromCategoryId, toCategoryId, amount) {
    // POST /months/:month/categorytransfers — body: { categorytransfer: { fromCategoryId, toCategoryId, amount } }
    const categorytransfer = { amount };
    if (fromCategoryId) categorytransfer.fromCategoryId = fromCategoryId;
    if (toCategoryId) categorytransfer.toCategoryId = toCategoryId;
    const response = await this._fetch(`/months/${month}/categorytransfers`, {
      method: 'POST',
      body: JSON.stringify({ categorytransfer }),
    });
    return response?.message ?? response;
  }

  // ─── Connection Test ───

  async testConnection() {
    try {
      await this.login();
      const budgets = await this.listBudgets();
      return { success: true, budgets };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async testHttpApi() {
    try {
      const data = await this._fetch('/accounts');
      return { success: true, accounts: data?.data || [] };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
}

const actualClient = new ActualBudgetClient();
export default actualClient;
