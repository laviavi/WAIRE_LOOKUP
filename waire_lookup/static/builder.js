'use strict';
/* Template Designer (SSMS-style builder). All page behavior lives here —
   template_builder.html is markup only. Zero inline onclick attributes:
   every listener is attached with addEventListener, so nothing needs to be
   exposed on window (the Phase-0 closure-scope bug class can't occur).

   State model: one template = one workbook. Boxes = every sheet and every
   Excel Table of that workbook (plus linked-template boxes, Phase 4).
   A view is bound to exactly ONE box (sheet/table group) — the grid greys
   out checkboxes that would mix boxes within a view. sheetKey format is
   "<sheet>|<table>" with empty strings for none — it MUST stay identical to
   core/view_groups._group_key so saved overrides bucket the same way. */

// ── Page data (JSON script tags — never Jinja inside JS) ──────────────────
var EXISTING = JSON.parse(document.getElementById('existing-template').textContent);
var ALL_TEMPLATES = JSON.parse(document.getElementById('all-templates').textContent);

// ── State ─────────────────────────────────────────────────────────────────
var state = {
  source: { type: 'local', path: '', url: '', drive_id: '', item_id: '', sp_name: '',
            cache_path: '', connection_id: '', query: '', header_row: 1 },
  workbookMap: null,      // /api/workbook_map response (synthesized for SQL)
  boxes: [],              // [{sheet, table, title, sub, columns:[...]}] — sheet/table normalized ''
  primary: { sheet: '', table: '' },
  keys: [],               // key column names, always from the primary box
  views: [{ name: 'View 1', sheet: '', table: '', bound: false, columns: [], join: null }],
  labels: {},             // column -> display label
  defaultFilter: null,    // {column, equals} | null
  matchMode: 'exact',
  links: [],              // [{from_key, to_template, to_key, to_key_index, label?, to_view?}]
  sheetJoins: [],         // [{left_sheet, right_sheet, on:[{left,right}]}] — same-workbook left joins
};
var activeViewIdx = 0;
var _hydrated = false;    // EXISTING applied to boxes once after first load

// ── Linking state (Phase 4) ──
var linkedBoxes = [];       // [{template, keys:[...]}] — session UI state, not persisted
var _linkedKeysCache = {};  // template -> keys[] (from /api/template_keys)
var _linkedViewsCache = {}; // template -> view names[] (for link "target view" select)
var _pendingLink = null;    // {from_key} while click-to-link awaits a target
var _dragLink = null;       // {from_key, x1, y1} during drag-to-link
var boxOffsets = {};        // boxKey/linked:template -> {x, y} drag offsets (session only)
// ponytail: positions reset on reload — persist in a sidecar file if it ever grates

// ── Tiny DOM helpers ──────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }
function el(tag, attrs) {
  var node = document.createElement(tag);
  attrs = attrs || {};
  Object.keys(attrs).forEach(function (k) {
    if (k === 'className') node.className = attrs[k];
    else if (k === 'textContent') node.textContent = attrs[k];
    else if (k === 'title') node.title = attrs[k];
    else node.setAttribute(k, attrs[k]);
  });
  for (var i = 2; i < arguments.length; i++) {
    var c = arguments[i];
    if (c != null) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function norm(v) { return v == null ? '' : String(v).trim(); }

// .dg-box-cols is manually resizable (native CSS `resize`, same affordance
// as this app's textareas) so a box with many columns doesn't stay stuck
// at a fixed height. A drag doesn't fire any DOM event by default, so watch
// for it and redraw the link lines, which anchor to column-row positions.
var _boxResizeObserver = (typeof ResizeObserver !== 'undefined')
  ? new ResizeObserver(function () { drawLinkLines(); })
  : null;
function observeBoxResize(colsEl) { if (_boxResizeObserver) _boxResizeObserver.observe(colsEl); }

function groupKey(sheet, table) { return norm(sheet) + '|' + norm(table); }

// ── Same-workbook join helpers ──
// A merged view's join-sheet columns are stored/displayed as "Col (Sheet)" —
// mirrors core/join.join_column_names so the builder and backend agree on the
// exact display name. splitJoinCol reverses it: given a stored column name,
// return {sheet, raw} if it belongs to a join sheet, else null (base column).
function joinSuffix(sheet) { return ' (' + sheet + ')'; }
function qualifyJoinCol(raw, sheet) { return raw + joinSuffix(sheet); }
function splitJoinCol(name) {
  for (var i = 0; i < state.sheetJoins.length; i++) {
    var suf = joinSuffix(state.sheetJoins[i].right_sheet);
    if (name.length > suf.length && name.slice(-suf.length) === suf) {
      return { sheet: state.sheetJoins[i].right_sheet, raw: name.slice(0, name.length - suf.length) };
    }
  }
  return null;
}
// The join (if any) whose base sheet is `baseSheet` and join sheet is `joinSheet`.
function findSheetJoin(baseSheet, joinSheet) {
  for (var i = 0; i < state.sheetJoins.length; i++) {
    var sj = state.sheetJoins[i];
    if (sj.left_sheet === baseSheet && sj.right_sheet === joinSheet) return sj;
  }
  return null;
}
// Any join with base sheet == baseSheet (a view bound to baseSheet may pull it in).
function joinFromBase(baseSheet) {
  for (var i = 0; i < state.sheetJoins.length; i++) {
    if (state.sheetJoins[i].left_sheet === baseSheet) return state.sheetJoins[i];
  }
  return null;
}
function boxKey(b) { return groupKey(b.sheet, b.table); }
function primaryKey() { return groupKey(state.primary.sheet, state.primary.table); }
function viewKey(v) { return groupKey(v.sheet, v.table); }
function findBox(key) {
  for (var i = 0; i < state.boxes.length; i++) if (boxKey(state.boxes[i]) === key) return state.boxes[i];
  return null;
}
function primaryBox() { return findBox(primaryKey()); }

function showError(msg) {
  var b = $('error-banner');
  b.textContent = '⚠ ' + msg;
  b.style.display = '';
  b.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function clearError() { var b = $('error-banner'); b.style.display = 'none'; b.textContent = ''; }
function setStatus(msg, cls) {
  var s = $('load-status');
  s.textContent = msg || '';
  s.className = 'bld-status' + (cls ? ' ' + cls : '');
}

// ── Source handling ───────────────────────────────────────────────────────
function srcType() {
  var r = document.querySelector('input[name=src-type]:checked');
  return r ? r.value : 'local';
}

function onSourceTypeChange() {
  var t = srcType();
  state.source.type = t;
  $('local-source-row').style.display = t === 'local' ? '' : 'none';
  $('sharepoint-source-row').style.display = t === 'sharepoint' ? '' : 'none';
  $('sql-source-row').style.display = t === 'sql' ? '' : 'none';
  if (t === 'sql') loadSqlConnectionList();
}

function currentSourcePath() {
  if (srcType() === 'sharepoint') return state.source.cache_path;
  return $('tpl-path').value.trim();
}

function browseFile() {
  setStatus('Opening file picker…');
  fetch('/api/browse_file')
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (j.error) { showError(j.error); setStatus(''); return; }
      if (j.path) { $('tpl-path').value = j.path; loadWorkbook(); }
      else setStatus('');
    })
    .catch(function (e) { showError(e.message); setStatus(''); });
}

function connectSharePoint() {
  var url = $('tpl-url').value.trim();
  if (!url) { showError('Paste a SharePoint URL first.'); return; }
  clearError();
  setStatus('Resolving SharePoint URL…');
  fetch('/api/resolve_source', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: url }),
  })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (j.error) {
        showError(j.needs_signin
          ? j.error + ' Click "Sign in" in the main window ribbon (Account), then try again.'
          : j.error);
        setStatus('');
        return;
      }
      state.source.url = url;
      state.source.drive_id = j.drive_id;
      state.source.item_id = j.item_id;
      state.source.sp_name = j.name;
      state.source.cache_path = j.cache_path;
      setStatus('Connected — loading workbook…');
      loadWorkbook();
    })
    .catch(function (e) { showError(e.message); setStatus(''); });
}

