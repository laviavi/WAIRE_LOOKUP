# Changelog — WAIRE LookUp Tool

Versions are tracked in `version.py`. Bump **Server** for backend changes,
**UI** for frontend changes, and add a line here for every iteration.

## Server v1.24.0 · UI v2.34.0 — 2026-07-18
- **"Back to X" button after following a cross-template link.** Following a link (e.g. costar → vacancy) previously left no way to get back to the original search — the target page's URL is cleaned after auto-run, so browser Back lands on a stale empty shell. `followLink` now appends the source page's own deep link as `&back=` (built via the existing `buildDeepLink()`); the target page captures it before URL cleanup and shows a "← Back to costar" button in the results header, which re-runs the original search exactly as it was. Consumed once — a later manual search on the target page no longer shows a stale back button.
- **Numbered pagination replaces "Show 50 more."** The append-forever button is gone; a shadcn/ui-styled pagination bar (`‹ Previous  1 … 4 5 6 … 35  Next ›`, filled active page, ellipsis windowing) lets you jump straight to any page of a truncated result set, in both card and table view. `/api/more_rows` now returns rows shaped exactly like the initial SSE payload (flat `{col: value, ...}` plus `_matched_on`/`_duplicate`/`_card_title`) so a fetched page renders through the identical card/table-row builder code as page one — no more separate "append" code path. Selection and closed-card state (keyed by absolute row index) persist across page navigation.
- New/updated tests: `tests/test_show_more.py` (new-shape assertion), `tests_e2e/global-handlers.spec.js` (pagination page-jump test replaces the old show-more test), `tests_e2e/links-and-notfound.spec.js` (back-button round trip; link-injection helper now regex-replaces costar's real `links` config instead of assuming it's empty, since costar now legitimately has one).

## Server v1.23.0 · UI v2.33.0 — 2026-07-18
- **Same-workbook sheet merge (left join), presented as an extra view.** A builder view can now left-join a second sheet of the same workbook and show columns from both in one table. Declared via a new **Join sheets** control in the diagram pane (base sheet + column ↔ join sheet + column); once a join exists, a view bound to the base sheet can check columns from the join sheet's box (the "can't mix sheets" block lifts for joined sheets). The merged view is just another view-tab alongside the per-sheet views — so "one combined table" vs "separate views" is a tab click, no separate mode. Backend: new pure `core/join.py` (`left_join`, normalized-key match like search, join columns always suffixed " (Sheet)", first-match-wins one-to-one); `view_groups` buckets a joined view into its own group; `api_search` loads both sheets, merges, then searches/displays the combined frame. Schema: a view may carry `join: {sheet_name, on:[{left,right}]}`; the template carries `sheet_joins` for the declared joins (round-trips on edit). Left join keeps every base row (blank join columns when no match).
- **Cross-template links can target a specific view.** A link chip now has a "target view" dropdown; `followLink` passes `?view=<name>` and the target page opens that view after the auto-run search (consumed once, so later manual searches fall back to the default). `/api/template_keys` now also returns the target template's view names. Cross-template linking stays jump-and-prefill (separate files/sources) — no cross-workbook data merge.
- New tests: `tests/test_join_merge.py` (left-join helper + merged search through `/api/search`), plus builder e2e for declaring a join and building a merged view.

## UI v2.32.0 — 2026-07-17
- **Fields-table (criteria grid) columns are now drag-resizable**, same `.col-resizer` handle pattern already used by the results table (`option_c.css`/`search.js`), scoped down to just resize (no sort/selection — not needed here). Widths are session-only, kept in memory across re-renders (the grid rebuilds on every state change), not persisted to `localStorage` since the column set/labels can change per template.
- **The plain-English "SEARCH BY … / VIEW …" summary is now collapsed by default** behind a "Technical summary" disclosure toggle, instead of always showing — useful for double-checking config but not something a non-technical user needs open by default.

## Server v1.22.0 · UI v2.31.0 — 2026-07-17
- **Fixed: a sheet lacking one configured key column was wrongly treated as entirely unsearchable, even when a search only used a key it does have.** Found on costar's real workbook: `key_columns: ["PropertyID", "Property Address"]`, and `Sheet1` has `Property Address` but no `PropertyID`. `api_search`'s `missing_keys` check (`app.py`) compared every configured key against the sheet's columns regardless of which ones the current search actually queried — so `Sheet1` was disabled for every search, even ones that only used `Property Address` and left `PropertyID` blank. Now only checks columns the current search actually queried (has a non-empty value for); a sheet is disabled only for the specific query where it's missing a column that query needs.
- **Fixed: the builder's diagram couldn't set a key column on any box but the primary one**, and its "not searchable" badge fired on any partial key mismatch instead of true unsearchability. Both `dg-key-toggle` (diagram) and `grid-key-toggle` (criteria grid) were hard-disabled outside the primary box; `reconcileWithBoxes()`/`setPrimaryBox()` also pruned or wiped keys that belonged to a non-primary box. A box's badge now only shows when it shares *none* of the configured keys — matching the corrected runtime behavior above — and any box's column can be toggled as a key.
- **Fixed: `validate_template` flagged legitimate multi-sheet key/result columns as "not found in source"** because it only ever checked against the primary source's columns, even for a key or view column that intentionally lives on a different sheet (schema v4). Now skips that check for key columns when the template spans more than one sheet, and only checks a view's columns when that view belongs to the primary group.
- New tests: `tests/test_multi_sheet_keys.py` (2, real two-sheet xlsx via the actual `/api/search` route), `test_validate_key_on_secondary_sheet_not_flagged`/`test_validate_key_missing_on_single_sheet_still_flagged` in `tests/test_templates_store.py`, `a non-primary sheet can set its own key and clears the badge` in `tests_e2e/builder.spec.js`.

