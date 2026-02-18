/**
 * Actual AI — Ingestion Pipeline
 *
 * Orchestrates the full flow:
 *   PDF → Text extraction → Gemini parsing → Categorization → Actual import
 */

import database from './database.js';
import gemini from './gemini.js';
import actualClient from './actual-client.js';
import pdfParser from './pdf-parser.js';

function uuid() {
  return crypto.randomUUID();
}

function amountToCents(amount) {
  return Math.round(amount * 100);
}

class IngestionPipeline {

  constructor() {
    this.onProgress = null; // callback: (step, message, percent) => {}
  }

  _emit(step, message, percent = null) {
    if (this.onProgress) {
      this.onProgress({ step, message, percent });
    }
  }

  /**
   * Full ingestion pipeline for a single PDF statement
   *
   * @param {File} file - The uploaded PDF
   * @param {string} accountId - Target Actual Budget account ID
   * @param {string} currency - Currency code
   * @returns {Promise<{statementId: string, transactionCount: number}>}
   */
  async ingest(file, accountId, currency = 'TRY', statementType = 'bank') {
    const statementId = uuid();

    try {
      // ─── Step 1: Hash check for duplicates ───
      this._emit('hash', 'Checking for duplicates...', 5);
      const fileHash = await pdfParser.hashFile(file);
      const existing = await database.getStatementByHash(fileHash);
      if (existing) {
        throw new Error(`This statement has already been uploaded (${existing.fileName}).`);
      }

      // ─── Step 2: Extract text from PDF ───
      this._emit('extract', 'Extracting text from PDF...', 15);
      const { text, pageCount } = await pdfParser.extractText(file);

      if (!text || text.trim().length < 50) {
        throw new Error(
          'Could not extract meaningful text from this PDF. It may be a scanned image — try a text-based PDF.'
        );
      }

      // ─── Step 3: Save statement record ───
      this._emit('save', 'Saving statement...', 25);
      await database.put('statements', {
        id: statementId,
        accountId,
        fileName: file.name,
        fileHash,
        pageCount,
        rawText: text,
        statementType,
        parseStatus: 'parsing',
        createdAt: new Date().toISOString(),
      });

      // ─── Step 4: Parse with Gemini ───
      this._emit('parse', 'AI is parsing your statement...', 35);
      const parsed = await gemini.parseStatement(text, currency, statementType);

      if (!parsed.transactions || parsed.transactions.length === 0) {
        await database.put('statements', {
          ...(await database.get('statements', statementId)),
          parseStatus: 'failed',
        });
        throw new Error('AI could not find any transactions in this statement.');
      }

      // ─── Step 4b: Validate and auto-correct sign convention ───
      this._validateSigns(parsed, statementType);

      // Update statement with parsed metadata
      await database.put('statements', {
        ...(await database.get('statements', statementId)),
        bankName: parsed.bankName,
        accountNumber: parsed.accountNumber,
        periodStart: parsed.periodStart,
        periodEnd: parsed.periodEnd,
        openingBalance: parsed.openingBalance ? amountToCents(parsed.openingBalance) : null,
        closingBalance: parsed.closingBalance ? amountToCents(parsed.closingBalance) : null,
        transactionCount: parsed.transactions.length,
        parseStatus: 'parsed',
      });

      // ─── Step 5: Store parsed transactions ───
      this._emit('store', `Found ${parsed.transactions.length} transactions. Processing...`, 50);
      const parsedTxs = parsed.transactions.map(tx => ({
        id: uuid(),
        statementId,
        date: tx.date,
        amount: amountToCents(tx.amount),
        rawDescription: tx.description,
        balance: tx.balance ? amountToCents(tx.balance) : null,
        type: tx.type || (tx.amount < 0 ? 'debit' : 'credit'),
        importStatus: 'pending',
        suggestedCategory: null,
        suggestedCategoryId: null,
        cleanPayee: null,
        confidence: null,
        createdAt: new Date().toISOString(),
      }));

      await database.putBatch('parsedTransactions', parsedTxs);

      // ─── Step 6: Auto-categorize using known mappings ───
      this._emit('categorize_local', 'Matching known merchants...', 60);
      let uncategorized = [];

      for (const tx of parsedTxs) {
        const mapping = await database.findMerchantMapping(tx.rawDescription);
        if (mapping) {
          tx.cleanPayee = mapping.cleanName;
          tx.suggestedCategoryId = mapping.actualCategoryId;
          tx.suggestedCategory = mapping.categoryName;
          tx.confidence = 1.0;
          tx.mappingSource = 'local';
          await database.put('parsedTransactions', tx);
        } else {
          uncategorized.push(tx);
        }
      }

      // ─── Step 7: AI categorization for unknowns ───
      if (uncategorized.length > 0) {
        this._emit(
          'categorize_ai',
          `AI is categorizing ${uncategorized.length} new transactions...`,
          75
        );

        try {
          const [categories, categoryGroups] = await Promise.all([
            actualClient.getCategories(),
            actualClient.getCategoryGroups(),
          ]);
          const suggestions = await gemini.categorizeTransactions(uncategorized, categories, categoryGroups);

          for (const suggestion of suggestions) {
            const tx = parsedTxs.find(t => t.id === suggestion.transactionId);
            if (tx) {
              tx.cleanPayee = suggestion.cleanPayee;
              tx.suggestedCategoryId = suggestion.categoryId;
              tx.suggestedCategory = suggestion.categoryName;
              tx.confidence = suggestion.confidence;
              tx.mappingSource = 'gemini';
              await database.put('parsedTransactions', tx);
            }
          }
        } catch (err) {
          console.warn('AI categorization failed, transactions will be uncategorized:', err);
          // Non-fatal — user can categorize manually
        }
      }

      // ─── Step 8: Done — ready for user review ───
      this._emit('ready', `Ready! ${parsed.transactions.length} transactions parsed.`, 100);

      return {
        statementId,
        transactionCount: parsed.transactions.length,
        categorized: parsedTxs.filter(t => t.suggestedCategoryId).length,
        uncategorized: parsedTxs.filter(t => !t.suggestedCategoryId).length,
      };

    } catch (error) {
      // Update statement status on failure
      try {
        const stmt = await database.get('statements', statementId);
        if (stmt) {
          await database.put('statements', { ...stmt, parseStatus: 'failed' });
        }
      } catch { /* ignore */ }

      this._emit('error', error.message, 0);
      throw error;
    }
  }