function checkSqlQuery() {
  var cid = $('sql-connection').value;
  var q = $('sql-query').value;
  if (!cid) { showError('Pick a SQL connection first.'); return; }
  if (!q.trim()) { showError('SQL query is empty.'); return; }
  clearError();
  setStatus('Checking query…');
  fetch('/api/sql_check', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connection_id: cid, query: q }),
  })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j.ok) { setStatus('⚠ ' + (j.error || 'Query failed.'), 'err'); return; }
      state.source.connection_id = cid;
      state.source.query = q;
      setStatus('✓ Query OK — ' + j.columns.length + ' column(s)', 'ok');
      applyWorkbookMap({ is_csv: false, sheets: [{ name: null, columns: j.columns, tables: [] }] }, 'query result');
    })
    .catch(function (e) { setStatus('⚠ ' + (e.message || e), 'err'); });
}

function loadWorkbook() {
  var path = currentSourcePath();
  if (!path) { showError('Enter a source first.'); return; }
  clearError();
  state.source.header_row = parseInt($('tpl-header').value, 10) || 1;
  setStatus('Reading workbook…');
  fetch('/api/workbook_map', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: path, header_row: state.source.header_row }),
  })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (j.error) { showError(j.error); setStatus(''); return; }
      applyWorkbookMap(j, null);
      var n = state.boxes.length;
      setStatus('✓ Loaded — ' + n + ' source box' + (n !== 1 ? 'es' : ''), 'ok');
    })
    .catch(function (e) { showError(e.message); setStatus(''); });
}

function applyWorkbookMap(map, sqlTitle) {
  state.workbookMap = map;
  state.boxes = [];
  // A template is based on the sheet, not any Excel Table on it — one box
  // per sheet, full stop. (An Excel Table is just a named/formatted range
  // over the same cells; reading the sheet at the configured header row
  // already sees the same columns.) /api/workbook_map still reports
  // per-table metadata for other callers, we just don't surface it here.
  (map.sheets || []).forEach(function (s) {
    var sheet = norm(s.name);
    state.boxes.push({
      sheet: sheet, table: '',
      title: sqlTitle || (sheet || 'File'),
      sub: sqlTitle ? 'SQL' : (map.is_csv ? 'CSV' : 'sheet'),
      columns: s.columns || [],
    });
  });

  if (!_hydrated && EXISTING) {
    hydrateFromExisting();
    _hydrated = true;
  } else {
    reconcileWithBoxes();
  }

  $('diagram-wrap').style.display = '';
  $('grid-wrap').style.display = '';
  $('summary-wrap').style.display = '';
  $('settings-strip').style.display = '';
  renderLinkedAddSelect();
  // Show boxes for templates this one already links to (edit mode).
  var pending = {};
  state.links.forEach(function (lk) { pending[lk.to_template] = true; });
  Object.keys(pending).forEach(addLinkedBox);
  render();
}

// Re-point primary / prune keys and view columns after a (re)load.
function reconcileWithBoxes() {
  if (!findBox(primaryKey())) {
    var first = state.boxes[0];
    state.primary = first ? { sheet: first.sheet, table: first.table } : { sheet: '', table: '' };
    state.keys = [];
  }
  state.keys = state.keys.filter(function (k) {
    return state.boxes.some(function (b) { return b.columns.indexOf(k) >= 0; });
  });
  state.views.forEach(function (v) {
    if (!v.bound) return;
    var b = findBox(viewKey(v));
    if (!b) { v.bound = false; v.sheet = ''; v.table = ''; v.columns = []; v.join = null; return; }
    v.columns = v.columns.filter(function (c) {
      if (b.columns.indexOf(c) >= 0) return true;
      // Keep a merged column only if its join sheet + raw column still exist.
      var sp = splitJoinCol(c);
      if (sp) { var jb = boxBySheet(sp.sheet); return !!(jb && jb.columns.indexOf(sp.raw) >= 0); }
      return false;
    });
    var stillJoined = v.join && v.columns.some(function (c) {
      var sp = splitJoinCol(c); return sp && sp.sheet === v.join.sheet;
    });
    if (!stillJoined) v.join = null;
    if (!v.columns.length) { v.bound = false; v.sheet = ''; v.table = ''; v.join = null; }
  });
}

// Hydrate keys/views from EXISTING once boxes are known. A template is
// based on the sheet, not any Excel Table — boxes never carry a table
// dimension, so any table_name on old data (e.g. a template created before
// this change, or with the old form-based builder) is intentionally
// dropped here; only sheet_name matters for matching a box. Omitted
// sheet_name on a view inherits the primary sheet.
function hydrateFromExisting() {
  var src = EXISTING.source || {};
  state.primary = { sheet: norm(src.sheet_name), table: '' };
  if (!findBox(primaryKey()) && state.boxes.length) {
    state.primary = { sheet: state.boxes[0].sheet, table: '' };
  }
  state.keys = (EXISTING.key_columns || []).slice();

  var views = EXISTING.views && EXISTING.views.length
    ? EXISTING.views
    : [{ name: 'Default', columns: (EXISTING.result_columns || []).slice() }];
  state.views = views.map(function (v) {
    var hasSheet = 'sheet_name' in v && norm(v.sheet_name) !== '';
    var sheet = hasSheet ? norm(v.sheet_name) : state.primary.sheet;
    var join = null;
    if (v.join && norm(v.join.sheet_name)) {
      join = { sheet: norm(v.join.sheet_name), on: (v.join.on || []).slice() };
    }
    return { name: v.name || 'View', sheet: sheet, table: '', bound: true,
             columns: (v.columns || []).slice(), join: join };
  });
  state.links = (EXISTING.links || []).slice();
  // Declared sheet-joins: from an explicit sheet_joins list if present, else
  // reconstructed from the views' join specs so the chips render on edit.
  state.sheetJoins = (EXISTING.sheet_joins || []).slice();
  if (!state.sheetJoins.length) {
    state.views.forEach(function (v) {
      if (v.join && v.join.sheet && !findSheetJoin(v.sheet, v.join.sheet)) {
        state.sheetJoins.push({ left_sheet: v.sheet, right_sheet: v.join.sheet, on: v.join.on.slice() });
      }
    });
  }
  activeViewIdx = 0;
  reconcileWithBoxes();
}

