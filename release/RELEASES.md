# WAIRE LookUp — Release History

Each distributable build gets its own versioned folder in `release/` and one
entry below. Keep old folders (or their zips) so any prior build can be handed
out again. This file is NOT shipped inside the distributable.

**Release version** is the number you hand to people (e.g. "give them v1.0.0").
It is independent of the app's internal `Server` / `UI` versions (`version.py`),
which move per code change — each release records which internals it bundled.

**Conventions**
- Folder name: `WAIRELookUp_v<release>` (e.g. `WAIRELookUp_v1.0.0`).
- Bump release version: MAJOR for breaking/behavioral overhauls, MINOR for new
  features, PATCH for fixes/packaging-only tweaks.
- Stamp the same version in the folder name **and** in the shipped `README.txt`
  header.
- Rebuild steps: see `../CLAUDE.md` → "Packaging / release".

| Release | Date       | App (Server / UI) | Notes |
|---------|------------|-------------------|-------|
| v1.3.1  | 2026-07-14 | 1.17.2 / 2.23.0   | AJAX search with SSE progress bar, parquet cache + preload, auto-install deps in run.bat. |
| v1.3.0  | 2026-07-14 | 1.17.0 / 2.22.0   | M1–M11: DPAPI token cache, vendored icons, template export/import, update checker, not-found report, pagination, cross-search, quick filter, Teams notifications, log viewer, auth test. |
| v1.2.0  | 2026-07-12 | 1.16.1 / 2.21.1   | Send-to (Outlook/Excel/Teams) + deep links, SQL Server sources, multi-sheet views, autocomplete. |
| v1.1.2  | 2026-07-11 | 1.10.0 / 2.14.0   | Zero-setup SharePoint via well-known Microsoft public Client ID. |
| v1.1.1  | 2026-07-11 | 1.9.0 / 2.13.0    | In-app SharePoint setup, release version in footer, hide Sign-in when unconfigured. |
| v1.1.0  | 2026-07-11 | 1.8.0 / 2.12.0    | SharePoint (Graph) connector, source poller, snapshot fix. |
| v1.0.0  | 2026-07-09 | 1.2.0 / 2.2.0     | First portable Windows build. |

---

## v1.3.1 — 2026-07-14  (app: Server 1.17.2 / UI 2.23.0)
Performance and UX release.
- **AJAX search with SSE progress bar** — search runs via `POST /api/search` streaming real-time stage updates (Loading source → Searching N rows → Rendering results). Client-side result rendering from JSON.
- **Parquet cache + startup preload** — parsed Excel DataFrames cached as parquet files (~50-100× faster repeat loads). All file-based templates preloaded at startup.
- **Auto-install dependencies** — `run.bat` checks for Flask on first run and installs from `requirements.txt` if missing.
- Fixed: removed invalid `pythoncom` from requirements.txt (bundled in pywin32).
- Fixed: "Working outside of request context" error in SSE search.
- 174 tests passing.

## v1.3.0 — 2026-07-14  (app: Server 1.17.0 / UI 2.22.0)
Feature release: all 11 roadmap modules (M1–M11).
- **DPAPI-encrypted token cache** (M1) — refresh token no longer plain text at rest; legacy files auto-migrated.
- **Vendored Tabler icons** (M2) — no CDN dependency; works fully offline.
- **Template export/import** (M3) — download/upload template JSON; SQL connection_id blanked on export for portability.
- **Update checker** (M4) — checks GitHub Releases with 6-hour cache; chip in status bar.
- **Not-found reporting** (M5) — expandable panel showing which lookup keys had no match; input value counters; CSV export includes not-found appendix.
- **Show-more pagination** (M6) — "Show 50 more" button per truncated result group.
- **Cross-template search** (M7) — "Search all" sweeps every file-based template (SQL skipped); results in a modal.
- **Quick filter** (M8) — client-side text filter over visible results; composes with card collapse and selection.
- **Teams source-change notification** (M9) — poller posts a MessageCard to a chosen webhook when a source updates; version-based debounce prevents spam.
- **In-app log viewer** (M10) — click version bar to open a scrollable log tail modal.
- **SharePoint Test connection** (M11) — "Test" button in the setup modal; checks config → token → Graph whoami.
- 174 tests passing.

