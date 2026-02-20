/**
 * Actual AI — Google Gemini Service
 *
 * Handles all interactions with Google's Generative AI API.
 * Uses the user's own API key stored in extension settings.
 */

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_CHAT_MODEL = 'gemini-2.0-flash';
const DEFAULT_PARSE_MODEL = 'gemini-2.0-flash';

/**
 * Supported Gemini models.
 * Each entry can optionally flag whether it supports tool/function calling.
 */
const SUPPORTED_MODELS = [
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (latest)', tools: true },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (highest quality)', tools: true },
  { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash (recommended)', tools: true },
  { id: 'gemini-2.0-flash-lite', label: 'Gemini 2.0 Flash Lite (fastest)', tools: true },
  { id: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro', tools: true },
];

class GeminiService {
  constructor() {
    this.apiKey = null;
    this.chatModel = DEFAULT_CHAT_MODEL;
    this.parseModel = DEFAULT_PARSE_MODEL;
  }

  async init() {
    // Load API key and per-purpose models from chrome.storage.
    // Falls back to legacy "geminiModel" for smooth migration.
    const result = await chrome.storage.local.get([
      'geminiApiKey', 'geminiChatModel', 'geminiParseModel', 'geminiModel',
    ]);
    this.apiKey = result.geminiApiKey || null;
    this.chatModel = result.geminiChatModel || result.geminiModel || DEFAULT_CHAT_MODEL;
    this.parseModel = result.geminiParseModel || result.geminiModel || DEFAULT_PARSE_MODEL;
  }

  setApiKey(key) {
    this.apiKey = key;
    chrome.storage.local.set({ geminiApiKey: key });
  }

  isConfigured() {
    return !!this.apiKey;
  }

  /**
   * @param {string} [modelOverride] — explicit model to use for this request.
   */
  async _request(contents, systemInstruction = null, generationConfig = {}, tools = null, modelOverride = null) {
    if (!this.apiKey) {
      throw new Error('Gemini API key not configured. Please set it in extension options.');
    }

    const model = modelOverride || this.chatModel;
    const url = `${GEMINI_API_BASE}/models/${model}:generateContent?key=${this.apiKey}`;

    const body = {
      contents,
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 8192,
        ...generationConfig,
      },
    };

    if (systemInstruction) {
      body.systemInstruction = {
        parts: [{ text: systemInstruction }],
      };
    }

    if (tools) {
      body.tools = tools;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(`Gemini API error ${response.status}: ${err?.error?.message || response.statusText}`);
    }

    const data = await response.json();

    // When tools are provided, return the full parts array so the caller
    // can inspect whether the response contains text or a functionCall.
    if (tools) {
      return data.candidates?.[0]?.content?.parts || [];
    }

    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  // ─── Bank Statement Parsing ───

  async parseStatement(rawText, currency = 'TRY', statementType = 'bank') {
    const isCreditCard = statementType === 'credit_card';

    const signConvention = isCreditCard
      ? `CREDIT CARD SIGN CONVENTION (this is a credit card statement):
- Purchases, fees, interest charges → NEGATIVE (they are expenses the user spent)
- Payments to the card, refunds, credits → POSITIVE (they reduce the balance owed)
- On credit card statements, charges are often shown as positive numbers and payments
  as negative. You MUST INVERT THEM: charges become negative, payments become positive.
- Think of it from the user's perspective: buying something = money going OUT = negative.`
      : `BANK ACCOUNT SIGN CONVENTION (this is a bank/debit account statement):
- Withdrawals, purchases, fees, outflows → NEGATIVE (money leaving the account)
- Deposits, income, refunds, inflows → POSITIVE (money entering the account)
- If the statement has separate debit/credit columns, make debits negative and credits positive.`;

    const systemPrompt = `You are a financial data extraction engine. You parse bank/credit card statements into structured JSON.

RULES:
- Extract every transaction row from the statement.
- Dates MUST be in YYYY-MM-DD format (convert from any format you see).
- Amounts are DECIMAL NUMBERS (e.g. -123.45, 1500.00). NOT cents — conversion happens downstream.

${signConvention}

VALIDATION — USE THE RUNNING BALANCE:
- If the statement includes a running/closing balance per transaction, use it to verify your sign choices.
  For a bank account: previous_balance + amount = next_balance.
  For a credit card: previous_balance + amount = next_balance (where balance is what's owed).
- If your signs don't produce a balance that matches, flip them.
- If opening and closing balances are available, verify that the sum of all transaction amounts
  bridges from opening to closing balance. If it doesn't, your signs are wrong.

OTHER RULES:
- Include the raw description/narrative exactly as shown in the statement.
- Detect the statement period (start and end dates).
- Detect opening and closing balances if present (as decimal numbers, using the same sign convention).
- Running balance per transaction if shown (as decimal number).
- Currency: ${currency}

Respond ONLY with valid JSON, no markdown fences, no explanation.`;

    const userPrompt = `Parse this bank statement text into structured data:

${rawText}

Return this exact JSON structure:
{
  "bankName": "detected bank name or null",
  "accountNumber": "detected account number or null",
  "currency": "${currency}",
  "periodStart": "YYYY-MM-DD",
  "periodEnd": "YYYY-MM-DD",
  "openingBalance": number_or_null,
  "closingBalance": number_or_null,
  "transactions": [
    {
      "date": "YYYY-MM-DD",
      "description": "raw description text",
      "amount": -123.45,
      "balance": 1234.56,
      "type": "debit|credit"
    }
  ]
}`;

    const text = await this._request(
      [{ role: 'user', parts: [{ text: userPrompt }] }],
      systemPrompt,
      { temperature: 0.1, responseMimeType: 'application/json' },
      null,
      this.parseModel
    );

    try {
      let cleaned = text.replace(/```json\n?|```/g, '').trim();
      // Sanitize control characters inside JSON string values (tabs, newlines, etc.)
      // that Gemini sometimes emits when bank descriptions contain special chars.
      cleaned = cleaned.replace(/[\x00-\x1F\x7F]/g, (ch) => {
        if (ch === '\n' || ch === '\r' || ch === '\t') return ' ';
        return '';
      });
      return JSON.parse(cleaned);
    } catch (e) {
      throw new Error(`Failed to parse Gemini response as JSON: ${e.message}`);
    }
  }

  // ─── Transaction Categorization ───

  async categorizeTransactions(transactions, categories, categoryGroups = []) {
    let categoryList;
    if (categoryGroups.length > 0) {
      // Build hierarchical representation: group → categories
      const groupMap = {};
      for (const g of categoryGroups) groupMap[g.id] = { name: g.name, categories: [] };
      const ungrouped = [];
      for (const c of categories) {
        if (c.group_id && groupMap[c.group_id]) {
          groupMap[c.group_id].categories.push(c);
        } else {
          ungrouped.push(c);
        }
      }
      const lines = [];
      for (const g of categoryGroups) {
        const entry = groupMap[g.id];
        if (entry.categories.length === 0) continue;
        lines.push(`${entry.name}:`);
        for (const c of entry.categories) {
          lines.push(`  - ${c.name} (id: ${c.id})`);
        }
      }
      if (ungrouped.length > 0) {
        lines.push('Other:');
        for (const c of ungrouped) lines.push(`  - ${c.name} (id: ${c.id})`);
      }
      categoryList = lines.join('\n');
    } else {
      categoryList = categories.map(c => `- ${c.name} (id: ${c.id})`).join('\n');
    }

    const systemPrompt = `You are a financial categorization engine. Given transactions and available categories (organized by group), assign the most appropriate category to each transaction.

Available categories:
${categoryList}

RULES:
- Match each transaction to exactly one category using the group context to pick the best fit
- Use the category id in your response
- Include a confidence score (0.0 to 1.0)
- Also suggest a clean merchant name
- Respond ONLY with valid JSON, no markdown fences`;

    // Use simple sequential indices instead of UUIDs — LLMs are unreliable
    // at echoing back long UUIDs, causing match failures downstream.
    const idMap = {}; // index → original ID
    const txList = transactions.map((t, i) => {
      idMap[String(i)] = t.id;
      return {
        id: i,
        description: t.rawDescription || t.description,
        amount: t.amount,
        date: t.date,
      };
    });

    const userPrompt = `Categorize these ${txList.length} transactions:

${JSON.stringify(txList, null, 2)}

Return a JSON array with exactly ${txList.length} items, one per transaction, in the same order:
[
  {
    "transactionId": 0,
    "categoryId": "matched category id",
    "categoryName": "matched category name",
    "cleanPayee": "cleaned merchant name",
    "confidence": 0.95
  }
]`;

    const text = await this._request(
      [{ role: 'user', parts: [{ text: userPrompt }] }],
      systemPrompt,
      { temperature: 0.1, responseMimeType: 'application/json' },
      null,
      this.parseModel
    );

    try {
      let cleaned = text.replace(/```json\n?|```/g, '').trim();
      cleaned = cleaned.replace(/[\x00-\x1F\x7F]/g, (ch) => {
        if (ch === '\n' || ch === '\r' || ch === '\t') return ' ';
        return '';
      });
      const results = JSON.parse(cleaned);

      // Map sequential indices back to original IDs
      for (const r of results) {
        const key = String(r.transactionId);
        if (idMap[key]) {
          r.transactionId = idMap[key];
        }
      }
      return results;
    } catch (e) {
      throw new Error(`Failed to parse categorization response: ${e.message}`);
    }
  }

  // ─── Financial Q&A ───

  async askFinancialQuestion(question, context) {
    const systemPrompt = `You are a helpful personal finance assistant for Actual Budget. You answer questions based ONLY on the financial data provided in the context. Be concise, specific, and use actual numbers.

DATA FORMAT (Actual Budget API):
- ALL monetary amounts in the data are INTEGERS in MINOR UNITS (cents or kuruş).
  To display: divide by 100. Example: 69990 → 699.90, -250000 → -2,500.00
- This applies to EVERY numeric amount: account balances, transaction amounts,
  budget figures (budgeted, spent, balance), income, expenses, and totals.
- Negative amounts = expenses/debits/outflows
- Positive amounts = income/credits/inflows

ACTUAL BUDGET CONCEPTS:
- "accounts" have a current balance and can be on-budget or off-budget.
  On-budget accounts are tracked by the budget. Off-budget accounts (savings, investments)
  hold money but aren't part of the monthly budgeting workflow.
- "budgetMonths" show the budget plan vs reality for each month:
  · "totalBudgeted" = how much was allocated to categories
  · "totalSpent" = how much was actually spent (negative number)
  · "totalBalance" = remaining budget across all categories
  · "toBudget" = money available to assign to categories
  · "categoryGroups" break this down by group (e.g. Bills, Food, Transport)
    with budgeted/spent/balance per group
- Transactions with "is_transfer: true" are internal moves between accounts
  (e.g. checking → savings). They do NOT count as income or spending.
  The totalIncome/totalExpenses in months already exclude transfers.

FIELD DESCRIPTIONS:
- "payee": the human-readable merchant/vendor name (already resolved from ID)
- "category": the human-readable category name (already resolved from ID)
- "account": the human-readable account name
- "notes": optional user notes on a transaction
- "offbudget": true if the account is off-budget (savings, investments, etc.)

RESPONSE RULES:
- Only reference data provided in the context — never fabricate numbers
- Always convert minor units to display format when presenting amounts to the user
  (e.g. show "2,500.00" not "250000")
- Format amounts clearly with two decimals and thousands separators
- If you can't answer from the data, say so clearly
- Be conversational but precise
- When comparing periods, calculate actual differences and percentages
- Suggest actionable insights when relevant
- When discussing budgets, compare budgeted vs spent to show over/under spending`;

    // Build a leaner representation to stay within token limits
    const lean = {
      summary: context.summary,
      accounts: context.accounts,
      categories: context.categories?.map(c => c.name),
      budgetMonths: (context.budgetMonths || []).map(bm => ({
        month: bm.month,
        totalIncome: bm.totalIncome,
        totalSpent: bm.totalSpent,
        totalBudgeted: bm.totalBudgeted,
        totalBalance: bm.totalBalance,
        toBudget: bm.toBudget,
        categoryGroups: bm.categoryGroups,
      })),
      months: (context.months || []).map(m => ({
        month: m.month,
        count: m.transactionCount,
        income: m.totalIncome,
        expenses: m.totalExpenses,
        net: m.net,
        // Include up to 100 transactions per month to stay within limits
        transactions: (m.transactions || []).slice(0, 100),
      })),
    };

    const userPrompt = `Here is my financial data:

${JSON.stringify(lean, null, 2)}

My question: ${question}`;

    return this._request(
      [{ role: 'user', parts: [{ text: userPrompt }] }],
      systemPrompt,
      { temperature: 0.4 },
      null,
      this.chatModel
    );
  }

  // ─── Conversational Assistant with Actions ───

  /**
   * Build the lean financial context object from the full context.
   */
  _buildLeanContext(context) {
    return {
      isNewBudget: context.isNewBudget || false,
      summary: context.summary,
      accounts: context.accounts,
      categories: context.categories?.map(c => c.name),
      budgetMonths: (context.budgetMonths || []).map(bm => ({
        month: bm.month,
        totalIncome: bm.totalIncome,
        totalSpent: bm.totalSpent,
        totalBudgeted: bm.totalBudgeted,
        totalBalance: bm.totalBalance,
        toBudget: bm.toBudget,
        categoryGroups: bm.categoryGroups,
      })),
      months: (context.months || []).map(m => ({
        month: m.month,
        count: m.transactionCount,
        income: m.totalIncome,
        expenses: m.totalExpenses,
        net: m.net,
        transactions: (m.transactions || []).slice(0, 100),
      })),
    };
  }

  async chatWithActions(context, functionDeclarations, history) {
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const today = now.toISOString().split('T')[0];
    const lean = this._buildLeanContext(context);

    const systemPrompt = `You are a smart personal finance assistant for Actual Budget. You can both ANSWER QUESTIONS about the user's finances and TAKE ACTIONS to manage their budget.

You are in a multi-turn conversation. The user may refer to things discussed earlier — use the conversation history to understand context. Never ask the user to repeat information they already provided.

TODAY: ${today}
CURRENT MONTH: ${currentMonth}

CURRENT FINANCIAL DATA:
${JSON.stringify(lean, null, 2)}

DATA FORMAT:
- All monetary amounts in the financial data above are integers in MINOR UNITS (cents/kuruş). Divide by 100 to display.
- When YOU specify amounts in function calls, use DISPLAY UNITS (e.g. 500 means 500.00, NOT 50000).
- Negative amounts = expenses/debits, positive = income/credits.

YOUR DATA — YOU CAN SEARCH IT:
- The CURRENT FINANCIAL DATA above contains INDIVIDUAL TRANSACTION records under months[].transactions[].
- Each transaction has: id, date, payee, category, amount, account, notes, is_transfer.
- You CAN and SHOULD search, filter, and list these transactions when the user asks about specific transactions, transfers, uncategorized items, large expenses, transactions from a payee, etc.
- When the user says "find", "show me", "list", "which ones", "search" — look through the transaction data and answer directly.
- Use the "id" field to reference specific transactions when calling update_transaction or delete_transaction.
- The pre-loaded data only covers the most recent ~3 months. If the user asks about an OLDER month not in the data, use the get_transactions function to fetch it on demand. NEVER say you can't access older data — just fetch it.

WHEN TO USE FUNCTIONS vs TEXT:
- If the user asks a QUESTION (how much, what are, show me, find, list, etc.) → answer with text by searching through the financial data.
- If the user wants to DO something (set, create, add, budget, move, delete, rename, etc.) → call the appropriate function.
- If the user's intent is ambiguous, ask for clarification in text.
- If the user says "yes", "ok", "do it", "go ahead" etc., look at the conversation history to understand what they're agreeing to, and proceed with the appropriate action.

CRITICAL — ONE FUNCTION CALL AT A TIME:
- You can only call ONE function per response. NEVER try to call multiple functions at once.
- NEVER generate code, scripts, or tool_code blocks. Only use the proper function calling mechanism.
- If the user asks for multiple actions (e.g. "add two transactions"), do the FIRST one now. After it completes, you will be asked to continue — then do the next one.
- When doing the first of multiple actions, mention how many remain so the user knows to continue. Example: "Let me add the first transaction (1 of 2)..."

CRITICAL — UPDATING vs ADDING TRANSACTIONS:
- When the user wants to CATEGORIZE, RE-CATEGORIZE, EDIT, FIX, or MODIFY an existing transaction, you MUST use update_transaction with the transaction's ID (from the financial data). NEVER use add_transaction for this — that creates a duplicate.
- Each transaction in the financial data has an "id" field. Use this ID when calling update_transaction or delete_transaction.
- add_transaction is ONLY for creating brand-new transactions that don't exist yet.
- If the user asks to categorize an uncategorized transaction, find it in the data, get its "id", and call update_transaction with the new category_name.
- NEVER ask the user for a transaction ID, payee name, or any detail that you can find in the financial data or conversation history. If you discussed a transaction earlier in the conversation, you already have its ID — use it. Search through months[].transactions[] and the conversation history to find it.

RESOLVING REFERENCES:
- "this month" → ${currentMonth}
- "next month" → compute the next month from ${currentMonth}
- "last month" → compute the previous month from ${currentMonth}
- "today" → ${today}
- For category/account/payee names, use the names as the user says them. The system will fuzzy-match to the actual names.
- If the user refers to "it", "that", "the same one", etc., resolve from conversation history.

ACTUAL BUDGET CONCEPTS:
- On-budget accounts are tracked by the budget. Off-budget accounts (savings, investments) are not.
- "budgetMonths" data shows budgeted/spent/balance per category group for each month.
- Transactions with "is_transfer: true" are internal moves between accounts.
- "toBudget" is unallocated money available to assign to categories.

MERCHANT LOOKUP:
- Bank statement merchant names are often cryptic codes (e.g. "AMZN*1A2B3C", "CKO*BOLT", "PAYU*TRENDYOL", "TST* SQUARE 1234").
- When the user asks "what is this merchant?", "look up this merchant", "find on google", etc., use the lookup_merchant function IMMEDIATELY. Do NOT ask the user for more information first — just call the function with what you have.
- Prefer the transaction's "notes" field (raw bank statement text) over the clean payee name, as it often has more detail. But if notes is empty or the same as the payee name, just use the payee name — that's fine.
- NEVER ask the user for the "notes" field, the raw description, or the country. Find the transaction in the financial data yourself, check its notes field, and if it has useful content use it. If not, use whatever name you have and call lookup_merchant right away.
- AFTER a successful merchant lookup, DO NOT just report the result and wait. IMMEDIATELY proceed to call update_payee to rename the payee to the identified real business name, OR update_transaction to fix the category. Pick the most relevant action and do it in the SAME turn (after the lookup result comes back). The user should not have to ask you to make the edit — be proactive.
- When looking up a merchant that was discussed earlier in the conversation, you ALREADY KNOW its transaction ID, payee name, date, amount, and account from the earlier messages and financial data. NEVER ask the user for a transaction ID you already have in the conversation history or in the financial data. Search the data and the history to find it.

CURRENCY CONVERSION:
- Actual Budget does not natively support multi-currency. If the user has accounts in different currencies, you can help convert transactions.
- Use get_exchange_rate to fetch historical FX rates for any date.
- To convert transactions: fetch the rate, calculate the new amount (original × rate), then update_transaction with the converted amount.
- For month-end rates, use the last business day of the month (not weekends/holidays).
- Process conversions one transaction at a time using the one-function-at-a-time rule.

PERSONALIZED CATEGORY SETUP:
- When the user tells you about themselves (lifestyle, job, family, hobbies, subscriptions, living situation, pets, etc.), use setup_budget_categories to create a COMPLETE personalized category structure in one go.
- Tailor categories to what they actually told you. Examples:
  • "I have a car" → add Transport group with Fuel, Car Insurance, Maintenance, Parking
  • "I have a dog" → add Pets group with Vet, Pet Food, Pet Supplies
  • "I rent" → add Housing group with Rent, Utilities, Internet, Renter's Insurance
  • "I own a home" → Housing group with Mortgage, Property Tax, Home Insurance, Maintenance
  • "I have subscriptions to Netflix and Spotify" → add Subscriptions group with Netflix, Spotify
  • "I'm married" → consider shared expenses, dining out, date nights
  • "I have kids" → add Kids/Family group with Childcare, School, Kids Activities, Kids Clothing
- Always include sensible defaults alongside personalized ones (e.g. Income group, Savings, Emergency Fund, Healthcare).
- If the user doesn't describe themselves but just says "set up categories" or similar, ask about their situation first before creating categories. A few targeted questions will make the result much better.
- When existing categories are already present, the batch action will skip duplicates automatically.

ONBOARDING:
- If "isNewBudget" is true in the financial data (0 accounts or 0 categories), the user has a fresh budget.
  Guide them step by step: (1) create accounts, (2) set up categories (offer to personalize based on their lifestyle), (3) set budget amounts.
- When the user says something vague like "help me set up" or "I'm new",
  walk them through the setup by suggesting one action at a time.
- After each action completes, suggest the natural next step clearly.
  End your response with a concrete suggestion like: "Next, tell me a bit about yourself — your living situation, transport, subscriptions — and I'll create personalized categories for you!"
- Be encouraging and explain WHY each step matters in plain language.
- Even if the budget is not new, if the user asks basic questions about how
  budgets work, explain concepts like on-budget accounts, category groups,
  budgeting to zero, and envelope budgeting in simple terms.

BE DECISIVE — DO NOT OVER-ASK:
- If you can infer details from the conversation history and financial data, JUST DO IT. Do not ask the user to confirm what you already know.
- When the user asks to do something and the context already contains the relevant data (amounts, dates, accounts, categories), fill in the blanks yourself and proceed with the action.
- Use common sense for missing details:
  · If the user discusses a specific month, use that month for dates (default to the 1st).
  · If the user says "income", use the "Income" category (or the closest match).
  · If the user says "reconcile" transfers, sum the amounts and create the offsetting transaction.
  · If there's only one plausible account/category/payee, use it without asking.
- Only ask a question when there is GENUINE AMBIGUITY that you cannot resolve from context — e.g. the user hasn't mentioned which account at all and there are multiple options.
- One clarifying question per turn is the maximum. NEVER ask 2+ questions in a single response.
- The user can always reject the action at the confirmation step, so err on the side of acting rather than asking.

RESPONSE RULES:
- Be concise, friendly, and use actual numbers from the data.
- Always show amounts in display format (e.g. 2,500.00 not 250000).
- When showing balances or totals, convert from minor units (divide by 100).
- If a function call fails, explain the error clearly and suggest what the user can do.`;

    const contents = [...history];
    const tools = [{ function_declarations: functionDeclarations }];

    const parts = await this._request(contents, systemPrompt, { temperature: 0.3 }, tools, this.chatModel);
    return this._parseResponseParts(parts);
  }

  /**
   * After executing a function, send the result back to Gemini so it can
   * generate a human-friendly summary of what happened.
   * Uses the full conversation history (which already includes the function
   * call and function response entries).
   */
  async sendFunctionResult(context, history) {
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const today = now.toISOString().split('T')[0];
    const lean = this._buildLeanContext(context);

    const systemPrompt = `You are a smart personal finance assistant for Actual Budget. You just executed an action on behalf of the user. Summarize what happened in a brief, friendly message.

TODAY: ${today}
CURRENT MONTH: ${currentMonth}

CURRENT FINANCIAL DATA:
${JSON.stringify(lean, null, 2)}

RESPONSE GUIDELINES:
- Summarize the completed action clearly and concisely.
- All amounts in the financial data are in minor units (cents/kuruş) — divide by 100 to display.
- If the action failed, explain why and suggest alternatives.
- You have the full conversation history. Use it to understand the broader context of what the user is doing.
- IMPORTANT: If the conversation history shows the user asked for MULTIPLE actions and you just completed one, tell the user what was done and ask if they'd like you to proceed with the next one. Be specific about what the next action will be.
- After summarizing, suggest a clear, concrete next step. For example:
  "Next, would you like to create some category groups? I'd suggest starting with Bills, Food, Transport, and Entertainment."
- If the user is setting up a new budget (isNewBudget is true), always guide them forward:
  After creating accounts → suggest creating category groups
  After creating category groups → suggest creating categories within them
  After creating categories → suggest setting budget amounts
  After setting budget amounts → suggest adding their first transaction or importing a statement
- Make the next step actionable — phrase it so the user can simply say "yes" or "do it" to proceed.
- MERCHANT LOOKUP FOLLOW-UP: If the action just completed was a lookup_merchant, summarize what was found and then IMMEDIATELY state what you will do next: "I'll rename the payee to [real name] and update the category to [appropriate category]." Then the user can just say "yes" to proceed. Include the specific transaction ID and details from the conversation history — NEVER ask the user for information you already have.`;

    const contents = [...history];

    const text = await this._request(contents, systemPrompt, { temperature: 0.3 }, null, this.chatModel);
    return typeof text === 'string' ? text : (text?.[0]?.text || 'Action completed.');
  }

  /**
   * Parse Gemini response parts into a structured result.
   * Returns { type: 'text', text } or { type: 'functionCall', name, args }.
   */
  _parseResponseParts(parts) {
    if (!parts || parts.length === 0) {
      return { type: 'text', text: 'I could not generate a response. Please try again.' };
    }

    // Check for function call first
    for (const part of parts) {
      if (part.functionCall) {
        return {
          type: 'functionCall',
          name: part.functionCall.name,
          args: part.functionCall.args || {},
        };
      }
    }

    // Otherwise it's a text response
    const textParts = parts.filter(p => p.text).map(p => p.text);
    return { type: 'text', text: textParts.join('\n') || 'I could not generate a response.' };
  }

  // ─── Summary Generation ───

  async generateSummary(transactions, period) {
    const systemPrompt = `You are a financial analyst. Generate a brief, insightful monthly summary from transaction data. Be specific with numbers and highlight notable patterns. Keep it to 3-4 sentences.`;

    const userPrompt = `Generate a financial summary for ${period}:

${JSON.stringify(transactions, null, 2)}

Include: total income, total expenses, net, top spending categories, and any notable patterns.`;

    return this._request(
      [{ role: 'user', parts: [{ text: userPrompt }] }],
      systemPrompt,
      { temperature: 0.3 },
      null,
      this.parseModel
    );
  }

  // ─── Merchant Lookup (Grounded Search) ───

  async lookupMerchant(merchantName, country = null) {
    if (!this.apiKey) {
      throw new Error('Gemini API key not configured.');
    }

    const model = this.chatModel;
    const url = `${GEMINI_API_BASE}/models/${model}:generateContent?key=${this.apiKey}`;

    const countryHint = country ? ` The merchant is likely based in or operates in ${country}.` : '';

    const body = {
      contents: [{
        role: 'user',
        parts: [{
          text: `What is the real business behind this bank statement merchant name: "${merchantName}"?${countryHint}

Please identify:
1. The real business/company name
2. What they sell or do (brief description)
3. Their industry/category (e.g. "Restaurant", "Online Shopping", "Transportation", "Subscription Service")
4. Their website if known

Bank statements often use abbreviated or coded merchant names. Common patterns include payment processor prefixes like "PP*", "SQ*", "TST*", "CKO*", "PAYU*", "AMZN*", "APL*", etc.` }],
      }],
      tools: [{ google_search: {} }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 1024,
      },
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(`Gemini API error ${response.status}: ${err?.error?.message || response.statusText}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts
      ?.filter(p => p.text)
      .map(p => p.text)
      .join('\n') || 'Could not identify this merchant.';

    const grounding = data.candidates?.[0]?.groundingMetadata;
    const sources = grounding?.groundingChunks
      ?.filter(c => c.web)
      .map(c => ({ title: c.web.title, url: c.web.uri })) || [];

    return {
      merchant_name: merchantName,
      analysis: text,
      sources,
    };
  }

  // ─── API Key Validation ───

  async validateApiKey(key) {
    const url = `${GEMINI_API_BASE}/models/${DEFAULT_CHAT_MODEL}:generateContent?key=${key}`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Say "ok"' }] }],
          generationConfig: { maxOutputTokens: 5 },
        }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

const gemini = new GeminiService();
export default gemini;
export { SUPPORTED_MODELS, DEFAULT_CHAT_MODEL, DEFAULT_PARSE_MODEL };