## Server v1.21.0 · UI v2.30.0 — 2026-07-17
- **Diagram boxes are based on the sheet, not any Excel Table on it.** The designer used to add a separate box per Excel Table in addition to the sheet itself (`applyWorkbookMap` in `builder.js`) — for a workbook where several sheets each contain a Table, that could nearly double the box count. Verified against costar's real workbook (5 sheets, 3 of which contain Excel Tables) that a sheet's own header-row columns are identical to its Table's columns, so nothing is lost by dropping the separate table box. `/api/workbook_map` is unchanged (still reports table metadata for other callers); the builder just stops surfacing it. Edit-mode hydration updated to match sheets by name only — old templates whose primary source referenced a specific `table_name` (e.g. costar's `source.table_name: "Table1"`) now resolve to the sheet box directly instead of missing a lookup and falling back to whichever box happened to be listed first.
- **Diagram boxes' column lists are now resizable** (native CSS `resize: vertical`, the same affordance already used for this app's textareas — no new JS dependency). A box with many columns (e.g. costar's 42-column primary sheet) no longer stays stuck at a fixed 240px scroll height. A `ResizeObserver` redraws the link lines after a manual resize, since they anchor to column-row positions that a resize can shift.
- **Send-to-Excel now opens the workbook directly in Excel** via COM automation (temp file + `win32com`, same pattern as `send_outlook.py`'s draft creation) instead of triggering a browser download that the user then has to find and double-click. New `core/send_excel.open_in_excel()`; `/api/send/excel` returns `{"ok": true}` like the Outlook/Teams routes instead of streaming a file. Still never looks for or appends to an existing workbook — always a fresh temp file. Windows + Excel only (same constraint as Send-to-Outlook).
- Fixed a bug found while testing: `renderLinkChips()` (link label + remove-button UI) targeted a `#link-chips` container that didn't exist in the HTML — the CSS and JS were both correct, just nothing to render into. Added the missing container.

## UI v2.29.0 — 2026-07-17
- **Linked-template boxes, click-to-link, and drag-to-link** (Phase 4 of the builder redesign — code was written and manually verified earlier but never versioned/documented). Diagram pane gains an "add linked template" dropdown; a linked template's key columns render as a dashed, read-only box. Click a primary key field then a linked key field (click-to-link), or drag directly between them (drag-to-link, rubber-band line on an SVG overlay) — both end in the same `createLink()` path, so there is exactly one way links actually get created regardless of gesture. Boxes are draggable (header-grab) so link lines stay readable; positions are not persisted. New e2e: `click-to-link creates a link`, `drag-to-link creates the same link` in `tests_e2e/builder.spec.js`.

## UI v2.28.0 — 2026-07-17
- **SSMS-style template designer** replaces the form-cascade builder in place (same routes `/templates/new` + `/templates/<name>/edit`, same schema-v4 save payload — no backend change). Three panes: diagram (one box per sheet AND per Excel Table, checkable columns, key-icon toggles, primary-box marker, "not searchable — missing key" badges mirroring the runtime disabled_reason wording), criteria grid (Field / Label — the first-ever labels editor / Sheet / Key / one checkbox column per view / + view), and a live plain-English summary (`SEARCH BY … / VIEW x: …`). Wizard strip tracks keys → views → fields. A view binds to exactly one sheet/table group; checkboxes that would mix sheets are disabled with an explanatory tooltip. Edit-mode hydration replicates `group_views_by_source` inheritance exactly (verified against costar: 9 boxes, both views bucketed to the primary group).
- New files: `static/builder.js` (all behavior — zero inline onclick, standalone page with `?v=` cache-busting on every asset; page data via JSON script tags, no Jinja-in-JS), `static/builder.css`. SQL connection manager and SharePoint resolve flow ported unchanged.
- New e2e: `tests_e2e/builder.spec.js` (5 tests) against checked-in fixtures `tests_e2e/fixtures/{people.csv,two_sheets.xlsx}` — fully machine-independent, templates cleaned up per test.

## Server v1.20.0 — 2026-07-17
- **New `/api/workbook_map` endpoint** — one-shot metadata for the upcoming builder diagram pane: every sheet with its Excel Tables and header-row columns, from a single `read_shared_bytes` call + one pandas header pass (vs N per-sheet `/api/columns` round trips, each re-copying a locked/OneDrive file). New `tests/test_workbook_map.py` (5 tests).
- **Fixed a pre-existing `/api/tables` bug the new endpoint exposed:** `_tables_for_sheet_from_zip` misreported every table in the workbook for a sheet that legitimately has zero tables (the all-tables fallback fired whenever `table_files` was empty, even with a specific sheet requested). The fallback now applies only when no sheet was specified.

## Server v1.19.0 · UI v2.27.0 — 2026-07-17
- **Wildcard search in Contains mode.** `*` matches any characters, `?` exactly one; a value containing a wildcard becomes an ANCHORED pattern over the normalized string (`100*` starts-with, `*100` ends-with, `1?0` three chars). Plain values keep substring behavior — fully backward compatible; exact mode treats wildcards as literal characters. One new `_value_matcher` helper in `core/search.py` is the single matching definition shared by the mask loop, the not_found loop, and `_matched_on_for_row` (the three sites can no longer disagree); regex-special characters in data are escaped. UI: mode dropdown renamed "Partial" → "Contains (* ? wildcards)" (internal token stays `partial` — saved templates and deep links unaffected); input hint mentions the syntax; autocomplete dropdown suppressed while the fragment contains a wildcard. 11 new unit tests + 1 e2e test.

## UI v2.26.0 — 2026-07-16
- **Extracted all inline JS out of the Jinja template into `static/search.js` (Phase 4 of the UI-quality review).** `search_c.html` shrank from 1,858 lines to 331 — mostly markup now, loaded as `<script src="{{ url_for('static', filename='search.js') }}?v={{ ui_version }}">`. The only two remaining Jinja-in-JS values (`auto_run`, `notify_webhook_id`) moved to `data-auto-run`/`data-notify-webhook-id` attributes on `<body>`, read via `document.body.dataset.*` — no Jinja interpolation happens inside JS at all anymore, so the entity-escaping-breaks-the-script bug class this replaced is now structurally impossible. `search.js` is a real, lintable file with no template placeholders.
- **Removed the last inline `onclick`/`oninput` attributes from JS-generated markup (Phase 5).** `_renderResults()`'s results header (view tabs, not-found chip, quick filter, show-more button) and the link buttons now build DOM nodes with `addEventListener` instead of concatenating `onclick="..."` strings. The worst offender — `followLink(JSON.stringify(link).replace(/'/g, "&#39;"))`, a JSON-serialized object glued into an `onclick` attribute with manual quote-escaping — is gone entirely; the link object is now captured by closure and passed by reference, so there's nothing left to serialize or escape. Verified by intercepting a real `/api/search` response and injecting a label containing `<b>`, quotes, and an apostrophe: renders as literal text, no HTML executes.
- **Found and fixed while verifying the above: linked-views buttons never appeared after any AJAX search.** `api_search()` sends `links` as a sibling of `result` in the SSE payload (`{"result": {...}, "links": [...]}`), but `_renderResults()` read `r.links` (`r = data.result`) instead of `data.links` — always `undefined`. Pre-existing since the linked-views feature was added; never caught because no test exercised it against real AJAX-rendered output. Fixed to read `data.links`; four new Playwright tests cover it (rendering, click payload, and the not-found panel's toggle/copy-list button, none of which had test coverage before).
- Card/table body markup (already using `_escHtml` consistently with no embedded `onclick`) was deliberately left as string-concatenation — no actual fragility there, and rewriting already-correct, heavily-tested code for pure style would only add regression risk. `crossSearch()`'s modal similarly has no `onclick` in its generated markup and was left as-is.

## UI v2.25.1 — 2026-07-16
- **Fix stale selection/closed-card state leaking across searches (Phase 3 of the UI-quality review).** Card ids are `<group_key>::<row_index>`, which a new search reuses verbatim — `_selected` and `_closed` were never cleared between searches, so a card selected/closed in one search could silently apply to an unrelated card at the same index in the next one. Confirmed: select a card, search again, select/ctrl-click anything else — the new card at the same index appeared selected without being clicked. New `resetResultState()`, called once at the top of `_renderResults()`, clears `_selected`/`_closed`/`_zTop` and consolidates the `_tableEnhanced`/`_cardsLaidOut` resets that were previously inlined at the same call site. New `tests_e2e/state-reset.spec.js`.

## Server v1.18.0 · UI v2.25.0 — 2026-07-16
- **Single rendering path (Phase 1 of the UI-quality review).** Results were rendered twice — once server-side in Jinja (`do_search`, the old `POST /search` route) and once client-side (`_renderResults()` after `POST /api/search`). In real usage the server-rendered path was already 100% dead: `index()` always passed `result=None`, the Search button is `type="button"` (never a native submit), and the form's own `submit` listener calls `e.preventDefault()` — so `do_search()` was never reachable from the live UI, only from direct POSTs (tests, curl). Deleted `do_search()` and the ~110-line duplicate Jinja results block entirely; `index()` now serves a genuinely empty shell and AJAX is the only renderer. Net **-230 lines** across `app.py` and `search_c.html`.
- **Found while doing this, now fixed: the "Found items" sidebar has been non-functional in the live app for as long as AJAX search has been the default.** `#found-panel` was only ever rendered inside the (already-dead) `{% if result %}` block, so `document.getElementById('found-panel')` always returned `null` and every found-list function silently no-opped. Now rendered unconditionally in the empty shell (hidden until a search runs), matching how `applyResultsView()` already expected to toggle it.
- **Snapshot lookup no longer touches the session at all.** Session-based snapshot storage never worked for AJAX searches (see the v1.17.6 note below) and, with `do_search` gone, had no other writer either — removed the dead `session["snapshot_ids"]` read/write/fallback code in `api_search()`, `/export`, and `/api/more_rows`. Snapshot ids now travel exclusively via the SSE payload and explicit `snapshot_id` params.
- **Snapshot cleanup restored without the session.** The old "delete the previous search's snapshot" behavior relied on session state that's now gone; replaced it with the client sending back the snapshot ids its *own* previous search produced (`ajaxSearch()`'s `prev_snapshot_ids`), which the server deletes before running the new search — same end result, no session dependency.
- **Ribbon buttons that require results (Export CSV, Copy TSV, Outlook, Excel, Teams) are now unconditionally `disabled` in the HTML**, matching the fact that only `_setResultButtonsEnabled()` (client-side) ever re-enables them.
- Rewrote `tests/test_app_snapshot.py`, `test_batch_report.py`, and `test_show_more.py` to exercise `/api/search` instead of the deleted `/search`, and to pass `snapshot_id` explicitly instead of injecting session state.
- New Playwright regression tests: Found items panel renders and lists every result after a search.

