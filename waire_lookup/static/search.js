// ── Views (client-side column switching + per-group block switching) ──────
// Populated by _renderResults() after an AJAX search — see below. The page
// always loads with no results (index() serves an empty shell; even a deep
// link with run=1 triggers ajaxSearch() on DOMContentLoaded rather than
// arriving pre-rendered).
var VIEWS = [];
var _currentViewIdx = 0;
var _currentGroupKey = '';
// A cross-template link can request a specific target view via ?view=<name>.
// Captured once at load (before the URL is cleaned) and consumed on the first
// results render, so later manual searches fall back to the default view.
var _deepLinkView = null;
// A cross-template link also carries this page's own deep link (?back=) so the
// target page can offer a "back to X" button. Captured before URL cleanup,
// consumed on the first render — a manual re-search makes it stale/irrelevant.
var _backLink = null;
// Shared across the initial SSE render and paginated page fetches, so both
// paths build cards/table rows with the exact same code.
var _resultLabels = {};
var _resultKch = '';
// group_key -> {page, pageSize, total} — numbered pagination state.
var _pageState = {};
// group_key -> snapshot id. AJAX (SSE) searches can't persist this to the
// session server-side (cookie header is committed before the streaming
// generator runs), so the client holds it and passes it explicitly to
// /api/more_rows and /export.
var _snapshotIds = {};

function _activeGroupBlock() {
  return document.querySelector('.group-block[data-group-key="' + _currentGroupKey + '"]');
}
function _activeCardView() {
  var b = _activeGroupBlock(); return b ? b.querySelector('.card-view') : null;
}
function _activeTableView() {
  var b = _activeGroupBlock(); return b ? b.querySelector('.table-view') : null;
}
function _activeResultsTable() {
  var b = _activeGroupBlock(); return b ? b.querySelector('.results-table') : null;
}

function switchView(idx) {
  _currentViewIdx = idx;
  var views = VIEWS;
  if (!views || !views[idx]) return;
  var v = views[idx];
  _currentGroupKey = v.group_key || _currentGroupKey;
  var egk = document.getElementById('export-group-key');
  if (egk) egk.value = _currentGroupKey;
  var esid = document.getElementById('export-snapshot-id');
  if (esid) esid.value = _snapshotIds[_currentGroupKey] || '';

  var cols = v.columns || [];
  var colSet = {};
  cols.forEach(function(c){ colSet[c] = true; });

  document.querySelectorAll('.view-tab').forEach(function(btn){
    btn.classList.toggle('active', parseInt(btn.getAttribute('data-view-idx'), 10) === idx);
  });

  // Show only the active group's block; hide others.
  document.querySelectorAll('.group-block').forEach(function(g){
    g.style.display = (g.getAttribute('data-group-key') === _currentGroupKey) ? '' : 'none';
  });

  // Within the active block, filter columns by the current view.
  var tbl = _activeResultsTable();
  if (tbl) {
    tbl.querySelectorAll('[data-col]').forEach(function(el){
      el.style.display = colSet[el.getAttribute('data-col')] ? '' : 'none';
    });
    // Recalculate table width after column visibility change
    if (tbl._totalW) tbl.style.width = tbl._totalW() + 'px';
  }
  var cv = _activeCardView();
  if (cv) {
    cv.querySelectorAll('.rc-row[data-col]').forEach(function(el){
      el.style.display = colSet[el.getAttribute('data-col')] ? '' : 'none';
    });
  }

  // Card layout / table enhancement is lazy per-group.
  _tableEnhanced = false;
  _cardsLaidOut = false;
  applyResultsView();
}

function applyInitialView() {
  var idx = 0;
  if (_deepLinkView) {
    for (var i = 0; i < VIEWS.length; i++) {
      if (VIEWS[i] && VIEWS[i].name === _deepLinkView) { idx = i; break; }
    }
    _deepLinkView = null;   // consume — only the first render honors the deep link
  }
  if (VIEWS.length >= 1) switchView(idx);
}

// ── Selection (multi-select, shared across card/table/found-list) ─────────
var _selected = new Set();
var _closed = {};

// Cards are keyed "<group_key>::<row_index>" — a new search reuses the same
// group keys and indices, so leftover _selected/_closed state from the
// previous search's cards silently applies to unrelated cards in the new
// one (confirmed: select a card, search again, select anything else — the
// new card at the same cid appears selected without being clicked). Called
// once at the top of _renderResults(), before any new DOM is built.
function resetResultState() {
  _selected.clear();
  _closed = {};
  _zTop = 10;
  _tableEnhanced = false;
  _cardsLaidOut = false;
}

function selectCard(cid, toggle) {
  if (_closed[cid]) return;
  if (toggle) {
    if (_selected.has(cid)) _selected.delete(cid);
    else _selected.add(cid);
  } else {
    _selected.clear();
    _selected.add(cid);
  }
  _syncSelectionVisuals();
}

function _syncSelectionVisuals() {
  document.querySelectorAll('.group-block .card-view .record-card').forEach(function(c){
    c.classList.toggle('selected', _selected.has(c.getAttribute('data-cid')));
  });
  document.querySelectorAll('.group-block .results-table tbody tr').forEach(function(r){
    r.classList.toggle('selected', _selected.has(r.getAttribute('data-cid')));
  });
  document.querySelectorAll('#found-list .found-item').forEach(function(li){
    li.classList.toggle('selected', _selected.has(li.getAttribute('data-cid')));
  });
  _updateSendTooltips();
}

// ── Inputs ────────────────────────────────────────────────────────────────
function clearInputs() {
  document.querySelectorAll('#search-form textarea').forEach(function(t){ t.value = ''; });
}

// ── Shared row-collection: which rows does an action (Copy TSV, Export,
// Send) apply to? Selected rows if any are selected, else all visible rows
// of the active view/group. ─────────────────────────────────────────────
function _visibleBodyRows() {
  var table = _activeResultsTable();
  if (!table) return [];
  return Array.from(table.querySelectorAll('tbody tr')).filter(function(r){ return r.style.display !== 'none'; });
}
function _rowsForAction() {
  var all = _visibleBodyRows();
  if (_selected.size > 0) {
    var sel = all.filter(function(r){ return _selected.has(r.getAttribute('data-cid')); });
    if (sel.length) return {rows: sel, usedSelection: true, total: all.length};
  }
  return {rows: all, usedSelection: false, total: all.length};
}
function _visibleDataColumns() {
  var table = _activeResultsTable();
  if (!table) return [];
  return Array.from(table.querySelectorAll('thead th[data-col]')).filter(function(th){ return th.style.display !== 'none'; });
}
function _rowDataValues(tr) {
  return Array.from(tr.querySelectorAll('td[data-col]'))
    .filter(function(td){ return td.style.display !== 'none'; })
    .map(function(td){ return td.innerText.trim(); });
}

// ── Copy TSV: respects selection when rows are selected ───────────────────
function copyTableTSV() {
  var table = _activeResultsTable();
  if (!table) return;
  var headerRow = table.querySelector('thead tr');
  var picked = _rowsForAction();
  function cellText(c) {
    var clone = c.cloneNode(true);
    clone.querySelectorAll('.sort-icon,.col-resizer').forEach(function(el){ el.remove(); });
    return clone.textContent.replace(/\t/g, ' ').trim();
  }
  var headers = Array.from(headerRow.querySelectorAll('th')).map(cellText);
  var lines = [headers.join('\t')];
  picked.rows.forEach(function(r){
    var cells = Array.from(r.querySelectorAll('td')).map(function(c){ return c.innerText.replace(/\t/g, ' '); });
    lines.push(cells.join('\t'));
  });
  navigator.clipboard.writeText(lines.join('\n'));
}

