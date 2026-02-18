# Actual AI — Chrome Extension

AI-powered bank statement ingestion and financial Q&A for [Actual Budget](https://github.com/actualbudget/actual).

## What it does

- **Upload bank statement PDFs** → AI extracts and structures transactions
- **Auto-categorize** → Learns your merchant-to-category mappings over time
- **Import to Actual Budget** → Pushes clean, categorized transactions via the API
- **Chat with your finances** → Ask natural language questions about your spending

## Privacy

- All data stored locally in your browser (IndexedDB)
- No data sent to any server except:
  - **Google Gemini** (for AI features, using your own API key)
  - **Your Actual Budget server** (for reading/writing budget data)
- No analytics, no tracking, no accounts

## Prerequisites

1. **Actual Budget** server running (self-hosted)
   - With the [Actual HTTP API](https://github.com/jhonderson/actual-http-api) bridge
2. **Google Gemini API key** (free from [Google AI Studio](https://aistudio.google.com/apikey))

## Installation

### From source (development)

```bash
git clone https://github.com/your-repo/actual-ai-extension.git
cd actual-ai-extension
```

1. Open Chrome → `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `actual-ai-extension` folder

### Setup

1. Click the extension icon → **Settings**
2. Add your Google Gemini API key
3. Add your Actual Budget server URL and password
4. Select your budget file
5. Start importing statements!

## Project Structure

```
actual-ai-extension/
├── manifest.json              # Chrome extension manifest v3
├── src/
│   ├── background/
│   │   └── service-worker.js  # Background service worker
│   ├── sidepanel/
│   │   ├── sidepanel.html     # Main UI (side panel)
│   │   └── sidepanel.js       # Side panel controller
│   ├── popup/
│   │   └── popup.html         # Extension popup
│   ├── options/
│   │   └── options.html       # Settings page
│   ├── lib/
│   │   ├── database.js        # IndexedDB layer
│   │   ├── gemini.js          # Google Gemini AI client
│   │   ├── actual-client.js   # Actual Budget API client
│   │   ├── pdf-parser.js      # PDF text extraction
│   │   └── pipeline.js        # Ingestion pipeline orchestrator
│   ├── styles/
│   │   └── main.css           # Shared styles
│   └── icons/
│       ├── icon16.png
│       ├── icon48.png
│       └── icon128.png
└── README.md
```

## How it works

```
PDF Upload → pdf.js extracts text → Gemini parses transactions
    → Match known merchants (local DB)
    → AI categorizes unknowns (Gemini)
    → User reviews & edits
    → Import via Actual Budget API
    → Save merchant mappings for next time
```

### Data Flow

```
┌─────────────────────────────────────────────┐
│              Chrome Extension                │
│                                              │
│  PDF → pdf.js → Gemini → Review → Actual    │
│                                              │
│  IndexedDB:                                  │
│  ├── statements (uploaded files)             │
│  ├── parsedTransactions (extracted rows)     │
│  ├── merchantMappings (learned patterns)     │
│  ├── chatMessages (Q&A history)              │
│  └── settings (API keys, prefs)              │
└─────────────┬──────────────┬────────────────┘
              │              │
              ▼              ▼
     Google Gemini    Actual Budget
     (AI features)    (budget data)
```

## Chat Examples

- "What are my top spending categories this month?"
- "How much did I spend on food vs last month?"
- "Am I spending more than I earn?"
- "Show me all transactions over ₺500"
- "What's my average daily spending?"

## Tech Stack

- **Chrome Extension Manifest V3**
- **IndexedDB** (via lightweight wrapper) for local storage
- **pdf.js** for PDF text extraction
- **Google Gemini 2.0 Flash** for AI parsing & Q&A
- **Actual Budget API** for budget data access
- Vanilla JS, no build step required

## Development

No build step needed — load the folder directly as an unpacked extension.

To add new bank format support, the AI handles most formats automatically.
For edge cases, add parsing hints in `src/lib/gemini.js` → `parseStatement()`.

## License

MIT — Same as Actual Budget.
