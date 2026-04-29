// Wanderlog Place Importer v3.1
// Architecture: injected script writes to window.__wanderlogImporter, popup polls it.
// Resolve logic: after clicking a suggestion, wait up to 8s for item count to increase.
// If it doesn't, pause and show manual resolve panel — user fixes it and clicks Skip/Continue.

let parsedPlaces      = [];
let selectedSection   = null;
let resolveMode       = 'auto';
let pauseTimerSecs    = 10;
let pollInterval      = null;
let countdownInterval = null;
let activeTabId       = null;
let resolveShownFor   = null;
let appMode           = 'import';  // 'import' | 'audit'
let auditParsedPlaces = [];
let auditSelectedSection = null;
let lastReconcileData = null;  // stored so "from done" can reuse it

// ── UI helpers ────────────────────────────────────────────────────────────────

function showPanel(id) {
  ['panelPaste','panelSection','panelImport','panelDone',
   'panelAuditPaste','panelAuditSection','panelReconcile'].forEach(p => {
    document.getElementById(p).style.display = p === id ? 'block' : 'none';
  });
}

function setStatus(msg, type = '') {
  const el = document.getElementById('status');
  if (!el) return;
  el.textContent = msg;
  el.className = type ? `status-${type}` : '';
  el.style.display = msg ? 'block' : 'none';
}

function updateProgress(current, total, label, address) {
  const container = document.getElementById('progressContainer');
  const bar       = document.getElementById('progressBar');
  const text      = document.getElementById('progressText');
  const labelEl   = document.getElementById('progressLabel');
  const addrEl    = document.getElementById('progressAddress');
  if (container) container.style.display = 'block';
  if (bar && total > 0) bar.style.width = `${Math.round((current / total) * 100)}%`;
  if (text) text.textContent = `${current} / ${total}`;
  if (labelEl && label) labelEl.textContent = label;
  if (addrEl) { addrEl.textContent = address || ''; addrEl.style.display = address ? 'block' : 'none'; }
}

// ── Page state bridge (read/write window.__wanderlogImporter via executeScript) ──

async function writePageState(key, value) {
  if (!activeTabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      func: (k, v) => { if (window.__wanderlogImporter) window.__wanderlogImporter[k] = v; },
      args: [key, value]
    });
  } catch (e) {}
}

async function readPageState() {
  if (!activeTabId) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      func: () => {
        const s = window.__wanderlogImporter;
        if (!s) return null;
        return { phase: s.phase, current: s.current, total: s.total, label: s.label,
                 address: s.address,
                 resolvePlaceName: s.resolvePlaceName, resolveResult: s.resolveResult,
                 shouldStop: s.shouldStop, results: s.results };
      }
    });
    return results?.[0]?.result || null;
  } catch (e) { return null; }
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

function startPolling() {
  stopPolling();
  pollInterval = setInterval(async () => {
    const s = await readPageState();
    if (!s) return;

    if (s.phase === 'running') {
      updateProgress(s.current, s.total, s.label, s.address);
      setStatus(s.label, 'running');
      hideResolvePanel();
    }

    if (s.phase === 'needs_resolve') {
      showResolvePanel(s.resolvePlaceName);
    }

    if (s.phase === 'done') {
      stopPolling();
      hideResolvePanel();
      buildDonePanel(s.results.imported, s.results.flagged, s.results.stopped);
    }
  }, 500);
}

function stopPolling() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

// ── Resolve panel ─────────────────────────────────────────────────────────────

function showResolvePanel(placeName) {
  if (resolveShownFor === placeName) return;
  resolveShownFor = placeName;

  const panel   = document.getElementById('resolvePanel');
  const nameEl  = document.getElementById('resolvePlaceName');
  const bar     = document.getElementById('countdownBar');
  const countEl = document.getElementById('countdownText');

  nameEl.textContent = `"${placeName}" wasn't added — fix it on the page if needed, then click below.`;
  countEl.textContent = pauseTimerSecs;
  bar.style.transition = 'none';
  bar.style.width = '100%';
  panel.classList.add('active');
  setStatus(`Paused — waiting for: ${placeName}`, 'waiting');

  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }

  let remaining = pauseTimerSecs;
  // Trigger CSS shrink after a frame
  requestAnimationFrame(() => requestAnimationFrame(() => {
    bar.style.transition = `width ${pauseTimerSecs}s linear`;
    bar.style.width = '0%';
  }));

  countdownInterval = setInterval(async () => {
    remaining--;
    countEl.textContent = remaining;
    if (remaining <= 0) {
      clearInterval(countdownInterval); countdownInterval = null;
      resolveShownFor = null;
      panel.classList.remove('active');
      await writePageState('resolveResult', 'timeout');
    }
  }, 1000);
}

function hideResolvePanel() {
  if (resolveShownFor === null) return;
  resolveShownFor = null;
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  document.getElementById('resolvePanel').classList.remove('active');
}

async function onResolveAddedClick() {
  hideResolvePanel();
  await writePageState('resolveResult', 'added');
  setStatus('Continuing…', 'running');
}

async function onResolveSkipClick() {
  hideResolvePanel();
  await writePageState('resolveResult', 'skip');
  setStatus('Skipped — moving on…', 'running');
}

// ── Parse ─────────────────────────────────────────────────────────────────────

function parseExport(text) {
  const places = [];
  if (!text || !text.trim()) return places;
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const re = /^\d+\.\s+(.+?)\s+(?:[✓✗]|📍)$/;
  let cur = null;
  for (const line of lines) {
    const m = line.match(re);
    if (m) {
      if (cur) places.push(cur);
      cur = { name: m[1].trim(), address: '', note: '' };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('Address:')) {
      const a = line.replace(/^Address:\s*/, '').trim();
      if (a && a !== 'No address' && !a.startsWith('No address')) cur.address = a;
    } else if (line.startsWith('Note:')) {
      cur.note = line.replace(/^Note:\s*/, '').trim();
    }
  }
  if (cur) places.push(cur);
  return places.filter(p => p.name);
}