## UI v2.24.9 — 2026-07-16
- **Fix card collapse doing nothing (and stale state on card close).** `_renderResults` wired every card's actions twice: once via `applyResultsView()` → `layoutCards()` → `makeCardInteractive()` (the real, full-featured wiring — drag, z-order, proper close/found-list tracking), and again via a `_initCardActions()`/`_initFoundList()` pair that duplicated the same bindings. Two click listeners on the same Collapse button meant every click toggled the `collapsed` class on, then immediately back off — visually nothing happened. The duplicate's Close handler was also broken: it hid the card but never marked it closed, removed its Found-items entry, or updated the count, leaving stale state behind. Removed the duplicate entirely; `applyResultsView()` (already called) fully covers card/table wiring and the found-list. Also fixes ctrl+click multi-select, which was double-toggling (and cancelling out) the same way. New regression tests in `global-handlers.spec.js`.

## Server v1.17.6 · UI v2.24.8 — 2026-07-16
- **Fix 7 dead ribbon/results buttons (Phase 0 of the UI-quality review).** `openLogViewer`, `loadLogTail`, `applyQuickFilter`, `crossSearch` ("Search all"), `loadMoreRows` ("Show 50 more"), `exportTemplate`, and `importTemplate` were declared inside the `DOMContentLoaded` closure, so their inline `onclick`/`onchange`/`oninput` HTML attributes (which execute in global scope) threw `ReferenceError` and silently no-opped. Exposed via `window.<fn> = <fn>` at the end of the closure, mirroring the existing `window.doSearch = ajaxSearch` pattern. New `tests_e2e/global-handlers.spec.js`: asserts every inline-handler function name resolves on `window`, plus live click-throughs of the log viewer, quick filter, cross-search, and template export with zero page errors.
- **Discovered while testing, now fixed: "Show 50 more" and "Export CSV" (no selection) were broken after any AJAX search.** `api_search()`'s SSE generator was writing `session["snapshot_ids"]` *inside* `generate()` (app.py), but Flask commits the session cookie header before a streaming response's generator body runs, so the write was silently lost; `/api/more_rows` and `/export` couldn't find the snapshot. Fixed by returning `snapshot_ids` in the SSE `result` payload and having the client pass the id explicitly (`&snapshot_id=` / hidden form field) instead of relying on the session; both routes still fall back to session lookup for the server-rendered path. The two `test.fail()` regression tests now pass for real.
- **Also discovered and fixed: the Export/Send ribbon buttons (Export CSV, Copy TSV, Outlook, Excel, Teams) stayed permanently disabled after any AJAX search.** They were only ever enabled via the server-rendered Jinja condition (`{% if not (result and result.total_matches) %}`); the AJAX path re-rendered results but never touched the `disabled` attribute. New `_setResultButtonsEnabled()` called from `_renderResults`.

