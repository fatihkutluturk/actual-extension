/**
 * Actual AI — PDF Parser
 *
 * Extracts text from uploaded bank statement PDFs using pdf.js,
 * then sends to Gemini for structured parsing.
 */

import * as pdfjsLib from './pdf.min.mjs';

// Set the worker source to the local bundled file
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs', import.meta.url).href;

class PDFParser {

  /**
   * Extract raw text from a PDF file
   * @param {File|Blob|ArrayBuffer} file - The PDF file
   * @returns {Promise<{text: string, pageCount: number}>}
   */
  async extractText(file) {
    let arrayBuffer;
    if (file instanceof ArrayBuffer) {
      arrayBuffer = file;
    } else if (file instanceof Blob || file instanceof File) {
      arrayBuffer = await file.arrayBuffer();
    } else {
      throw new Error('Invalid file type. Expected File, Blob, or ArrayBuffer.');
    }

    // pdf.js is imported at the top of this module
    if (!pdfjsLib) {
      throw new Error('pdf.js failed to load.');
    }

    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const pages = [];

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();

      // Reconstruct text with layout awareness
      const pageText = this._reconstructLayout(textContent);
      pages.push(pageText);
    }

    return {
      text: pages.join('\n\n--- PAGE BREAK ---\n\n'),
      pageCount: pdf.numPages,
    };
  }

  /**
   * Reconstruct text layout from pdf.js text content items
   * Preserves table-like structure by using position data
   */
  _reconstructLayout(textContent) {
    const items = textContent.items;
    if (!items.length) return '';

    // Sort items by Y position (top to bottom), then X (left to right)
    const sorted = [...items].sort((a, b) => {
      const yDiff = b.transform[5] - a.transform[5]; // Y is inverted in PDF
      if (Math.abs(yDiff) > 3) return yDiff; // Different line
      return a.transform[4] - b.transform[4]; // Same line, sort by X
    });

    const lines = [];
    let currentLine = [];
    let currentY = null;

    for (const item of sorted) {
      const y = Math.round(item.transform[5]);
      const x = Math.round(item.transform[4]);

      if (currentY !== null && Math.abs(y - currentY) > 3) {
        // New line
        lines.push(this._buildLine(currentLine));
        currentLine = [];
      }

      currentLine.push({ text: item.str, x, width: item.width });
      currentY = y;
    }

    if (currentLine.length) {
      lines.push(this._buildLine(currentLine));
    }

    return lines.join('\n');
  }

  /**
   * Build a line from positioned text items, using tabs for spacing
   */
  _buildLine(items) {
    if (!items.length) return '';

    items.sort((a, b) => a.x - b.x);

    let line = '';
    let lastEnd = 0;

    for (const item of items) {
      const gap = item.x - lastEnd;
      if (gap > 20) {
        line += '\t';
      } else if (gap > 5) {
        line += '  ';
      }
      line += item.text;
      lastEnd = item.x + (item.width || item.text.length * 5);
    }

    return line;
  }

  /**
   * Compute SHA-256 hash of file for duplicate detection
   */
  async hashFile(file) {
    let arrayBuffer;
    if (file instanceof ArrayBuffer) {
      arrayBuffer = file;
    } else {
      arrayBuffer = await file.arrayBuffer();
    }

    const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }
}

const pdfParser = new PDFParser();
export default pdfParser;