function onPasteInput() {
  const text = document.getElementById('pasteBox')?.value || '';
  const btn  = document.getElementById('scanBtn');
  const st   = document.getElementById('parseStatus');
  if (!text.trim()) {
    parsedPlaces = []; st.textContent = 'Paste your export above to begin';
    st.className = 'parse-status'; if (btn) btn.disabled = true; return;
  }
  parsedPlaces = parseExport(text);
  if (!parsedPlaces.length) {
    st.textContent = 'Could not parse any places — paste the full "Copy to Clipboard" output';
    st.className = 'parse-status err'; if (btn) btn.disabled = true;
  } else {
    const a = parsedPlaces.filter(p => p.address).length;
    const n = parsedPlaces.filter(p => p.note).length;
    st.textContent = `✓ ${parsedPlaces.length} places · ${a} with addresses · ${n} with notes`;
    st.className = 'parse-status ok'; if (btn) btn.disabled = false;
  }
}

// ── Scan ──────────────────────────────────────────────────────────────────────

function fetchSections() {
  const out = [];
  document.querySelectorAll('[data-rbd-droppable-id]').forEach(s => {
    const id = s.getAttribute('data-rbd-droppable-id');
    if (!id) return;
    const h = document.getElementById(`SectionComponentHeader__${id}`);
    if (!h) return;
    const inp = h.querySelector('input[type="text"]');
    const title = inp ? inp.value.trim() : null;
    if (!title) return;
    out.push({ id, title, itemCount: s.querySelectorAll('[id^="SectionItem__id-"]').length });
  });
  return out;
}

async function onScanPageClick() {
  if (!parsedPlaces.length) { setStatus('Paste your export first', 'error'); return; }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url.includes('wanderlog.com')) {
    setStatus('Please open a Wanderlog trip page first', 'error'); return;
  }
  activeTabId = tab.id;
  const btn = document.getElementById('scanBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Scanning…'; }
  setStatus('Reading Wanderlog lists…', 'running');
  try {
    const res = await chrome.scripting.executeScript({ target: { tabId: tab.id }, function: fetchSections });
    const sections = res?.[0]?.result;
    if (!Array.isArray(sections) || !sections.length)
      setStatus("No lists found — make sure you're on a Wanderlog trip page", 'error');
    else buildSectionPicker(sections);
  } catch (err) { setStatus(`Error: ${err.message}`, 'error'); }
  if (btn) { btn.disabled = false; btn.textContent = 'Scan Page'; }
}

// ── Section picker ────────────────────────────────────────────────────────────

function buildSectionPicker(sections) {
  selectedSection = null;
  const list = document.getElementById('sectionList');
  const confirm = document.getElementById('sectionConfirmBtn');
  list.textContent = ''; if (confirm) confirm.disabled = true;
  sections.forEach(sec => {
    const row = document.createElement('div'); row.className = 'section-option';
    const radio = document.createElement('input');
    radio.type = 'radio'; radio.name = 'sectionPick'; radio.value = sec.id;
    radio.addEventListener('change', () => { selectedSection = { id: sec.id, title: sec.title }; if (confirm) confirm.disabled = false; });
    const body = document.createElement('div');
    const name = document.createElement('div'); name.className = 'section-option-name'; name.textContent = sec.title;
    const count = document.createElement('div'); count.className = 'section-option-count';
    count.textContent = `${sec.itemCount} place${sec.itemCount !== 1 ? 's' : ''} already`;
    body.appendChild(name); body.appendChild(count);
    row.appendChild(radio); row.appendChild(body);
    row.addEventListener('click', e => { if (e.target !== radio) radio.click(); });
    list.appendChild(row);
  });
  setStatus(''); showPanel('panelSection');
}

// ── Start import ──────────────────────────────────────────────────────────────

async function onImportClick() {
  if (!selectedSection) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url.includes('wanderlog.com')) {
    setStatus('Please open a Wanderlog trip page first', 'error'); return;
  }
  activeTabId = tab.id;
  document.getElementById('importSummaryTitle').textContent =
    `Importing into "${selectedSection.title}" (${resolveMode === 'auto' ? '⚡ auto' : '✋ manual'})…`;
  document.getElementById('importSummaryDetail').textContent = `${parsedPlaces.length} places to process.`;
  showPanel('panelImport');
  updateProgress(0, parsedPlaces.length, 'Starting…');

  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: runImport,
    args: [parsedPlaces, selectedSection.title, resolveMode]
  }).catch(err => { setStatus(`Injection error: ${err.message}`, 'error'); stopPolling(); });

  startPolling();
}

async function onStopClick() {
  const btn = document.getElementById('stopBtn');
  if (btn) { btn.textContent = '⏹️ Stopping…'; btn.disabled = true; }
  setStatus('Stopping…', 'stopped');
  await writePageState('shouldStop', true);
}

// ── INJECTED FUNCTION ─────────────────────────────────────────────────────────
// Runs inside the Wanderlog tab. No chrome.runtime at all.
// Uses window.__wanderlogImporter for all state.
// Core logic: type query → pick suggestion → click → wait up to 8s for item count to go up.
// If it doesn't → pause (needs_resolve) → wait for popup to set resolveResult.