## Server v1.17.5 · UI v2.24.6 — 2026-07-16
- **Card title shows the record's real value, not the search term.** Card headers now show the record's actual value in the matched key column (e.g. "10062907") and append "(partial match)" when that value only contains the searched term rather than equaling it. Exact matches show the value with no annotation. Replaces the old "PropertyID = 100" title + "dup" badge. New pure `_card_title_for_row` in `core/search.py`; `_duplicate` still drives table row styling.

## Server v1.17.4 · UI v2.24.5 — 2026-07-16
- **Fix results footer placement (AJAX).** The "Queried at / Source file updated at" line was inserted inside `.body`, making it a flex child to the right of the results. Now inserted after `.body` as a full-width ribbon at the bottom, matching the server-rendered location.

## Server v1.17.4 · UI v2.24.4 — 2026-07-16
- **Match column now names the searched field.** When a search uses a single key field, the first result column is headed with that field's name (e.g. "PropertyID") and shows only the found value, instead of a generic "Match" header with a "PropertyID = 275739" string. Multi-field searches keep the "Match" header and composite value. Applies to AJAX and server-rendered results; header derives from the fields actually queried, not the template's full key-column list.

## Server v1.17.3 · UI v2.24.3 — 2026-07-15
- **Linked views.** Templates can declare cross-template key equivalences (e.g. "Property ID" here = "PropertyID" there). After searching, link buttons appear in the results header — click one to jump to the linked template pre-filled with matched values and auto-run the search. Links are configured in the template builder (Links section) and stored in the template JSON. Works with both server-rendered and AJAX search results.
- **Fix view switching after AJAX search.** The global `VIEWS` array wasn't updated from AJAX results, so `switchView()` silently bailed out.
- **Fix multi-value input.** Enter key handler on textareas was eating newlines, preventing multi-value entry. Now only intercepts Enter on `input[type="text"]`, not textareas.
- **Fix column resize in multi-view tables.** Replaced colgroup-based column widths with direct `th.style.width`. The colgroup approach broke because `display:none` on cells shifts the browser's column-to-col mapping in `table-layout:fixed` — handle N modified col[N] but the browser mapped it to a different visible column. With widths on `th` directly, each resize handle always modifies its own header regardless of which columns are hidden.

## Server v1.17.2 · UI v2.23.0 — 2026-07-14
- **AJAX search with SSE progress bar.** Search now runs via `POST /api/search` with server-sent events streaming real-time stage updates (Loading source → Searching N rows → Rendering results). Progress bar with indeterminate animation while working. Results rendered client-side from JSON. Fixed session context error by moving session reads out of the streaming generator. Removed invalid `pythoncom` entry from requirements.txt.

## Server v1.17.1 — 2026-07-14
- **Parquet cache + preload.** Excel sources are cached as local parquet files after first parse (~50-100x faster on repeat loads). All file-based templates are preloaded in a background thread at startup so the first search is instant.

## Server v1.17.0 · UI v2.22.0 — 2026-07-14
- **v1.3.0 feature release (M1–M11).** DPAPI-encrypted token cache with legacy migration (M1). Vendored Tabler icons offline (M2). Template export/import with SQL connection_id blanked on export (M3). GitHub update checker with 6-hour cache (M4). Not-found reporting with expandable panel, input counters, CSV appendix (M5). Show-50-more pagination for truncated result groups (M6). Cross-template search sweeping all file-based templates (M7). Quick filter composing with card collapse and selection state (M8). Source-change notification to Teams webhooks with version-based debounce (M9). In-app log viewer modal (M10). SharePoint "Test connection" button in setup modal (M11).

## Server v1.16.1 · UI v2.21.1 — 2026-07-12
- **Send-to-Excel now always downloads a fresh workbook.** Removed the append-to-tracker-workbook flow entirely (`core/send_targets.py`, the target dialog, the caret button, `/api/send_targets`) — it was built as the default in the previous iteration, then deliberately removed at Avi's request: "it should not look for a file to open and append as the default behavior." Clicking **Excel** now generates a new `.xlsx` from the sent rows server-side (`send_excel.build_workbook()`) and streams it to the browser as a download; the user saves it themselves if they want to keep it.