// ── Mutators ──────────────────────────────────────────────────────────────
function setPrimaryBox(key) {
  var b = findBox(key);
  if (!b) return;
  state.primary = { sheet: b.sheet, table: b.table };
  render();
}

function toggleKey(col) {
  var i = state.keys.indexOf(col);
  if (i >= 0) state.keys.splice(i, 1);
  else state.keys.push(col);
  render();
}

function toggleColumnInView(vIdx, box, col) {
  var v = state.views[vIdx];
  if (!v) return;
  var bKey = boxKey(box);

  // Same sheet as the view's base (or the view isn't bound yet) → plain column.
  if (!v.bound || viewKey(v) === bKey) {
    var i = v.columns.indexOf(col);
    if (i >= 0) {
      v.columns.splice(i, 1);
      if (!v.columns.length) { v.bound = false; v.sheet = ''; v.table = ''; v.join = null; }
    } else {
      if (!v.bound) { v.bound = true; v.sheet = box.sheet; v.table = box.table; }
      v.columns.push(col);
    }
    render();
    return;
  }

  // Different sheet: allowed only when a join connects the view's base sheet
  // to this box's sheet. The column is stored qualified ("Col (Sheet)") and
  // the view is marked as merged; clearing the last such column drops the merge.
  var sj = findSheetJoin(v.sheet, box.sheet);
  if (!sj) return;   // no join → the checkbox is disabled anyway
  var qualified = qualifyJoinCol(col, box.sheet);
  var qi = v.columns.indexOf(qualified);
  if (qi >= 0) v.columns.splice(qi, 1);
  else { v.columns.push(qualified); v.join = { sheet: box.sheet, on: sj.on }; }

  var stillJoined = v.columns.some(function (c) {
    var sp = splitJoinCol(c); return sp && sp.sheet === box.sheet;
  });
  if (!stillJoined) v.join = null;
  render();
}

function addView() {
  state.views.push({ name: 'View ' + (state.views.length + 1), sheet: '', table: '', bound: false, columns: [], join: null });
  activeViewIdx = state.views.length - 1;
  render();
}

function removeView(idx) {
  if (state.views.length <= 1) return;
  state.views.splice(idx, 1);
  if (activeViewIdx >= state.views.length) activeViewIdx = state.views.length - 1;
  render();
}

function setActiveView(idx) {
  activeViewIdx = idx;
  render();
}

// ── Linking (Phase 4) ─────────────────────────────────────────────────────
function fetchLinkedKeys(template) {
  if (_linkedKeysCache[template]) return Promise.resolve(_linkedKeysCache[template]);
  return fetch('/api/template_keys?name=' + encodeURIComponent(template))
    .then(function (r) { return r.json(); })
    .then(function (j) {
      _linkedKeysCache[template] = j.keys || [];
      _linkedViewsCache[template] = j.views || [];
      return _linkedKeysCache[template];
    });
}

function addLinkedBox(template) {
  if (!template) return;
  for (var i = 0; i < linkedBoxes.length; i++) if (linkedBoxes[i].template === template) return;
  fetchLinkedKeys(template).then(function (keys) {
    linkedBoxes.push({ template: template, keys: keys });
    render();
  });
}

// The single link-creation path — click-to-link and drag-to-link both end here.
function createLink(fromKey, toTemplate, toKey) {
  var keys = _linkedKeysCache[toTemplate] || [];
  var idx = keys.indexOf(toKey);
  var link = { from_key: fromKey, to_template: toTemplate, to_key: toKey,
               to_key_index: idx >= 0 ? idx : 0 };
  var dup = state.links.some(function (l) {
    return l.from_key === link.from_key && l.to_template === link.to_template && l.to_key === link.to_key;
  });
  _pendingLink = null;
  if (!dup) state.links.push(link);
  render();
}

function removeLink(i) {
  state.links.splice(i, 1);
  render();
}

function startLink(fromKey) {
  _pendingLink = (_pendingLink && _pendingLink.from_key === fromKey) ? null : { from_key: fromKey };
  render();
}

function cancelPendingLink() {
  if (_pendingLink) { _pendingLink = null; render(); }
}