function runImport(places, targetSectionTitle, resolveMode) {
  window.__wanderlogImporter = {
    phase: 'running', current: 0, total: places.length, label: 'Starting…',
    address: '', resolvePlaceName: '', resolveResult: null, shouldStop: false, results: null
  };
  const st = window.__wanderlogImporter;

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function normalise(str) {
    return (str || '').toLowerCase()
      .replace(/[\uE000-\uF8FF]/g, '').replace(/[''`]/g, "'")
      .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function namesMatch(a, b) {
    const na = normalise(a), nb = normalise(b);
    if (!na || !nb) return false;
    if (na === nb || na.includes(nb) || nb.includes(na)) return true;
    const wa = na.split(' ').filter(w => w.length > 2);
    const wb = nb.split(' ').filter(w => w.length > 2);
    if (!wa.length || !wb.length) return false;
    const [sh, lo] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
    return sh.filter(w => lo.includes(w)).length / sh.length >= 0.6;
  }

  function findSectionId(title) {
    const headers = document.querySelectorAll('[id^="SectionComponentHeader__"]');
    for (const h of headers) {
      const inp = h.querySelector('input[type="text"]');
      if (inp && normalise(inp.value.trim()) === normalise(title))
        return h.id.replace('SectionComponentHeader__', '');
    }
    for (const h of headers) {
      const inp = h.querySelector('input[type="text"]');
      if (!inp) continue;
      const a = normalise(inp.value.trim()), b = normalise(title);
      if (a.startsWith(b) || b.startsWith(a))
        return h.id.replace('SectionComponentHeader__', '');
    }
    return null;
  }

  function countItems(sectionId) {
    const scope = document.querySelector(`[data-rbd-droppable-id="${sectionId}"]`);
    return scope ? scope.querySelectorAll('[id^="SectionItem__id-"]').length : 0;
  }

  // Success signal: item count in the section increased.
  // We use a MutationObserver for instant detection + a polling fallback.
  function waitForNewItem(sectionId, prevCount, maxMs = 10000) {
    return new Promise(resolve => {
      const scope = document.querySelector(`[data-rbd-droppable-id="${sectionId}"]`);
      if (!scope) { resolve(false); return; }

      // Check immediately in case it already appeared
      if (scope.querySelectorAll('[id^="SectionItem__id-"]').length > prevCount) {
        resolve(true); return;
      }

      let resolved = false;
      function done(val) {
        if (resolved) return;
        resolved = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve(val);
      }

      // MutationObserver watches for new child elements
      const observer = new MutationObserver(() => {
        if (scope.querySelectorAll('[id^="SectionItem__id-"]').length > prevCount) {
          done(true);
        }
      });
      observer.observe(scope, { childList: true, subtree: true });

      // Fallback timeout
      const timer = setTimeout(() => done(false), maxMs);
    });
  }

  async function typeIntoInput(input, text) {
    // Escape first to dismiss any lingering dropdown from previous place
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(150);
    input.focus(); await sleep(200);
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    await sleep(200);
    document.execCommand('insertText', false, text);
    await sleep(300);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(200);
  }

  async function clearInput(input) {
    // Press Escape first to dismiss any open dropdown
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(200);
    input.focus(); await sleep(150);
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    await sleep(100);
    // Blur and click away to fully deactivate the input
    input.blur();
    document.body.click();
    await sleep(600);
  }

  async function waitForSuggestions() {
    // Wait for any previous dropdown to clear
    await sleep(200);
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await sleep(300);
      // The container gets the '--open' class when suggestions are rendered
      const c = document.querySelector('#react-autowhatever-1.react-autosuggest__suggestions-container--open');
      if (!c) continue;
      // Suggestions are inside a UL child, not direct children of the container
      const ul = c.querySelector('ul.react-autosuggest__suggestions-list');
      const items = ul ? ul.querySelectorAll('li[role="option"]') : c.querySelectorAll('li');
      if (items.length > 0) return Array.from(items);
    }
    return [];
  }

  function isPlaceSuggestion(li) {
    const t = li.textContent || '';
    // Filter out non-place suggestions
    if (t.includes('See result') || t.includes('See location')) return false;
    if (t.includes('Add note for')) return false;
    if (t.includes('Add places from anywhere')) return false;
    if (li.querySelector('[data-icon="magnifying-glass"]')) return false;
    // Positive signal: actual place suggestions have GooglePlaceSuggestion__inner
    if (li.querySelector('.GooglePlaceSuggestion__inner')) return true;
    // Fallback: if it has content and doesn't match exclusions, accept it
    return t.trim().length > 0;
  }

  function pickBestSuggestion(items, placeName) {
    const cands = items.filter(isPlaceSuggestion);
    if (!cands.length) return null;

    for (const li of cands) {
      // The actual DOM structure: LI > DIV.GooglePlaceSuggestion__inner > DIV.text-truncate > DIV.text-truncate > SPAN.font-weight-bold
      const inner = li.querySelector('.GooglePlaceSuggestion__inner');
      let suggestionName = '';
      if (inner) {
        // Get the bold place name (first span.font-weight-bold)
        const bold = inner.querySelector('span.font-weight-bold');
        suggestionName = bold ? bold.textContent.trim() : '';
        // If no bold found, try the first text-truncate div's first line
        if (!suggestionName) {
          const truncDiv = inner.querySelector('.text-truncate');
          suggestionName = truncDiv ? truncDiv.textContent.split('\n')[0].trim() : '';
        }
      }
      // Fallback: grab first line of the LI text
      if (!suggestionName) {
        suggestionName = li.textContent.split('\n')[0].trim();
      }

      if (namesMatch(placeName, suggestionName)) return li;
    }
    // No name match — return first place candidate
    return cands[0];
  }

  // Pause and wait for popup to set resolveResult
  async function waitForResolve(placeName) {
    st.phase = 'needs_resolve';
    st.resolvePlaceName = placeName;
    st.resolveResult = null;
    while (st.resolveResult === null && !st.shouldStop) {
      await sleep(300);
    }
    const result = st.shouldStop ? 'skip' : st.resolveResult;
    st.resolveResult = null;
    st.phase = 'running';
    return result;
  }

  async function writeNote(sectionId, placeName, note) {
    if (!note) return true;
    const scope = document.querySelector(`[data-rbd-droppable-id="${sectionId}"]`);
    if (!scope) return false;
    // Delay to let the item fully render and Quill mount
    await sleep(1200);
    const items = [...scope.querySelectorAll('[id^="SectionItem__id-"]')];
    // Try to find the item by matching the place name in its text content
    // Item text structure: "2\nToby's Estate Coffee Roasters\n...\nMark as visited..."
    let targetItem = null;
    for (const item of items) {
      const text = item.innerText || '';
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      // The place name is typically the second line (first is the number)
      const itemName = lines.length >= 2 ? lines[1] : lines[0] || '';
      if (namesMatch(itemName, placeName)) { targetItem = item; break; }
    }
    // Fallback: try the last item (most recently added)
    if (!targetItem && items.length > 0) {
      targetItem = items[items.length - 1];
    }
    if (!targetItem) return false;

    // Look for a Quill editor or any contenteditable
    const editor = targetItem.querySelector('div.ql-editor[contenteditable="true"]')
                || targetItem.querySelector('[contenteditable="true"]');
    if (!editor) return false;
    editor.focus();
    const sel = window.getSelection(), range = document.createRange();
    range.selectNodeContents(editor); sel.removeAllRanges(); sel.addRange(range);
    document.execCommand('delete', false, null);
    document.execCommand('insertText', false, note);
    editor.blur();
    return true;
  }

  (async () => {
    const imported = [], flagged = [];

    const sectionId = findSectionId(targetSectionTitle);
    if (!sectionId) {
      st.phase = 'done';
      st.results = { imported: [], flagged: [{ name: '(setup)', reason: `Section "${targetSectionTitle}" not found on page` }], stopped: false };
      return;
    }

    // Helper: get all item IDs currently in the section
    function getItemIds(secId) {
      const scope = document.querySelector(`[data-rbd-droppable-id="${secId}"]`);
      if (!scope) return [];
      return [...scope.querySelectorAll('[id^="SectionItem__id-"]')].map(el => el.id);
    }

    // Helper: get the text of a specific item by its DOM id
    function getItemText(itemDomId) {
      const el = document.getElementById(itemDomId);
      return el ? (el.innerText || '').trim() : '';
    }

    for (let i = 0; i < places.length; i++) {
      if (st.shouldStop) break;

      const place = places[i];
      st.label = `Adding ${i + 1}/${places.length}: ${place.name}`;
      st.address = place.address || '';
      st.current = i;
      st.phase = 'running';

      const input = document.getElementById(`PlaceAutosuggest__${sectionId}`);
      if (!input) {
        flagged.push({ name: place.name, reason: 'Section input not found — page may have changed' });
        continue;
      }

      // Snapshot item IDs BEFORE typing
      const prevIds = new Set(getItemIds(sectionId));

      // Build query: name + short locality hint for disambiguation
      let query = place.name;
      if (place.address) {
        const parts = place.address.split(',').map(p => p.trim());
        if (parts.length >= 2) {
          const locality = parts[1].replace(/\s+(NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\s*\d*/i, '').trim();
          if (locality) query += ' ' + locality;
        }
      }
      await typeIntoInput(input, query);

      // PHASE 1: Wait up to 12s for either:
      //   a) A new item to appear in the section (auto-added), or
      //   b) The suggestion dropdown to appear (needs a click)
      let newItemId = null;
      let suggestionsCaptured = null;
      const deadline = Date.now() + 12000;

      while (Date.now() < deadline) {
        await sleep(400);

        // Check for new item in the section
        const currentIds = getItemIds(sectionId);
        const added = currentIds.find(id => !prevIds.has(id));
        if (added) { newItemId = added; break; }

        // Check for visible suggestion dropdown
        if (!suggestionsCaptured) {
          const c = document.querySelector('#react-autowhatever-1.react-autosuggest__suggestions-container--open');
          if (c) {
            const ul = c.querySelector('ul.react-autosuggest__suggestions-list');
            const items = ul ? [...ul.querySelectorAll('li[role="option"]')] : [...c.querySelectorAll('li')];
            if (items.length > 0) { suggestionsCaptured = items; break; }
          }
        }
      }

      // PHASE 2a: New item appeared (auto-added) — verify with name match
      if (newItemId) {
        const itemText = getItemText(newItemId);
        const itemLines = itemText.split('\n').map(l => l.trim()).filter(Boolean);
        // Item text structure: "1\nPlace Name\n...\nMark as visited..."
        const addedName = itemLines.length >= 2 ? itemLines[1] : itemLines[0] || '';
        const matched = namesMatch(addedName, place.name);

        let noteWritten = false;
        if (place.note) {
          noteWritten = await writeNote(sectionId, place.name, place.note);
        }

        imported.push({
          name: place.name,
          note: place.note || '',
          noteWritten,
          wanderlogName: addedName,
          nameMatched: matched
        });
        st.label = matched ? `✓ Added: ${place.name}` : `⚠ Added as "${addedName}" (expected "${place.name}")`;
        st.current = i + 1;
        await sleep(2000);
        continue;
      }

      // PHASE 2b: Suggestions appeared — pick best and click
      if (suggestionsCaptured && suggestionsCaptured.length > 0) {
        const best = pickBestSuggestion(suggestionsCaptured, place.name);
        if (!best) {
          await clearInput(input);
          flagged.push({ name: place.name, reason: 'Suggestions appeared but none matched' });
          continue;
        }

        best.click();
        await sleep(300);

        // Wait for item to appear after clicking
        const appeared = await waitForNewItem(sectionId, prevIds.size, 10000);
        if (appeared) {
          // Verify the new item
          const afterIds = getItemIds(sectionId);
          const clickedItemId = afterIds.find(id => !prevIds.has(id));
          const addedName = clickedItemId ? getItemText(clickedItemId).split('\n').map(l=>l.trim()).filter(Boolean)[1] || '' : '';

          let noteWritten = false;
          if (place.note) {
            noteWritten = await writeNote(sectionId, place.name, place.note);
          }
          imported.push({ name: place.name, note: place.note || '', noteWritten, wanderlogName: addedName, nameMatched: namesMatch(addedName, place.name) });
          st.label = `✓ Added: ${place.name}`;
          st.current = i + 1;
          await sleep(2000);
          continue;
        }

        // Click didn't result in new item
        await clearInput(input);
        if (resolveMode === 'manual') {
          const r = await waitForResolve(place.name);
          if (r === 'added') { imported.push({ name: place.name, note: place.note || '', noteWritten: false }); }
          else flagged.push({ name: place.name, reason: 'Clicked suggestion but place did not appear' });
        } else {
          flagged.push({ name: place.name, reason: 'Clicked suggestion but place did not appear' });
        }
        continue;
      }

      // PHASE 2c: Neither happened — nothing worked
      await clearInput(input);
      if (resolveMode === 'manual') {
        const r = await waitForResolve(place.name);
        if (r === 'added') { imported.push({ name: place.name, note: place.note || '', noteWritten: false }); }
        else flagged.push({ name: place.name, reason: 'No suggestions and no auto-add within 12 seconds' });
      } else {
        flagged.push({ name: place.name, reason: 'No suggestions and no auto-add within 12 seconds' });
      }
    }

    st.phase = 'done';
    st.results = { imported, flagged, stopped: st.shouldStop };
  })();

  return true;
}

// ── Done panel ────────────────────────────────────────────────────────────────

function buildDonePanel(imported, flagged, stopped) {
  stopPolling();
  const summary = document.getElementById('doneSummary');
  summary.textContent = '';
  const h = document.createElement('h3');
  h.textContent = stopped ? '⏹️ Import stopped' : '✅ Import complete';
  summary.appendChild(h);
  const noteCount = imported.filter(p => p.noteWritten).length;
  [
    `${imported.length} place${imported.length !== 1 ? 's' : ''} added to Wanderlog`,
    noteCount > 0 ? `${noteCount} note${noteCount !== 1 ? 's' : ''} written` : null,
    flagged.length > 0 ? `${flagged.length} could not be imported — see below` : null,
    stopped ? 'Stopped early — remaining places not processed' : null
  ].filter(Boolean).forEach(text => {
    const d = document.createElement('div'); d.textContent = text; summary.appendChild(d);
  });

  const importedList = document.getElementById('importedList');
  importedList.textContent = '';
  imported.forEach(p => {
    const row = document.createElement('div'); row.className = 'imported-row';
    const name = document.createElement('div'); name.className = 'imported-name'; name.textContent = p.name;
    const detail = document.createElement('div'); detail.className = 'imported-detail';
    detail.textContent = p.noteWritten ? `✓ Note: "${p.note.substring(0,50)}${p.note.length>50?'…':''}"` : '✓ Added (no note)';
    row.appendChild(name); row.appendChild(detail); importedList.appendChild(row);
  });

  const flaggedSection = document.getElementById('flaggedSection');
  const flaggedList    = document.getElementById('flaggedList');
  flaggedList.textContent = '';
  if (flagged.length > 0) {
    flaggedSection.style.display = 'block';
    flagged.forEach(p => {
      const row = document.createElement('div'); row.className = 'flagged-row';
      const name = document.createElement('div'); name.className = 'flagged-name'; name.textContent = p.name;
      const reason = document.createElement('div'); reason.className = 'flagged-reason'; reason.textContent = p.reason;
      row.appendChild(name); row.appendChild(reason); flaggedList.appendChild(row);
    });
  } else { flaggedSection.style.display = 'none'; }

  setStatus(`${imported.length} imported · ${flagged.length} flagged`, flagged.length > 0 ? 'stopped' : 'success');
  showPanel('panelDone');
  const stopBtn = document.getElementById('stopBtn');
  if (stopBtn) { stopBtn.textContent = '⏹️ Stop Import'; stopBtn.disabled = false; }
}

// ── Reconciliation engine ─────────────────────────────────────────────────────

// Injected function: reads all items from a Wanderlog section
function readSectionItems(sectionTitle) {
  function normalise(str) {
    return (str || '').toLowerCase()
      .replace(/[\uE000-\uF8FF]/g, '').replace(/[''`]/g, "'")
      .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // Find section ID by title
  const headers = document.querySelectorAll('[id^="SectionComponentHeader__"]');
  let sectionId = null;
  for (const h of headers) {
    const inp = h.querySelector('input[type="text"]');
    if (inp && normalise(inp.value.trim()) === normalise(sectionTitle)) {
      sectionId = h.id.replace('SectionComponentHeader__', '');
      break;
    }
  }
  if (!sectionId) {
    for (const h of headers) {
      const inp = h.querySelector('input[type="text"]');
      if (!inp) continue;
      const a = normalise(inp.value.trim()), b = normalise(sectionTitle);
      if (a.startsWith(b) || b.startsWith(a)) {
        sectionId = h.id.replace('SectionComponentHeader__', '');
        break;
      }
    }
  }
  if (!sectionId) return { error: `Section "${sectionTitle}" not found` };

  const scope = document.querySelector(`[data-rbd-droppable-id="${sectionId}"]`);
  if (!scope) return { error: 'Section container not found' };

  const items = [...scope.querySelectorAll('[id^="SectionItem__id-"]')];
  const results = [];
  for (const item of items) {
    const text = (item.innerText || '').trim();
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    // Item text: "1\nPlace Name\nAddress line\n...\nMark as visited..."
    // Name is typically line[1] (line[0] is the number)
    const name = lines.length >= 2 ? lines[1] : lines[0] || '';
    // Try to find an address-like line (contains comma or street indicators)
    let address = '';
    for (let j = 2; j < Math.min(lines.length, 5); j++) {
      if (lines[j].includes(',') || /\d{4,}/.test(lines[j])) {
        address = lines[j];
        break;
      }
    }
    // Read note from Quill editor if present
    let note = '';
    const editor = item.querySelector('div.ql-editor[contenteditable="true"]');
    if (editor) {
      const noteText = (editor.innerText || '').trim();
      if (noteText && noteText !== 'Add a note') note = noteText;
    }
    if (name && !name.match(/^(Mark as visited|Add a note|Drag to reorder)$/i)) {
      results.push({ name, address, note });
    }
  }
  return { items: results, sectionId };
}

// Fuzzy matching (mirrors the injected version for consistency)
function normaliseForMatch(str) {
  return (str || '').toLowerCase()
    .replace(/[\uE000-\uF8FF]/g, '').replace(/[''`]/g, "'")
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function namesMatchLocal(a, b) {
  const na = normaliseForMatch(a), nb = normaliseForMatch(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const wa = na.split(' ').filter(w => w.length > 2);
  const wb = nb.split(' ').filter(w => w.length > 2);
  if (!wa.length || !wb.length) return false;
  const [sh, lo] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  return sh.filter(w => lo.includes(w)).length / sh.length >= 0.6;
}

function buildReconciliation(googlePlaces, wanderlogItems) {
  const rows = [];
  const wlUsed = new Set();

  for (const gp of googlePlaces) {
    let bestMatch = null;
    let bestIdx = -1;
    for (let j = 0; j < wanderlogItems.length; j++) {
      if (wlUsed.has(j)) continue;
      if (namesMatchLocal(gp.name, wanderlogItems[j].name)) {
        bestMatch = wanderlogItems[j];
        bestIdx = j;
        break;
      }
    }

    if (bestMatch) {
      wlUsed.add(bestIdx);
      const exactName = normaliseForMatch(gp.name) === normaliseForMatch(bestMatch.name);
      rows.push({
        status: exactName ? 'matched' : 'mismatch',
        google: gp,
        wanderlog: bestMatch
      });
    } else {
      rows.push({
        status: 'missing',
        google: gp,
        wanderlog: null
      });
    }
  }

  // Extras: Wanderlog items not matched to any Google place
  const extras = wanderlogItems.filter((_, i) => !wlUsed.has(i));

  return { rows, extras };
}

function buildReconcilePanel(data, sectionTitle) {
  lastReconcileData = { data, sectionTitle };

  const { rows, extras } = data;
  const matched  = rows.filter(r => r.status === 'matched').length;
  const mismatch = rows.filter(r => r.status === 'mismatch').length;
  const missing  = rows.filter(r => r.status === 'missing').length;

  // Subtitle
  document.getElementById('reconcileSubtitle').textContent =
    `Comparing ${rows.length} Google places against "${sectionTitle}"`;

  // Stats
  const statsEl = document.getElementById('reconcileStats');
  statsEl.innerHTML = '';
  const stats = [
    { label: `${matched} matched`, cls: 'stat-matched' },
    { label: `${mismatch} name mismatch`, cls: 'stat-mismatch' },
    { label: `${missing} missing`, cls: 'stat-missing' },
    { label: `${extras.length} extra`, cls: 'stat-extra' },
  ];
  stats.forEach(s => {
    const span = document.createElement('span');
    span.className = `reconcile-stat ${s.cls}`;
    span.textContent = s.label;
    statsEl.appendChild(span);
  });

  // Table body
  const tbody = document.getElementById('reconcileBody');
  tbody.innerHTML = '';
  rows.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.className = `row-${r.status}`;

    // Row number
    const tdNum = document.createElement('td');
    tdNum.className = 'col-num';
    tdNum.textContent = i + 1;
    tr.appendChild(tdNum);

    // Status icon
    const tdSt = document.createElement('td');
    tdSt.className = 'col-status';
    tdSt.textContent = r.status === 'matched' ? '✅' : r.status === 'mismatch' ? '⚠️' : '❌';
    tr.appendChild(tdSt);

    // Google column
    const tdG = document.createElement('td');
    const gName = document.createElement('div'); gName.className = 'recon-name'; gName.textContent = r.google.name;
    tdG.appendChild(gName);
    if (r.google.address) {
      const gAddr = document.createElement('div'); gAddr.className = 'recon-addr'; gAddr.textContent = r.google.address;
      tdG.appendChild(gAddr);
    }
    if (r.google.note) {
      const gNote = document.createElement('div'); gNote.className = 'recon-note'; gNote.textContent = r.google.note;
      tdG.appendChild(gNote);
    }
    tr.appendChild(tdG);

    // Wanderlog column
    const tdW = document.createElement('td');
    if (r.wanderlog) {
      const wName = document.createElement('div'); wName.className = 'recon-name'; wName.textContent = r.wanderlog.name;
      tdW.appendChild(wName);
      if (r.wanderlog.address) {
        const wAddr = document.createElement('div'); wAddr.className = 'recon-addr'; wAddr.textContent = r.wanderlog.address;
        tdW.appendChild(wAddr);
      }
      if (r.wanderlog.note) {
        const wNote = document.createElement('div'); wNote.className = 'recon-note'; wNote.textContent = r.wanderlog.note;
        tdW.appendChild(wNote);
      }
    } else {
      const empty = document.createElement('div'); empty.className = 'recon-empty'; empty.textContent = 'Not found';
      tdW.appendChild(empty);
    }
    tr.appendChild(tdW);
    tbody.appendChild(tr);
  });

  // Extras
  const extrasSection = document.getElementById('reconcileExtras');
  const extrasList = document.getElementById('reconcileExtrasList');
  extrasList.innerHTML = '';
  if (extras.length > 0) {
    extrasSection.style.display = 'block';
    extras.forEach(e => {
      const row = document.createElement('div'); row.className = 'reconcile-extra-row';
      row.textContent = e.name + (e.note ? ` — ${e.note}` : '');
      extrasList.appendChild(row);
    });
  } else {
    extrasSection.style.display = 'none';
  }

  showPanel('panelReconcile');
}

// ── Export helpers ─────────────────────────────────────────────────────────────

function reconcileToText(data, sectionTitle) {
  const { rows, extras } = data;
  const lines = [];
  lines.push(`Reconciliation Report — "${sectionTitle}"`);
  lines.push(`Generated: ${new Date().toLocaleString()}`);
  lines.push('');

  const matched  = rows.filter(r => r.status === 'matched').length;
  const mismatch = rows.filter(r => r.status === 'mismatch').length;
  const missing  = rows.filter(r => r.status === 'missing').length;
  lines.push(`Matched: ${matched} | Name mismatch: ${mismatch} | Missing: ${missing} | Extra in Wanderlog: ${extras.length}`);
  lines.push('');
  lines.push('─'.repeat(80));

  rows.forEach((r, i) => {
    const statusLabel = r.status === 'matched' ? '✅ Matched' : r.status === 'mismatch' ? '⚠️ Name Mismatch' : '❌ Missing';
    lines.push(`${i + 1}. [${statusLabel}]`);
    lines.push(`   Google:    ${r.google.name}${r.google.address ? ' | ' + r.google.address : ''}${r.google.note ? ' | Note: ' + r.google.note : ''}`);
    if (r.wanderlog) {
      lines.push(`   Wanderlog: ${r.wanderlog.name}${r.wanderlog.address ? ' | ' + r.wanderlog.address : ''}${r.wanderlog.note ? ' | Note: ' + r.wanderlog.note : ''}`);
    } else {
      lines.push(`   Wanderlog: (not found)`);
    }
    lines.push('');
  });

  if (extras.length > 0) {
    lines.push('─'.repeat(80));
    lines.push('Extra items in Wanderlog (not in Google export):');
    extras.forEach((e, i) => {
      lines.push(`  ${i + 1}. ${e.name}${e.note ? ' — Note: ' + e.note : ''}`);
    });
  }

  return lines.join('\n');
}

function reconcileToCsv(data) {
  const { rows, extras } = data;
  const escape = v => `"${(v || '').replace(/"/g, '""')}"`;
  const csvLines = [];
  csvLines.push('#,Status,Google Name,Google Address,Google Note,Wanderlog Name,Wanderlog Address,Wanderlog Note');

  rows.forEach((r, i) => {
    csvLines.push([
      i + 1,
      escape(r.status === 'matched' ? 'Matched' : r.status === 'mismatch' ? 'Name Mismatch' : 'Missing'),
      escape(r.google.name), escape(r.google.address), escape(r.google.note),
      escape(r.wanderlog?.name || ''), escape(r.wanderlog?.address || ''), escape(r.wanderlog?.note || '')
    ].join(','));
  });

  extras.forEach((e, i) => {
    csvLines.push([
      rows.length + i + 1,
      escape('Extra in Wanderlog'),
      escape(''), escape(''), escape(''),
      escape(e.name), escape(e.address || ''), escape(e.note || '')
    ].join(','));
  });

  return csvLines.join('\n');
}

function downloadCsv(csvString, filename) {
  const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Audit flow ────────────────────────────────────────────────────────────────

function onAuditPasteInput() {
  const text = document.getElementById('auditPasteBox')?.value || '';
  const btn  = document.getElementById('auditScanBtn');
  const st   = document.getElementById('auditParseStatus');
  if (!text.trim()) {
    auditParsedPlaces = []; st.textContent = 'Paste your export above to begin';
    st.className = 'parse-status'; if (btn) btn.disabled = true; return;
  }
  auditParsedPlaces = parseExport(text);
  if (!auditParsedPlaces.length) {
    st.textContent = 'Could not parse any places — paste the full "Copy to Clipboard" output';
    st.className = 'parse-status err'; if (btn) btn.disabled = true;
  } else {
    const a = auditParsedPlaces.filter(p => p.address).length;
    const n = auditParsedPlaces.filter(p => p.note).length;
    st.textContent = `✓ ${auditParsedPlaces.length} places · ${a} with addresses · ${n} with notes`;
    st.className = 'parse-status ok'; if (btn) btn.disabled = false;
  }
}

async function onAuditScanClick() {
  if (!auditParsedPlaces.length) { setStatus('Paste your export first', 'error'); return; }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url.includes('wanderlog.com')) {
    setStatus('Please open a Wanderlog trip page first', 'error'); return;
  }
  activeTabId = tab.id;
  const btn = document.getElementById('auditScanBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Scanning…'; }
  setStatus('Reading Wanderlog lists…', 'running');
  try {
    const res = await chrome.scripting.executeScript({ target: { tabId: tab.id }, function: fetchSections });
    const sections = res?.[0]?.result;
    if (!Array.isArray(sections) || !sections.length)
      setStatus("No lists found — make sure you're on a Wanderlog trip page", 'error');
    else buildAuditSectionPicker(sections);
  } catch (err) { setStatus(`Error: ${err.message}`, 'error'); }
  if (btn) { btn.disabled = false; btn.textContent = 'Scan Page'; }
}

function buildAuditSectionPicker(sections) {
  auditSelectedSection = null;
  const list = document.getElementById('auditSectionList');
  const confirm = document.getElementById('auditSectionConfirmBtn');
  list.textContent = ''; if (confirm) confirm.disabled = true;
  sections.forEach(sec => {
    const row = document.createElement('div'); row.className = 'section-option';
    const radio = document.createElement('input');
    radio.type = 'radio'; radio.name = 'auditSectionPick'; radio.value = sec.id;
    radio.addEventListener('change', () => { auditSelectedSection = { id: sec.id, title: sec.title }; if (confirm) confirm.disabled = false; });
    const body = document.createElement('div');
    const name = document.createElement('div'); name.className = 'section-option-name'; name.textContent = sec.title;
    const count = document.createElement('div'); count.className = 'section-option-count';
    count.textContent = `${sec.itemCount} place${sec.itemCount !== 1 ? 's' : ''} in list`;
    body.appendChild(name); body.appendChild(count);
    row.appendChild(radio); row.appendChild(body);
    row.addEventListener('click', e => { if (e.target !== radio) radio.click(); });
    list.appendChild(row);
  });
  setStatus(''); showPanel('panelAuditSection');
}

async function runAudit(places, sectionTitle) {
  setStatus('Reading Wanderlog section…', 'running');
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      func: readSectionItems,
      args: [sectionTitle]
    });
    const result = res?.[0]?.result;
    if (!result || result.error) {
      setStatus(result?.error || 'Could not read section', 'error');
      return;
    }
    const data = buildReconciliation(places, result.items);
    setStatus('');
    buildReconcilePanel(data, sectionTitle);
  } catch (err) {
    setStatus(`Error reading section: ${err.message}`, 'error');
  }
}

