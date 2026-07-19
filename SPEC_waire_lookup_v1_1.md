# WAIRE LookUp Tool — Current Build Specification

**Build described:** Server v1.24.0 · UI v2.34.0 · Release v1.3.x (2026-07-18)
Concept and system design: Avi Lavi | Code implementation: Claude (Anthropic).

Local Flask application replacing manual Excel/CSV lookups. Single-user, localhost-only
(`127.0.0.1:2305`, permanent port), no auth on the app itself. Sources can be local
Excel/CSV files, SharePoint files (read-only via Microsoft Graph, locally cached), or
SQL Server queries.

> This document supersedes the original v1 phase-by-phase build spec. It describes the
> features and behaviors of the build as it exists now. History lives in
> `waire_lookup/CHANGELOG.md`; developer navigation and conventions live in `CLAUDE.md`;
> the original implementation plans are `PLAN_send_and_links.md` and `PLAN_roadmap_v1_3.md`.

---

## 1. Project layout

```
waire_lookup/
  app.py                      # Flask app — all routes (search SSE, builder API, send, auth, admin)
  config.py                   # paths, SEARCH_RESULT_CAP=50, secret key
  version.py                  # SERVER_VERSION / UI_VERSION / RELEASE_VERSION (bumped every iteration)
  core/
    normalize.py              # normalize_key, parse_values
    search.py                 # pure search engine (wildcards, dup flagging, truncation)
    join.py                   # pure left_join for same-workbook merged views
    view_groups.py            # buckets a template's views by effective sheet/table (+ join groups)
    templates_store.py        # template JSON load/save/validate (schema v4)
    settings_store.py         # settings.json (card_max, poll_minutes, graph_*, teams_webhooks)
    snapshot_store.py         # full-result snapshots on disk, TTL cleanup
    source_status.py          # per-source etag/checked/updated/error status
    poller.py                 # background staleness poller daemon
    fileio.py                 # shared/lock-tolerant reads, is_csv, friendly errors
    logger.py                 # plain-text append log
    graph_auth.py             # MSAL public client + DPAPI-encrypted token cache
    graph_client.py           # read-only Graph endpoints, typed GraphError
    source_sync.py            # SharePoint metadata check → tmp download → atomic swap
    sql_connections.py        # named reusable SQL connections (no passwords in JSON)
    sql_credentials.py        # DPAPI-encrypted username+password store
    dpapi.py                  # ctypes CryptProtectData/CryptUnprotectData wrapper
    send_format.py            # pure serializers (Outlook HTML, Teams MessageCard)
    send_excel.py             # build fresh xlsx + open directly in Excel via COM
    send_outlook.py           # Outlook draft via COM (never auto-sent)
    send_teams.py             # post MessageCard to saved incoming webhook
    update_check.py           # GitHub Releases check, 6-hour cache
  connectors/
    base.py                   # abstract DataSource
    synced_file.py            # local xlsx/CSV source, mtime staleness, parquet cache
    sharepoint_cached.py      # SharePoint source reading from local cache
    sql_query.py              # free-form SQL via pymssql (SQL auth only)
  templates/
    search_c.html             # DEFAULT UI (Option C ribbon) — markup only, empty shell
    template_builder.html     # SSMS-style template designer — markup only
    search.html, base.html    # legacy classic UI, kept on disk, no longer routed
  static/
    search.js                 # all search-page behavior (AJAX search, rendering, everything)
    builder.js                # all designer behavior
    option_c.css, builder.css, style.css
    vendor/tabler/            # vendored Tabler icons (no CDN dependency)
  lookup_templates/*.json     # saved templates
  exports/                    # all CSV exports land here, nowhere else
  logs/lookups.log
  tests/                      # pytest suite (200+ tests)
tests_e2e/                    # Playwright suite (project root; auto-starts the app on 2305)
packaging/entry.py            # PyInstaller frozen-build entry wrapper
```

Dependencies: flask, pandas, openpyxl, pytest, msal, requests, pymssql, pywin32,
pyarrow (parquet cache). E2E: @playwright/test (npm).