// ── Export CSV: client-side from selected rows, else full server export ───
function _csvField(v) {
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
function exportCsv() {
  var picked = _rowsForAction();
  if (!picked.usedSelection) {
    document.getElementById('export-form').submit();
    return;
  }
  var headerCells = _visibleDataColumns();
  var columns = headerCells.map(function(th){
    var clone = th.cloneNode(true);
    clone.querySelectorAll('.sort-icon,.col-resizer').forEach(function(el){ el.remove(); });
    return clone.textContent.trim();
  });
  var lines = [columns.map(_csvField).join(',')];
  picked.rows.forEach(function(r){
    lines.push(_rowDataValues(r).map(_csvField).join(','));
  });
  var blob = new Blob([lines.join('\r\n')], {type: 'text/csv;charset=utf-8;'});
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = (_tmpl() || 'export') + '_selected.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Send-to pipeline (Outlook / Excel / Teams) ─────────────────────────────
function buildDeepLink() {
  var form = document.getElementById('search-form');
  if (!form) return '';
  var params = new URLSearchParams();
  params.set('template', form.querySelector('input[name=template]').value);
  form.querySelectorAll('.ta[data-ac-idx]').forEach(function(ta){
    if (ta.value.trim()) params.set('key_' + ta.dataset.acIdx, ta.value.trim());
  });
  params.set('mode', form.querySelector('select[name=mode]').value);
  params.set('run', '1');
  return location.origin + '/?' + params.toString();
}
function copyDeepLink() {
  var link = buildDeepLink();
  if (!link) return;
  navigator.clipboard.writeText(link).then(function(){ showToast('Link copied.'); });
}

function followLink(link) {
  // Collect unique values for link.from_key from visible result rows
  var fromKey = link.from_key;
  var seen = {};
  var vals = [];
  // Check both table cells and card fields
  document.querySelectorAll('.results-table tbody td[data-col="' + fromKey + '"], .record-card .rc-row[data-col="' + fromKey + '"] .rc-v').forEach(function(el) {
    var v = (el.textContent || '').trim();
    if (v && !seen[v]) { seen[v] = true; vals.push(v); }
  });
  if (!vals.length) { showToast('No ' + fromKey + ' values in current results.'); return; }
  // Find which key index in the target template maps to to_key
  // We don't know the target's key order, so put all values in key_0
  // and let the target figure it out via its own key columns.
  // The to_key_index tells us which key_N to fill.
  var toKeyIdx = link.to_key_index || 0;
  var params = new URLSearchParams();
  params.set('template', link.to_template);
  params.set('key_' + toKeyIdx, vals.join('\n'));
  params.set('mode', 'exact');
  params.set('run', '1');
  if (link.to_view) params.set('view', link.to_view);   // open a specific view on the target
  var myLink = buildDeepLink();   // this page's own search — lets the target link back
  if (myLink) params.set('back', myLink);
  window.location.href = '/?' + params.toString();
}

function buildSendPayload() {
  var headerCells = _visibleDataColumns();
  if (!headerCells.length) { showToast('Nothing to send.'); return null; }
  var columns = headerCells.map(function(th){ return th.getAttribute('data-col'); });
  var picked = _rowsForAction();
  if (!picked.rows.length) { showToast('Nothing to send.'); return null; }
  if (!picked.usedSelection) {
    if (!confirm('Nothing selected — send all ' + picked.total + ' row' + (picked.total !== 1 ? 's' : '') + '?')) return null;
  }
  var rows = picked.rows.map(_rowDataValues);
  return {template: _tmpl(), columns: columns, rows: rows, deep_link: buildDeepLink()};
}

function kindLabel(kind) { return kind === 'outlook' ? 'Outlook' : kind === 'excel' ? 'Excel' : 'Teams'; }

// Excel opens directly via COM (server-side, same machine — see
// core/send_excel.py) — a fresh temp workbook, never an append to an
// existing tracker. Same request shape as Outlook/Teams, no file download.
function sendTo(kind, targetId) {
  var p = buildSendPayload();
  if (!p) return;
  if (targetId) p.target = targetId;
  fetch('/api/send/' + kind, {method: 'POST',
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify(p)})
    .then(function(r){ return r.json(); })
    .then(function(res){
      if (res.ok) { showToast((kind === 'excel' ? 'Opened' : 'Sent') + ' ' + p.rows.length + ' row(s) ' + (kind === 'excel' ? 'in' : 'to') + ' ' + kindLabel(kind) + '.'); }
      else { showToast('Error: ' + (res.error || 'failed')); }
    })
    .catch(function(){ showToast('Error: server unreachable.'); });
}

// ── Teams webhook chooser + manage dialog ───────────────────────────────
function toggleTeamsChooser() {
  var el = document.getElementById('teams-chooser');
  if (!el) return;
  if (el.style.display !== 'none') { el.style.display = 'none'; return; }
  fetch('/api/teams_webhooks').then(function(r){ return r.json(); }).then(function(hooks){
    el.innerHTML = '';
    if (!hooks.length) {
      var empty = document.createElement('div');
      empty.className = 'teams-chooser-empty';
      empty.textContent = 'No saved webhooks.';
      el.appendChild(empty);
    }
    hooks.forEach(function(h){
      var item = document.createElement('div');
      item.className = 'teams-chooser-item';
      item.textContent = h.name + ' (…' + h.url_tail + ')';
      item.addEventListener('click', function(){ el.style.display = 'none'; sendTo('teams', h.id); });
      el.appendChild(item);
    });
    var manage = document.createElement('div');
    manage.className = 'teams-chooser-item teams-chooser-manage';
    manage.textContent = 'Manage…';
    manage.addEventListener('click', function(){ el.style.display = 'none'; openTeamsManage(); });
    el.appendChild(manage);
    el.style.display = '';
  });
}
document.addEventListener('click', function(e){
  var wrap = document.querySelector('.send-teams-wrap');
  var chooser = document.getElementById('teams-chooser');
  if (chooser && chooser.style.display !== 'none' && wrap && !wrap.contains(e.target)) chooser.style.display = 'none';
});
function openTeamsManage() {
  var m = document.getElementById('teams-manage-modal'); if (!m) return;
  document.getElementById('teams-manage-error').style.display = 'none';
  document.getElementById('teams-new-name').value = '';
  document.getElementById('teams-new-url').value = '';
  _loadTeamsManageList();
  _loadNotifySelect();
  m.style.display = '';
}
function closeTeamsManage() { var m = document.getElementById('teams-manage-modal'); if (m) m.style.display = 'none'; }
function _loadTeamsManageList() {
  fetch('/api/teams_webhooks').then(function(r){ return r.json(); }).then(function(hooks){
    var list = document.getElementById('teams-manage-list');
    list.innerHTML = '';
    hooks.forEach(function(h){
      var li = document.createElement('li');
      li.className = 'found-item';
      var label = document.createElement('span'); label.className = 'found-label';
      label.textContent = h.name + ' (…' + h.url_tail + ')';
      var x = document.createElement('button'); x.type = 'button'; x.className = 'found-x'; x.textContent = '×'; x.title = 'Delete';
      x.addEventListener('click', function(){
        fetch('/api/teams_webhooks?id=' + encodeURIComponent(h.id), {method: 'DELETE'}).then(_loadTeamsManageList);
      });
      li.appendChild(label); li.appendChild(x);
      list.appendChild(li);
    });
  });
}
function _loadNotifySelect() {
  fetch('/api/teams_webhooks').then(function(r){ return r.json(); }).then(function(hooks){
    var sel = document.getElementById('notify-webhook-select'); if (!sel) return;
    var current = document.body.dataset.notifyWebhookId || '';
    sel.innerHTML = '<option value="">Off</option>';
    hooks.forEach(function(h){
      var opt = document.createElement('option'); opt.value = h.id; opt.textContent = h.name;
      if (h.id === current) opt.selected = true;
      sel.appendChild(opt);
    });
  });
}
function saveNotifyWebhook(val) {
  var body = new URLSearchParams(); body.set('template', _tmpl()||''); body.set('notify_webhook_id', val);
  fetch('/settings', {method: 'POST', body: body}).catch(function(){});
}
function addTeamsWebhook() {
  var name = document.getElementById('teams-new-name').value.trim();
  var url = document.getElementById('teams-new-url').value.trim();
  fetch('/api/teams_webhooks', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name: name, url: url})})
    .then(function(r){ return r.json().then(function(j){ return {ok: r.ok, j: j}; }); })
    .then(function(res){
      if (!res.ok || !res.j || res.j.ok === false) {
        var err = document.getElementById('teams-manage-error');
        err.textContent = '⚠ ' + ((res.j && res.j.error) || 'Could not add webhook.');
        err.style.display = '';
        return;
      }
      document.getElementById('teams-new-name').value = '';
      document.getElementById('teams-new-url').value = '';
      _loadTeamsManageList();
    });
}

// ── Send/Export button tooltips reflect selection state ────────────────
function _updateSendTooltips() {
  var picked = _rowsForAction();
  var n = picked.usedSelection ? _selected.size : picked.total;
  var label = picked.usedSelection ? (n + ' selected row' + (n !== 1 ? 's' : '')) : ('all ' + n + ' row' + (n !== 1 ? 's' : ''));
  ['send-outlook-btn', 'send-excel-btn', 'send-teams-btn'].forEach(function(id){
    var btn = document.getElementById(id);
    if (btn && !btn.disabled) btn.title = 'Send ' + label + ' to ' + kindLabelForBtn(id);
  });
  var exportBtn = document.getElementById('export-csv-btn');
  if (exportBtn && !exportBtn.disabled) exportBtn.title = 'Export ' + label + ' to CSV';
}
function kindLabelForBtn(id) {
  return id === 'send-outlook-btn' ? 'Outlook' : id === 'send-excel-btn' ? 'Excel' : 'Teams';
}

// ── Autocomplete ──────────────────────────────────────────────────────────
var _acSourceCache = {};   // tpl::col → string[] loaded from server

