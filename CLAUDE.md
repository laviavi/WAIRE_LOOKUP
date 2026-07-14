# WAIRE LookUp Tool — Project Guide

Local Flask app that replaces manual Excel/CSV lookups. Runs on `127.0.0.1:2305`,
single-user, localhost-only, no auth. Credit line: "Concept and system design: Avi Lavi | Code implementation: Claude (Anthropic)".

---

## How to run

```
cd D:\WAIRELookUp\waire_lookup
python app.py            # or run.bat (opens browser + starts server)
```

- **Port: 2305** (permanent). Set in `app.py`, `run.bat`, `.claude\launch.json`.
- Tests: `python -m pytest tests/ -q` (from `waire_lookup\`).
- Restart from the UI: the ribbon **Server → Restart** button (self-relaunches the process).

---

## Architecture

- **Flask app** (`app.py`) — single-threaded, renders server-side Jinja templates + a small JSON API for the template builder.
- **Sources are read lazily** — a workbook/CSV is only loaded into pandas on the first search, never on page render. Cached in-memory per path in `_sources`.
- **Fast metadata via ZIP** — sheet names, table names, and column headers are read straight from the xlsx ZIP XML (100–10,000× faster than opening the whole workbook). Full `pd.read_excel` happens only at search time.
- **Lock-tolerant reads** — every source read goes through `core/fileio.py`, which reads bytes with shared access (falls back to a temp copy) so files open in Excel or syncing on OneDrive still load. Excel **and** CSV supported.
- **Templates** are JSON files in `lookup_templates/`, one per lookup config (source path, sheet/table, key columns, result columns, header row, match mode, optional default filter).
- **Search logic** is a pure function: AND across key columns, OR within a column's value list.

---

## Navigation map (what lives where)

### Backend — `waire_lookup/`
- `app.py` — all routes: search screen (`/`, `/search`), refresh/export/toggle/restart, the builder JSON API (`/api/browse_file`, `/api/sheets`, `/api/tables`, `/api/columns`, `/api/save_template`), Send-to pipeline (`/api/send/outlook`, `/api/send/excel`, `/api/send/teams`, `/api/teams_webhooks`), template import/export (`/api/template_export`, `/api/template_import`), update check (`/api/update_check`), paginated rows (`/api/more_rows`), cross-search (`/api/cross_search`), log tail (`/api/log_tail`), auth test (`/api/auth_test`). Also injects version numbers into every template.
- `config.py` — paths, `SEARCH_RESULT_CAP=50`, secret key.
- `version.py` — `SERVER_VERSION` / `UI_VERSION`. **Bump every iteration** (see Versioning).
- `connectors/base.py` — abstract `DataSource`.
- `connectors/synced_file.py` — `SyncedFileSource`: mtime-based staleness, loads xlsx table/sheet or CSV from shared in-memory bytes.
- `core/fileio.py` — `is_csv`, `read_shared_bytes`, `friendly_read_error`.
- `core/normalize.py` — `normalize_key` (casefold, whitespace, Excel `.0` artifact), `parse_values` (comma/newline split, quotes escape commas).
- `core/search.py` — `search()` pure function + `SearchResult`; AND/OR logic, duplicate flagging, truncation.
- `core/view_groups.py` — pure `group_views_by_source(template)`: buckets views by their effective (sheet, table). A template can spread views across multiple sheets of the same workbook (schema v4). `do_search` loops groups, runs one `search()` per group.
- `core/templates_store.py` — save/load/list/delete/validate template JSON.
- `core/settings_store.py` — app-wide settings (`card_max`, `poll_minutes`, `graph_client_id`, `graph_tenant`) persisted to `settings.json`; `load/save/validate_settings` (save merges over stored settings — a single-field POST never resets others).
- `core/snapshot_store.py` — server-side snapshots of the full search result set in `data/snapshots/<uuid>.json`; session cookie carries only a 32-hex opaque id. Atomic writes, TTL cleanup. Fixes ERR_RESPONSE_HEADERS_TOO_BIG.
- `core/source_status.py` — per-source status (etag/last_checked/last_updated/last_error) in `data/source_status.json`; atomic writes.
- `core/poller.py` — background daemon thread (`start_poller`), runs `poll_once` every `poll_minutes`, records status, cleans expired snapshots. Local mtime for local sources; delegates to `source_sync` for SharePoint.
- `core/graph_auth.py` — MSAL public-client + persisted `SerializableTokenCache`; interactive sign-in runs in a background thread (blocks on localhost redirect + system browser).
- `core/graph_client.py` — read-only Graph endpoints (`/shares/{id}/driveItem`, `/drives/{drive}/items/{item}` metadata + content). Typed `GraphError(kind, message)`.
- `core/source_sync.py` — `sync_sharepoint_source`: metadata check → `.tmp` download → validate → `os.replace`. **A bad download never clobbers a valid cache.**
- `connectors/sharepoint_cached.py` — `SharePointCachedSource(SyncedFileSource)`; cache path derived from item_id (never stored in template).
- `connectors/sql_query.py` — `SqlQuerySource(DataSource)` (schema v4 SQL). Free-form query via `pymssql`, SQL-auth only (Windows Integrated Auth NOT supported by pymssql — documented, not a bug). `is_stale()` is always True (no cheap freshness signal for live SQL), so every search re-queries. Also provides `check_query(...)` — runs `SELECT TOP 0 * FROM (query) AS q` and returns columns or the raw SQL Server error verbatim (used by the builder Check button).
- `core/sql_connections.py` — CRUD for named, reusable SQL connections (server/port/db/username + `credential_id` pointer). Reusable across templates. Password NEVER stored in this JSON file.
- `core/sql_credentials.py` — DPAPI-encrypted username+password store, atomic writes (`sql_credentials.dat`). Bound to current Windows user account.
- `core/dpapi.py` — thin ctypes wrapper around Win32 `CryptProtectData`/`CryptUnprotectData`. No new pip dep. Non-Windows fallback for test portability.
- `core/logger.py` — plain-text append log to `logs/lookups.log` (incl. `log_settings_change`, `log_source_update`, `log_source_error`, `log_send`).
- `core/send_format.py` — pure serializers for the Send-to pipeline (Outlook mail HTML, Teams MessageCard JSON). No I/O — unit-testable without Outlook/Teams/network.
- `core/send_excel.py` — `build_workbook()`: generates a fresh in-memory .xlsx from the sent rows for download. Does NOT look for or append to any existing workbook — the user saves the download themselves if they want to keep it.
- `core/send_outlook.py` — creates an Outlook draft via COM (`pywin32`, Windows + classic desktop Outlook only). Never calls `.Send()` — user always reviews and sends manually.
- `core/send_teams.py` — posts a MessageCard to a saved Teams incoming webhook URL.
- `core/update_check.py` — GitHub Releases API check with 6-hour in-memory cache.

### Frontend — `waire_lookup/templates/` + `static/`
- `search_c.html` — **DEFAULT UI (Option C, ribbon layout)**. Rendered by `index()` and `do_search()`. Standalone page (does not extend `base.html`).
- `search.html` — classic single-column UI. **Kept on disk, no longer routed.** Don't delete; Avi may reuse it.
- `template_builder.html` — new/edit template screen (extends `base.html`); JS cascade browse → sheets → tables → columns → save.
- `base.html` — chrome for the builder/classic pages.
- `static/option_c.css` — Option C styles. `static/style.css` — shared/classic styles.
- `static/vendor/tabler/` — vendored Tabler icons (woff2/woff + CSS). No CDN dependency.

### Data / output
- `lookup_templates/*.json` — saved templates (e.g. `costar.json`).
- `exports/` — CSV exports. `logs/lookups.log` — search/refresh/template log.

### Tests — `waire_lookup/tests/`
- `test_normalize.py`, `test_search.py`, `test_templates_store.py`, `test_synced_file.py` (incl. CSV + open-while-in-use).
- `test_send_format.py`, `test_send_excel.py`, `test_send_routes.py` — Send-to pipeline + deep links.
- `test_graph_auth_cache.py` — DPAPI token cache (M1). `test_template_share.py` — export/import (M3).
- `test_update_check.py` — GitHub update checker (M4). `test_batch_report.py` — not-found reporting (M5).
- `test_show_more.py` — pagination (M6). `test_cross_search.py` — cross-template search (M7).
- `test_poll_notify.py` — Teams notifications (M9). `test_log_view.py` — log viewer (M10). `test_auth_test.py` — auth test (M11).

---

## Key decisions / conventions

- **Option C is the default UI.** To revert to classic, change the two `render_template("search_c.html", …)` calls in `app.py` back to `search.html`.
- **1-based header row** in template JSON (user-facing, "like Excel"); converted to 0-based for pandas via `max(0, n-1)` in `_header_row_to_pandas`.
- **No nested `<form>` elements** — browsers orphan submit buttons. Multi-action pages use sibling hidden forms + JS submit.
- **Ribbon groups (Option C):** Source (New Template, select, Edit, Delete, Refresh, Auto-check) · Export (CSV, Copy TSV, Copy link) · Send (Outlook, Excel, Teams chooser) · View (Cards/Table toggle, Check-every-N-min) · Account · Server (Restart). Search / match-mode / Clear live under the input fields, not in the ribbon.
- **Deep links:** `?template=<name>&key_0=...&key_N=...&mode=exact|partial&run=1` prefills the search form and (with `run=1`) auto-submits it. Built client-side by `buildDeepLink()`.
- **Send-to pipeline:** selection rule matches Copy TSV — selected rows if any, else all visible rows of the active view (confirm dialog first). **Send-to-Excel always generates a fresh downloadable .xlsx — it never looks for or appends to an existing tracker workbook** (that append/target flow was built, then deliberately removed at Avi's request). Outlook drafts are never auto-sent.
- **Ribbon icons** load Tabler from a CDN (jsdelivr). Needs internet on first load; text labels work regardless. Vendor locally if offline use is required.
- **Privacy:** `autocomplete="off"` on all inputs (never surface browser history in dropdowns).
- **Results view:** both card and table views are always rendered into the DOM; a **Cards / Table toggle** (ribbon **View** group) switches which is shown — client-side only, never reruns the search. The choice persists in browser `localStorage` (`waire_viewmode`, default cards). Cards collapse to header-only via a chevron. (The `card_max` setting still exists in `settings_store`/`settings.json` but no longer drives the UI — kept for backward compat.)
- **Resizable + sortable table columns:** ported from BidFloor's colgroup/col-resizer + sort pattern (JS `enhanceResultsTable` in `search_c.html`). On render, JS measures natural widths, builds a `<colgroup>`, switches to `table-layout:fixed`, adds a drag handle per header, and makes headers click-to-sort (↕/↑/↓, numeric vs text auto-detected, blanks last; resize-handle clicks excluded from sort). Cells clip with ellipsis (full text on hover). Column widths persist per template in browser `localStorage` (`waire_colw::<template>`); sort state is not persisted.

---

## Versioning (do this every iteration)

- `version.py`: bump `SERVER_VERSION` for backend changes, `UI_VERSION` for template/CSS/JS changes.
- Add a line to `waire_lookup/CHANGELOG.md`.
- Both versions render in the app footer status bar.
- Current: Server 1.17.2 · UI 2.23.0.

---

## Packaging / release (portable Windows build)

Self-contained PyInstaller **onedir** build — recipient needs no Python/pip/internet.

- **Build files** (separate from source, never bundled into it): `packaging/entry.py` (frozen entry-point wrapper — redirects writable data next to the .exe, fixes Flask template/static paths, makes Restart relaunch the .exe). Source under `waire_lookup/` is imported unchanged.
- **Rebuild** (run from `D:\WAIRELookUp`):
  ```
  python -m PyInstaller --noconfirm --clean --name WAIRELookUp \
    --paths waire_lookup \
    --add-data "D:\WAIRELookUp\waire_lookup\templates;templates" \
    --add-data "D:\WAIRELookUp\waire_lookup\static;static" \
    --collect-submodules win32com \
    --collect-all msal \
    --collect-all pymssql \
    --distpath release --workpath packaging\build --specpath packaging \
    packaging\entry.py
  ```
  **Use absolute `--add-data` paths.** PyInstaller 6.21 resolves relative `--add-data` paths against `--specpath`, not the current directory — a relative path here silently fails with "Unable to find ... when adding binary and data files."
  **`--collect-submodules win32com` / `--collect-all msal` / `--collect-all pymssql` are required, not optional.** Without them PyInstaller's static import graph misses these packages' compiled extensions — the v1.1.2 build shipped without `msal` or `pymssql` at all despite the app depending on both (undetected until the v1.2.0 rebuild). Verify after every build: launch the exe and hit `/api/auth_status` (exercises msal) and `/api/sql_check` (exercises pymssql) — both should return a clean JSON error, not a 500 import traceback.
  Kill any running `WAIRELookUp.exe` before rebuilding — PyInstaller's clean step can't delete DLLs the running exe has locked (`PermissionError: Access is denied`).
  Ships with **no templates** — do not copy `lookup_templates/*.json` into the release; `data/lookup_templates/` starts empty (source paths in dev templates are machine-local anyway). Keep `Run WAIRE LookUp.bat`, `README.txt`, and `AZURE_SETUP.md` at `release\WAIRELookUp_v<release>\`.
- **Output:** a versioned folder `release\WAIRELookUp_v<release>\` (~85 MB unpacked, ~48 MB zipped). Recipient runs `Run WAIRE LookUp.bat` or `WAIRELookUp.exe`; browser opens to port 2305. Writable data (templates/exports/logs) lives in `data\` next to the exe — must run from a writable location (not Program Files).
- **Release versioning:** independent of `version.py`'s Server/UI numbers. Each build → new `WAIRELookUp_v<release>` folder + an entry in `release\RELEASES.md` (records date + bundled Server/UI versions) + the version stamped in the shipped `README.txt` header. Keep old release folders for history. Current: **Release v1.2.0** (app Server 1.16.1 / UI 2.21.1).
- **Frozen-only concern:** the `python -c` restart in `app.py` doesn't work in a frozen exe, so `entry.py` overrides the `do_restart` view. If Restart behavior changes in source, mirror it in `entry.py`.

## Status

Spec phases 1–5 implemented (+ logging, template builder, restart, CSV, shared-file reads).
39 tests passing. Not started: any multi-user / sharing features (deferred — single-user local only for now).

---

## Work Style (Avi)

**While working: silence.** No running commentary, no inline explanations between tool calls. Just do the work.

**After finishing: report by exception, not by default.** The summary covers only what actually matters — anything that may need further development or Avi's attention.

- **If you deviated from an instruction in any way, spell out exactly what and why.** If you did **not** deviate, say nothing about it — no "I followed your instructions" filler.
- **Flag anything incomplete, uncertain, problematic, or likely to trigger follow-up work.**
- **Skip routine confirmations** and anything that doesn't need attention.
- **Raise genuinely valuable suggestions / next steps and any real questions.**
- If everything went exactly as instructed with nothing outstanding, keep the summary minimal, factual, and informative — don't pad it.

Also: minimal diffs; assess before rewriting (never rewrite without confirmation); keep functions/files small and single-purpose; flag expensive/scope-creeping requests before doing them.