## v1.2.0 — 2026-07-12  (app: Server 1.16.1 / UI 2.21.1)
Feature release spanning everything built since v1.1.2: SQL Server sources,
multi-sheet views, autocomplete, and — headline feature — Send-to-Outlook/
Excel/Teams plus deep links.
- **Send-to pipeline.** New ribbon "Send" group. Outlook opens a pre-filled
  draft via COM (never auto-sent — user reviews and sends). Excel downloads
  a fresh `.xlsx` of the sent rows — deliberately does NOT look for or
  append to an existing tracker workbook (that append flow was built, then
  removed at Avi's explicit request before this release). Teams posts a
  card to a saved incoming webhook (URL never logged, only a masked tail
  shown back).
- **Deep links.** "Copy link" builds a URL that reopens a search (template +
  values + match mode) and auto-runs it when opened.
- **SQL Server sources** — free-form query, SQL-auth only, DPAPI-encrypted
  passwords, named reusable connections, a builder "Check" button that
  surfaces raw SQL Server errors.
- **Multi-sheet views** — a template's views can each pull from a different
  sheet of the same workbook.
- **Autocomplete, explicit Cards/Table toggle, resizable/sortable table
  columns, draggable input/results divider**, and reliability fixes (dev
  server staleness, large-result-set search, an autocomplete-killing Jinja
  auto-escape bug).
- **New bundled dependency**: `pywin32==310` (Outlook COM). Build command
  now includes `--collect-submodules win32com --collect-all msal
  --collect-all pymssql` — the prior release's build silently omitted the
  `msal` and `pymssql` packages despite the app depending on them; this
  build was verified to actually bundle both.
- Verified end-to-end on the packaged exe: footer shows
  `Release v1.2.0 · Server v1.16.1 · UI v2.21.1`; `/api/auth_status` (msal),
  `/api/sql_check` (pymssql), and `/api/send/excel` (the new download path)
  all respond correctly from the frozen build, not just from source.

**Not verified without real external accounts**: interactive Microsoft
sign-in, a live SQL Server connection, a real Outlook draft window opening
visually (COM call succeeded and returned 200, but no human confirmed the
window appeared), and a real Teams webhook post.

## v1.1.2 — 2026-07-11  (app: Server 1.10.0 / UI 2.14.0)
Removes the Azure setup step from the first-run experience.
- **Default Client ID is now Microsoft's own published "Graph Command Line Tools"** (`14d82eec-204b-4c2f-b7e8-296a70dab67e`). This is the shared public client Microsoft themselves publish for scripts and tools to reuse. Colleagues no longer need to complete `AZURE_SETUP.md` — they launch the app, click Sign in, grant consent once.
- Setup modal reworded to make clear it's optional (only for custom-branded consent or if a tenant blocks the shared identity). Added a "Reset to defaults" link.
- Ribbon tooltips clarified: Sign in is the normal path; Setup SharePoint is only for advanced/enterprise scenarios.
- Ships with `data/settings.json` pre-populated with the well-known ID; users need edit nothing.
- Trade-off (documented in README): consent dialog on first sign-in reads "Microsoft Graph Command Line Tools wants access…" instead of the tool's name. Acceptable for small internal tools; users who want a branded consent dialog can fall back to AZURE_SETUP.md.
- Verified on the packaged exe: `configured:true` out of the box, footer shows `Release v1.1.2 · Server v1.10.0 · UI v2.14.0`, modal + reset link render correctly.

**Cannot be verified without a real Microsoft 365 sign-in** (same as prior releases): whether the shared Client ID's default consent is pre-approved on the tester's tenant, silent WAM SSO on an Azure AD-joined machine, real 401/403/404 rendering.

## v1.1.1 — 2026-07-11  (app: Server 1.9.0 / UI 2.13.0)
Small UX polish over v1.1.0 to improve first-run experience and bug reporting:
- **In-app SharePoint setup modal** — no more editing `data/settings.json` in Notepad. Ribbon → Account → "Setup SharePoint" opens a form with Client ID + Tenant fields, GUID validation, inline error/success feedback.
- **Sign-in button hidden until SharePoint is configured** — replaced by "Setup SharePoint" so the UI never offers an action that can't succeed. Ribbon also has a small gear icon that opens the setup modal any time.
- **Release version shown in the footer** (`Release v1.1.1 · Server v1.9.0 · UI v2.13.0`) — a screenshot from the target machine now uniquely identifies the build.
- Internal: `POST /settings` returns JSON (`{ok:true|false, error?}`). `save_settings` refined so blank Client ID actually clears (was previously merged as no-op).
- 96 unit tests passing (added `test_save_clears_graph_client_id`).
- Verified end-to-end on the packaged exe: footer shows `Release v1.1.1`, modal + setup button present, `/settings` accepts a valid GUID and flips `configured` to true, empty Client ID resets `configured` to false.

## v1.1.0 — 2026-07-11  (app: Server 1.8.0 / UI 2.12.0)
Second portable Windows package. Backward compatible with v1.0.0 templates.
- **SharePoint (Microsoft Graph) source support** — read-only, delegated
  sign-in via MSAL. Templates can point at a sharing link or a direct file
  URL; single input field accepts both.
- **Local cache of SharePoint files** — searches read the cache (fast, no
  Graph calls at search time). Background poller detects source changes
  every `poll_minutes` (default 5). Failed/invalid downloads never clobber
  a valid cache.
- **Refresh Results banner** — appears when a source has been updated;
  clicking it re-runs the current search against the fresh cache without
  clearing inputs or results.
- **Big-result search fix** — full result set no longer stuffed into the
  session cookie; `ERR_RESPONSE_HEADERS_TOO_BIG` cannot recur.
- **New deps bundled**: `msal==1.31.1`, `requests==2.32.3` (+ certifi CA
  bundle). Pure-Python; auto-detected by PyInstaller.
- **New data dirs** created next to the exe: `data/snapshots/`,
  `data/source_cache/`, `data/source_status.json`, `data/token_cache.json`.
- **AZURE_SETUP.md shipped in the release folder** — one-time app
  registration instructions (~10 min).
- Verified end-to-end on the packaged exe: page render, footer versions,
  `poll_minutes` UI, Sign-in button, `/api/source_status`,
  `/api/auth_status`, `/api/resolve_source` (401 when not signed in but
  configured; 400 when not configured). MSAL code path reachable in the
  frozen build (no import errors).
- **Not verified without a real Azure registration**: interactive sign-in,
  live `/shares` resolution, real 401/403/404 mapping, eTag change
  detection, MSAL interactive flow through corporate proxies.

## v1.0.0 — 2026-07-09  (app: Server 1.2.0 / UI 2.2.0)
First self-contained, portable Windows package (PyInstaller onedir).
- Runs with no Python / pip / internet on the recipient's machine.
- Bundles runtime + Flask + pandas + openpyxl; Excel and CSV supported.
- Ships with no templates (user creates their own).
- Verified end-to-end on the packaged exe: page render, static assets, xlsx
  search (openpyxl+zip+pandas), CSV search, and the frozen restart override.