function acLoad(tpl, idx) {
  try { return JSON.parse(localStorage.getItem('waire_ac::' + tpl + '::' + idx) || '[]'); } catch(e) { return []; }
}
function acSave(tpl, idx, val) {
  val = (val || '').trim();
  if (!val) return;
  var key = 'waire_ac::' + tpl + '::' + idx;
  var hist = acLoad(tpl, idx).filter(function(v){ return v !== val; });
  hist.unshift(val);
  try { localStorage.setItem(key, JSON.stringify(hist.slice(0, 30))); } catch(e){}
}
function acFragment(ta) {
  var val = ta.value;
  var last = Math.max(val.lastIndexOf(','), val.lastIndexOf('\n'));
  return last >= 0 ? val.slice(last + 1).trim() : val.trim();
}
function acSourceValues(tpl, col, frag, cb) {
  var f = (frag || '').toLowerCase();
  var key = tpl + '::' + col + '::' + f;
  if (_acSourceCache[key]) { cb(_acSourceCache[key]); return; }
  _acSourceCache[key] = [];   // mark as loading so we don't double-fetch
  var url = '/api/column_values?template=' + encodeURIComponent(tpl)
          + '&col=' + encodeURIComponent(col);
  if (f) url += '&q=' + encodeURIComponent(f);
  fetch(url)
    .then(function(r){ return r.ok ? r.json() : []; })
    .then(function(vals){
      _acSourceCache[key] = vals || [];
      cb(_acSourceCache[key]);
    }).catch(function(){ cb([]); });
}
function initAutocomplete() {
  document.querySelectorAll('.ta[data-ac-tpl]').forEach(function(ta) {
    var tpl  = ta.getAttribute('data-ac-tpl');
    var idx  = ta.getAttribute('data-ac-idx');
    var col  = ta.getAttribute('data-ac-col');   // set by server via data-ac-col
    var drop = ta.parentNode.querySelector('.ac-dropdown');
    if (!drop) return;

    function renderDropdown(sourceVals) {
      var frag = acFragment(ta).toLowerCase();
      // Wildcard fragment: suggestions are literal-substring matches and become
      // noise the moment the user starts typing a * / ? pattern — hide them.
      if (/[*?]/.test(frag)) { drop.style.display = 'none'; return; }
      var hist = acLoad(tpl, idx);

      // Merge: history items first (recently used), then source values, deduped
      var histSet = {};
      hist.forEach(function(v){ histSet[v] = true; });
      var pool = hist.concat(sourceVals.filter(function(v){ return !histSet[v]; }));

      // Substring match, prefix-first ordering: entries whose lowercase starts
      // with the fragment show before entries that merely contain it.
      var matches;
      if (!frag) {
        matches = pool;
      } else {
        var starts = [], contains = [];
        pool.forEach(function(v){
          var lv = v.toLowerCase();
          if (lv === frag) return;               // exact-current: skip
          if (lv.indexOf(frag) === 0) starts.push(v);
          else if (lv.indexOf(frag) > 0) contains.push(v);
        });
        matches = starts.concat(contains);
      }
      matches = matches.slice(0, 12);
      if (!matches.length) { drop.style.display = 'none'; return; }
      drop.innerHTML = '';
      matches.forEach(function(m) {
        var item = document.createElement('div');
        item.className = 'ac-item';
        item.textContent = m;
        item.addEventListener('mousedown', function(e) {
          e.preventDefault();
          var val = ta.value;
          var last = Math.max(val.lastIndexOf(','), val.lastIndexOf('\n'));
          ta.value = last >= 0 ? val.slice(0, last + 1) + (val[last] === ',' ? ' ' : '') + m : m;
          drop.style.display = 'none';
          ta.focus();
        });
        drop.appendChild(item);
      });
      drop.style.display = '';
    }

    function showSuggestions() {
      acSourceValues(tpl, col, acFragment(ta), renderDropdown);
    }

    ta.addEventListener('input', showSuggestions);
    ta.addEventListener('focus', showSuggestions);
    ta.addEventListener('blur', function(){ setTimeout(function(){ drop.style.display = 'none'; }, 150); });
    ta.addEventListener('keydown', function(e) {
      if (drop.style.display === 'none') return;
      var items = Array.from(drop.querySelectorAll('.ac-item'));
      var activeIdx = items.findIndex(function(i){ return i.classList.contains('ac-active'); });
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (activeIdx >= 0) items[activeIdx].classList.remove('ac-active');
        items[(activeIdx + 1) % items.length].classList.add('ac-active');
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (activeIdx >= 0) items[activeIdx].classList.remove('ac-active');
        items[(activeIdx - 1 + items.length) % items.length].classList.add('ac-active');
      } else if (e.key === 'Enter' && activeIdx >= 0) {
        e.preventDefault();
        items[activeIdx].dispatchEvent(new MouseEvent('mousedown'));
      } else if (e.key === 'Escape') {
        drop.style.display = 'none';
      }
    });
  });
}

// Save searched values to autocomplete history on submit
(function() {
  var form = document.getElementById('search-form');
  if (!form) return;
  form.addEventListener('submit', function() {
    var tpl = (form.querySelector('input[name=template]') || {}).value || '';
    form.querySelectorAll('.ta[data-ac-idx]').forEach(function(ta) {
      var idx = ta.getAttribute('data-ac-idx');
      ta.value.split(/[\n,]+/).forEach(function(raw) {
        var v = raw.trim();
        if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).trim();
        acSave(tpl, idx, v);
      });
    });
  });
})();

// Export/Send ribbon buttons start disabled server-side (Jinja, no result yet)
// and are never re-enabled after an AJAX search renders new results — do it here.
function _setResultButtonsEnabled(enabled) {
  ['export-csv-btn', 'copy-tsv-btn', 'send-outlook-btn', 'send-excel-btn', 'send-teams-btn'].forEach(function(id) {
    var btn = document.getElementById(id);
    if (btn) btn.disabled = !enabled;
  });
}

// ── Refresh toast ─────────────────────────────────────────────────────────
function showToast(msg) {
  var t = document.getElementById('waire-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'waire-toast';
    t.className = 'waire-toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._to);
  t._to = setTimeout(function(){ t.classList.remove('show'); }, 2500);
}

// ── Source-update banner / refresh ────────────────────────────────────────
function refreshResults() {
  var f = document.getElementById('search-form');
  if (!f) return;
  var fr = document.getElementById('force-reload');
  if (fr) fr.value = '1';
  f.requestSubmit();
}
function ribbonRefresh() {
  var hasResult = parseInt((_rw() || {}).getAttribute && _rw().getAttribute('data-total') || '0', 10) > 0;
  if (hasResult) {
    sessionStorage.setItem('waire_refreshed', '1');
    refreshResults();
    return;
  }
  var tpl = _tmpl(); if (!tpl) return;
  var body = new URLSearchParams(); body.set('template', tpl);
  fetch('/refresh', {method: 'POST', body: body})
    .then(function(){ showToast('Source refreshed.'); })
    .catch(function(){ showToast('Refresh failed.'); });
}

function _tmpl() {
  var tpl = document.querySelector('#search-form input[name=template]');
  return tpl ? tpl.value : '';
}

function pollSourceStatus() {
  var tpl = _tmpl(); if (!tpl) return;
  fetch('/api/source_status?template=' + encodeURIComponent(tpl), {credentials: 'same-origin'})
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(j) {
      if (!j) return;
      var b = document.getElementById('update-banner');
      if (b) b.style.display = j.stale ? '' : 'none';
    }).catch(function(){});
}

// ── Microsoft 365 sign-in ─────────────────────────────────────────────────
function signIn() {
  fetch('/auth/signin', {method: 'POST'}).then(function(r) {
    if (!r.ok) { r.json().then(function(j){ alert(j && j.error ? j.error : 'Sign-in failed.'); }, function(){}); return; }
    setAuthStatusText('Signing in… (a browser window opened)');
    var iv = setInterval(function() {
      fetch('/api/auth_status').then(function(r){ return r.ok ? r.json() : null; }).then(function(j) {
        if (!j) return;
        if (j.signed_in) { clearInterval(iv); renderAuthStatus(j); }
        else if (j.last_error && !j.running) { clearInterval(iv); renderAuthStatus(j); }
      });
    }, 1500);
  });
}
function signOut() {
  fetch('/auth/signout', {method: 'POST'}).then(function(){ refreshAuthStatus(); });
}
function refreshAuthStatus() {
  fetch('/api/auth_status').then(function(r){ return r.ok ? r.json() : null; }).then(renderAuthStatus);
}
function setAuthStatusText(t){ var el = document.getElementById('auth-status'); if (el) el.textContent = t; }
function renderAuthStatus(j) {
  if (!j) return;
  var setupBtn = document.getElementById('setup-btn');
  var inBtn = document.getElementById('signin-btn');
  var outBtn = document.getElementById('signout-btn');
  if (!j.configured) {
    setAuthStatusText('SharePoint not configured');
    setupBtn.style.display = ''; inBtn.style.display = 'none'; outBtn.style.display = 'none';
    return;
  }
  setupBtn.style.display = 'none';
  if (j.signed_in) {
    setAuthStatusText('Signed in: ' + (j.username || ''));
    inBtn.style.display = 'none'; outBtn.style.display = '';
  } else {
    setAuthStatusText(j.last_error || 'Not signed in');
    inBtn.style.display = ''; outBtn.style.display = 'none'; inBtn.disabled = false;
  }
}

// ── SharePoint setup modal ────────────────────────────────────────────────
function openSetup() { var m = document.getElementById('setup-modal'); if (m) { m.style.display = ''; setupClearFeedback(); } }
function closeSetup() { var m = document.getElementById('setup-modal'); if (m) m.style.display = 'none'; }
function setupClearFeedback() {
  var e = document.getElementById('setup-error'); if (e) { e.style.display = 'none'; e.textContent = ''; }
  var o = document.getElementById('setup-ok'); if (o) o.style.display = 'none';
}
function resetSetupDefaults() {
  document.getElementById('cfg-client-id').value = '14d82eec-204b-4c2f-b7e8-296a70dab67e';
  document.getElementById('cfg-tenant').value = 'organizations';
}
function saveSetup() {
  setupClearFeedback();
  var body = new URLSearchParams();
  body.set('template', _tmpl() || '');
  body.set('graph_client_id', (document.getElementById('cfg-client-id').value || '').trim());
  body.set('graph_tenant', (document.getElementById('cfg-tenant').value || '').trim());
  fetch('/settings', {method: 'POST', body: body}).then(function(r) {
    return r.json().then(function(j){ return {ok: r.ok, j: j}; });
  }).then(function(res) {
    if (!res.ok || !res.j || res.j.ok === false) {
      var err = document.getElementById('setup-error');
      err.textContent = '⚠ ' + ((res.j && res.j.error) || 'Could not save settings.');
      err.style.display = '';
      return;
    }
    document.getElementById('setup-ok').style.display = '';
    refreshAuthStatus();
    setTimeout(closeSetup, 900);
  }).catch(function(e) {
    var err = document.getElementById('setup-error');
    err.textContent = '⚠ ' + (e && e.message ? e.message : 'Save failed.');
    err.style.display = '';
  });
}