// ── Reconcile from done panel (post-import) ──────────────────────────────────

async function onReconcileFromDone() {
  if (!parsedPlaces.length || !selectedSection) {
    setStatus('No import data available', 'error'); return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url.includes('wanderlog.com')) {
    setStatus('Please keep your Wanderlog trip page open', 'error'); return;
  }
  activeTabId = tab.id;
  await runAudit(parsedPlaces, selectedSection.title);
}

// ── Reconnect on open ─────────────────────────────────────────────────────────

async function tryReconnect() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url?.includes('wanderlog.com')) return;
  activeTabId = tab.id;
  const s = await readPageState();
  if (!s) return;
  if (s.phase === 'running' || s.phase === 'needs_resolve') {
    document.getElementById('importSummaryTitle').textContent = 'Import in progress…';
    document.getElementById('importSummaryDetail').textContent = `${s.total} places total.`;
    showPanel('panelImport');
    updateProgress(s.current, s.total, s.label);
    setStatus(s.label, 'running');
    startPolling();
  } else if (s.phase === 'done' && s.results) {
    buildDonePanel(s.results.imported, s.results.flagged, s.results.stopped);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const modeAutoBtn   = document.getElementById('modeAutoBtn');
  const modeManualBtn = document.getElementById('modeManualBtn');
  const modeDesc      = document.getElementById('modeDesc');
  const timerControl  = document.getElementById('timerControl');

  modeAutoBtn.addEventListener('click', () => {
    resolveMode = 'auto';
    modeAutoBtn.classList.add('active'); modeManualBtn.classList.remove('active');
    modeDesc.textContent = 'If a place doesn\'t appear, the import pauses briefly then flags it and moves on.';
    timerControl.style.display = 'none';
  });
  modeManualBtn.addEventListener('click', () => {
    resolveMode = 'manual';
    modeManualBtn.classList.add('active'); modeAutoBtn.classList.remove('active');
    modeDesc.textContent = 'If anything is unclear, the import pauses so you can handle it manually.';
    timerControl.style.display = 'flex';
  });

  document.getElementById('timerSlider')?.addEventListener('input', e => {
    pauseTimerSecs = parseInt(e.target.value);
    document.getElementById('timerValue').textContent = `${pauseTimerSecs}s`;
  });

  document.getElementById('pasteBox')?.addEventListener('input', onPasteInput);
  document.getElementById('scanBtn')?.addEventListener('click', onScanPageClick);
  document.getElementById('sectionBackBtn')?.addEventListener('click', () => {
    selectedSection = null; setStatus(''); showPanel('panelPaste');
  });
  document.getElementById('sectionConfirmBtn')?.addEventListener('click', onImportClick);
  document.getElementById('stopBtn')?.addEventListener('click', onStopClick);
  document.getElementById('resolveAddedBtn')?.addEventListener('click', onResolveAddedClick);
  document.getElementById('resolveSkipBtn')?.addEventListener('click', onResolveSkipClick);

  document.getElementById('resetBtn')?.addEventListener('click', () => {
    stopPolling();
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
    resolveShownFor = null; parsedPlaces = []; selectedSection = null; activeTabId = null;
    document.getElementById('pasteBox').value = '';
    document.getElementById('parseStatus').textContent = 'Paste your export above to begin';
    document.getElementById('parseStatus').className = 'parse-status';
    document.getElementById('scanBtn').disabled = true;
    document.getElementById('progressBar').style.width = '0%';
    document.getElementById('flaggedSection').style.display = 'none';
    document.getElementById('resolvePanel').classList.remove('active');
    const stopBtn = document.getElementById('stopBtn');
    if (stopBtn) { stopBtn.textContent = '⏹️ Stop Import'; stopBtn.disabled = false; }
    setStatus(''); showPanel('panelPaste');
  });

  // ── Mode toggle ──────────────────────────────────────────────────────────
  const topImportBtn = document.getElementById('topModeImport');
  const topAuditBtn  = document.getElementById('topModeAudit');

  topImportBtn.addEventListener('click', () => {
    appMode = 'import';
    topImportBtn.classList.add('active'); topAuditBtn.classList.remove('active');
    setStatus(''); showPanel('panelPaste');
  });
  topAuditBtn.addEventListener('click', () => {
    appMode = 'audit';
    topAuditBtn.classList.add('active'); topImportBtn.classList.remove('active');
    setStatus(''); showPanel('panelAuditPaste');
  });

  // ── Audit flow ───────────────────────────────────────────────────────────
  document.getElementById('auditPasteBox')?.addEventListener('input', onAuditPasteInput);
  document.getElementById('auditScanBtn')?.addEventListener('click', onAuditScanClick);
  document.getElementById('auditSectionBackBtn')?.addEventListener('click', () => {
    auditSelectedSection = null; setStatus(''); showPanel('panelAuditPaste');
  });
  document.getElementById('auditSectionConfirmBtn')?.addEventListener('click', async () => {
    if (!auditSelectedSection) return;
    await runAudit(auditParsedPlaces, auditSelectedSection.title);
  });

  // ── Reconcile from done panel ────────────────────────────────────────────
  document.getElementById('reconcileFromDoneBtn')?.addEventListener('click', onReconcileFromDone);

  // ── Reconcile panel buttons ──────────────────────────────────────────────
  document.getElementById('reconcileCopyBtn')?.addEventListener('click', () => {
    if (!lastReconcileData) return;
    const text = reconcileToText(lastReconcileData.data, lastReconcileData.sectionTitle);
    navigator.clipboard.writeText(text).then(() => {
      const btn = document.getElementById('reconcileCopyBtn');
      btn.textContent = '✓ Copied!';
      setTimeout(() => { btn.textContent = '📋 Copy'; }, 2000);
    });
  });
  document.getElementById('reconcileCsvBtn')?.addEventListener('click', () => {
    if (!lastReconcileData) return;
    const csv = reconcileToCsv(lastReconcileData.data);
    const filename = `reconciliation_${lastReconcileData.sectionTitle.replace(/[^a-z0-9]/gi, '_')}_${new Date().toISOString().slice(0,10)}.csv`;
    downloadCsv(csv, filename);
  });
  document.getElementById('reconcileBackBtn')?.addEventListener('click', () => {
    setStatus('');
    if (appMode === 'audit') showPanel('panelAuditPaste');
    else showPanel('panelDone');
  });

  await tryReconnect();
});