  /**
   * Validate and auto-correct transaction signs using opening/closing balance.
   * If opening + sum(amounts) ≈ closing, signs are correct.
   * If opening - sum(amounts) ≈ closing, all signs are flipped → invert them.
   */
  _validateSigns(parsed, statementType) {
    const txs = parsed.transactions;
    if (!txs || txs.length === 0) return;

    const opening = parsed.openingBalance;
    const closing = parsed.closingBalance;

    // Balance-based validation: if we have both opening and closing, check the math
    if (opening != null && closing != null) {
      const sum = txs.reduce((s, t) => s + (t.amount || 0), 0);
      const expectedClosing = opening + sum;
      const flippedClosing = opening - sum;
      const tolerance = 0.02; // allow small rounding errors

      if (Math.abs(expectedClosing - closing) <= tolerance) {
        // Signs are correct as-is
        console.log('Sign validation: signs are correct (balance matches).');
        return;
      }

      if (Math.abs(flippedClosing - closing) <= tolerance) {
        // Signs are inverted — flip all amounts
        console.warn('Sign validation: signs were inverted — auto-correcting all transaction amounts.');
        for (const tx of txs) {
          tx.amount = -tx.amount;
          tx.type = tx.amount < 0 ? 'debit' : 'credit';
        }
        this._emit('validate', 'Auto-corrected transaction signs using balance data.', 40);
        return;
      }

      console.warn(`Sign validation: neither sign convention matches balance. Opening=${opening}, Sum=${sum}, Expected=${expectedClosing}, Actual closing=${closing}. Proceeding with AI output as-is.`);
      return;
    }

    // Heuristic validation for credit card statements without balance data:
    // On a CC statement, most transactions should be expenses (negative).
    // If the majority are positive, signs are likely wrong.
    if (statementType === 'credit_card') {
      const positiveCount = txs.filter(t => t.amount > 0).length;
      const negativeCount = txs.filter(t => t.amount < 0).length;

      if (positiveCount > negativeCount && positiveCount > txs.length * 0.6) {
        console.warn('Sign validation (CC heuristic): majority of CC transactions are positive — flipping signs.');
        for (const tx of txs) {
          tx.amount = -tx.amount;
          tx.type = tx.amount < 0 ? 'debit' : 'credit';
        }
        this._emit('validate', 'Auto-corrected credit card signs (most charges should be negative).', 40);
      }
    }
  }