function testConnection() {
  setupClearFeedback();
  var btn = document.getElementById('test-conn-btn');
  btn.disabled = true; btn.textContent = 'Testing…';
  fetch('/api/auth_test', {method: 'POST'}).then(function(r){ return r.json(); })
  .then(function(j) {
    btn.disabled = false; btn.innerHTML = '<i class="ti ti-plug" aria-hidden="true"></i> Test';
    var el = document.getElementById(j.ok ? 'setup-ok' : 'setup-error');
    el.textContent = j.ok ? '✓ ' + j.message : '⚠ ' + j.message;
    el.style.display = '';
  }).catch(function() {
    btn.disabled = false; btn.innerHTML = '<i class="ti ti-plug" aria-hidden="true"></i> Test';
    var err = document.getElementById('setup-error');
    err.textContent = '⚠ Connection test failed.'; err.style.display = '';
  });
}

// ── View toggle (cards vs table) — explicit, persisted in localStorage ─────
function storedViewMode() {
  try { return localStorage.getItem('waire_viewmode') === 'table' ? 'table' : 'cards'; }
  catch(e) { return 'cards'; }
}
function setViewMode(mode) {
  mode = (mode === 'table') ? 'table' : 'cards';
  try { localStorage.setItem('waire_viewmode', mode); } catch(e){}
  applyResultsView();
}
function applyResultsView() {
  var wrap = _rw(); if (!wrap) return;
  var mode = storedViewMode();
  var cardBtn = document.getElementById('vm-cards');
  var tableBtn = document.getElementById('vm-table');
  if (cardBtn) cardBtn.classList.toggle('active', mode === 'cards');
  if (tableBtn) tableBtn.classList.toggle('active', mode === 'table');

  var cardView = _activeCardView();
  var tableView = _activeTableView();
  var foundPanel = document.getElementById('found-panel');
  if (!cardView || !tableView) {
    // Active group is disabled/empty — no card/table blocks. Nothing to toggle.
    if (foundPanel) foundPanel.style.display = 'none';
    return;
  }
  var showCards = mode === 'cards';
  cardView.style.display = showCards ? '' : 'none';
  tableView.style.display = showCards ? 'none' : '';
  if (foundPanel) foundPanel.style.display = '';
  if (showCards) { if (!_cardsLaidOut) { layoutCards(); _cardsLaidOut = true; } }
  else { if (!_tableEnhanced) { enhanceResultsTable(); _tableEnhanced = true; } buildFoundList(); }
}