---

## 2. Data sources

Abstract `DataSource` interface: `load() -> DataFrame`, `columns()`,
`source_timestamp()`, `is_stale()`. Three implementations:

### 2.1 Local file (`SyncedFileSource`)
- Excel (`.xlsx` sheet or named Excel Table) or CSV. All columns read `dtype=str`
  (leading zeros preserved); NaN → empty string.
- **Lock-tolerant reads** (`core/fileio.py`): bytes are read with shared access,
  falling back to a temp copy — files open in Excel or syncing on OneDrive still load.
- **1-based header row** in template JSON (user-facing, "like Excel"); converted to
  0-based for pandas.
- `is_stale()` is a cheap mtime stat comparison.
- **Parquet cache**: after first parse, Excel sources are cached as parquet keyed by
  (path, sheet, table, header, mtime) — ~50–100× faster repeat loads. All file-based
  templates are preloaded in a background thread at startup so the first search is instant.
- Named Excel Tables are located via direct xlsx ZIP-XML parsing (fast), then read
  with a bounded `pd.read_excel` — no slow openpyxl cell iteration.

### 2.2 SharePoint (`SharePointCachedSource`)
- Read-only Microsoft Graph access; delegated MSAL sign-in (`Files.Read.All`,
  `Sites.Read.All`) — no write scopes anywhere.
- Default client id is Microsoft's published "Microsoft Graph Command Line Tools"
  public app (`14d82eec-204b-4c2f-b7e8-296a70dab67e`) — zero Azure setup for most
  tenants; `graph_client_id`/`graph_tenant` are overridable in Settings (in-app modal).
- Token cache is DPAPI-encrypted on disk (bound to the Windows account), atomic writes.
- **Local source cache**: the poller checks Graph metadata (eTag/lastModified); on
  change, downloads to `.tmp`, validates, then atomically `os.replace`s into
  `data/source_cache/<item_id>.xlsx`. **A failed download never clobbers a valid
  cache.** Searches always read the cache — Graph is never called at search time.
- Cache path derives from the driveItem id and is never stored in the template
  (templates stay portable). Ribbon Account group: Sign in / name / Sign out, plus a
  "Test connection" button.

### 2.3 SQL Server (`SqlQuerySource`)
- Free-form SQL query per template. Driver: `pymssql` — **SQL Server Authentication
  only** (Windows Integrated Auth is not supported by this driver; documented
  limitation, not a bug).
- **Named, reusable connections** (`server/port/database/username` +
  `credential_id`) stored in JSON; **passwords are DPAPI-encrypted in a separate
  store and never appear in any JSON/log**. Connections are reusable across templates.
- `is_stale()` is always True (no cheap freshness signal), so every search re-queries.
- Builder "Check" button runs `SELECT TOP 0 * FROM (query) AS q` — success returns
  the column list; failure surfaces the raw SQL Server error verbatim.

---

## 3. Normalization and search engine

`core/normalize.py`:
- `normalize_key`: strip, casefold, collapse internal whitespace, strip the Excel
  `^\d+\.0$` float artifact. Applied identically to inputs and cell values.
- `parse_values`: splits input on commas and newlines; double quotes escape commas.

`core/search.py` — pure functions, DataFrame in / DataFrame out:
- `search(df, column_queries, mode, limit=50)` where `column_queries` is
  `[(column, [values...]), ...]`: **AND across key columns, OR within a column's
  value list**. A row matches when every queried column matches at least one of its
  values.
- **Exact mode**: normalized equality; wildcard characters are literal.
- **Contains mode** (internal token `partial`; UI label "Contains (* ? wildcards)"):
  - A plain value is an unanchored substring match (backward compatible).
  - A value containing `*` (any chars) or `?` (exactly one char) becomes an
    **anchored** pattern over the normalized string: `100*` = starts-with,
    `*100` = ends-with, `1?0` = exactly three chars. Regex-special characters in
    data are escaped.
  - One `_value_matcher` helper is the single matching definition shared by the row
    mask, the not-found check, and the matched-on labeling — the three sites cannot
    disagree.
