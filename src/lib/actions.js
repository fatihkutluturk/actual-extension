/**
 * Actual AI — Action Executor
 *
 * Maps Gemini function calls to Actual Budget API operations.
 * Handles name-to-UUID resolution, amount conversion, and execution.
 */

import actualClient from './actual-client.js';
import gemini from './gemini.js';

// ─── Function Declarations for Gemini ───
// These define the tools Gemini can invoke via function calling.

export const functionDeclarations = [
  // ── Budget Management ──
  {
    name: 'set_budget_amount',
    description: 'Set or update the budgeted amount for a category in a specific month. Use this when the user wants to budget money for a category.',
    parameters: {
      type: 'OBJECT',
      properties: {
        category_name: { type: 'STRING', description: 'Name of the category to budget for (e.g. "Groceries", "Rent")' },
        month: { type: 'STRING', description: 'Month in YYYY-MM format (e.g. "2026-02")' },
        amount: { type: 'NUMBER', description: 'Amount to budget in display units (e.g. 500 means 500.00, NOT cents)' },
      },
      required: ['category_name', 'month', 'amount'],
    },
  },
  {
    name: 'transfer_budget',
    description: 'Move budgeted money from one category to another within a month. Use when the user wants to reallocate budget between categories.',
    parameters: {
      type: 'OBJECT',
      properties: {
        from_category: { type: 'STRING', description: 'Source category name (or "To Be Budgeted" for unallocated funds)' },
        to_category: { type: 'STRING', description: 'Destination category name (or "To Be Budgeted" for unallocated funds)' },
        month: { type: 'STRING', description: 'Month in YYYY-MM format' },
        amount: { type: 'NUMBER', description: 'Amount to move in display units (e.g. 100 means 100.00)' },
      },
      required: ['from_category', 'to_category', 'month', 'amount'],
    },
  },

  // ── Categories ──
  {
    name: 'create_category',
    description: 'Create a new budget category within a category group. Use when the user wants to add a new spending/income category.',
    parameters: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING', description: 'Name for the new category (e.g. "Subscriptions", "Pet Care")' },
        group_name: { type: 'STRING', description: 'Name of the category group to put it in (e.g. "Bills", "Food", "Frequent")' },
        is_income: { type: 'BOOLEAN', description: 'Whether this is an income category. Defaults to false.' },
      },
      required: ['name', 'group_name'],
    },
  },
  {
    name: 'create_category_group',
    description: 'Create a new category group (a container for categories). Use when the user wants to organize categories into a new group.',
    parameters: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING', description: 'Name for the new group (e.g. "Hobbies", "Health")' },
        is_income: { type: 'BOOLEAN', description: 'Whether this is an income group. Defaults to false.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_category',
    description: 'Rename a category or move it to a different group.',
    parameters: {
      type: 'OBJECT',
      properties: {
        current_name: { type: 'STRING', description: 'Current name of the category' },
        new_name: { type: 'STRING', description: 'New name for the category (optional, omit to keep current name)' },
        new_group_name: { type: 'STRING', description: 'Name of the group to move it to (optional, omit to keep current group)' },
      },
      required: ['current_name'],
    },
  },
  {
    name: 'delete_category',
    description: 'Delete a category. Optionally transfer its transactions to another category.',
    parameters: {
      type: 'OBJECT',
      properties: {
        category_name: { type: 'STRING', description: 'Name of the category to delete' },
        transfer_to: { type: 'STRING', description: 'Name of the category to transfer existing transactions to (optional)' },
      },
      required: ['category_name'],
    },
  },

  // ── Transactions ──
  {
    name: 'add_transaction',
    description: 'Add a new transaction to an account. Use when the user wants to record a purchase, payment, income, or expense.',
    parameters: {
      type: 'OBJECT',
      properties: {
        account_name: { type: 'STRING', description: 'Name of the account (e.g. "Checking", "Credit Card")' },
        date: { type: 'STRING', description: 'Transaction date in YYYY-MM-DD format' },
        payee_name: { type: 'STRING', description: 'Who the transaction is with (e.g. "Starbucks", "Amazon")' },
        amount: { type: 'NUMBER', description: 'Amount in display units. Negative for expenses (e.g. -50 for a $50 expense), positive for income.' },
        category_name: { type: 'STRING', description: 'Category to assign (e.g. "Groceries", "Salary"). Optional.' },
        notes: { type: 'STRING', description: 'Optional notes for the transaction' },
      },
      required: ['account_name', 'date', 'payee_name', 'amount'],
    },
  },
  {
    name: 'update_transaction',
    description: 'Update an existing transaction. Use this to change the category, payee, amount, date, or notes of a transaction that already exists. ALWAYS prefer this over add_transaction when the user wants to modify, categorize, or fix an existing transaction.',
    parameters: {
      type: 'OBJECT',
      properties: {
        transaction_id: { type: 'STRING', description: 'The UUID of the transaction to update (from the financial context data)' },
        category_name: { type: 'STRING', description: 'New category to assign (optional)' },
        payee_name: { type: 'STRING', description: 'New payee name (optional)' },
        amount: { type: 'NUMBER', description: 'New amount in display units (optional). Negative for expenses, positive for income.' },
        date: { type: 'STRING', description: 'New date in YYYY-MM-DD format (optional)' },
        notes: { type: 'STRING', description: 'New notes (optional)' },
      },
      required: ['transaction_id'],
    },
  },
  {
    name: 'delete_transaction',
    description: 'Delete a transaction by its ID. Only use when the user references a specific transaction to delete.',
    parameters: {
      type: 'OBJECT',
      properties: {
        transaction_id: { type: 'STRING', description: 'The UUID of the transaction to delete' },
      },
      required: ['transaction_id'],
    },
  },

  // ── Accounts ──
  {
    name: 'create_account',
    description: 'Create a new account. Use when the user wants to add a bank account, credit card, or savings account.',
    parameters: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING', description: 'Account name (e.g. "Checking", "Savings", "Chase Visa")' },
        offbudget: { type: 'BOOLEAN', description: 'Set to true for off-budget accounts (savings, investments). Defaults to false (on-budget).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'close_account',
    description: 'Close an account. If it has a balance, the remaining funds must be transferred to another account.',
    parameters: {
      type: 'OBJECT',
      properties: {
        account_name: { type: 'STRING', description: 'Name of the account to close' },
        transfer_to: { type: 'STRING', description: 'Name of the account to transfer remaining balance to (required if balance is non-zero)' },
      },
      required: ['account_name'],
    },
  },
  {
    name: 'reopen_account',
    description: 'Reopen a previously closed account.',
    parameters: {
      type: 'OBJECT',
      properties: {
        account_name: { type: 'STRING', description: 'Name of the account to reopen' },
      },
      required: ['account_name'],
    },
  },

  // ── Payees ──
  {
    name: 'create_payee',
    description: 'Create a new payee (merchant/vendor). Use when the user wants to add a payee that does not exist yet.',
    parameters: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING', description: 'Payee name (e.g. "Netflix", "Landlord")' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_payee',
    description: 'Rename an existing payee.',
    parameters: {
      type: 'OBJECT',
      properties: {
        current_name: { type: 'STRING', description: 'Current name of the payee' },
        new_name: { type: 'STRING', description: 'New name for the payee' },
      },
      required: ['current_name', 'new_name'],
    },
  },
  {
    name: 'delete_payee',
    description: 'Delete a payee.',
    parameters: {
      type: 'OBJECT',
      properties: {
        payee_name: { type: 'STRING', description: 'Name of the payee to delete' },
      },
      required: ['payee_name'],
    },
  },

  // ── Batch Setup ──
  {
    name: 'setup_budget_categories',
    description: 'Create a complete personalized budget category structure in a single operation. Use this when the user describes their lifestyle, situation, or spending habits and you want to set up a tailored set of category groups and categories all at once. This avoids creating them one by one. Existing groups/categories with the same name are skipped (not duplicated).',
    parameters: {
      type: 'OBJECT',
      properties: {
        groups: {
          type: 'ARRAY',
          description: 'Array of category groups to create, each containing its categories',
          items: {
            type: 'OBJECT',
            properties: {
              name: { type: 'STRING', description: 'Category group name (e.g. "Housing", "Food & Dining")' },
              is_income: { type: 'BOOLEAN', description: 'Whether this is an income group. Defaults to false.' },
              categories: {
                type: 'ARRAY',
                description: 'Categories to create within this group',
                items: {
                  type: 'OBJECT',
                  properties: {
                    name: { type: 'STRING', description: 'Category name (e.g. "Rent", "Groceries")' },
                  },
                  required: ['name'],
                },
              },
            },
            required: ['name', 'categories'],
          },
        },
      },
      required: ['groups'],
    },
  },

  // ── Read-only queries (no confirmation needed) ──
  {
    name: 'get_transactions',
    description: 'Fetch transactions for a specific account and date range. Use when the user asks about transactions outside the pre-loaded months in the financial data, or when you need the full list for a specific period.',
    parameters: {
      type: 'OBJECT',
      properties: {
        account_name: { type: 'STRING', description: 'Account name (e.g. "Checking"). Use "all" to search across all accounts.' },
        start_date: { type: 'STRING', description: 'Start date in YYYY-MM-DD format' },
        end_date: { type: 'STRING', description: 'End date in YYYY-MM-DD format' },
      },
      required: ['account_name', 'start_date', 'end_date'],
    },
  },
  {
    name: 'get_account_balance',
    description: 'Get the current balance of a specific account.',
    parameters: {
      type: 'OBJECT',
      properties: {
        account_name: { type: 'STRING', description: 'Name of the account' },
      },
      required: ['account_name'],
    },
  },
  {
    name: 'get_exchange_rate',
    description: 'Get the historical exchange rate between two currencies for a specific date. Use this when the user needs to convert transaction amounts between currencies.',
    parameters: {
      type: 'OBJECT',
      properties: {
        date: { type: 'STRING', description: 'Date in YYYY-MM-DD format (e.g. "2025-11-30"). Use the last business day of the month for month-end rates.' },
        from_currency: { type: 'STRING', description: 'Source currency code (e.g. "USD", "EUR")' },
        to_currency: { type: 'STRING', description: 'Target currency code (e.g. "TRY", "GBP")' },
      },
      required: ['date', 'from_currency', 'to_currency'],
    },
  },
  {
    name: 'get_budget_month',
    description: 'Get budget details for a specific month including budgeted/spent/balance per category.',
    parameters: {
      type: 'OBJECT',
      properties: {
        month: { type: 'STRING', description: 'Month in YYYY-MM format' },
      },
      required: ['month'],
    },
  },
  {
    name: 'lookup_merchant',
    description: 'Look up a merchant/payee using Google Search to identify the real business behind a bank statement name. Call this IMMEDIATELY when the user asks about a merchant — do NOT ask for more info first. Use the transaction\'s "notes" field if it has more detail than the payee name, otherwise just use the payee name as-is.',
    parameters: {
      type: 'OBJECT',
      properties: {
        merchant_name: { type: 'STRING', description: 'The merchant name to search for. Prefer the "notes" field from the transaction if it contains more detail, otherwise use the payee name.' },
        country: { type: 'STRING', description: 'Country context to narrow the search (e.g. "Turkey", "US", "UK"). Infer from the account/currency if possible — do NOT ask the user.' },
      },
      required: ['merchant_name'],
    },
  },
];

// Actions that are read-only and don't need confirmation
const READ_ONLY_ACTIONS = new Set([
  'get_transactions',
  'get_account_balance',
  'get_exchange_rate',
  'get_budget_month',
  'lookup_merchant',
]);

// Actions that delete data (shown with red confirmation)
const DESTRUCTIVE_ACTIONS = new Set([
  'delete_category',
  'delete_transaction',
  'delete_payee',
  'close_account',
]);

// ─── Name-to-UUID Resolvers ───

let _cachedAccounts = null;
let _cachedCategories = null;
let _cachedCategoryGroups = null;
let _cachedPayees = null;

async function getAccounts() {
  if (!_cachedAccounts) _cachedAccounts = await actualClient.getAccounts();
  return _cachedAccounts;
}

async function getCategories() {
  if (!_cachedCategories) _cachedCategories = await actualClient.getCategories();
  return _cachedCategories;
}

async function getCategoryGroups() {
  if (!_cachedCategoryGroups) _cachedCategoryGroups = await actualClient.getCategoryGroups();
  return _cachedCategoryGroups;
}

async function getPayees() {
  if (!_cachedPayees) _cachedPayees = await actualClient.getPayees();
  return _cachedPayees;
}

function fuzzyMatch(items, nameKey, query) {
  const q = query.toLowerCase().trim();
  // Exact match
  let match = items.find(i => i[nameKey]?.toLowerCase() === q);
  if (match) return match;
  // Starts-with match
  match = items.find(i => i[nameKey]?.toLowerCase().startsWith(q));
  if (match) return match;
  // Contains match
  match = items.find(i => i[nameKey]?.toLowerCase().includes(q));
  return match || null;
}

async function resolveAccount(name) {
  const accounts = await getAccounts();
  const match = fuzzyMatch(accounts, 'name', name);
  if (!match) throw new Error(`Account "${name}" not found. Available: ${accounts.map(a => a.name).join(', ')}`);
  return match;
}

async function resolveCategory(name) {
  const categories = await getCategories();
  const match = fuzzyMatch(categories, 'name', name);
  if (!match) throw new Error(`Category "${name}" not found. Available: ${categories.filter(c => !c.hidden).map(c => c.name).join(', ')}`);
  return match;
}

async function resolveCategoryGroup(name) {
  const groups = await getCategoryGroups();
  const match = fuzzyMatch(groups, 'name', name);
  if (!match) throw new Error(`Category group "${name}" not found. Available: ${groups.map(g => g.name).join(', ')}`);
  return match;
}

async function resolvePayee(name) {
  const payees = await getPayees();
  const match = fuzzyMatch(payees, 'name', name);
  if (!match) throw new Error(`Payee "${name}" not found. Available payees include: ${payees.slice(0, 10).map(p => p.name).join(', ')}...`);
  return match;
}

function toMinorUnits(displayAmount) {
  return Math.round(displayAmount * 100);
}

// ─── Execution ───

class ActionExecutor {
  /**
   * Check if a function call requires user confirmation.
   */
  isReadOnly(functionName) {
    return READ_ONLY_ACTIONS.has(functionName);
  }

  /**
   * Check if a function call is destructive (delete/close).
   */
  isDestructive(functionName) {
    return DESTRUCTIVE_ACTIONS.has(functionName);
  }

  /**
   * Generate a human-readable description of what the action will do.
   */
  describeAction(functionName, args, context = null) {
    switch (functionName) {
      case 'set_budget_amount':
        return `Set **${args.category_name}** budget to **${Number(args.amount).toFixed(2)}** for ${args.month}`;
      case 'transfer_budget':
        return `Move **${Number(args.amount).toFixed(2)}** from **${args.from_category}** to **${args.to_category}** in ${args.month}`;
      case 'create_category':
        return `Create category **${args.name}** in group **${args.group_name}**`;
      case 'create_category_group':
        return `Create category group **${args.name}**`;
      case 'update_category':
        return `Update category **${args.current_name}**${args.new_name ? ` → rename to **${args.new_name}**` : ''}${args.new_group_name ? ` → move to **${args.new_group_name}**` : ''}`;
      case 'delete_category':
        return `Delete category **${args.category_name}**${args.transfer_to ? ` (transfer transactions to **${args.transfer_to}**)` : ''}`;
      case 'add_transaction':
        return `Add transaction: **${Number(args.amount).toFixed(2)}** to **${args.payee_name}** on ${args.date} in **${args.account_name}**${args.category_name ? ` (${args.category_name})` : ''}`;
      case 'update_transaction': {
        let txLabel = `**${args.transaction_id.slice(0, 8)}…**`;
        if (context?.months) {
          for (const m of context.months) {
            const tx = (m.transactions || []).find(t => t.id === args.transaction_id);
            if (tx) {
              const amt = (tx.amount / 100).toFixed(2);
              txLabel = `**${amt}** from **${tx.payee || 'Unknown'}** on ${tx.date}`;
              break;
            }
          }
        }
        const changes = [];
        if (args.category_name) changes.push(`category → **${args.category_name}**`);
        if (args.payee_name) changes.push(`payee → **${args.payee_name}**`);
        if (args.amount != null) changes.push(`amount → **${Number(args.amount).toFixed(2)}**`);
        if (args.date) changes.push(`date → **${args.date}**`);
        if (args.notes) changes.push(`notes → "${args.notes}"`);
        return `Update transaction ${txLabel}: ${changes.join(', ')}`;
      }
      case 'delete_transaction': {
        let txDetail = `**${args.transaction_id.slice(0, 8)}…**`;
        if (context?.months) {
          for (const m of context.months) {
            const tx = (m.transactions || []).find(t => t.id === args.transaction_id);
            if (tx) {
              const amt = (tx.amount / 100).toFixed(2);
              txDetail = `**${amt}** from **${tx.payee || 'Unknown'}** on ${tx.date} in **${tx.account || 'Unknown'}**${tx.category ? ` (${tx.category})` : ''}`;
              break;
            }
          }
        }
        return `Delete transaction: ${txDetail}`;
      }
      case 'create_account':
        return `Create ${args.offbudget ? 'off-budget' : 'on-budget'} account **${args.name}**`;
      case 'close_account':
        return `Close account **${args.account_name}**${args.transfer_to ? ` (transfer balance to **${args.transfer_to}**)` : ''}`;
      case 'reopen_account':
        return `Reopen account **${args.account_name}**`;
      case 'create_payee':
        return `Create payee **${args.name}**`;
      case 'update_payee':
        return `Rename payee **${args.current_name}** → **${args.new_name}**`;
      case 'delete_payee':
        return `Delete payee **${args.payee_name}**`;
      case 'setup_budget_categories': {
        const totalCats = (args.groups || []).reduce((sum, g) => sum + (g.categories?.length || 0), 0);
        const lines = [`Set up **${args.groups?.length || 0} groups** with **${totalCats} categories**:\n`];
        for (const g of (args.groups || [])) {
          const cats = (g.categories || []).map(c => c.name).join(', ');
          lines.push(`- **${g.name}**: ${cats}`);
        }
        return lines.join('\n');
      }
      default:
        return `Execute ${functionName}`;
    }
  }

  /**
   * Execute a function call and return the result.
   * Clears cached data after write operations.
   */
  async execute(functionName, args) {
    // Clear caches before write operations so resolvers use fresh data
    _cachedAccounts = null;
    _cachedCategories = null;
    _cachedCategoryGroups = null;
    _cachedPayees = null;

    switch (functionName) {
      case 'set_budget_amount': {
        const cat = await resolveCategory(args.category_name);
        const amount = toMinorUnits(args.amount);
        await actualClient.updateBudgetAmount(args.month, cat.id, amount);
        return { success: true, message: `Set ${args.category_name} budget to ${Number(args.amount).toFixed(2)} for ${args.month}` };
      }

      case 'transfer_budget': {
        const fromId = args.from_category.toLowerCase() === 'to be budgeted' ? null : (await resolveCategory(args.from_category)).id;
        const toId = args.to_category.toLowerCase() === 'to be budgeted' ? null : (await resolveCategory(args.to_category)).id;
        const amount = toMinorUnits(args.amount);
        await actualClient.transferBudget(args.month, fromId, toId, amount);
        return { success: true, message: `Moved ${Number(args.amount).toFixed(2)} from ${args.from_category} to ${args.to_category}` };
      }

      case 'create_category': {
        const group = await resolveCategoryGroup(args.group_name);
        const categoryId = await actualClient.createCategory({
          name: args.name,
          group_id: group.id,
          is_income: args.is_income || false,
        });
        return { success: true, message: `Created category "${args.name}" in ${group.name}`, id: categoryId };
      }

      case 'create_category_group': {
        const groupId = await actualClient.createCategoryGroup({
          name: args.name,
          is_income: args.is_income || false,
        });
        return { success: true, message: `Created category group "${args.name}"`, id: groupId };
      }

      case 'update_category': {
        const cat = await resolveCategory(args.current_name);
        const updates = {};
        if (args.new_name) updates.name = args.new_name;
        if (args.new_group_name) {
          const group = await resolveCategoryGroup(args.new_group_name);
          updates.group_id = group.id;
        }
        await actualClient.updateCategory(cat.id, updates);
        return { success: true, message: `Updated category "${args.current_name}"` };
      }

      case 'delete_category': {
        const cat = await resolveCategory(args.category_name);
        let transferId = null;
        if (args.transfer_to) {
          const transferCat = await resolveCategory(args.transfer_to);
          transferId = transferCat.id;
        }
        await actualClient.deleteCategory(cat.id, transferId);
        return { success: true, message: `Deleted category "${args.category_name}"` };
      }

      case 'add_transaction': {
        const acct = await resolveAccount(args.account_name);
        const tx = {
          date: args.date,
          amount: toMinorUnits(args.amount),
          payee_name: args.payee_name,
          cleared: false,
        };
        if (args.category_name) {
          const cat = await resolveCategory(args.category_name);
          tx.category = cat.id;
        }
        if (args.notes) tx.notes = args.notes;
        const result = await actualClient.addTransaction(acct.id, tx);
        return { success: true, message: `Added transaction: ${Number(args.amount).toFixed(2)} to ${args.payee_name}`, id: result };
      }

      case 'update_transaction': {
        const updates = {};
        if (args.category_name) {
          const cat = await resolveCategory(args.category_name);
          updates.category = cat.id;
        }
        if (args.payee_name) {
          const payee = await resolvePayee(args.payee_name);
          updates.payee = payee.id;
        }
        if (args.amount != null) updates.amount = toMinorUnits(args.amount);
        if (args.date) updates.date = args.date;
        if (args.notes !== undefined) updates.notes = args.notes;
        await actualClient.updateTransaction(args.transaction_id, updates);
        const changedFields = Object.keys(updates).join(', ');
        return { success: true, message: `Updated transaction (${changedFields})`, transaction_id: args.transaction_id };
      }

      case 'delete_transaction': {
        await actualClient.deleteTransaction(args.transaction_id);
        return { success: true, message: `Deleted transaction ${args.transaction_id}` };
      }

      case 'create_account': {
        const accountId = await actualClient.createAccount({
          name: args.name,
          offbudget: args.offbudget || false,
        });
        return { success: true, message: `Created account "${args.name}"`, id: accountId };
      }

      case 'close_account': {
        const acct = await resolveAccount(args.account_name);
        let transferAcctId = null;
        if (args.transfer_to) {
          const transferAcct = await resolveAccount(args.transfer_to);
          transferAcctId = transferAcct.id;
        }
        await actualClient.closeAccount(acct.id, transferAcctId);
        return { success: true, message: `Closed account "${args.account_name}"` };
      }

      case 'reopen_account': {
        // For closed accounts we need to search all accounts including closed
        const accounts = await getAccounts();
        const all = await actualClient.getAccounts();
        const match = fuzzyMatch(all, 'name', args.account_name);
        if (!match) throw new Error(`Account "${args.account_name}" not found`);
        await actualClient.reopenAccount(match.id);
        return { success: true, message: `Reopened account "${args.account_name}"` };
      }

      case 'create_payee': {
        const payeeId = await actualClient.createPayee({ name: args.name });
        return { success: true, message: `Created payee "${args.name}"`, id: payeeId };
      }

      case 'update_payee': {
        const payee = await resolvePayee(args.current_name);
        await actualClient.updatePayee(payee.id, { name: args.new_name });
        return { success: true, message: `Renamed payee "${args.current_name}" to "${args.new_name}"` };
      }

      case 'delete_payee': {
        const payee = await resolvePayee(args.payee_name);
        await actualClient.deletePayee(payee.id);
        return { success: true, message: `Deleted payee "${args.payee_name}"` };
      }

      case 'setup_budget_categories': {
        const results = { groupsCreated: 0, groupsSkipped: 0, categoriesCreated: 0, categoriesSkipped: 0, errors: [] };
        const existingGroups = await getCategoryGroups();
        const existingCategories = await getCategories();

        for (const groupDef of (args.groups || [])) {
          try {
            // Check if group already exists (case-insensitive)
            let group = existingGroups.find(g => g.name.toLowerCase() === groupDef.name.toLowerCase());
            if (group) {
              results.groupsSkipped++;
            } else {
              const groupId = await actualClient.createCategoryGroup({
                name: groupDef.name,
                is_income: groupDef.is_income || false,
              });
              group = { id: groupId, name: groupDef.name };
              existingGroups.push(group);
              results.groupsCreated++;
            }

            // Create categories within the group
            for (const catDef of (groupDef.categories || [])) {
              try {
                const exists = existingCategories.find(c => c.name.toLowerCase() === catDef.name.toLowerCase());
                if (exists) {
                  results.categoriesSkipped++;
                } else {
                  const catId = await actualClient.createCategory({
                    name: catDef.name,
                    group_id: group.id,
                    is_income: groupDef.is_income || false,
                  });
                  existingCategories.push({ id: catId, name: catDef.name });
                  results.categoriesCreated++;
                }
              } catch (err) {
                results.errors.push(`Category "${catDef.name}": ${err.message}`);
              }
            }
          } catch (err) {
            results.errors.push(`Group "${groupDef.name}": ${err.message}`);
          }
        }

        // Invalidate caches so subsequent operations see the new data
        _cachedCategoryGroups = null;
        _cachedCategories = null;

        const summary = [`Created ${results.groupsCreated} groups and ${results.categoriesCreated} categories.`];
        if (results.groupsSkipped) summary.push(`Skipped ${results.groupsSkipped} existing groups.`);
        if (results.categoriesSkipped) summary.push(`Skipped ${results.categoriesSkipped} existing categories.`);
        if (results.errors.length) summary.push(`Errors: ${results.errors.join('; ')}`);

        return {
          success: results.errors.length === 0,
          message: summary.join(' '),
          ...results,
        };
      }

      // ── Read-only actions (executed immediately, no confirmation) ──

      case 'get_transactions': {
        const allAccounts = await getAccounts();
        const categories = await getCategories();
        const payees = await getPayees();

        const categoryMap = {};
        for (const c of categories) categoryMap[c.id] = c.name;
        const payeeMap = {};
        for (const p of payees) payeeMap[p.id] = p.name;

        const targetAccounts = args.account_name.toLowerCase() === 'all'
          ? allAccounts.filter(a => !a.closed)
          : [await resolveAccount(args.account_name)];

        const allTxs = [];
        for (const acct of targetAccounts) {
          const txs = await actualClient.getTransactions(acct.id, args.start_date, args.end_date);
          for (const t of txs) {
            const isTransfer = !!t.transfer_id;
            allTxs.push({
              id: t.id,
              date: t.date,
              payee: payeeMap[t.payee] || t.imported_payee || 'Unknown',
              category: categoryMap[t.category] || (isTransfer ? 'Transfer' : 'Uncategorized'),
              amount: (t.amount / 100).toFixed(2),
              account: acct.name,
              notes: t.notes || null,
              is_transfer: isTransfer,
            });
          }
        }

        return {
          success: true,
          count: allTxs.length,
          start_date: args.start_date,
          end_date: args.end_date,
          note: 'All amounts are in display units (e.g. 500.00 means five hundred). Do NOT divide by 100 again.',
          transactions: allTxs,
        };
      }

      case 'get_exchange_rate': {
        const { date, from_currency, to_currency } = args;
        const url = `https://api.frankfurter.app/${date}?from=${from_currency.toUpperCase()}&to=${to_currency.toUpperCase()}`;
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Failed to fetch exchange rate: ${response.status} ${response.statusText}. The date may be a weekend/holiday — try the previous business day.`);
        }
        const data = await response.json();
        const rate = data.rates?.[to_currency.toUpperCase()];
        if (!rate) {
          throw new Error(`Exchange rate for ${from_currency}→${to_currency} not found. Supported currencies include: USD, EUR, TRY, GBP, JPY, etc.`);
        }
        return {
          success: true,
          date: data.date,
          from: from_currency.toUpperCase(),
          to: to_currency.toUpperCase(),
          rate,
          note: `1 ${from_currency.toUpperCase()} = ${rate} ${to_currency.toUpperCase()} on ${data.date}`,
        };
      }

      case 'get_account_balance': {
        const acct = await resolveAccount(args.account_name);
        const balance = await actualClient.getAccountBalance(acct.id);
        return { success: true, account: acct.name, balance: (balance / 100).toFixed(2), note: 'Balance is in display units. Do NOT divide by 100 again.' };
      }

      case 'get_budget_month': {
        const data = await actualClient.getBudgetMonth(args.month);
        return { success: true, data };
      }

      case 'lookup_merchant': {
        const result = await gemini.lookupMerchant(args.merchant_name, args.country);
        return { success: true, ...result };
      }

      default:
        throw new Error(`Unknown action: ${functionName}`);
    }
  }
}

const actionExecutor = new ActionExecutor();
export default actionExecutor;