## Server v1.16.0 · UI v2.21.0 — 2026-07-12
- **Send-to pipeline (Outlook / Excel / Teams) + deep links.** New ribbon "Send" group sends the selected rows (or all visible rows, with a confirm) to an Outlook draft (COM, never auto-sent — user reviews and sends manually), appends them to a per-template target workbook (`core/send_targets.py`, `core/send_excel.py`; header-mismatch handled by name-matching, not guessing), or posts a MessageCard to a saved Teams incoming webhook (`core/send_teams.py`, `core/settings_store.py`'s new `teams_webhooks` list — URLs never logged or echoed back, only a masked tail). Serializers live in `core/send_format.py` (pure, unit-tested). New routes: `/api/send/{outlook,excel,teams}`, `/api/send_targets`, `/api/teams_webhooks`.
- **Deep links.** "Copy link" button builds a URL encoding template + key values + match mode + `run=1`; opening it prefills the search form and auto-submits. `index()` now parses `key_N`/`mode`/`run` query params.
- **Export CSV** now builds client-side from selected rows (Blob download, no server round-trip) when a selection exists; unchanged (full server snapshot) otherwise. Send/Export button tooltips reflect selection state.
- Added `pywin32==310` dependency (Outlook COM). Frozen-build note: next PyInstaller build needs `--collect-submodules win32com`.

## Server v1.15.1 · UI v2.20.2 — 2026-07-12
- **Regression fix: autocomplete JS completely dead on no-result page.** Jinja auto-escaped the `else '""'` branch of the `_currentGroupKey` initializer to `&#34;&#34;` inside the `<script>` block, causing a JS `Unexpected token '&'` syntax error that silently killed every JS function on the page (autocomplete, view-switching, etc.). Fixed by routing the whole expression through `| tojson` so the empty-string case is always safe. Added two regression tests: one for `/api/column_values` substring filtering, one asserting no HTML entities appear inside the inline script block.

## Server v1.15.1 · UI v2.20.1 — 2026-07-12
- **Regressions from v2.19.0's per-group results restructure, fixed:**
  - **Cards/table workspace collapsed to zero height.** When view containers moved from an `#card-view` id to a `.card-view` class (one per group), the CSS `#card-view.card-canvas { position:relative; flex:1; min-height:0 }` stopped matching, so cards had nothing to position against and the table lost its scroll area. Selector changed to `.card-view.card-canvas`, added `.table-view.table-scroll { flex:1; min-height:0 }`, and `.group-block` is now a `flex: 1; display: flex; flex-direction: column` container so its child block fills the panel.
  - **"Queried at" / "Source file updated at" ribbon** moved out of the results panel and up to the app level, sitting as a full-width bar directly above the release/version bar — actually at the bottom of the page as originally intended, not tucked inside the results column.
  - **Autocomplete substring matching, server-side too.** `/api/column_values` now accepts an optional `q` param and returns case-insensitive substring matches (prefix hits first, then contains, capped at 200). Client fetches per-fragment so a large column no longer chops off entries alphabetically before the user sees any match. Client dropdown also switched from `startsWith` to substring with prefix-first ordering.

## Server v1.15.0 · UI v2.20.0 — 2026-07-12
- **SQL Server connector** — Phase B. Templates can now query SQL Server directly with a free-form SQL statement instead of pointing at an Excel file. New source type `sql` in the template schema; the search pipeline is unchanged (the SQL rows land as string columns, same as Excel/CSV, so `normalize_key`/`search()` treat them identically).
- **Driver:** `pymssql` (pure-Python wheel, bundles FreeTDS — no separate ODBC driver install). **Auth: SQL Server Authentication only** (username + password); Windows Integrated Auth is not supported by this driver and is explicitly out of scope. If you need Windows auth in the future, migrate the connector to `pyodbc` + Microsoft ODBC Driver.
- **Named, reusable connections** — new `core/sql_connections.py` stores `{name, server, port, database, username, credential_id}` in `data/sql_connections.json`; passwords are NEVER stored there. Reuse the same connection across many templates.
- **DPAPI-encrypted passwords** — new `core/dpapi.py` (thin ctypes wrapper around Win32 `CryptProtectData`/`CryptUnprotectData`, no new pip dep) and `core/sql_credentials.py` (atomic, tmp+replace writes). Encryption is bound to the current Windows user, so credentials do not carry over if the data folder is copied to a different machine/account (intentional — forces re-entry rather than silent leakage).
- **Builder UX** — new "SQL Server" option on the Source-type radio, with a Connection dropdown, a "+ New / manage" dialog (CRUD for saved connections), a Query textarea, and a **Check** button. Check runs the query wrapped as `SELECT TOP 0 * FROM (…) AS q` — success reports the column list inline and unlocks the same key/views cascade Excel uses; failure surfaces the **raw SQL Server error verbatim** so query bugs are debuggable straight from the builder.
- New routes: `GET/POST/DELETE /api/sql_connections`, `POST /api/sql_check`.
- Schema validation: `type: "sql"` requires `connection_id` and `query`.
- Tests: 17 new unit tests (DPAPI round-trip, credentials CRUD, connections CRUD + password-preservation, `SqlQuerySource` load/columns/is_stale + `check_query` success/syntax-error/connect-failure — all via a fake `pymssql` module, no real DB needed).

## Server v1.14.0 · UI v2.19.0 — 2026-07-12
- **Multi-sheet views** — Phase A. A single template can now expose views backed by different sheets of the same workbook. Each view gains an optional `sheet_name`/`table_name` in the schema (v4); omitted → the view uses the template's primary sheet, exactly as today (existing v3 templates keep working with no migration).
- Backend: new pure `core/view_groups.group_views_by_source(template)` buckets views by their effective (sheet, table). `_get_source` cache key extended to include sheet/table, and a helper `_get_view_group_source` resolves a distinct source instance per group. `do_search` now loops groups, runs a single `search()` per group, and produces one snapshot per group; the same key-column queries and mode apply to every group. A view whose sheet lacks a required key column renders as a disabled tab with an inline reason instead of failing the whole search.
- Frontend: results panel restructured to render one card+table block per group, keyed by `data-group-key`. View tabs now switch both the visible group block AND its column filter; found-items and copy/export target the currently active group. Export form carries the active `group_key` server-side.
- Template builder: each view block gets an optional "Use a different sheet in the same workbook" toggle with its own sheet/table dropdown; reuses the existing `/api/sheets`, `/api/tables`, `/api/columns` endpoints unmodified.
- Tests: 7 new unit tests for `view_groups` grouping logic; existing 103-test suite still green.

## Server v1.13.0 · UI v2.18.0 — 2026-07-12
- **Fixes the recurring stale-server dev issue.** Two changes eliminate it at the source instead of requiring a manual kill-all:
  - `app.config["TEMPLATES_AUTO_RELOAD"] = True` — Jinja templates are re-read from disk on every request, so template/HTML/JS edits are live immediately with zero restart.
  - New `ensure_single_instance(port)` (`app.py`, called from both `app.py`'s and `entry.py`'s startup) — before binding, finds any process already listening on port 2305 (via `netstat -ano`) and force-kills it (`taskkill /PID … /F`). Starting the server always wins the port, so there can never be two competing processes serving different code. Also makes the in-app Restart button reliable.
  - Verified: starting a second instance while the first is still running terminates the first and the second serves immediately; a template edit with no restart at all is picked up on the next request.

## Server v1.12.0 · UI v2.18.0 — 2026-07-12
- **Explicit Card / Table view toggle.** The ribbon View group's `Cards up to [N]` input is replaced by two buttons — **Cards** and **Table** — that switch the results display directly. The choice persists per browser (`localStorage`, defaults to Cards); it never reruns the search. (The `card_max` setting is no longer used by the UI; backend field left in place, harmless.)
- **Results footer ribbon.** `Queried at:` and `Source file updated at:` moved out of the results header into a footer bar pinned to the bottom of the results panel — header now holds just the match count, view tabs, and chips.
- **Collapsible result cards.** Each card header has a chevron that collapses it to the title bar only (hides all Field:value rows); click again to expand.
- **Collapsible view blocks in the template builder.** Each view block header has a chevron that hides/shows its column checklist — purely visual, Save still reads every column.

## Server v1.12.0 · UI v2.17.2 — 2026-07-12
- **Found items restored in table view.** After the v2.17.1 multi-select rework, the "Found items" list only showed in card view — so any search returning more than "Cards up to" matches (table view) showed no found list. It now renders and stays in sync (selection + close) across both card and table views. Clicking a found item scrolls its table row into view when in table view.

## Server v1.12.0 · UI v2.17.1 — 2026-07-12
- **Autocomplete from source data**: new `GET /api/column_values` endpoint returns distinct values for a key column. Suggestions are drawn live from the source file — no prior search needed. Recently searched values still appear first.

## Server v1.11.0 · UI v2.17.0 — 2026-07-12
- **Autocomplete on search inputs**: previously searched values saved per template/column in localStorage; suggested as you type.
- **Refresh toast**: ribbon Refresh button now shows a "Source refreshed." notification.
- **Query timestamp**: results header shows "Queried at: YYYY-MM-DD HH:MM:SS" — when the search ran.
- **Source file timestamp**: relabeled from "data as of" to secondary "Source file updated at:", clearly distinct from result freshness.
- **Multi-select**: Ctrl+click in Found Items or table rows to add/remove from selection; selection syncs across card/table/found views.
- **Copy/TSV respects selection**: Copy TSV copies only selected rows when any are selected; copy card copies all selected cards when multiple are selected.
- **Matched-on column first in table**: leftmost column uses actual key column name as header; cells show just the matched value (single-key) or full match string (multi-key).

## Server v1.11.0 · UI v2.16.1 — 2026-07-11
- **Sort icon redesigned**: unsorted columns now show `·` instead of `↕` (two-arrow symbol). Active sort still shows `↑`/`↓`.
- **Last column resize fixed**: last header now has `overflow: visible` so its drag handle extends past the clipped edge and is grabbable.

## Server v1.11.0 · UI v2.16.0 — 2026-07-11
- **Select Template visually distinct from New Template** — template selector now shows a list icon and a styled wrapper, clearly separate from the New Template button.
- **Template picker (`…` menu) in template builder** — a `…` button next to the template name opens a dropdown of all saved templates; selecting one navigates directly to its edit page. Highlighted if it's the currently open template.
- **Draggable panel divider** — the border between the inputs panel and results panel is now a 5px drag handle. Dragging resizes the inputs panel (140–600px); width persists in `localStorage`. Card and table layouts re-trigger after release.
- **Back button in template builder** — positioned top-right of the builder page, always visible, returns to the search screen.

## Server v1.11.0 · UI v2.15.1 — 2026-07-11
- **Ribbon Refresh no longer clears inputs/results.** If a search is showing, Refresh now re-runs it with `force_reload=1` (same as the banner's Refresh Results button) — inputs and results are preserved. If no search is showing, it reloads the source in the background via fetch, no page redirect.

## Server v1.11.0 · UI v2.15.0 — 2026-07-11
- **Template views.** Each template can now define multiple named views — each a named subset of result columns. The builder shows a "Views" section with one view block per view; add more with "+ Add view". Views stored as `views` array in template JSON (schema_version 3); `result_columns` mirrors `views[0]` for backward compat.
- When a template has multiple views, tab buttons appear in the results header. Clicking a tab switches displayed columns client-side (no re-search), for both card and table views.
- Templates without `views` (schema v1/v2) continue to work unchanged — server synthesises a single "Default" view from `result_columns`.

## Server v1.10.0 · UI v2.14.1 — 2026-07-11
- Sheet dropdown in the template builder no longer includes a "— first sheet —" placeholder option. Only real worksheet names from the workbook are listed.

## Server v1.10.0 · UI v2.14.0 · Release v1.1.2 — 2026-07-11
- **Zero-setup SharePoint access.** Default `graph_client_id` is now Microsoft's own published "Microsoft Graph Command Line Tools" public Client ID (`14d82eec-204b-4c2f-b7e8-296a70dab67e`). Colleagues no longer need to complete Azure app registration — they just click Sign in and grant consent. AZURE_SETUP.md becomes a fallback for tenants whose Conditional Access blocks the well-known ID or for users who want a branded consent dialog.
- Setup modal reworded: "Most users don't need to change anything here." Adds a "Reset to defaults (Microsoft shared)" link so a user who broke their config can recover.
- Ribbon tooltip clarifies: Sign in is the normal path; Setup SharePoint only appears when tenant blocks the default.
- No functional code changes in `graph_auth`/`graph_client`/`source_sync` — same MSAL flow, different default identity.

## Server v1.9.0 · UI v2.13.0 · Release v1.1.1 — 2026-07-11
- **In-app SharePoint setup modal**: new "Setup SharePoint" button (and always-visible gear icon) in the ribbon Account group opens a modal to paste the Azure Client ID + tenant. No more editing `data/settings.json` in Notepad. Inline validation feedback (invalid GUID → clear error), success confirmation on save.
- **Sign-in button hidden when SharePoint isn't configured** — replaced by "Setup SharePoint" so the UI never offers an action that can't succeed yet.
- **Release version shown in the footer** (`Release v1.1.1 · Server v1.9.0 · UI v2.13.0`) so bug-report screenshots identify the exact build.
- **`POST /settings` now returns JSON** (`{ok:true, settings}` or `{ok:false, error}`), so the modal can show validation errors inline. The existing card_max/poll_minutes fetches ignore the body — no behavior change there.
- Version tracking gains `RELEASE_VERSION` (injected into all templates); bumped to `1.1.1`.

## Server v1.8.0 · UI v2.12.0 — 2026-07-10
- **Microsoft Graph / SharePoint connector (read-only).** Templates can now point at a SharePoint URL (sharing link or direct URL). Delegated MSAL sign-in (`Files.Read.All`, `Sites.Read.All`), no write scopes anywhere. Access token lives in `data/token_cache.json` (atomic writes).
- **Local source cache.** `core/source_sync.sync_sharepoint_source` polls Graph metadata (`eTag` + `lastModifiedDateTime`); when it changes, the file is downloaded to `.tmp`, validated (xlsx zip integrity or CSV parseable), then atomically `os.replace`d into `data/source_cache/<item_id>.xlsx`. A failed or invalid download **never clobbers a valid cache**. All searches read from the cache — Graph is never called at search time.
- New connector `connectors/sharepoint_cached.SharePointCachedSource` derives its local cache path from the driveItem id (never stored in the template — templates stay portable across machines) and inherits parsing/staleness from `SyncedFileSource`.
- Poller extended to sync SharePoint sources on the same cadence.
- Template schema v2 (backward compatible; local templates unchanged): `source.type` ∈ {`local` (default), `sharepoint`}.
- Builder gains a Local/SharePoint toggle + "Connect & load"; single URL field accepts both sharing links and direct URLs.
- Ribbon Account group: Sign in / signed-in name / Sign out; live status via new `/api/auth_status`.
- New routes: `POST /auth/signin`, `POST /auth/signout`, `GET /api/auth_status`, `POST /api/resolve_source`.
- Friendly error taxonomy for Graph failures (auth/forbidden/not_found/transient/network) via `friendly_read_error`.
- Settings: `graph_client_id` (validated GUID) and `graph_tenant` (default `organizations`). App runs fully for local files with no registration; SharePoint attempts show clear actionable errors instead.
- Requirements: `msal==1.31.1`, `requests==2.32.3`.

## Server v1.7.0 · UI v2.11.0 — 2026-07-10
- **Fixes `ERR_RESPONSE_HEADERS_TOO_BIG`.** Full result set no longer stored in the Flask session cookie. New `core/snapshot_store.py` persists each search's uncapped `full_rows` to `data/snapshots/<uuid>.json` (atomic); session keeps only a 32-hex opaque id. `/export` reads from the snapshot; new search replaces the session's prior snapshot. TTL cleanup (24h) at startup and every poller tick.
- **New background source poller.** `core/poller.py` runs a daemon thread (started under `if __name__ == "__main__"` in `app.py` and from `entry.py`). Reads `poll_minutes` from settings each cycle (default 5, min 1, clamp max 120). Records per-source status in `data/source_status.json` via new `core/source_status.py`.
- **Update banner + Refresh Results.** New `GET /api/source_status?template=` returns `{stale, last_checked, last_updated, last_error, signed_in}` without touching Graph. `search_c.html` polls it every 60s and, when stale after the last search, shows a banner with a **Refresh Results** button that submits `force_reload=1` to the existing search form. Inputs are preserved by the server render — no retyping.
- **`poll_minutes` setting** in the ribbon View group; validated + clamped + logged like `card_max`.
- **`save_settings` bug fix**: now merges over stored settings before validating, so posting a single field never resets other keys to defaults.
- **New paths**: `config.SNAPSHOTS_DIR`, `SOURCE_CACHE_DIR`, `SOURCE_STATUS_FILE`, `TOKEN_CACHE_FILE`, `SNAPSHOT_TTL_HOURS`. Frozen `entry.py` redirects them all under `data/` and calls `app_module.start_background()` before `flask_app.run()`.
- Logger: `log_source_update`, `log_source_error`.

## Server v1.6.0 · UI v2.10.0 — 2026-07-09
- **Card title now uses the exact "Matched on" value** (e.g. `PropertyID = 275739`) — same value shown in the table's Matched on column, no longer a stripped-down value. Removed the now-unused `_matched_value` derivation server-side.
- **Active state redesigned**: strong 2px accent ring (via box-shadow, no layout shift), tinted background, stronger elevation shadow, and a small "Active" badge in the header — shown purely via CSS on `.record-card.active`. Selecting a card or its Found items entry removes the active state from the previously selected card immediately (unchanged JS logic, restyled).
- Selected card still comes to front (z-index) and scrolls into view when activated from Found items (unchanged behavior, re-verified).
- **"Cards up to" capped at 99**: `max="99"` on the input, clamped client-side (typing/changing snaps to 1–99) and server-side (`settings_store` clamps values above 99 down to 99).

## Server v1.5.0 · UI v2.9.0 — 2026-07-09
- **Fix card workspace scrollbar**: removed the forced `minHeight` that made the canvas overflow its flex bounds (clipped by `.results`, no scrollbar). The canvas now keeps its height and scrolls internally, so a vertical scrollbar appears whenever cards extend below the visible area.
- **Copy now includes the header value** — the matched key field(s) are prepended as `Field: value` line(s), same style as the rest (e.g. `PropertyID: 721617`).

## Server v1.5.0 · UI v2.8.0 — 2026-07-09
- **Card header now shows the matched search value** that created the card (not the first result value). New `_matched_value` derived from the match in `do_search`.
- **Single header per card** — the footer/"Matched on" strip was removed; duplicate rows now show a small `dup` badge in the header.
- **Copy button** added beside the close X — copies the card as `Label: value` lines (one per field), so pasting into email/Notepad reads cleanly.
- **Drag bounds are the full gray results workspace** (at least the visible area, taller if cards need it), not the tiled card extent; cards stay inside it.
- **Workspace scrolls vertically** — `overflow-y:auto`; a scrollbar appears when cards extend below the visible area.
- **Clicking a Found item** activates + fronts its card and scrolls the workspace to reveal it (reliable container scroll).
- View-switch state preservation unchanged (no rerun/clear).

## Server v1.4.0 · UI v2.7.0 — 2026-07-09
- **Card workspace.** Both card and table views are rendered once; JS toggles between them.
  - Changing "Cards up to" now switches view client-side only — persists via background fetch, never reruns the search or clears inputs/results/card state.
  - Cards are draggable by their header, constrained to the canvas bounds, and come to front on click (z-order).
  - Each card has an X close button; cards have bottom padding so text doesn't touch the border.
  - New "Found items" list below the search bars mirrors the current cards. Clicking an entry activates + fronts its card; the entry's X closes the card. Closing from either place syncs the card, the list, and the table row.

## Server v1.4.0 · UI v2.6.0 — 2026-07-09
- **Cards render every configured result column** — a field the source lacks is now shown blank instead of being silently dropped, so a card can never omit fields. (`do_search` no longer filters `result_columns` down to `display_cols`.)
- **Card grid**: multiple matches now flow as a responsive grid of cards (`repeat(auto-fill, minmax(360px, 1fr))`) that fills the results pane instead of a single narrow column.
- Static CSS links are cache-busted with `?v=<ui_version>` so browsers can't serve a stale stylesheet after an update.

## Server v1.3.0 · UI v2.5.0 — 2026-07-09
- **Sortable columns** (ported from BidFloor's sort pattern): click any header to sort; click again to flip direction. Header shows ↕ / ↑ / ↓ and highlights the active column. Numeric columns (e.g. RBA) sort numerically, text columns alphabetically (natural order), blanks always last. Clicking the resize handle doesn't trigger a sort.

## Server v1.3.0 · UI v2.4.0 — 2026-07-09
- **Resizable table columns** (ported from BidFloor's colgroup/col-resizer pattern): drag any column's right edge to set its width; each column is independent. Table switches to `table-layout:fixed` with a `<colgroup>`; cells clip with an ellipsis (full value on hover via `title`). Widths persist per template in `localStorage`.

## Server v1.3.0 · UI v2.3.0 — 2026-07-09
- **Vertical record cards** for results: a single match always renders as a top-to-bottom `Field: value` card (no sideways scrolling for wide fields like owner contact/address).
- **New "View" setting** (`card_max`): show cards up to N matches, table above N. Persisted in `data/settings.json`, validated, and the change is logged — mirrors BidFloor's settings convention (persisted + validated + logged), file-based instead of SQLite. Edit it inline in the ribbon's View group.
- **Variable-width table columns**: table switched to content-sized (`table-layout:auto`) columns with wrapping for long values.
- Backend: `core/settings_store.py`, `/settings` route, `config.SETTINGS_FILE`, `log_settings_change`. Packaging: `entry.py` redirects `SETTINGS_FILE` into `data/`.

## Server v1.2.0 · UI v2.2.0 — 2026-07-09
- **CSV support**: source files can now be `.csv` as well as Excel. CSV templates skip sheet/table selection and go straight to column picking. File dialog now lists CSV.
- **Shared / in-use files**: source files are read via a shared, lock-tolerant in-memory read (`core/fileio.py`), so a file open in Excel or being synced/shared on OneDrive can still be read. Locked-file and missing-file errors now show a clear, actionable message instead of a raw exception.
- Builder "Workbook path" relabeled "File path (Excel or CSV)"; "Load sheets" → "Load file".

## Server v1.1.1 · UI v2.1.0 — 2026-07-09
- Ribbon "Data" group renamed to **Source**; now holds New Template + template selector, plus Edit / Delete / Refresh / Auto-check when a template is in use.
- Removed the ribbon "Search" group; moved Search, Exact/Partial mode, and Clear under the input fields in the left panel.
- Removed the redundant New Template link from the title bar.

## Server v1.1.1 · UI v2.0.0 — 2026-07-09
- Fix duplicate-row flagging: only rows whose matched value hit more than one record are flagged (previously every row was flagged whenever a search returned 2+ rows).

## Server v1.1.0 · UI v2.0.0 — 2026-07-09
- New **Option C** ribbon UI (`templates/search_c.html`) is now the default search screen.
- Grouped ribbon: **Data** (template, refresh, auto-check) · **Search** (run, match mode, clear) · **Export** (CSV, copy TSV) · **Server** (restart).
- Left input panel + right results grid; no page scrolling to reach results.
- Persistent footer: "WAIRE LookUp Tool - made by Avi Lavi" plus live Server/UI version labels.
- Server port changed to **2305** (was 5000) — now the permanent port.
- Classic single-column UI (`templates/search.html`) preserved on disk, no longer the default.

## Server v1.0.0 · UI v1.0.0 — baseline
- Classic single-column search UI, per-key-column inputs with AND logic, multi-value parsing.
- Template builder, synced-file source, export, logging. Ran on port 5000.