// Drag-to-link: rubber-band line on the SVG overlay, same document-level
// mousedown/move/up pattern as search.js's panel divider / card drag.
function beginDragLink(fromKey, startEvent) {
  startEvent.preventDefault();
  var pane = $('diagram-pane');
  var moved = false;
  var band = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  band.setAttribute('stroke', '#ba7517');
  band.setAttribute('stroke-width', '1.5');
  band.setAttribute('stroke-dasharray', '5 4');

  function paneCoords(ev) {
    var pr = pane.getBoundingClientRect();
    return { x: ev.clientX - pr.left + pane.scrollLeft, y: ev.clientY - pr.top + pane.scrollTop };
  }
  var start = paneCoords(startEvent);
  band.setAttribute('x1', start.x); band.setAttribute('y1', start.y);
  band.setAttribute('x2', start.x); band.setAttribute('y2', start.y);

  function onMove(ev) {
    if (!moved) { moved = true; $('dg-links').appendChild(band); }
    var p = paneCoords(ev);
    band.setAttribute('x2', p.x); band.setAttribute('y2', p.y);
  }
  function onUp(ev) {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    if (band.parentNode) band.parentNode.removeChild(band);
    if (!moved) return;   // plain click — the click handler owns that gesture
    _suppressClick = true;   // a drag happened; swallow the trailing click
    var target = document.elementFromPoint(ev.clientX, ev.clientY);
    var row = target && target.closest ? target.closest('.dg-box.linked .dg-col') : null;
    if (row) {
      var boxEl = row.closest('.dg-box.linked');
      createLink(fromKey, boxEl.getAttribute('data-linked-template'), row.getAttribute('data-col'));
    }
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// Box dragging (header-grab) so link lines stay readable — transform-based,
// offsets kept per box in boxOffsets and re-applied on every render.
function beginBoxDrag(offsetKey, boxEl, startEvent) {
  if (startEvent.target.closest('button, input')) return;
  startEvent.preventDefault();
  var startX = startEvent.clientX, startY = startEvent.clientY;
  var base = boxOffsets[offsetKey] || { x: 0, y: 0 };
  function onMove(ev) {
    boxOffsets[offsetKey] = { x: base.x + ev.clientX - startX, y: base.y + ev.clientY - startY };
    boxEl.style.transform = 'translate(' + boxOffsets[offsetKey].x + 'px,' + boxOffsets[offsetKey].y + 'px)';
    drawLinkLines();
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function drawLinkLines() {
  var svg = $('dg-links');
  var pane = $('diagram-pane');
  svg.textContent = '';
  svg.setAttribute('width', pane.scrollWidth);
  svg.setAttribute('height', pane.scrollHeight);
  if (!state.links.length) return;
  var pr = pane.getBoundingClientRect();
  function centerOf(elm) {
    var r = elm.getBoundingClientRect();
    return { x: r.left + r.width / 2 - pr.left + pane.scrollLeft,
             y: r.top + r.height / 2 - pr.top + pane.scrollTop };
  }
  var pKey = primaryKey();
  state.links.forEach(function (lk) {
    var fromRow = document.querySelector('.dg-box[data-box-key="' + pKey + '"] .dg-col[data-col="' + lk.from_key + '"]');
    var toRow = document.querySelector('.dg-box[data-linked-template="' + lk.to_template + '"] .dg-col[data-col="' + lk.to_key + '"]');
    if (!fromRow || !toRow) return;
    var a = centerOf(fromRow), b = centerOf(toRow);
    var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
    line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
    line.setAttribute('stroke', '#ba7517');
    line.setAttribute('stroke-width', '1.5');
    line.setAttribute('stroke-dasharray', '5 4');
    svg.appendChild(line);
  });
}

function renderLinkedBoxes(wrap) {
  linkedBoxes.forEach(function (lb) {
    var boxEl = el('div', { className: 'dg-box linked' });
    boxEl.setAttribute('data-linked-template', lb.template);
    var offsetKey = 'linked:' + lb.template;
    var off = boxOffsets[offsetKey];
    if (off) boxEl.style.transform = 'translate(' + off.x + 'px,' + off.y + 'px)';

    var head = el('div', { className: 'dg-box-head' },
      el('i', { className: 'ti ti-link', 'aria-hidden': 'true' }), lb.template,
      el('span', { className: 'dg-sub', textContent: 'linked template' }));
    head.addEventListener('mousedown', function (e) { beginBoxDrag(offsetKey, boxEl, e); });
    boxEl.appendChild(head);

    var colsEl = el('div', { className: 'dg-box-cols' });
    lb.keys.forEach(function (k) {
      var row = el('div', { className: 'dg-col linkable', title: 'Click (or drop a drag) to link a key to this' });
      row.setAttribute('data-col', k);
      row.appendChild(el('span', { className: 'dg-key-toggle on' },
        el('i', { className: 'ti ti-key', 'aria-hidden': 'true' })));
      row.appendChild(el('span', { className: 'dg-col-name', textContent: k, title: k }));
      row.addEventListener('click', function () {
        if (_pendingLink) createLink(_pendingLink.from_key, lb.template, k);
      });
      colsEl.appendChild(row);
    });
    boxEl.appendChild(colsEl);
    observeBoxResize(colsEl);
    wrap.appendChild(boxEl);
  });
}

function renderLinkChips() {
  var wrap = $('link-chips');
  if (!wrap) return;
  wrap.textContent = '';
  state.links.forEach(function (lk, i) {
    var chip = el('span', { className: 'bld-link-chip' },
      el('i', { className: 'ti ti-link', 'aria-hidden': 'true' }),
      lk.from_key + ' ↔ ' + lk.to_template + '.' + lk.to_key);
    var labelInput = el('input', { type: 'text', value: lk.label || '', placeholder: 'button label',
                                   autocomplete: 'off', 'aria-label': 'Link button label' });
    labelInput.addEventListener('input', function () {
      var v = labelInput.value.trim();
      if (v) lk.label = v; else delete lk.label;
      renderSummary();
    });
    chip.appendChild(labelInput);
    // Optional: target a specific view on the linked template (else its default).
    var viewSel = el('select', { className: 'chip-view', 'aria-label': 'Target view' });
    viewSel.appendChild(el('option', { value: '', textContent: 'default view' }));
    (_linkedViewsCache[lk.to_template] || []).forEach(function (vn) {
      viewSel.appendChild(el('option', { value: vn, textContent: vn }));
    });
    viewSel.value = lk.to_view || '';
    viewSel.addEventListener('change', function () {
      if (viewSel.value) lk.to_view = viewSel.value; else delete lk.to_view;
      renderSummary();
    });
    chip.appendChild(viewSel);
    var x = el('button', { className: 'chip-x', type: 'button', textContent: '×', title: 'Remove link' });
    x.addEventListener('click', function () { removeLink(i); });
    chip.appendChild(x);
    wrap.appendChild(chip);
  });
}

// ── Same-workbook joins ───────────────────────────────────────────────────
function renderJoinChips() {
  var wrap = $('join-chips');
  if (!wrap) return;
  wrap.textContent = '';
  state.sheetJoins.forEach(function (sj, i) {
    var onStr = sj.on.map(function (p) { return p.left + ' = ' + p.right; }).join(', ');
    var chip = el('span', { className: 'bld-link-chip' },
      el('i', { className: 'ti ti-arrow-merge', 'aria-hidden': 'true' }),
      sj.left_sheet + ' ⟕ ' + sj.right_sheet + '  (' + onStr + ')');
    var x = el('button', { className: 'chip-x', type: 'button', textContent: '×', title: 'Remove join' });
    x.addEventListener('click', function () { removeSheetJoin(i); });
    chip.appendChild(x);
    wrap.appendChild(chip);
  });
}

function createSheetJoin(baseSheet, baseCol, joinSheet, joinCol) {
  if (!baseSheet || !joinSheet || !baseCol || !joinCol || baseSheet === joinSheet) return;
  var existing = findSheetJoin(baseSheet, joinSheet);
  if (existing) existing.on = [{ left: baseCol, right: joinCol }];
  else state.sheetJoins.push({ left_sheet: baseSheet, right_sheet: joinSheet,
                               on: [{ left: baseCol, right: joinCol }] });
  render();
}

function removeSheetJoin(i) {
  var sj = state.sheetJoins[i];
  if (!sj) return;
  state.sheetJoins.splice(i, 1);
  // Strip this join's brought-over columns from every view and drop the merge marker.
  var suf = joinSuffix(sj.right_sheet);
  state.views.forEach(function (v) {
    v.columns = v.columns.filter(function (c) {
      return !(c.length > suf.length && c.slice(-suf.length) === suf);
    });
    if (v.join && v.join.sheet === sj.right_sheet) v.join = null;
  });
  render();
}

function boxBySheet(sheet) {
  return state.boxes.filter(function (b) { return b.sheet === sheet; })[0] || null;
}

function openJoinDialog() {
  if (state.boxes.length < 2) return;
  if ($('join-dialog')) return;
  var sheets = state.boxes.map(function (b) { return b.sheet; });

  function sheetSelect(defaultSheet) {
    var s = el('select', { className: 'bld-grow' });
    sheets.forEach(function (sh) { s.appendChild(el('option', { value: sh, textContent: sh || '(sheet)' })); });
    if (defaultSheet != null) s.value = defaultSheet;
    return s;
  }
  function colSelect(sheet) {
    var s = el('select', { className: 'bld-grow' });
    var box = boxBySheet(sheet);
    (box ? box.columns : []).forEach(function (c) { s.appendChild(el('option', { value: c, textContent: c })); });
    return s;
  }
  function fillCols(colSel, sheet) {
    colSel.textContent = '';
    var box = boxBySheet(sheet);
    (box ? box.columns : []).forEach(function (c) { colSel.appendChild(el('option', { value: c, textContent: c })); });
  }

  var baseSheet = state.primary.sheet || sheets[0];
  var joinSheet = sheets.filter(function (s) { return s !== baseSheet; })[0] || sheets[1];

  var baseSel = sheetSelect(baseSheet); baseSel.className += ' join-base-sheet';
  var baseCol = colSelect(baseSheet); baseCol.className += ' join-base-col';
  var joinSel = sheetSelect(joinSheet); joinSel.className += ' join-join-sheet';
  var joinCol = colSelect(joinSheet); joinCol.className += ' join-join-col';
  baseSel.addEventListener('change', function () { fillCols(baseCol, baseSel.value); });
  joinSel.addEventListener('change', function () { fillCols(joinCol, joinSel.value); });

  function row(label, a, b) {
    return el('div', { className: 'bld-src-row' }, el('label', { textContent: label }), a, b);
  }
  var modal = el('div', { className: 'bld-modal' },
    el('h3', { textContent: 'Join two sheets (left join)' }),
    el('p', { className: 'bld-status', textContent:
      'Every row of the base sheet is kept; matching columns from the join sheet are added alongside.' }),
    row('Base sheet', baseSel, baseCol),
    row('Join sheet', joinSel, joinCol));

  var actions = el('div', { className: 'bld-save-actions' });
  var cancel = el('button', { className: 'rbtn', type: 'button', textContent: 'Cancel' });
  var create = el('button', { className: 'rbtn primary join-create', type: 'button', textContent: 'Create join' });
  cancel.addEventListener('click', closeJoinDialog);
  create.addEventListener('click', function () {
    createSheetJoin(baseSel.value, baseCol.value, joinSel.value, joinCol.value);
    closeJoinDialog();
  });
  actions.appendChild(cancel); actions.appendChild(create);
  modal.appendChild(actions);

  var backdrop = el('div', { className: 'bld-modal-backdrop', id: 'join-dialog' }, modal);
  backdrop.addEventListener('click', function (e) { if (e.target === backdrop) closeJoinDialog(); });
  document.body.appendChild(backdrop);
}
function closeJoinDialog() { var d = $('join-dialog'); if (d) d.parentNode.removeChild(d); }

function renderLinkedAddSelect() {
  var sel = $('linked-add');
  var selfName = EXISTING ? EXISTING.name : $('tpl-name').value.trim();
  var current = sel.value;
  sel.textContent = '';
  sel.appendChild(el('option', { value: '', textContent: '— add linked template —' }));
  ALL_TEMPLATES.forEach(function (n) {
    if (n === selfName) return;
    sel.appendChild(el('option', { value: n, textContent: n }));
  });
  sel.value = current || '';
  $('linked-add-wrap').style.display = '';
}

// ── Render ────────────────────────────────────────────────────────────────
function render() {
  renderDiagram();
  renderGrid();
  renderSummary();
  updateWizard();
  renderFilterOptions();
  renderLinkChips();
  renderJoinChips();
  var jw = $('join-add-wrap');
  if (jw) jw.style.display = (state.boxes.length >= 2 && srcType() !== 'sql') ? '' : 'none';
  drawLinkLines();
}

var _suppressClick = false;

function renderDiagram() {
  var wrap = $('dg-boxes');
  wrap.textContent = '';
  var av = state.views[activeViewIdx];

  state.boxes.forEach(function (box) {
    var bKey = boxKey(box);
    var isPrimary = bKey === primaryKey();
    var boxEl = el('div', { className: 'dg-box' + (isPrimary ? ' primary' : '') });
    boxEl.setAttribute('data-box-key', bKey);
    var off = boxOffsets[bKey];
    if (off) boxEl.style.transform = 'translate(' + off.x + 'px,' + off.y + 'px)';

    var head = el('div', { className: 'dg-box-head' },
      el('i', { className: 'ti ti-table', 'aria-hidden': 'true' }), box.title);
    if (isPrimary) {
      head.appendChild(el('span', { className: 'dg-sub', textContent: 'primary · ' + box.sub }));
    } else {
      var mkBtn = el('button', { className: 'dg-primary-btn', type: 'button', textContent: 'make primary' });
      mkBtn.addEventListener('click', function () { setPrimaryBox(bKey); });
      var sub = el('span', { className: 'dg-sub' }, mkBtn);
      head.appendChild(sub);
    }
    head.addEventListener('mousedown', function (e) { beginBoxDrag(bKey, boxEl, e); });
    boxEl.appendChild(head);

    // Missing-key warning — a sheet is only truly unsearchable when it has
    // NONE of the configured key columns (mirrors api_search: a search that
    // only fills in a key this sheet does have still runs fine here).
    if (!isPrimary && state.keys.length) {
      var hasAnyKey = state.keys.some(function (k) { return box.columns.indexOf(k) >= 0; });
      if (!hasAnyKey) {
        boxEl.appendChild(el('span', { className: 'dg-badge' },
          'not searchable — missing key ' + state.keys.map(function (k) { return "'" + k + "'"; }).join(', ')));
      }
    }

    var colsEl = el('div', { className: 'dg-box-cols' });
    box.columns.forEach(function (col) {
      var row = el('div', { className: 'dg-col' });
      row.setAttribute('data-col', col);

      var cb = el('input', { type: 'checkbox' });
      var ownSheet = !av || !av.bound || viewKey(av) === bKey;
      var joinHere = av && av.bound && !ownSheet && findSheetJoin(av.sheet, box.sheet);
      if (ownSheet) {
        cb.checked = !!(av && av.bound && av.columns.indexOf(col) >= 0);
        cb.disabled = false;
      } else if (joinHere) {
        cb.checked = av.columns.indexOf(qualifyJoinCol(col, box.sheet)) >= 0;
        cb.disabled = false;
      } else {
        cb.checked = false;
        cb.disabled = !!(av && av.bound);
        if (cb.disabled) {
          var avBox = findBox(viewKey(av));
          cb.title = "View '" + av.name + "' reads " + (avBox ? avBox.title : viewKey(av)) +
                     " — join the sheets to combine them in one view";
        }
      }
      cb.addEventListener('change', function () { toggleColumnInView(activeViewIdx, box, col); });
      row.appendChild(cb);

      var keyBtn = el('button', {
        className: 'dg-key-toggle' + (state.keys.indexOf(col) >= 0 ? ' on' : ''),
        type: 'button', title: 'Toggle key (search) column',
        'aria-label': 'Toggle key column',
      }, el('i', { className: 'ti ti-key', 'aria-hidden': 'true' }));
      keyBtn.addEventListener('click', function () { toggleKey(col); });
      row.appendChild(keyBtn);

      var nameSpan = el('span', { className: 'dg-col-name', textContent: col, title: col });
      // Key columns of the primary box are link sources: click to start a
      // link (click-to-link), or drag onto a linked box's key row.
      if (isPrimary && state.keys.indexOf(col) >= 0) {
        row.classList.add('linkable');
        if (_pendingLink && _pendingLink.from_key === col) row.classList.add('link-pending');
        nameSpan.title = col + ' — click or drag to link to another template’s key';
        nameSpan.addEventListener('click', function (e) {
          e.stopPropagation();
          if (_suppressClick) { _suppressClick = false; return; }
          startLink(col);
        });
        nameSpan.addEventListener('mousedown', function (e) { beginDragLink(col, e); });
      }
      row.appendChild(nameSpan);
      colsEl.appendChild(row);
    });
    boxEl.appendChild(colsEl);
    observeBoxResize(colsEl);
    wrap.appendChild(boxEl);
  });

  renderLinkedBoxes(wrap);
}

function renderGrid() {
  var table = $('criteria-grid');
  table.textContent = '';

  var thead = el('thead');
  var hr = el('tr');
  hr.appendChild(el('th', { textContent: 'Field' }));
  hr.appendChild(el('th', { textContent: 'Label' }));
  hr.appendChild(el('th', { textContent: 'Sheet' }));
  hr.appendChild(el('th', { textContent: 'Key', className: 'center' }));
  state.views.forEach(function (v, vi) {
    var th = el('th', { className: 'view-col' + (vi === activeViewIdx ? ' active' : '') });
    var nameInput = el('input', { type: 'text', value: v.name, 'aria-label': 'View name' });
    nameInput.addEventListener('input', function () { v.name = nameInput.value; renderSummary(); updateWizard(); });
    nameInput.addEventListener('click', function (e) { e.stopPropagation(); });
    th.appendChild(nameInput);
    if (state.views.length > 1) {
      var x = el('button', { className: 'view-x', type: 'button', textContent: '×', title: 'Remove view' });
      x.addEventListener('click', function (e) { e.stopPropagation(); removeView(vi); });
      th.appendChild(x);
    }
    th.addEventListener('click', function () { setActiveView(vi); });
    th.title = 'Click to make this the active view (diagram checkboxes target it)';
    hr.appendChild(th);
  });
  var addTh = el('th');
  var addBtn = el('button', { className: 'add-view-btn', type: 'button', textContent: '+ view' });
  addBtn.addEventListener('click', addView);
  addTh.appendChild(addBtn);
  hr.appendChild(addTh);
  thead.appendChild(hr);
  table.appendChild(thead);

  // Row set: keys (primary box) first, then every view's columns, deduped.
  // `raw` is the box-native column name (used for toggling/keys); `col` is the
  // display name (a merged column shows as "Col (Sheet)"); `isJoin` marks a
  // brought-over join-sheet column, which can't be a key.
  var rows = [];
  var seen = {};
  function addRow(box, col, raw, isJoin) {
    if (!box) return;
    var id = boxKey(box) + '::' + col;
    if (seen[id]) return;
    seen[id] = true;
    rows.push({ box: box, col: col, raw: raw == null ? col : raw, isJoin: !!isJoin });
  }
  var pb = primaryBox();
  state.keys.forEach(function (k) {
    // A key can live on any box now — attribute the row to whichever box
    // actually has that column (falling back to primary if none does).
    var owner = pb;
    if (!owner || owner.columns.indexOf(k) < 0) {
      for (var bi = 0; bi < state.boxes.length; bi++) {
        if (state.boxes[bi].columns.indexOf(k) >= 0) { owner = state.boxes[bi]; break; }
      }
    }
    addRow(owner, k);
  });
  state.views.forEach(function (v) {
    if (!v.bound) return;
    var baseBox = findBox(viewKey(v));
    v.columns.forEach(function (c) {
      var sp = splitJoinCol(c);
      if (sp) {
        // Merged column from a join sheet — attribute to that sheet's box.
        var jb = state.boxes.filter(function (b) { return b.sheet === sp.sheet; })[0];
        addRow(jb || baseBox, c, sp.raw, true);
      } else {
        addRow(baseBox, c);
      }
    });
  });

  var tbody = el('tbody');
  rows.forEach(function (r) {
    var bKey = boxKey(r.box);
    var tr = el('tr');
    tr.appendChild(el('td', { textContent: r.col }));

    var labelTd = el('td');
    var labelInput = el('input', { type: 'text', value: state.labels[r.col] || '', placeholder: r.col, autocomplete: 'off' });
    labelInput.addEventListener('input', function () {
      var v = labelInput.value.trim();
      if (v) state.labels[r.col] = v;
      else delete state.labels[r.col];
      renderSummary();
    });
    labelTd.appendChild(labelInput);
    tr.appendChild(labelTd);

    tr.appendChild(el('td', { className: 'sheet-cell', textContent: r.box.title }));

    var keyTd = el('td', { className: 'center' });
    if (!r.isJoin) {   // brought-over join columns aren't search keys
      var kb = el('button', {
        className: 'grid-key-toggle' + (state.keys.indexOf(r.raw) >= 0 ? ' on' : ''),
        type: 'button', title: 'Toggle key (search) column', 'aria-label': 'Toggle key column',
      }, el('i', { className: 'ti ti-key', 'aria-hidden': 'true' }));
      kb.addEventListener('click', function () { toggleKey(r.raw); });
      keyTd.appendChild(kb);
    }
    tr.appendChild(keyTd);

    state.views.forEach(function (v, vi) {
      var td = el('td', { className: 'center' });
      var cb = el('input', { type: 'checkbox' });
      var ownSheet = v.bound && viewKey(v) === bKey;
      var joinHere = v.bound && !ownSheet && findSheetJoin(v.sheet, r.box.sheet);
      if (ownSheet) {
        cb.checked = v.columns.indexOf(r.raw) >= 0;
        cb.disabled = false;
      } else if (joinHere) {
        cb.checked = v.columns.indexOf(qualifyJoinCol(r.raw, r.box.sheet)) >= 0;
        cb.disabled = false;
      } else {
        cb.disabled = !!v.bound;
        if (cb.disabled) {
          var vBox = findBox(viewKey(v));
          cb.title = "View '" + v.name + "' reads " + (vBox ? vBox.title : '') +
                     " — join the sheets to combine them in one view";
        }
      }
      cb.addEventListener('change', function () { toggleColumnInView(vi, r.box, r.raw); });
      td.appendChild(cb);
      tr.appendChild(td);
    });
    tr.appendChild(el('td'));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  enhanceGridResize(table);
}

// Drag-resizable Fields-table columns (session-only, by column index — the
// grid rebuilds on every render, so persistence beyond this page load isn't
// worth the complexity of keying it to view names that can themselves change).
var gridColWidths = {};
function enhanceGridResize(table) {
  var ths = Array.prototype.slice.call(table.querySelectorAll('thead th'));
  if (!ths.length) return;
  table.classList.add('resizable');
  ths.forEach(function (th, i) {
    if (gridColWidths[i]) th.style.width = gridColWidths[i] + 'px';
    var handle = el('span', { className: 'col-resizer' });
    handle.addEventListener('mousedown', function (e) {
      e.preventDefault(); e.stopPropagation();
      var startX = e.pageX, startW = th.getBoundingClientRect().width;
      function onMove(ev) {
        var w = Math.max(40, startW + ev.pageX - startX);
        th.style.width = w + 'px';
        gridColWidths[i] = w;
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    th.appendChild(handle);
  });
}

function renderSummary() {
  var lines = [];
  if (state.keys.length) lines.push('SEARCH BY ' + state.keys.join(' OR '));
  state.views.forEach(function (v) {
    if (!v.bound || !v.columns.length) return;
    var where = v.sheet ? v.sheet + (v.table ? ' › ' + v.table : '') : 'file';
    if (v.join && v.join.sheet) where += ' + ' + v.join.sheet;
    var cols = v.columns.map(function (c) { return state.labels[c] || c; });
    lines.push('VIEW ' + (v.name || '(unnamed)') + ' (' + where + '): ' + cols.join(', '));
  });
  state.sheetJoins.forEach(function (sj) {
    lines.push('JOIN ' + sj.left_sheet + ' ⟕ ' + sj.right_sheet + ' ON ' +
               sj.on.map(function (p) { return p.left + ' = ' + p.right; }).join(', '));
  });
  state.links.forEach(function (lk) {
    var self = $('tpl-name').value.trim() || 'this';
    lines.push('LINK ' + self + '.' + lk.from_key + ' ↔ ' + lk.to_template + '.' + lk.to_key +
               (lk.label ? '   [' + lk.label + ']' : ''));
  });
  $('summary-pane').textContent = lines.join('\n') || '(pick key columns to begin)';
}

function updateWizard() {
  var steps = document.querySelectorAll('#wizard .wz-step');
  var done = [
    state.keys.length > 0,
    state.views.length >= 1 && state.views.every(function (v) { return (v.name || '').trim(); }),
    state.views.every(function (v) { return v.columns.length > 0; }),
  ];
  steps.forEach(function (s, i) { s.classList.toggle('done', !!done[i]); });
}

function renderFilterOptions() {
  var sel = $('tpl-filter-col');
  var current = state.defaultFilter ? state.defaultFilter.column : '';
  sel.textContent = '';
  sel.appendChild(el('option', { value: '', textContent: '— none —' }));
  var pb = primaryBox();
  (pb ? pb.columns : []).forEach(function (c) {
    var o = el('option', { value: c, textContent: c });
    if (c === current) o.selected = true;
    sel.appendChild(o);
  });
  sel.value = current && pb && pb.columns.indexOf(current) >= 0 ? current : '';
  onFilterColChange(false);
}

function onFilterColChange(fromUser) {
  var col = $('tpl-filter-col').value;
  $('filter-equals-label').style.display = col ? '' : 'none';
  $('tpl-filter-val').style.display = col ? '' : 'none';
  if (fromUser) {
    state.defaultFilter = col ? { column: col, equals: $('tpl-filter-val').value.trim() } : null;
    renderSummary();
  }
}

// ── Save ──────────────────────────────────────────────────────────────────
function saveTemplate() {
  clearError();
  var name = $('tpl-name').value.trim();
  if (!name) { showError('Template name is required.'); return; }

  var t = srcType();
  var source;
  if (t === 'sharepoint') {
    if (!$('tpl-url').value.trim()) { showError('SharePoint URL is required.'); return; }
    if (!state.source.drive_id || !state.source.item_id) {
      showError('Click "Connect & load" to resolve the SharePoint URL first.'); return;
    }
    source = { type: 'sharepoint', url: $('tpl-url').value.trim(),
               drive_id: state.source.drive_id, item_id: state.source.item_id,
               name: state.source.sp_name };
  } else if (t === 'sql') {
    var cid = $('sql-connection').value;
    var q = $('sql-query').value.trim();
    if (!cid) { showError('Pick a SQL connection.'); return; }
    if (!q) { showError('SQL query is required.'); return; }
    source = { type: 'sql', connection_id: cid, query: q };
  } else {
    var path = $('tpl-path').value.trim();
    if (!path) { showError('File path is required.'); return; }
    source = { type: 'local', path: path };
  }
  if (t !== 'sql') {
    source.sheet_name = state.primary.sheet || null;
    source.table_name = state.primary.table || null;
    source.header_row = parseInt($('tpl-header').value, 10) || 1;
  }

  if (!state.keys.length) { showError('Select at least one key column (click the key icon next to a column).'); return; }

  var pKey = primaryKey();
  var views = [];
  for (var i = 0; i < state.views.length; i++) {
    var v = state.views[i];
    var vname = (v.name || '').trim();
    if (!vname) { showError('Every view must have a name.'); return; }
    if (!v.columns.length) { showError('View "' + vname + '" has no fields — check at least one column.'); return; }
    var out = { name: vname, columns: v.columns.slice() };
    if (viewKey(v) !== pKey) {
      // Same override semantics as schema v4 / view_groups: emit sheet_name
      // always, table_name only when the view targets an Excel Table.
      if (v.sheet) out.sheet_name = v.sheet;
      if (v.table) out.table_name = v.table;
    }
    // Merged view: carry the left-join spec so the backend can combine sheets.
    if (v.join && v.join.sheet) {
      out.join = { sheet_name: v.join.sheet, on: v.join.on };
    }
    views.push(out);
  }

  state.matchMode = $('tpl-mode').value;
  var filterCol = $('tpl-filter-col').value;
  var payload = {
    name: name,
    source: source,
    key_columns: state.keys.slice(),
    result_columns: views[0].columns,
    views: views,
    labels: state.labels,
    default_filter: filterCol ? { column: filterCol, equals: $('tpl-filter-val').value.trim() } : null,
    default_match_mode: state.matchMode,
    links: state.links,
    sheet_joins: state.sheetJoins,
  };

  fetch('/api/save_template', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (j.errors && j.errors.length) { showError(j.errors.join(' ')); return; }
      window.location.href = '/?template=' + encodeURIComponent(name);
    })
    .catch(function (e) { showError(e.message); });
}

// ── SQL connection manager (ported from the old builder) ──────────────────
function loadSqlConnectionList() {
  var sel = $('sql-connection');
  var currentValue = sel.value ||
    (EXISTING && EXISTING.source && EXISTING.source.type === 'sql' ? EXISTING.source.connection_id : '');
  fetch('/api/sql_connections')
    .then(function (r) { return r.json(); })
    .then(function (j) {
      sel.textContent = '';
      sel.appendChild(el('option', { value: '', textContent: '— none —' }));
      (j.connections || []).forEach(function (c) {
        var o = el('option', { value: c.id, textContent: c.name + ' — ' + c.server + '/' + c.database });
        if (c.id === currentValue) o.selected = true;
        sel.appendChild(o);
      });
    })
    .catch(function () {
      sel.textContent = '';
      sel.appendChild(el('option', { value: '', textContent: '— error loading —' }));
    });
}

function openSqlConnDialog() {
  $('sql-conn-dialog').style.display = 'flex';
  renderSqlConnList();
  clearSqlConnForm();
}
function closeSqlConnDialog() { $('sql-conn-dialog').style.display = 'none'; }

function renderSqlConnList() {
  var box = $('sql-conn-list');
  box.textContent = 'Loading…';
  fetch('/api/sql_connections')
    .then(function (r) { return r.json(); })
    .then(function (j) {
      var conns = j.connections || [];
      box.textContent = '';
      if (!conns.length) { box.textContent = 'No saved connections yet.'; return; }
      conns.forEach(function (c) {
        var row = el('div', { className: 'bld-conn-row' },
          el('span', { textContent: c.name + ' — ' + c.server + ':' + c.port + '/' + c.database + ' (' + c.username + ')' }));
        var actions = el('span', { className: 'conn-actions' });
        var editBtn = el('button', { type: 'button', textContent: 'Edit' });
        editBtn.addEventListener('click', function () { loadIntoSqlConnForm(c); });
        var delBtn = el('button', { type: 'button', className: 'danger', textContent: 'Delete' });
        delBtn.addEventListener('click', function () {
          if (!confirm('Delete "' + c.name + '"?')) return;
          fetch('/api/sql_connections?id=' + encodeURIComponent(c.id), { method: 'DELETE' })
            .then(function () { renderSqlConnList(); loadSqlConnectionList(); });
        });
        actions.appendChild(editBtn);
        actions.appendChild(delBtn);
        row.appendChild(actions);
        box.appendChild(row);
      });
    });
}

function loadIntoSqlConnForm(c) {
  $('sql-conn-id').value = c.id;
  $('sql-conn-name').value = c.name || '';
  $('sql-conn-server').value = c.server || '';
  $('sql-conn-port').value = c.port || 1433;
  $('sql-conn-database').value = c.database || '';
  $('sql-conn-username').value = c.username || '';
  $('sql-conn-password').value = '';
  $('sql-conn-status').textContent = 'Editing — leave password blank to keep existing.';
}

function clearSqlConnForm() {
  ['sql-conn-id', 'sql-conn-name', 'sql-conn-server', 'sql-conn-database', 'sql-conn-username', 'sql-conn-password']
    .forEach(function (id) { $(id).value = ''; });
  $('sql-conn-port').value = 1433;
  $('sql-conn-status').textContent = '';
  $('sql-conn-status').className = 'bld-conn-status';
}

function saveSqlConnection() {
  var status = $('sql-conn-status');
  status.className = 'bld-conn-status';
  var payload = {
    id: $('sql-conn-id').value || null,
    name: $('sql-conn-name').value,
    server: $('sql-conn-server').value,
    port: $('sql-conn-port').value,
    database: $('sql-conn-database').value,
    username: $('sql-conn-username').value,
    password: $('sql-conn-password').value,
  };
  fetch('/api/sql_connections', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j.ok) { status.textContent = j.error || 'Save failed.'; return; }
      status.className = 'bld-conn-status ok';
      status.textContent = 'Saved.';
      clearSqlConnForm();
      renderSqlConnList();
      loadSqlConnectionList();
      $('sql-connection').value = j.id;
    });
}

// ── Init ──────────────────────────────────────────────────────────────────
function initBuilder() {
  document.querySelectorAll('input[name=src-type]').forEach(function (r) {
    r.addEventListener('change', onSourceTypeChange);
  });
  $('browse-btn').addEventListener('click', browseFile);
  $('load-btn').addEventListener('click', loadWorkbook);
  $('sp-connect-btn').addEventListener('click', connectSharePoint);
  $('sql-check-btn').addEventListener('click', checkSqlQuery);
  $('sql-manage-btn').addEventListener('click', openSqlConnDialog);
  $('sql-conn-save-btn').addEventListener('click', saveSqlConnection);
  $('sql-conn-clear-btn').addEventListener('click', clearSqlConnForm);
  $('sql-conn-close-btn').addEventListener('click', closeSqlConnDialog);
  $('sql-conn-dialog').addEventListener('click', function (e) {
    if (e.target === $('sql-conn-dialog')) closeSqlConnDialog();
  });
  $('save-btn').addEventListener('click', saveTemplate);
  $('tpl-filter-col').addEventListener('change', function () { onFilterColChange(true); });
  $('tpl-filter-val').addEventListener('input', function () { onFilterColChange(true); });
  $('tpl-mode').addEventListener('change', function () { state.matchMode = $('tpl-mode').value; });
  $('tpl-name').addEventListener('input', renderSummary);

  // Same-workbook joins
  $('join-add-btn').addEventListener('click', openJoinDialog);

  // Linking (Phase 4)
  $('linked-add').addEventListener('change', function () {
    addLinkedBox($('linked-add').value);
    $('linked-add').value = '';
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') cancelPendingLink(); });
  // Link chips live under the diagram pane; container created once here.
  var chips = el('div', { id: 'link-chips' });
  $('diagram-wrap').appendChild(chips);

  if (EXISTING) {
    $('tpl-name').value = EXISTING.name || '';
    var src = EXISTING.source || {};
    var t = src.type || 'local';
    var radio = document.querySelector('input[name=src-type][value="' + t + '"]');
    if (radio) radio.checked = true;
    $('tpl-header').value = src.header_row || 1;
    $('tpl-mode').value = EXISTING.default_match_mode || 'exact';
    state.matchMode = $('tpl-mode').value;
    state.labels = Object.assign({}, EXISTING.labels || {});
    if (EXISTING.default_filter && EXISTING.default_filter.column) {
      state.defaultFilter = EXISTING.default_filter;
      $('tpl-filter-val').value = EXISTING.default_filter.equals || '';
    }
    onSourceTypeChange();
    if (t === 'sharepoint') {
      $('tpl-url').value = src.url || '';
      state.source.drive_id = src.drive_id || '';
      state.source.item_id = src.item_id || '';
      state.source.sp_name = src.name || '';
      connectSharePoint();
    } else if (t === 'sql') {
      $('sql-query').value = src.query || '';
      fetch('/api/sql_connections').then(function (r) { return r.json(); }).then(function () {
        loadSqlConnectionList();
        setTimeout(function () {
          $('sql-connection').value = src.connection_id || '';
          if ($('sql-connection').value) checkSqlQuery();
        }, 300);
      });
    } else {
      $('tpl-path').value = src.path || '';
      if (src.path) loadWorkbook();
    }
  } else {
    onSourceTypeChange();
  }
}

document.addEventListener('DOMContentLoaded', initBuilder);
