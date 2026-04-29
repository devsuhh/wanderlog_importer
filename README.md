# Wanderlog Place Importer

A Chrome extension that imports your Google Maps saved places directly into a [Wanderlog](https://wanderlog.com) trip section — with notes. Includes a reconciliation audit to verify what made it in.
This compliments the [Google Maps Extractor](https://github.com/devsuhh/google_maps_extractor) extension that I built.

## What it does

If you've built up a list of saved places in Google Maps and want to move them into a Wanderlog trip, this extension automates the tedious process of searching and adding each place one by one.

**Import mode** — Paste your exported Google Maps list, pick a Wanderlog section, and the extension types each place into Wanderlog's search, selects the best match, and adds it. Notes are written into each place's note field automatically.

**Audit mode** — After importing (or any time), run a side-by-side reconciliation report comparing your Google Maps export against what's actually in your Wanderlog section. See what matched, what's missing, and what has name mismatches. Export the report as CSV or copy it to your clipboard.

## Prerequisites

This extension works with the output of a **Google Maps list extractor** — a separate tool that scrapes your Google Maps saved list and produces a numbered text export. The expected format looks like this:

```
1. Café Mogador ✓
   Address: 101 St Marks Pl, New York, NY 10009
   Note: great shakshuka

2. Watsons Bay 📍
   Address: No address (panel appeared but no data)
   Note: cliff walk?

3. Toby's Estate Coffee ✗
   Address: 125 N 6th St, Brooklyn, NY 11249
   Note:
```

Each place starts with a numbered line ending in a status icon (`✓`, `✗`, or `📍`), followed by `Address:` and `Note:` lines.

> **The Google Maps extractor is not included in this repo.** You'll need to bring your own — there are various userscripts and tools that can export a Google Maps saved list in this format.

## Installation

1. Clone or download this repo
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (toggle in the top right)
4. Click **Load unpacked** and select the folder containing these files
5. The extension icon will appear in your toolbar

## Usage

### Importing places

1. Run your Google Maps extractor on a saved list and copy the output
2. Open your Wanderlog trip page in Chrome
3. Click the extension icon
4. Paste the export into the text box — the parser will show how many places it found
5. Choose a resolve mode:
   - **Auto-resolve** — if a place can't be added automatically, it gets flagged and the import moves on
   - **Manual resolve** — the import pauses so you can handle tricky places yourself, with a configurable countdown timer
6. Click **Scan Page** — the extension reads your Wanderlog trip's sections
7. Pick the section you want to import into
8. Click **Import Into This List** and let it run

The extension works by typing each place name into Wanderlog's search input, waiting for suggestions, picking the best match using fuzzy name matching, and confirming the place was added by watching the section's item count. Notes are written into the Quill editor on each item after it's added.

### Running an audit

**After an import:** Click **Run Reconciliation Report** on the done panel. The extension reads back the Wanderlog section and compares it against your Google export.

**Standalone audit:** Switch to **Audit** mode using the toggle at the top. Paste your Google export, scan the page, pick a section, and run the comparison — no import needed.

The report shows:
- ✅ **Matched** — place found in both, names match
- ⚠️ **Name Mismatch** — place found but the name differs (e.g. Google has "ST. ALi Coffee" and Wanderlog has "St Ali")
- ❌ **Missing** — place in your Google export but not found in Wanderlog
- **Extra in Wanderlog** — places in the Wanderlog section that aren't in your Google export

Each row is numbered and you can export via **Copy to Clipboard** (formatted text) or **Download CSV**.

## Caveats and limitations

**This is a DOM-scraping tool, not an API integration.** It works by injecting JavaScript into the Wanderlog page and interacting with the UI the same way a human would — typing into inputs, clicking suggestions, reading DOM elements. This means:

- **It can break if Wanderlog changes their UI.** The extension relies on specific CSS class names (`.GooglePlaceSuggestion__inner`, `.react-autosuggest__suggestions-container--open`), DOM IDs (`SectionComponentHeader__`, `SectionItem__id-`, `PlaceAutosuggest__`), and HTML structure (Quill editors, `data-rbd-droppable-id` attributes). Any redesign or refactor on Wanderlog's side could break parts or all of this.

- **It's not fast.** Each place takes several seconds — the extension needs to type the query, wait for network responses and suggestion dropdowns, click, wait for the item to appear, then write the note. Built-in delays (`sleep()` calls) are necessary to let React re-render and the UI settle. Rushing causes failures.

- **Fuzzy matching isn't perfect.** The name matching uses word overlap (60% threshold) and substring matching. It works well for most cases but can produce false positives for places with very common names or false negatives for places with highly transliterated names.

- **Note writing is best-effort.** The extension finds the Quill rich text editor inside each section item and uses `document.execCommand` to insert text. If the editor hasn't mounted yet or the item structure is unexpected, the note silently fails to write. The done panel and audit report both indicate whether notes were successfully written.

- **No undo.** Places added to Wanderlog are added for real. If the extension adds the wrong place, you'll need to remove it manually on Wanderlog.

- **One section at a time.** You can only import into one Wanderlog section per run. If your Google export covers multiple categories, you'll need to split them up or run multiple imports.

- **The audit reads visible DOM only.** The reconciliation report reads place names and notes from the rendered HTML in the Wanderlog section. If Wanderlog lazy-loads or virtualizes long lists (only rendering items in the viewport), the audit may miss items that aren't currently in the DOM. Scroll through the entire section before running the audit to make sure everything is rendered.

- **Address matching is limited.** The audit compares places by name only, not by address. Two different places with similar names could be incorrectly matched. The address columns in the report are there for your visual comparison, not used in the matching logic.

## File structure

```
├── manifest.json      # Chrome extension manifest (MV3)
├── popup.html         # Extension popup UI and styles
├── popup.js           # All popup logic, injected import script, and audit/reconciliation engine
├── background.js      # Service worker (message broker for popup ↔ content script)
└── popup.css          # (currently unused — styles are inline in popup.html)
```

## Permissions

- `activeTab` — access the current tab to inject scripts
- `scripting` — inject the import/audit scripts into the Wanderlog page
- `tabs` — query tab URLs to verify you're on a Wanderlog page
- `https://wanderlog.com/*` — host permission for script injection

The extension does not make any network requests, collect any data, or communicate with any server. Everything runs locally between the popup and the Wanderlog tab.

## Updates and Comments

I will try to keep this updated, but this will be on a best-effort basis (and based on how many tokens I may have leftover from my daily work!)

If this helped you, consider [buying me a coffee :)](https://buymeacoffee.com/devsuhh)

## License

MIT