// ── Resizable + sortable table columns ───────────────────────────────────
function enhanceResultsTable() {
  var table = _activeResultsTable();
  if (!table) return;
  if (table._enhanced) return;   // don't re-enhance per group
  table._enhanced = true;
  var ths = Array.prototype.slice.call(table.querySelectorAll('thead th'));
  if (!ths.length) return;
  var tbody = table.querySelector('tbody');

  var labels = ths.map(function(th) {
    var clone = th.cloneNode(true);
    clone.querySelectorAll('.sort-icon,.col-resizer').forEach(function(el){ el.remove(); });
    return clone.textContent.trim();
  });

  ths.forEach(function(th) {
    th.classList.add('sortable');
    var icon = document.createElement('span');
    icon.className = 'sort-icon';
    icon.textContent = '·';
    th.appendChild(icon);
  });

  var KEY = 'waire_colw::' + (table.getAttribute('data-template') || '');
  var saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch(e) { saved = {}; }

  var widths = ths.map(function(th, i) {
    if (saved[labels[i]]) return saved[labels[i]];
    return Math.min(Math.max(Math.round(th.getBoundingClientRect().width), 60), 320);
  });

  // Set widths directly on th elements (not colgroup) so hidden columns
  // don't break the column-index mapping in table-layout:fixed.
  ths.forEach(function(th, i) { th.style.width = widths[i] + 'px'; });
  table.classList.add('resizable');
  function totalW(){
    var sum = 0;
    for (var j = 0; j < widths.length; j++) {
      if (ths[j] && getComputedStyle(ths[j]).display === 'none') continue;
      sum += widths[j];
    }
    return sum;
  }
  table._totalW = totalW;
  table.style.width = totalW() + 'px';
  if (ths.length) ths[ths.length - 1].style.overflow = 'visible';

  ths.forEach(function(th, i) {
    var handle = document.createElement('span');
    handle.className = 'col-resizer';
    th.appendChild(handle);
    handle.addEventListener('mousedown', function(e) {
      e.preventDefault(); e.stopPropagation();
      var startX = e.pageX, startW = widths[i];
      handle.classList.add('dragging');
      function onMove(ev) {
        widths[i] = Math.max(40, startW + ev.pageX - startX);
        th.style.width = widths[i] + 'px';
        table.style.width = totalW() + 'px';
      }
      function onUp() {
        handle.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        saved[labels[i]] = widths[i];
        try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch(e){}
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });

  var sortIndex = -1, sortDir = 'asc';
  function clean(v){ return v.replace(/[,$£€%]/g, '').trim(); }
  function columnIsNumeric(i) {
    var any = false;
    for (var r = 0; r < tbody.rows.length; r++) {
      var v = (tbody.rows[r].cells[i] ? tbody.rows[r].cells[i].textContent : '').trim();
      if (!v) continue;
      any = true;
      if (!/^-?\d+(\.\d+)?$/.test(clean(v))) return false;
    }
    return any;
  }
  function sortBy(i) {
    sortDir = (sortIndex === i && sortDir === 'asc') ? 'desc' : 'asc';
    sortIndex = i;
    var numeric = columnIsNumeric(i);
    var dir = sortDir === 'asc' ? 1 : -1;
    var rows = Array.prototype.slice.call(tbody.rows);
    rows.sort(function(ra, rb) {
      var a = (ra.cells[i] ? ra.cells[i].textContent : '').trim();
      var b = (rb.cells[i] ? rb.cells[i].textContent : '').trim();
      if (!a && !b) return 0; if (!a) return 1; if (!b) return -1;
      var c = numeric ? (parseFloat(clean(a)) - parseFloat(clean(b)))
                      : a.localeCompare(b, undefined, {numeric: true, sensitivity: 'base'});
      return c * dir;
    });
    rows.forEach(function(r){ tbody.appendChild(r); });
    ths.forEach(function(th, j) {
      var ic = th.querySelector('.sort-icon');
      if (j === i) { ic.textContent = sortDir === 'asc' ? '↑' : '↓'; th.classList.add('sort-active'); }
      else { ic.textContent = '·'; th.classList.remove('sort-active'); }
    });
  }
  ths.forEach(function(th, i) {
    th.addEventListener('click', function(e) {
      if (e.target.closest('.col-resizer')) return;
      sortBy(i);
    });
  });

  // Table row click → selection
  Array.prototype.forEach.call(tbody.rows, function(tr) {
    tr.addEventListener('click', function(e) {
      var cid = tr.getAttribute('data-cid');
      if (cid) selectCard(cid, e.ctrlKey || e.metaKey);
    });
  });
}

// ── Cards workspace ───────────────────────────────────────────────────────
var _tableEnhanced = false, _cardsLaidOut = false, _zTop = 10, _cardsContentH = 0, _workspaceH = 0;

function _rw(){ return document.querySelector('.results'); }
function openCount(){
  var block = _activeGroupBlock(); if (!block) return 0;
  var n = 0;
  block.querySelectorAll('.card-view .record-card').forEach(function(c){ if (!_closed[c.getAttribute('data-cid')]) n++; });
  return n;
}

function onPollMinutesChange(val) {
  var n = Math.min(120, Math.max(1, parseInt(val, 10) || 1));
  var input = document.querySelector('input[name=poll_minutes]');
  if (input) input.value = n;
  _postSetting({poll_minutes: n});
}
function _postSetting(kv) {
  try {
    var body = new URLSearchParams();
    var tpl = document.querySelector('#settings-form input[name=template]');
    body.set('template', (tpl && tpl.value) || '');
    Object.keys(kv).forEach(function(k){ body.set(k, kv[k]); });
    fetch('/settings', {method: 'POST', body: body, redirect: 'manual'}).catch(function(){});
  } catch(e){}
}

function layoutCards() {
  var cv = _activeCardView(); if (!cv) return;
  var cards = Array.prototype.slice.call(cv.querySelectorAll('.record-card'));
  if (!cards.length) return;
  var pad = 14, cardW = 340, gap = 14;
  var W = cv.clientWidth || 800;
  var cols = Math.max(1, Math.floor((W - pad*2 + gap) / (cardW + gap)));
  cards.forEach(function(c){ c.style.width = cardW + 'px'; });
  var rowH = 0; cards.forEach(function(c){ rowH = Math.max(rowH, c.offsetHeight); });
  cards.forEach(function(c, i) {
    var col = i % cols, row = Math.floor(i / cols);
    c.style.position = 'absolute';
    c.style.left = (pad + col * (cardW + gap)) + 'px';
    c.style.top  = (pad + row * (rowH + gap)) + 'px';
    c.style.zIndex = 1;
    makeCardInteractive(c);
  });
  var rows = Math.ceil(cards.length / cols);
  _cardsContentH = pad*2 + rows * (rowH + gap);
  _workspaceH = Math.max(cv.clientHeight, _cardsContentH);
  buildFoundList();
}

function makeCardInteractive(card) {
  if (card._wired) return; card._wired = true;
  var cv = card.closest('.card-view');
  var head = card.querySelector('.rc-head');
  // Click on card body = select it (not toggle)
  card.addEventListener('mousedown', function(e){ if (!e.target.closest('button')) activateCard(card, false); });
  if (head) {
    head.addEventListener('mousedown', function(e) {
      if (e.target.closest('button')) return;
      e.preventDefault();
      selectCard(card.getAttribute('data-cid'), e.ctrlKey || e.metaKey);
      activateCard(card, false);
      var startX = e.clientX, startY = e.clientY, startL = card.offsetLeft, startT = card.offsetTop;
      head.classList.add('dragging');
      function onMove(ev) {
        var maxL = Math.max(0, cv.clientWidth - card.offsetWidth);
        var maxT = Math.max(0, Math.max(cv.clientHeight, _workspaceH) - card.offsetHeight);
        card.style.left = Math.min(Math.max(0, startL + ev.clientX - startX), maxL) + 'px';
        card.style.top  = Math.min(Math.max(0, startT + ev.clientY - startY), maxT) + 'px';
      }
      function onUp(){ head.classList.remove('dragging'); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }
  var x = card.querySelector('.rc-close');
  if (x) x.addEventListener('click', function(e){ e.stopPropagation(); closeCard(card.getAttribute('data-cid')); });
  var cp = card.querySelector('.rc-copy');
  if (cp) cp.addEventListener('click', function(e){ e.stopPropagation(); copyCard(card, cp); });
  var cl = card.querySelector('.rc-collapse');
  if (cl) cl.addEventListener('click', function(e){ e.stopPropagation(); card.classList.toggle('collapsed'); });
}

function copyCard(card, btn) {
  // If multiple cards are selected, copy all of them; otherwise just this one.
  var cid = card.getAttribute('data-cid');
  var cardsToUse = (_selected.size > 1 && _selected.has(cid))
    ? Array.from(document.querySelectorAll('.group-block .card-view .record-card')).filter(function(c){ return _selected.has(c.getAttribute('data-cid')); })
    : [card];

  var lines = [];
  cardsToUse.forEach(function(c, ci) {
    if (ci > 0) lines.push('---');
    var mo = c.getAttribute('data-matched') || '';
    if (mo) {
      mo.split(' & ').forEach(function(seg) {
        var idx = seg.indexOf(' = ');
        if (idx > -1) lines.push(seg.slice(0, idx).trim() + ': ' + seg.slice(idx + 3).trim());
      });
    }
    c.querySelectorAll('.rc-row').forEach(function(r) {
      if (r.style.display === 'none') return;
      var k = ((r.querySelector('.rc-k') || {}).textContent || '').trim();
      var v = ((r.querySelector('.rc-v') || {}).textContent || '').trim();
      lines.push(k + ': ' + v);
    });
  });

  function done(){ if (btn) { btn.classList.add('copied'); setTimeout(function(){ btn.classList.remove('copied'); }, 1200); } }
  if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(lines.join('\n')).then(done, function(){}); }
}

function activateCard(card, scroll) {
  document.querySelectorAll('.group-block .card-view .record-card.active').forEach(function(c){ c.classList.remove('active'); });
  card.classList.add('active');
  card.style.zIndex = ++_zTop;
  var cid = card.getAttribute('data-cid');
  document.querySelectorAll('#found-list .found-item').forEach(function(li){ li.classList.toggle('active', li.getAttribute('data-cid') === cid); });
  if (scroll) {
    var cv = card.closest('.card-view');
    if (!cv) return;
    var top = card.offsetTop, bot = top + card.offsetHeight;
    if (top < cv.scrollTop) cv.scrollTop = Math.max(0, top - 10);
    else if (bot > cv.scrollTop + cv.clientHeight) cv.scrollTop = bot - cv.clientHeight + 10;
  }
}

function closeCard(cid) {
  _closed[cid] = true;
  _selected.delete(cid);
  var card = document.querySelector('.group-block .card-view .record-card[data-cid="' + cid + '"]');
  if (card) card.style.display = 'none';
  var tr = document.querySelector('.results-table tr[data-cid="' + cid + '"]');
  if (tr) tr.style.display = 'none';
  var li = document.querySelector('#found-list .found-item[data-cid="' + cid + '"]');
  if (li && li.parentNode) li.parentNode.removeChild(li);
  updateFoundCount();
}

function buildFoundList() {
  var list = document.getElementById('found-list'); if (!list) return;
  list.innerHTML = '';
  // Only records from the currently-active group appear in Found items.
  var block = _activeGroupBlock();
  if (!block) { updateFoundCount(); return; }
  block.querySelectorAll('.card-view .record-card').forEach(function(card) {
    var cid = card.getAttribute('data-cid');
    if (_closed[cid]) return;
    var title = (card.getAttribute('data-title') || '').trim() || ('Record ' + cid);
    var li = document.createElement('li');
    li.className = 'found-item';
    li.setAttribute('data-cid', cid);
    var label = document.createElement('span'); label.className = 'found-label'; label.textContent = title; label.title = title;
    var x = document.createElement('button'); x.type = 'button'; x.className = 'found-x'; x.textContent = '×'; x.title = 'Close card'; x.setAttribute('aria-label', 'Close card');
    li.appendChild(label); li.appendChild(x);
    li.addEventListener('click', function(e) {
      if (e.target === x) return;
      selectCard(cid, e.ctrlKey || e.metaKey);
      var cv = _activeCardView();
      if (cv && cv.style.display !== 'none') {
        var c = cv.querySelector('.record-card[data-cid="' + cid + '"]');
        if (c) activateCard(c, true);
      } else {
        var tr = document.querySelector('.results-table tr[data-cid="' + cid + '"]');
        if (tr) tr.scrollIntoView({block: 'nearest'});
      }
    });
    x.addEventListener('click', function(e){ e.stopPropagation(); closeCard(cid); });
    list.appendChild(li);
  });
  updateFoundCount();
}

function updateFoundCount(){ var fc = document.getElementById('found-count'); if (fc) fc.textContent = '(' + openCount() + ')'; }

// ── Draggable panel divider ───────────────────────────────────────────────
(function(){
  var handle = document.getElementById('panel-divider');
  var panel  = document.getElementById('inputs-panel');
  if (!handle || !panel) return;
  var STORAGE_KEY = 'waire_inputs_w';
  var saved = parseInt(localStorage.getItem(STORAGE_KEY), 10);
  if (saved >= 140 && saved <= 600) panel.style.width = saved + 'px';
  handle.addEventListener('mousedown', function(e) {
    e.preventDefault();
    var startX = e.clientX, startW = panel.offsetWidth;
    document.body.style.cursor = 'col-resize';
    handle.classList.add('dragging');
    function onMove(ev) {
      var w = Math.min(600, Math.max(140, startW + ev.clientX - startX));
      panel.style.width = w + 'px';
    }
    function onUp() {
      document.body.style.cursor = '';
      handle.classList.remove('dragging');
      try { localStorage.setItem(STORAGE_KEY, panel.offsetWidth); } catch(e){}
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      var cv = _activeCardView(), tv = _activeTableView();
      if (cv && cv.style.display !== 'none') {
        _cardsLaidOut = false; layoutCards();
      } else if (tv && tv.style.display !== 'none') {
        _tableEnhanced = false;
        var t = _activeResultsTable(); if (t) t._enhanced = false;
        enhanceResultsTable();
      }
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
})();

document.addEventListener('DOMContentLoaded', function() {
  applyResultsView();
  applyInitialView();
  refreshAuthStatus();
  initAutocomplete();
  document.querySelectorAll('.ta[data-ac-idx]').forEach(function(ta){
    var counter = document.createElement('span');
    counter.className = 'val-count';
    ta.parentNode.appendChild(counter);
    function upd(){
      var raw = ta.value.trim();
      if (!raw) { counter.textContent = ''; return; }
      var n = raw.split(/[\n,]+/).filter(function(v){ var s = v.trim(); if(s.startsWith('"')&&s.endsWith('"')) s=s.slice(1,-1).trim(); return s.length > 0; }).length;
      counter.textContent = n + ' value' + (n !== 1 ? 's' : '');
    }
    ta.addEventListener('input', upd);
    upd();
  });
  if (_tmpl()) {
    pollSourceStatus();
    setInterval(pollSourceStatus, 60000);
  }
  // Show toast if page was reloaded by ribbonRefresh
  if (sessionStorage.getItem('waire_refreshed')) {
    sessionStorage.removeItem('waire_refreshed');
    showToast('Source refreshed.');
  }
  _updateSendTooltips();
  fetch('/api/update_check').then(function(r){ return r.ok ? r.json() : null; }).then(function(j){
    if (!j || !j.update_available) return;
    var chip = document.getElementById('update-chip');
    if (!chip) return;
    var a = document.createElement('a');
    a.href = j.url || '#'; a.target = '_blank'; a.rel = 'noopener';
    a.textContent = '⬆ ' + (j.latest || 'update') + ' available';
    a.style.cssText = 'color:#1a3a5c;font-size:11px;text-decoration:underline;margin-right:8px';
    chip.appendChild(a); chip.style.display = '';
  }).catch(function(){});
  // ── Log viewer (M10) ────────────────────────────────────────────────────
  function openLogViewer() {
    document.getElementById('log-modal').style.display = '';
    loadLogTail();
  }
  function loadLogTail() {
    var pre = document.getElementById('log-pre'); if (!pre) return;
    pre.textContent = 'Loading…';
    fetch('/api/log_tail?lines=200').then(function(r){ return r.json(); }).then(function(j){
      pre.textContent = (j.lines || []).join('\n') || '(empty)';
      pre.scrollTop = pre.scrollHeight;
    }).catch(function(){ pre.textContent = 'Failed to load log.'; });
  }

  // ── Quick filter (M8) ───────────────────────────────────────────────────
  var _filterTimer = null;
  function applyQuickFilter(raw) {
    clearTimeout(_filterTimer);
    _filterTimer = setTimeout(function(){ _doFilter(raw); }, 150);
  }
  function _doFilter(raw) {
    var q = (raw || '').toLowerCase();
    var block = _activeGroupBlock(); if (!block) return;
    var total = 0, shown = 0;
    // Table rows
    block.querySelectorAll('.results-table tbody tr').forEach(function(tr){
      total++;
      if (_closed[tr.getAttribute('data-cid')]) return;
      var text = tr.textContent.toLowerCase();
      var match = !q || text.indexOf(q) >= 0;
      tr.style.display = match ? '' : 'none';
      if (match) shown++;
    });
    // Cards
    block.querySelectorAll('.card-view .record-card').forEach(function(c){
      if (_closed[c.getAttribute('data-cid')]) return;
      var text = c.textContent.toLowerCase();
      var match = !q || text.indexOf(q) >= 0;
      c.style.display = match ? '' : 'none';
    });
    // Found items
    document.querySelectorAll('#found-list .found-item').forEach(function(li){
      if (_closed[li.getAttribute('data-cid')]) return;
      var text = li.textContent.toLowerCase();
      li.style.display = (!q || text.indexOf(q) >= 0) ? '' : 'none';
    });
    var fc = document.getElementById('filter-count');
    if (fc) fc.textContent = q ? (shown + ' of ' + total + ' shown') : '';
  }

  // ── Cross-template search (M7) ──────────────────────────────────────────
  function crossSearch() {
    var form = document.getElementById('search-form'); if (!form) return;
    var tas = form.querySelectorAll('.ta[data-ac-idx]');
    var value = ''; var mode = form.querySelector('select[name=mode]').value;
    tas.forEach(function(ta){ var v = ta.value.trim(); if (v && !value) value = v; });
    if (!value) { showToast('Enter a value first.'); return; }
    var body = document.getElementById('cross-body');
    body.innerHTML = '<p style="color:#888;font-size:13px">Searching…</p>';
    document.getElementById('cross-modal').style.display = '';
    fetch('/api/cross_search', {method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({value: value, mode: mode})})
      .then(function(r){ return r.json(); })
      .then(function(j){
        if (j.error) { body.innerHTML = '<p style="color:red">' + j.error + '</p>'; return; }
        var hits = (j.results||[]).filter(function(r){ return r.matches > 0; });
        var misses = (j.results||[]).filter(function(r){ return r.matches === 0 && !r.skipped && !r.error; });
        var skipped = (j.results||[]).filter(function(r){ return r.skipped || r.error; });
        var html = '<p style="font-size:13px;margin:0 0 8px">Results for <b>' + _escHtml(j.value) + '</b> (' + j.mode + '):</p>';
        if (!hits.length) html += '<p style="color:#888;font-size:13px">No matches in any template.</p>';
        hits.forEach(function(r){
          var link = '/?template=' + encodeURIComponent(r.template) + '&key_0=' + encodeURIComponent(j.value) + '&mode=' + j.mode + '&run=1';
          html += '<div style="margin:4px 0;font-size:13px"><a href="' + link + '" style="color:#1a3a5c;font-weight:600">' + _escHtml(r.template) + '</a>';
          html += ' — <b>' + r.matches + '</b> match' + (r.matches!==1?'es':'') + ' in <i>' + _escHtml(r.column) + '</i>';
          if (r.sample && r.sample.length) html += ' <span style="color:#888">(' + r.sample.map(_escHtml).join(', ') + ')</span>';
          html += '</div>';
        });
        if (misses.length) html += '<p style="margin:10px 0 2px;font-size:12px;color:#888">No matches in ' + misses.length + ' other template' + (misses.length!==1?'s':'') + '.</p>';
        if (skipped.length) {
          html += '<p style="margin:6px 0 2px;font-size:12px;color:#888">Skipped:</p>';
          skipped.forEach(function(r){ html += '<div style="font-size:12px;color:#888">' + _escHtml(r.template) + ' — ' + _escHtml(r.skipped||r.error||'') + '</div>'; });
        }
        body.innerHTML = html;
      }).catch(function(){ body.innerHTML = '<p style="color:red">Request failed.</p>'; });
  }
  function _escHtml(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  // ── Template export / import ─────────────────────────────────────────────
  function exportTemplate() {
    var tpl = _tmpl(); if (!tpl) return;
    window.location.href = '/api/template_export?template=' + encodeURIComponent(tpl);
  }
  function importTemplate(input) {
    var file = (input.files || [])[0]; if (!file) return;
    var reader = new FileReader();
    reader.onload = function() {
      var data;
      try { data = JSON.parse(reader.result); } catch(e) { showToast('Invalid JSON file.'); input.value = ''; return; }
      fetch('/api/template_import', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data)})
        .then(function(r){ return r.json().then(function(j){ return {ok: r.ok, j: j}; }); })
        .then(function(res){
          input.value = '';
          if (!res.ok || res.j.error) { showToast('Import: ' + (res.j.error || 'failed')); return; }
          showToast('Imported "' + (res.j.name || '') + '".');
          window.location.href = '/?template=' + encodeURIComponent(res.j.name || '');
        }).catch(function(){ input.value = ''; showToast('Import failed.'); });
    };
    reader.readAsText(file);
  }

  // Inline onclick/onchange/oninput HTML attributes execute in global scope
  // and cannot see functions declared inside this DOMContentLoaded closure —
  // expose the ones referenced that way (mirrors window.doSearch below).
  window.openLogViewer = openLogViewer;
  window.loadLogTail = loadLogTail;
  window.applyQuickFilter = applyQuickFilter;
  window.crossSearch = crossSearch;
  window.exportTemplate = exportTemplate;
  window.importTemplate = importTemplate;

  // ── AJAX search with SSE progress ───────────────────────────────────────
  function _showProgress(msg) {
    var el = document.getElementById('search-progress');
    el.classList.add('active');
    document.getElementById('progress-status').textContent = msg || 'Preparing…';
    // hide existing results / empty state while searching
    var panel = document.getElementById('results-panel');
    Array.prototype.forEach.call(panel.children, function(c) {
      if (c.id !== 'search-progress') c.style.display = 'none';
    });
  }
  function _hideProgress() {
    document.getElementById('search-progress').classList.remove('active');
  }

  // Card/table row builders — shared by the initial SSE render and by
  // goToPage() so a fetched page renders through the exact same code path as
  // page one. Both read _resultLabels/_resultKch (set at the top of
  // _renderResults) rather than taking them as params.
  function _cardNode(row, cols, gk, ri) {
    var cid = gk + '::' + ri;
    var card = document.createElement('div');
    card.className = 'record-card';
    card.setAttribute('data-cid', cid);
    var cardTitle = row._card_title || row._matched_on;
    card.setAttribute('data-title', cardTitle);
    card.setAttribute('data-matched', row._matched_on);
    var headHtml = '<div class="rc-head"><span class="rc-title" title="' + _escHtml(cardTitle) + '">' + _escHtml(cardTitle) + '</span><span class="rc-active-badge">Active</span><span class="rc-actions"><button type="button" class="rc-collapse" title="Collapse / expand card" aria-label="Collapse card"><i class="ti ti-chevron-up" aria-hidden="true"></i></button><button type="button" class="rc-copy" title="Copy card" aria-label="Copy card"><i class="ti ti-copy" aria-hidden="true"></i></button><button type="button" class="rc-close" title="Close card" aria-label="Close card">×</button></span></div>';
    var bodyHtml = '';
    cols.forEach(function(c) {
      var label = _resultLabels[c] || c;
      bodyHtml += '<div class="rc-row" data-col="' + _escHtml(c) + '"><div class="rc-k">' + _escHtml(label) + '</div><div class="rc-v">' + _escHtml(row[c] || '') + '</div></div>';
    });
    card.innerHTML = headHtml + bodyHtml;
    if (_closed[cid]) card.style.display = 'none';
    if (_selected.has(cid)) card.classList.add('selected');
    return card;
  }
  function _tableRowHtml(row, cols, gk, ri) {
    var cid = gk + '::' + ri;
    var mo = row._matched_on || '';
    var moDisplay = mo;
    if (cols.length && mo.indexOf(' = ') >= 0) { var parts = mo.split(' = '); if (parts.length === 2) moDisplay = parts[1]; }
    var cls = (row._duplicate ? 'dup' : '') + (_selected.has(cid) ? ' selected' : '');
    var style = _closed[cid] ? ' style="display:none"' : '';
    var html = '<tr class="' + cls + '" data-cid="' + cid + '"' + style + '><td class="mo-col" title="' + _escHtml(mo) + '">' + _escHtml(moDisplay) + '</td>';
    cols.forEach(function(c) { html += '<td data-col="' + _escHtml(c) + '" title="' + _escHtml(row[c] || '') + '">' + _escHtml(row[c] || '') + '</td>'; });
    html += '</tr>';
    return html;
  }

  // ── Numbered pagination (shadcn-style: « Prev  1 … 4 5 6 … 12  Next » ) ──
  function _pageWindow(current, total) {
    if (total <= 1) return [1];
    var delta = 1, mid = [];
    for (var i = Math.max(2, current - delta); i <= Math.min(total - 1, current + delta); i++) mid.push(i);
    var pages = [1];
    if (mid.length && mid[0] > 2) pages.push('...');
    pages = pages.concat(mid);
    if (mid.length && mid[mid.length - 1] < total - 1) pages.push('...');
    pages.push(total);
    return pages;
  }
  function _paginationBarNode(gk) {
    var bar = document.createElement('div');
    bar.className = 'pagination-bar';
    bar.setAttribute('data-group-key', gk);
    _fillPaginationBar(bar, gk);
    return bar;
  }
  function _fillPaginationBar(bar, gk) {
    var st = _pageState[gk];
    if (!st) return;
    var totalPages = Math.max(1, Math.ceil(st.total / st.pageSize));
    bar.innerHTML = '';
    if (totalPages <= 1) return;

    function pageBtn(label, page, opts) {
      opts = opts || {};
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'page-btn' + (opts.nav ? ' nav' : '') + (opts.active ? ' active' : '');
      b.textContent = label;
      b.disabled = !!opts.disabled || opts.active;
      if (!opts.disabled && !opts.active) b.addEventListener('click', function(){ goToPage(gk, page); });
      return b;
    }

    bar.appendChild(pageBtn('‹ Previous', st.page - 1, { nav: true, disabled: st.page <= 1 }));
    _pageWindow(st.page, totalPages).forEach(function(p) {
      if (p === '...') {
        var e = document.createElement('span');
        e.className = 'page-ellipsis';
        e.textContent = '…';
        bar.appendChild(e);
      } else {
        bar.appendChild(pageBtn(String(p), p, { active: p === st.page }));
      }
    });
    bar.appendChild(pageBtn('Next ›', st.page + 1, { nav: true, disabled: st.page >= totalPages }));
  }

  function goToPage(gk, page) {
    var st = _pageState[gk];
    if (!st) return;
    var totalPages = Math.max(1, Math.ceil(st.total / st.pageSize));
    if (page < 1 || page > totalPages || page === st.page) return;
    var offset = (page - 1) * st.pageSize;
    var sid = _snapshotIds[gk] || '';
    var bar = document.querySelector('.pagination-bar[data-group-key="' + gk + '"]');
    if (bar) bar.querySelectorAll('.page-btn').forEach(function(b){ b.disabled = true; });
    fetch('/api/more_rows?group_key=' + encodeURIComponent(gk) + '&offset=' + offset + '&limit=' + st.pageSize
        + (sid ? '&snapshot_id=' + encodeURIComponent(sid) : ''))
      .then(function(r){ if (r.status === 410) { showToast('Results expired — search again.'); return null; } return r.json(); })
      .then(function(j){
        if (!j || j.error) { if (bar) _fillPaginationBar(bar, gk); return; }
        st.page = page;
        _renderGroupPage(gk, j.rows, j.columns, offset);
        if (bar) _fillPaginationBar(bar, gk);
      })
      .catch(function(){ if (bar) _fillPaginationBar(bar, gk); });
  }

  function _renderGroupPage(gk, rows, cols, offsetStart) {
    var block = document.querySelector('.group-block[data-group-key="' + gk + '"]');
    if (!block) return;
    var cardDiv = block.querySelector('.card-view');
    var tbody = block.querySelector('.results-table tbody');
    if (cardDiv) {
      cardDiv.innerHTML = '';
      rows.forEach(function(row, ri) { cardDiv.appendChild(_cardNode(row, cols, gk, offsetStart + ri)); });
    }
    if (tbody) {
      var html = '';
      rows.forEach(function(row, ri) { html += _tableRowHtml(row, cols, gk, offsetStart + ri); });
      tbody.innerHTML = html;
      // Re-wire row-click selection (enhanceResultsTable only wired the rows
      // that existed when it first ran; these are brand new elements).
      Array.prototype.forEach.call(tbody.rows, function(tr) {
        tr.addEventListener('click', function(e){ selectCard(tr.getAttribute('data-cid'), e.ctrlKey || e.metaKey); });
      });
    }
    _cardsLaidOut = false;   // new cards need (re)positioning next time cards are shown
    if (storedViewMode() === 'cards') { layoutCards(); } else { buildFoundList(); }
  }

  function _renderResults(data) {
    var r = data.result;
    _resultLabels = r.labels || {};
    _resultKch = data.key_col_header;
    var labels = _resultLabels;
    var kch = _resultKch;
    var panel = document.getElementById('results-panel');
    panel.setAttribute('data-total', r.total_matches);
    panel.setAttribute('data-view', r.view);
    panel.setAttribute('data-primary-group', r.primary_group_key);
    _currentGroupKey = r.primary_group_key;
    VIEWS = r.views || [];
    _snapshotIds = data.snapshot_ids || {};
    _currentViewIdx = 0;
    resetResultState();
    _setResultButtonsEnabled(r.total_matches > 0);

    // Remove old result content (keep progress div)
    Array.prototype.forEach.call(panel.querySelectorAll('.res-head,.group-block,.empty-results,.nf-panel'), function(el) { el.remove(); });
    var oldFoot = document.querySelector('.res-foot');
    if (oldFoot) oldFoot.remove();

    if (r.total_matches === 0 && !r.groups.length) {
      panel.innerHTML += '<div class="empty-results"><i class="ti ti-search-off" aria-hidden="true"></i><p>No matches.</p></div>';
      _hideProgress();
      return;
    }

    // res-head — built with createElement + addEventListener (not onclick
    // attribute strings) so no interpolated value (a link label, a template
    // name, a not-found value) can ever be interpreted as markup or script.
    // followLink in particular used to JSON.stringify an object straight into
    // an onclick='...' attribute with manual quote-escaping — a real
    // injection surface. addEventListener captures the object by reference
    // instead, so there's nothing left to serialize or escape.
    var head = document.createElement('div');
    head.className = 'res-head';

    var countSpan = document.createElement('span');
    countSpan.className = 'res-count';
    countSpan.textContent = r.total_matches + ' match' + (r.total_matches !== 1 ? 'es' : '');
    head.appendChild(countSpan);

    if (r.views.length > 1) {
      var viewSwitcher = document.createElement('span');
      viewSwitcher.className = 'view-switcher';
      r.views.forEach(function(v, i) {
        var tabBtn = document.createElement('button');
        tabBtn.type = 'button';
        tabBtn.className = 'view-tab' + (i === 0 ? ' active' : '');
        tabBtn.setAttribute('data-view-idx', i);
        tabBtn.setAttribute('data-group-key', v.group_key);
        tabBtn.textContent = v.name;
        tabBtn.addEventListener('click', function(){ switchView(i); });
        viewSwitcher.appendChild(tabBtn);
      });
      head.appendChild(viewSwitcher);
    }

    if (r.not_found && r.not_found.length) {
      var nfChip = document.createElement('span');
      nfChip.className = 'chip nf-toggle';
      nfChip.style.cursor = 'pointer';
      nfChip.title = 'Click to expand';
      nfChip.textContent = r.not_found.length + ' not found';
      nfChip.addEventListener('click', function(){
        var p = document.getElementById('nf-panel');
        if (p) p.style.display = (p.style.display === 'none') ? '' : 'none';
      });
      head.appendChild(nfChip);
    }

    if (r.truncated) {
      var truncChip = document.createElement('span');
      truncChip.className = 'chip info';
      truncChip.textContent = 'showing first 50 — export for all';
      head.appendChild(truncChip);
    }

    // Pre-existing bug found while testing this rewrite: "links" is a sibling
    // of "result" in the SSE payload (see api_search()'s _evt("result", {...})
    // in app.py — "links" is set alongside "result", not inside it), but this
    // read "r.links" (r = data.result) instead of "data.links" — always
    // undefined, so the linked-views feature never rendered a button after
    // any AJAX search since it was added.
    // A cross-template link carries the source page's own deep link as
    // ?back=; show a way back to it, then consume it — a later manual search
    // from this page has nothing to do with where the user came from.
    if (_backLink) {
      var backTplName = '';
      try { backTplName = new URL(_backLink, location.origin).searchParams.get('template') || ''; } catch (e) {}
      var backBtn = document.createElement('button');
      backBtn.type = 'button';
      backBtn.className = 'rbtn back-btn';
      backBtn.title = 'Return to ' + (backTplName || 'the previous search');
      backBtn.innerHTML = '<i class="ti ti-arrow-left" aria-hidden="true"></i> Back' + (backTplName ? ' to ' + _escHtml(backTplName) : '');
      var backHref = _backLink;
      backBtn.addEventListener('click', function(){ window.location.href = backHref; });
      head.appendChild(backBtn);
      _backLink = null;
    }

    if (data.links && data.links.length) {
      data.links.forEach(function(lk) {
        var linkBtn = document.createElement('button');
        linkBtn.type = 'button';
        linkBtn.className = 'rbtn link-btn';
        linkBtn.title = 'Search ' + lk.to_template + ' using matched ' + lk.from_key + ' values';
        linkBtn.innerHTML = '<i class="ti ti-link" aria-hidden="true"></i> ' + _escHtml(lk.label || lk.to_template);
        linkBtn.addEventListener('click', function(){ followLink(lk); });
        head.appendChild(linkBtn);
      });
    }

    var filterWrap = document.createElement('span');
    filterWrap.className = 'filter-wrap';
    var filterInput = document.createElement('input');
    filterInput.type = 'text'; filterInput.id = 'quick-filter'; filterInput.className = 'quick-filter';
    filterInput.placeholder = 'Filter…'; filterInput.autocomplete = 'off';
    filterInput.addEventListener('input', function(){ applyQuickFilter(this.value); });
    filterWrap.appendChild(filterInput);
    var filterCount = document.createElement('span');
    filterCount.id = 'filter-count'; filterCount.className = 'filter-count';
    filterWrap.appendChild(filterCount);
    head.appendChild(filterWrap);

    panel.appendChild(head);

    // not-found panel
    if (r.not_found && r.not_found.length) {
      var nfDiv = document.createElement('div');
      nfDiv.id = 'nf-panel'; nfDiv.className = 'nf-panel'; nfDiv.style.display = 'none';
      var nfHead = document.createElement('div');
      nfHead.className = 'nf-head';
      nfHead.appendChild(document.createTextNode(r.not_found.length + ' value' + (r.not_found.length !== 1 ? 's' : '') + ' not found '));
      var nfCopyBtn = document.createElement('button');
      nfCopyBtn.type = 'button'; nfCopyBtn.className = 'rbtn'; nfCopyBtn.title = 'Copy list';
      nfCopyBtn.innerHTML = '<i class="ti ti-copy" aria-hidden="true"></i> Copy list';
      nfCopyBtn.addEventListener('click', function(){
        var list = document.getElementById('nf-list');
        var t = list ? list.innerText : '';
        navigator.clipboard.writeText(t).then(function(){ showToast('Copied.'); });
      });
      nfHead.appendChild(nfCopyBtn);
      nfDiv.appendChild(nfHead);
      var nfList = document.createElement('pre');
      nfList.id = 'nf-list'; nfList.className = 'nf-list';
      nfList.textContent = r.not_found.join('\n');
      nfDiv.appendChild(nfList);
      panel.appendChild(nfDiv);
    }

    // groups
    r.groups.forEach(function(g) {
      var block = document.createElement('div');
      block.className = 'group-block';
      block.setAttribute('data-group-key', g.group_key);
      block.setAttribute('data-group-total', g.total_matches);
      if (!g.is_primary) block.style.display = 'none';

      if (g.disabled_reason) {
        block.innerHTML = '<div class="empty-results"><i class="ti ti-alert-circle" aria-hidden="true"></i><p>This view is not searchable — ' + _escHtml(g.disabled_reason) + '.</p></div>';
      } else if (g.total_matches === 0) {
        block.innerHTML = '<div class="empty-results"><i class="ti ti-search-off" aria-hidden="true"></i><p>No matches in this view.</p></div>';
      } else {
        var rows = g.display_rows || [];
        var cols = g.all_view_cols || [];
        _pageState[g.group_key] = { page: 1, pageSize: 50, total: g.total_matches };

        // cards
        var cardDiv = document.createElement('div');
        cardDiv.className = 'card-view card-canvas';
        if (r.view !== 'cards') cardDiv.style.display = 'none';
        rows.forEach(function(row, ri) { cardDiv.appendChild(_cardNode(row, cols, g.group_key, ri)); });
        block.appendChild(cardDiv);

        // table
        var tableDiv = document.createElement('div');
        tableDiv.className = 'table-view table-scroll';
        if (r.view === 'cards') tableDiv.style.display = 'none';
        var tbl = '<table class="tbl results-table" data-template="' + _escHtml(data.template_name) + '" data-group-key="' + _escHtml(g.group_key) + '"><thead><tr><th class="mo-col">' + _escHtml(kch) + '</th>';
        cols.forEach(function(c) { tbl += '<th data-col="' + _escHtml(c) + '">' + _escHtml(labels[c] || c) + '</th>'; });
        tbl += '</tr></thead><tbody>';
        rows.forEach(function(row, ri) { tbl += _tableRowHtml(row, cols, g.group_key, ri); });
        tbl += '</tbody></table>';
        tableDiv.innerHTML = tbl;
        block.appendChild(tableDiv);

        if (g.truncated) {
          block.appendChild(_paginationBarNode(g.group_key));
        }
      }
      panel.appendChild(block);
    });

    // footer
    var foot = document.createElement('div');
    foot.className = 'res-foot';
    foot.innerHTML = '<span>Queried at: ' + _escHtml(r.queried_at) + '</span><span title="When the source file was last modified">Source file updated at: ' + _escHtml(r.source_timestamp) + '</span>';
    // Insert after .body (full-width ribbon), matching the server-rendered location —
    // not inside .body, where it would become a flex child beside the results.
    var body = panel.closest('.body') || panel.parentNode;
    body.parentNode.insertBefore(foot, body.nextSibling);

    _hideProgress();
    // applyResultsView() -> layoutCards()/enhanceResultsTable() fully wires card
    // interactivity, table row selection, and the found-list (buildFoundList()).
    // A separate _initCardActions()/_initFoundList() pair used to run right after
    // this and re-wire the same elements a second time — two click listeners per
    // collapse button meant each click toggled the class on, then immediately
    // back off, so Collapse silently did nothing. Removed; do not reintroduce.
    applyResultsView();
    applyInitialView();
    if (typeof enhanceResultsTable === 'function') {
      panel.querySelectorAll('.results-table').forEach(enhanceResultsTable);
    }
  }

  function ajaxSearch() {
    var form = document.getElementById('search-form');
    if (!form) return;
    _showProgress('Preparing…');
    var formData = new FormData(form);
    // Tell the server which snapshots the previous search created so it can
    // delete them instead of leaving them to accumulate on disk until the
    // next TTL sweep — the server can't track this itself (see _snapshotIds).
    var prevIds = Object.keys(_snapshotIds).map(function(k){ return _snapshotIds[k]; });
    if (prevIds.length) formData.append('prev_snapshot_ids', JSON.stringify(prevIds));

    fetch('/api/search', { method: 'POST', body: new URLSearchParams(formData) })
      .then(function(response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        var reader = response.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';

        function processChunk() {
          return reader.read().then(function(chunk) {
            buffer += chunk.done ? '' : decoder.decode(chunk.value, { stream: true });
            var parts = buffer.split('\n\n');
            buffer = chunk.done ? '' : parts.pop();
            parts.forEach(handleEvent);
            if (!chunk.done) return processChunk();
          });
        }

        function handleEvent(block) {
          if (!block.trim()) return;
          var eventType = 'message', data = '';
          block.split('\n').forEach(function(line) {
            if (line.indexOf('event: ') === 0) eventType = line.slice(7);
            else if (line.indexOf('data: ') === 0) data = line.slice(6);
          });
          if (!data) return;
          try { var parsed = JSON.parse(data); } catch(e) { return; }
          if (eventType === 'status') {
            document.getElementById('progress-status').textContent = parsed.detail || 'Working…';
          } else if (eventType === 'result') {
            _renderResults(parsed);
          } else if (eventType === 'error') {
            _hideProgress();
            var panel = document.getElementById('results-panel');
            Array.prototype.forEach.call(panel.children, function(c) {
              if (c.id !== 'search-progress') c.style.display = '';
            });
            showToast(parsed.message || 'Search failed.');
          }
        }

        return processChunk();
      })
      .catch(function(e) {
        _hideProgress();
        var panel = document.getElementById('results-panel');
        Array.prototype.forEach.call(panel.children, function(c) {
          if (c.id !== 'search-progress') c.style.display = '';
        });
        showToast('Search failed: ' + (e.message || e));
      });
  }

  // Expose globally for the Search button onclick and Enter-key
  window.doSearch = ajaxSearch;

  // Enter key in text inputs triggers search; textareas need Enter for newlines (multi-value)
  document.querySelectorAll('#search-form input[type="text"]').forEach(function(el) {
    el.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { e.preventDefault(); ajaxSearch(); }
    });
  });

  // Fallback: intercept native form submit (e.g. implicit submission)
  var searchForm = document.getElementById('search-form');
  if (searchForm) {
    searchForm.addEventListener('submit', function(e) {
      e.preventDefault();
      ajaxSearch();
    });
  }

  if (document.body.dataset.autoRun === 'true') {
    var f = document.getElementById('search-form');
    if (f) {
      var tpl = f.querySelector('input[name=template]').value;
      _deepLinkView = new URLSearchParams(location.search).get('view');   // before URL is cleaned
      _backLink = new URLSearchParams(location.search).get('back');
      history.replaceState(null, '', location.pathname + '?template=' + encodeURIComponent(tpl));
      ajaxSearch();
    }
  }
});