  /**
   * Import reviewed transactions into Actual Budget
   *
   * @param {string} statementId - The statement to import
   * @param {string} accountId - Target account
   * @param {Array} approvedIds - IDs of approved transactions (null = import all)
   */
  async importToActual(statementId, accountId, approvedIds = null) {
    this._emit('import', 'Importing to Actual Budget...', 0);

    let transactions = await database.getAllByIndex(
      'parsedTransactions', 'statementId', statementId
    );

    // Filter to approved only
    if (approvedIds) {
      transactions = transactions.filter(t => approvedIds.includes(t.id));
    } else {
      transactions = transactions.filter(t => t.importStatus === 'pending');
    }

    if (transactions.length === 0) {
      throw new Error('No transactions to import.');
    }

    // Format for Actual HTTP API importTransactions endpoint.
    // See: POST /budgets/{budgetSyncId}/accounts/{accountId}/transactions/import
    // Expected fields per transaction:
    //   - date: string (YYYY-MM-DD, required)
    //   - amount: integer (minor units / cents, required)
    //   - payee_name: string (creates/matches payee by name)
    //   - imported_payee: string (original payee text from import source)
    //   - category: string (category UUID)
    //   - notes: string
    //   - imported_id: string (unique ID to prevent duplicate imports)
    //   - cleared: boolean
    const actualTxs = transactions.map(tx => {
      const entry = {
        date: tx.date,
        amount: tx.amount,
        payee_name: tx.cleanPayee || tx.rawDescription.substring(0, 50),
        imported_payee: tx.rawDescription,
        notes: tx.rawDescription,
        imported_id: `actual-ai-${tx.id}`,
        cleared: false,
      };
      // Only include category if we have a valid UUID
      if (tx.suggestedCategoryId) {
        entry.category = tx.suggestedCategoryId;
      }
      return entry;
    });

    const result = await actualClient.importTransactions(accountId, actualTxs);

    // Mark as imported
    for (const tx of transactions) {
      tx.importStatus = 'imported';
      tx.importedAt = new Date().toISOString();
      await database.put('parsedTransactions', tx);
    }

    // Save merchant mappings for future auto-categorization
    for (const tx of transactions) {
      if (tx.suggestedCategoryId && tx.cleanPayee) {
        const existing = await database.findMerchantMapping(tx.rawDescription);
        if (!existing) {
          await database.put('merchantMappings', {
            id: uuid(),
            rawPattern: tx.rawDescription.toLowerCase().trim(),
            cleanName: tx.cleanPayee,
            actualCategoryId: tx.suggestedCategoryId,
            categoryName: tx.suggestedCategory,
            confidence: tx.confidence || 0.8,
            source: tx.mappingSource || 'user',
            timesConfirmed: 1,
            isRegex: false,
            createdAt: new Date().toISOString(),
          });
        } else {
          existing.timesConfirmed = (existing.timesConfirmed || 0) + 1;
          await database.put('merchantMappings', existing);
        }
      }
    }

    // Update statement status
    const stmt = await database.get('statements', statementId);
    if (stmt) {
      stmt.parseStatus = 'imported';
      stmt.importedAt = new Date().toISOString();
      await database.put('statements', stmt);
    }

    this._emit('done', `Imported ${transactions.length} transactions!`, 100);

    // ─── Balance reconciliation ───
    let balanceDiscrepancy = null;
    if (stmt && stmt.closingBalance != null) {
      try {
        const actualBalance = await actualClient.getAccountBalance(accountId);
        const isCreditCard = stmt.statementType === 'credit_card';
        // Credit card statements show positive balance (amount owed),
        // but Actual stores CC debt as negative
        const expectedBalance = isCreditCard ? -Math.abs(stmt.closingBalance) : stmt.closingBalance;
        const diff = expectedBalance - actualBalance;

        if (Math.abs(diff) > 1) { // more than 1 cent difference
          balanceDiscrepancy = {
            actualBalance,
            expectedBalance,
            closingBalance: stmt.closingBalance,
            adjustment: diff,
            isCreditCard,
          };
        }
      } catch (err) {
        console.warn('Balance reconciliation check failed:', err);
      }
    }

    return { ...result, balanceDiscrepancy };
  }

  /**
   * Create a balance adjustment transaction to reconcile with the statement closing balance.
   */
  async applyBalanceAdjustment(accountId, adjustment, periodEnd) {
    const date = periodEnd || new Date().toISOString().slice(0, 10);
    await actualClient.addTransaction(accountId, {
      date,
      amount: adjustment,
      payee_name: 'Balance Adjustment',
      notes: 'Auto-adjustment to match statement closing balance',
      cleared: true,
    });
  }
}

const pipeline = new IngestionPipeline();
export default pipeline;
