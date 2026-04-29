// background.js — Wanderlog Place Importer v2.0
//
// Acts as the persistent message broker. The popup is ephemeral (destroyed
// when closed); the injected script runs in the Wanderlog tab. This service
// worker bridges them and stores state so the popup can reconnect at any time.
//
// State machine:
//   idle      → no import running
//   running   → import in progress
//   paused    → waiting for user resolve (manual mode)
//   done      → import finished, results ready

const state = {
  phase: 'idle',       // 'idle' | 'running' | 'paused' | 'done'
  wanderlogTabId: null,
  total: 0,
  current: 0,
  label: '',
  resolvePlaceName: '',  // set when phase === 'paused'
  results: null,         // set when phase === 'done'  { imported, flagged, stopped }
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function broadcastToPopup(msg) {
  // Send to all extension pages (popup if open)
  chrome.runtime.sendMessage(msg).catch(() => {
    // Popup not open — ignore
  });
}

// ── Message handler ───────────────────────────────────────────────────────────
//
// Messages FROM injected script (content context):
//   IMPORTER_PROGRESS    { current, total, label }
//   IMPORTER_NEEDS_RESOLVE { placeName }
//   IMPORTER_DONE        { imported, flagged, stopped }
//
// Messages FROM popup:
//   POPUP_GET_STATE      → reply with full state
//   POPUP_RESOLVE        { outcome: 'added'|'skip'|'timeout' }
//   POPUP_STOP           → forward STOP_IMPORTER to tab

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // ── From injected script ──────────────────────────────────────────────────

  if (msg.type === 'IMPORTER_PROGRESS') {
    state.phase   = 'running';
    state.current = msg.current;
    state.total   = msg.total;
    state.label   = msg.label;
    broadcastToPopup({ type: 'BG_PROGRESS', current: msg.current, total: msg.total, label: msg.label });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'IMPORTER_NEEDS_RESOLVE') {
    state.phase           = 'paused';
    state.resolvePlaceName = msg.placeName;
    broadcastToPopup({ type: 'BG_NEEDS_RESOLVE', placeName: msg.placeName });
    // Don't respond yet — we respond when popup sends POPUP_RESOLVE
    // Keep the message channel open
    return true;
  }

  if (msg.type === 'IMPORTER_DONE') {
    state.phase   = 'done';
    state.results = { imported: msg.imported, flagged: msg.flagged, stopped: msg.stopped };
    broadcastToPopup({ type: 'BG_DONE', imported: msg.imported, flagged: msg.flagged, stopped: msg.stopped });
    sendResponse({ ok: true });
    return true;
  }

  // ── From popup ────────────────────────────────────────────────────────────

  if (msg.type === 'POPUP_GET_STATE') {
    sendResponse({ ...state });
    return true;
  }

  if (msg.type === 'POPUP_RESOLVE') {
    // Forward resolve outcome to the injected script in the Wanderlog tab
    if (state.wanderlogTabId !== null) {
      chrome.tabs.sendMessage(state.wanderlogTabId, {
        type: 'RESOLVE_RESPONSE',
        outcome: msg.outcome
      }).catch(() => {});
    }
    state.phase = 'running';
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'POPUP_STOP') {
    if (state.wanderlogTabId !== null) {
      chrome.tabs.sendMessage(state.wanderlogTabId, { type: 'STOP_IMPORTER' }).catch(() => {});
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'POPUP_START_IMPORT') {
    // Popup tells background which tab the import is running in
    state.wanderlogTabId = msg.tabId;
    state.phase   = 'running';
    state.total   = msg.total;
    state.current = 0;
    state.label   = 'Starting…';
    state.results = null;
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'POPUP_RESET') {
    state.phase           = 'idle';
    state.wanderlogTabId  = null;
    state.total           = 0;
    state.current         = 0;
    state.label           = '';
    state.resolvePlaceName = '';
    state.results         = null;
    sendResponse({ ok: true });
    return true;
  }
});