- Result columns added: `_matched_on` (which column = which value matched),
  `_duplicate` (True when the matched value hit more than one row), `_card_title`
  (the record's own value in the matched column, "(partial match)" appended when it
  isn't an exact hit).
- `SearchResult`: capped `rows` (50), uncapped `full_rows` (for export/pagination),
  `total_matches`, `not_found` (input values matching zero rows, checked per-column
  against the full frame), `truncated`.

`core/join.py` — same-workbook merged views:
- `left_join(base_df, join_df, on, join_label)`: base sheet LEFT JOIN a second sheet
  of the same workbook, matched on **normalized** keys (messy-Excel variants line
  up). One row per base row (first match wins on the join side); unmatched rows get
  blanks. Join-sheet columns are **always** suffixed `" (SheetName)"` so display
  names map back to their sheet unambiguously; join-key columns are dropped from the
  join side. Pure — `python -m core.join` self-checks.

---

## 4. Templates (schema v4)

One JSON file per template in `lookup_templates/` (filename = slugified name).

```json
{
  "schema_version": 4,
  "name": "costar",
  "source": {
    "type": "local | sharepoint | sql",
    "path": "C:/.../workbook.xlsx",          // local
    "url": "...", "drive_id": "...", "item_id": "...",   // sharepoint
    "connection_id": "...", "query": "SELECT ...",       // sql
    "sheet_name": "Export072722",
    "table_name": null,
    "header_row": 1
  },
  "key_columns": ["PropertyID", "Property Address"],
  "result_columns": ["..."],                  // mirrors views[0] for backward compat
  "views": [
    { "name": "owner",  "columns": ["Owner Name", "..."] },
    { "name": "places", "columns": ["..."], "sheet_name": "Sheet1" },
    { "name": "Combined", "columns": ["Owner Name", "County Name (Sheet1)"],
      "join": { "sheet_name": "Sheet1",
                "on": [{ "left": "Property Address", "right": "Property Address" }] } }
  ],
  "sheet_joins": [ { "left_sheet": "Export072722", "right_sheet": "Sheet1",
                     "on": [{ "left": "Property Address", "right": "Property Address" }] } ],
  "labels": { "PropertyID": "Property ID" },
  "default_filter": { "column": "Phase", "equals": "1" },
  "default_match_mode": "exact | partial",
  "links": [ { "from_key": "PropertyID", "to_template": "vacancy", "to_key": "PIN",
               "to_key_index": 0, "label": "Vacancy", "to_view": "owner" } ]
}
```

Semantics:
- **One template = one workbook/source.** Views may target different sheets of the
  same workbook (per-view `sheet_name`/`table_name` override; omitted → primary).
  Older schema versions (v1–v3) load unchanged — views are synthesized from
  `result_columns` when absent.
- **`key_columns` is a single flat, template-wide list — a key does not have to
  exist on every sheet.** At search time a sheet/group is disabled only when it lacks
  a key column the *current search actually filled in* (queried columns, not the
  full configured list). Example: with keys `[PropertyID, Property Address]`, a sheet
  that has only `Property Address` is fully searchable by address alone.
- **Merged views** (`join` on a view): the base sheet is left-joined to the join
  sheet at search time; the merged view renders as its own view-tab. "One combined
  table" vs "separate per-sheet views" is just a tab click — both remain available.
- **Cross-template links** (`links`): jump-and-prefill only, never a data merge (two
  separate files/sources with independent freshness/cost). After a search, a button
  per link appears in the results header; clicking opens the target template
  pre-filled with the matched values, auto-runs the search, and (when `to_view` is
  set) opens that named view on the target.
- `default_filter` (optional, one column = one value, normalized equality) is applied
  to the frame before searching.
- Validation (`validate_template`) runs on selection and save; problems render as a
  warning banner, never a stack trace. Key/result columns are only checked against
  the primary source's columns when the template is single-sheet (a multi-sheet
  template's columns may legitimately live elsewhere). Zero key columns or an empty
  view blocks save.
- Templates can be **exported/imported** as `.waire-template.json` (SQL
  `connection_id` blanked on export; import validates before save).

---

## 5. Search screen (Option C — the default and only routed UI)

Standalone ribbon-layout page (`search_c.html` + `static/search.js`).
`GET /` always serves an **empty shell** — every search renders client-side.

### 5.1 The single rendering path
`POST /api/search` is the **only** search route. It streams Server-Sent Events:
status stages ("Loading… / Searching N rows… / Rendering…", drawn as a progress
bar), then one `result` event containing all group results as JSON. The client
(`ajaxSearch()`/`_renderResults()`) renders everything. There is deliberately no
server-rendered results path (the old `POST /search` was removed as a chronic source
of drift bugs — do not reintroduce one).

Per search, the server:
1. Parses `key_0..key_N` inputs (`parse_values` per field), builds column queries
   from non-empty fields only.
2. Buckets views into groups via `group_views_by_source` — one group per effective
   (sheet, table), plus one group per merged (join) view. One `search()` call per
   group; merged groups load both sheets and `left_join` first.
3. Saves one full-result **snapshot** per group to disk (`snapshot_store`) and
   returns opaque snapshot ids in the payload (session cookies never carry results —
   that caused `ERR_RESPONSE_HEADERS_TOO_BIG`; the client passes ids back explicitly
   for export/pagination, and sends the previous search's ids for cleanup).
4. Returns per-group rows (capped at 50), `not_found` values, truncation flags,
   view definitions, labels, links, warnings, timestamps, and duration.

### 5.2 Results presentation
- **Views as tabs**: when a template defines multiple views, tabs appear in the
  results header; switching is client-side only (shows the view's group block and
  filters its columns — never re-runs the search). A group whose sheet is missing a
  queried key renders as a disabled tab with the reason inline.
- **Cards / Table toggle** (ribbon View group): both renderings are always in the
  DOM; the toggle switches which is shown. Persists per browser (`localStorage`,
  default cards).
  - **Cards**: draggable by header, z-order on click, collapsible to header-only,
    per-card Copy (as `Label: value` lines) and Close buttons. Card title is the
    record's matched-column value, "(partial match)" when substring-matched.
  - **Table**: leftmost match column (headed with the searched field's name for
    single-field searches, "Match" for multi-field), duplicate rows visually marked,
    **drag-resizable columns** (widths persist per template in `localStorage`),
    **click-to-sort headers** (numeric vs text auto-detected, blanks last).
- **Found items** sidebar lists every result; entries activate/front/scroll to their
  card or table row; closing syncs card, list, and row. Ctrl+click multi-selects
  across card/table/found views.
- **Quick filter** box narrows visible rows client-side; composes with selection and
  collapse state.
- **Not-found panel**: chip in the header expands to the list of searched values
  that matched nothing, with a Copy-list button. Not-found values are also appended
  to CSV exports as an appendix.
- **Numbered pagination** (shadcn/ui-styled: `‹ Previous  1 … 4 5 6 … N  Next ›`,
  filled active page) replaces the append-forever "Show more" pattern when a group
  is truncated. `/api/more_rows` serves any page of the group's snapshot, shaped
  identically to the initial render's rows (flat `{col: value, ...}` plus
  `_matched_on`/`_duplicate`/`_card_title`), so a fetched page renders through the
  same card/table-row builder as page one. Works in both card and table view;
  selection and closed-card state (keyed by absolute row index) persist across pages.
- **Footer ribbon**: "Queried at" + "Source file updated at" timestamps, plus
  release/Server/UI version labels.
- Selection rule shared by Copy TSV / Export / Send: selected rows if any, else all
  visible rows of the active view (with a confirm).

### 5.3 Ribbon groups
- **Source**: New Template, template selector, Edit, Delete, Refresh (preserves
  inputs/results — re-runs with `force_reload=1` when results are showing),
  Auto-check toggle, Import template.
- **Export**: Export CSV (client-side Blob from selection; full server snapshot
  otherwise — UTF-8 BOM, into `exports/` only), Copy TSV, Copy link (deep link).
- **Send**: Outlook, Excel, Teams (webhook chooser) — see §7.
- **View**: Cards/Table toggle, poll-minutes setting.
- **Account**: SharePoint Sign in / status / Sign out, Setup modal, Test connection.
- **Server**: Restart (self-relaunches the process; the frozen build overrides this
  in `entry.py`).
- Search button, match-mode select ("Exact" / "Contains (* ? wildcards)"), and Clear
  live under the input fields, not in the ribbon.
- Buttons that require results are disabled in the HTML and enabled client-side
  after a search renders.

### 5.4 Input aids
- One multi-line textarea per key column (comma/newline separated values; quotes
  escape commas). Enter runs the search on text inputs; newlines work in textareas.
- **Autocomplete** per key column: live distinct values from the source
  (`/api/column_values`, case-insensitive substring, prefix hits first, capped 200)
  merged with recently-searched values (localStorage). Suppressed while the fragment
  contains a wildcard. `autocomplete="off"` on all inputs (privacy — never surface
  browser history).
- **Cross-template search** ("Search all"): sweeps every file-based template for a
  value and reports hits per template.
- Draggable divider between the inputs panel and results (width persists).

### 5.5 Deep links
`?template=<name>&key_0=...&key_N=...&mode=exact|partial&run=1[&view=<name>][&back=<url>]`
prefills the form; `run=1` auto-submits on load (then the URL is cleaned to just the
template). `view=` opens the named view on the first render. `back=` (set
automatically by a cross-template link — see §4/§6.4) carries the *source* page's own
deep link; the target page shows a "← Back to `<source template>`" button in the
results header that re-runs the original search exactly as it was, solving the
"followed a link and have no way back" gap (the target's URL is cleaned after
auto-run, so browser Back alone doesn't work). Both `view=` and `back=` are consumed
once — a later manual search on the same page has nothing to go back to. Built
client-side by `buildDeepLink()`; cross-template link buttons and Teams
notifications use it.

### 5.6 Freshness
- Default: data loads lazily on first search and is cached in-memory per
  (path, sheet, table); the user refreshes manually. Headers always show timestamps.
- **Auto-check toggle** (session-scoped, off by default): when on, each search
  stat-checks `is_stale()` first and reloads if changed.
- **Background poller** (daemon thread, `poll_minutes` setting, default 5): records
  per-source status; for SharePoint sources it syncs the local cache. A staleness
  banner with a **Refresh Results** button appears when the source changed after the
  last search (re-submits with `force_reload=1`, inputs preserved).
- **Teams notifications** (opt-in, M9): the poller can post a source-changed card to
  a saved webhook, debounced by source version.

---

## 6. Template designer (SSMS-style)

`GET /templates/new` and `GET /templates/<name>/edit` — a standalone
query-designer-style page (`template_builder.html` + `static/builder.js`), replacing
the old form-cascade builder (same routes, same schema-v4 save payload).

### 6.1 Layout — three panes + wizard strip
- **Wizard strip**: 1 · Pick key columns → 2 · Create views → 3 · Pick fields per
  view; steps check off as the state satisfies them.
- **Source strip**: name, source type radio (Local file / SharePoint URL / SQL
  Server), path or URL or connection+query, header row, Load. Loading uses
  `/api/workbook_map` — one shot returning every sheet with its columns (single
  shared-bytes read + one pandas header pass, instead of N per-sheet round trips).
- **Diagram pane**: **one box per sheet** (a box is per-sheet, not per-Excel-Table —
  a Table is just a named range over the same columns). Each box lists its columns
  with: a checkbox (adds the column to the active view), a key icon (toggles the
  column as a search key — allowed on **any** box, not just the primary), and a
  "make primary" control. Boxes are draggable; column lists are user-resizable
  (native CSS `resize: vertical`). A "not searchable — missing key" badge appears
  only when a box shares **none** of the configured keys (mirrors runtime behavior).
- **Criteria grid ("Fields")**: one row per used column — Field / Label (the labels
  editor) / Sheet / Key toggle / one checkbox column per view / "+ view". Columns
  are drag-resizable. Clicking a view's header makes it the active view (diagram
  checkboxes target it); view names are edited inline; views can be removed.
- **Technical summary**: plain-English `SEARCH BY … / VIEW … / JOIN … / LINK …`
  readout, collapsed by default behind a disclosure toggle.
- **Settings strip**: default match mode, optional default filter (column + value),
  Save / Cancel.

### 6.2 View rules
- **A view binds to exactly one sheet** — checkboxes that would mix sheets are
  disabled with an explanatory tooltip… **unless the sheets are joined** (below).
- Save validation: at least one key column, every view named and non-empty.

### 6.3 Same-workbook joins (merged views)
- A **"Join sheets"** button opens a dialog: base sheet + column ↔ join sheet +
  column → creates a left-join declaration, shown as a chip
  (`Base ⟕ Join (col = col)`) with a remove ×.
- Once a join exists, a view bound to the base sheet **can** check the join sheet's
  columns. Such a column is stored qualified as `"Column (SheetName)"` (matching the
  backend's naming exactly), and the view becomes a merged view. Unchecking the last
  join column reverts it to a plain view. Removing a join strips its columns from
  all views.
- Joined columns cannot be search keys.

### 6.4 Cross-template links
- An "add linked template" dropdown adds any other saved template as a **dashed,
  read-only box** showing its key columns.
- **Click-to-link** (click a key field here, then a key field there) or
  **drag-to-link** (rubber-band line between them) — both funnel into the same
  creation path. Links render as chips with an editable button label and a
  **target-view dropdown** (default view or any named view of the target).
- Links are navigation only — see §4 semantics.

### 6.5 Edit mode
Hydration replicates `group_views_by_source` inheritance exactly: per-view sheet
overrides, join specs, declared `sheet_joins` (reconstructed from views when
absent), links, labels, filter, and match mode all round-trip. Legacy `table_name`
references resolve to their sheet's box.

### 6.6 Engineering rules for both pages
- Markup-only Jinja templates; **all** behavior in `static/*.js` files with `?v=`
  cache-busting. Page data passes via JSON `<script type="application/json">` tags
  or `data-*` attributes — **no Jinja interpolation inside JS, ever** (the
  entity-escaping bug class this eliminated is structurally impossible now).
- **Zero inline `onclick` attributes**; results-header and designer content is built
  with `createElement`/`addEventListener` (the string-concatenated-handler pattern
  caused a dead-button bug class and a real injection surface — do not reintroduce).
- No nested `<form>` elements (browsers orphan submit buttons).

---

## 7. Send-to pipeline

Ribbon **Send** group; selection rule matches Copy TSV (selected rows, else all
visible rows with a confirm). Serializers are pure (`core/send_format.py`) and
unit-tested without Outlook/Teams/network.

- **Outlook** (`/api/send/outlook`): creates a draft via COM (`pywin32`; Windows +
  classic desktop Outlook only). Includes the rows as an HTML table and a deep link
  back to the search. **Never calls `.Send()`** — the user always reviews and sends.
- **Excel** (`/api/send/excel`): builds a **fresh** in-memory `.xlsx` from the sent
  rows, writes it to a temp file, and **opens it directly in Excel via COM** — no
  browser download, no manual double-click. **It never looks for or appends to any
  existing tracker workbook** (that flow was built and deliberately removed).
  Windows + Excel only.
- **Teams** (`/api/send/teams`): posts a MessageCard to a saved incoming-webhook URL
  (managed in settings; URLs never logged or echoed back — masked tail only).

---

## 8. Logging, snapshots, settings, admin

- **Log** (`logs/lookups.log`, plain-text append): one line per search
  (`template | mode | value count | matches | not_found values | duration_ms`),
  plus template save/edit, refresh, settings changes, source updates/errors, and
  send events. **Never logs result rows or result column contents.** In-app log
  viewer modal (ribbon) tails it via `/api/log_tail`.
- **Snapshots** (`data/snapshots/<uuid>.json`, atomic writes): the full uncapped
  result set per group per search; drive export and show-more. Cleaned by TTL (24h)
  at startup/poller ticks, plus the client reports its previous search's ids for
  immediate deletion.
- **Settings** (`settings.json` via `settings_store`): `card_max` (legacy, no longer
  drives the UI), `poll_minutes` (clamped 1–120), `graph_client_id`/`graph_tenant`,
  `teams_webhooks`. Saves merge over stored settings — a single-field POST never
  resets others. Changes are validated and logged.
- **Update checker**: `/api/update_check` polls GitHub Releases (6-hour in-memory
  cache) and surfaces a new-version notice.
- **Restart**: ribbon Server → Restart self-relaunches the process. On startup,
  `ensure_single_instance(2305)` kills any process already holding the port, so two
  competing server processes can never serve different code;
  `TEMPLATES_AUTO_RELOAD=True` makes template edits live without restarts.
- **Versioning discipline**: `version.py` (`SERVER_VERSION` for backend,
  `UI_VERSION` for frontend) is bumped **every iteration** with a `CHANGELOG.md`
  entry; both render in the footer status bar.

---

## 9. Testing

- **pytest** (`waire_lookup/tests/`, 200+ tests): normalization, search (incl.
  wildcards), join/merge (helper + through the real `/api/search` route),
  view-groups, multi-sheet keys, templates store, synced file (CSV + locked files),
  send pipeline + routes, graph auth cache, template share, update check, batch
  not-found, show-more, cross-search, poll/notify, log view, auth test, snapshot
  lifecycle, workbook map.
- **Playwright e2e** (`tests_e2e/`, run from repo root; auto-starts the app):
  JS-layer coverage the Python suite can't provide — AJAX search and rendering,
  view switching, column resize, card interactions, global handler wiring
  (regression guard for the closure-scope dead-button class), state reset across
  searches, links + not-found panel (incl. XSS-safety with hostile labels), and the
  full designer (create, edit round-trip, mix-sheets greyout, missing-key badge,
  key-on-secondary-sheet, click/drag linking, join → merged view). Machine-
  independent fixtures in `tests_e2e/fixtures/`.
- Working rule: **test by impact, not by layer** — UI/UX verification in the browser
  is mandatory whenever user-facing behavior is affected.

---

## 10. Packaging (portable Windows build)

Self-contained PyInstaller **onedir** build (recipient needs no Python/pip/
internet). Build files live in `packaging/` (`entry.py` redirects writable data
next to the exe, fixes Flask paths, overrides Restart). Must pass
`--collect-submodules win32com --collect-all msal --collect-all pymssql` and
absolute `--add-data` paths. Output: `release/WAIRELookUp_v<release>/` with
`Run WAIRE LookUp.bat`, `README.txt`, `AZURE_SETUP.md`; writable data in `data/`
next to the exe. Ships with no templates. Release versioning is independent of
Server/UI numbers (`release/RELEASES.md`). See `CLAUDE.md` for the exact rebuild
command and verification steps.

---

## 11. Explicit non-goals (current)

- Multi-user / sharing features, or auth on the Flask app (single-user localhost).
- **Cross-workbook data merges** — cross-template links navigate; only same-workbook
  sheets merge. Deliberate: separate files have independent freshness/cost.
- Windows Integrated Auth for SQL (pymssql limitation; migrate to pyodbc if needed).
- Writing to SharePoint (read-only scopes by design).
- Auto-sending Outlook mail (drafts only).
- Appending to existing workbooks in Send-to-Excel (fresh temp workbook only).
- Log rotation.

## 12. Working rules for coding sessions

1. Minimal diffs; fix reported bugs with targeted edits, don't rewrite files.
2. Bump `version.py` + add a `CHANGELOG.md` line every iteration.
3. Pure logic gets pytest coverage; user-facing changes get browser verification
   (and Playwright coverage where the bug class warrants a regression guard).
4. Keep `CLAUDE.md`'s navigation map and key decisions in sync with structural
   changes.
5. If a design question isn't answered here or in `CLAUDE.md`, stop and ask rather
   than choosing silently.
