# Implementation Plan — Roadmap toward Release v1.3.0

Target executor: **Sonnet 5 in Claude Code.** Read `CLAUDE.md` first — every
convention in it applies (minimal diffs, work silently, report by exception,
versioning every iteration, navigation map before scanning files).

## How to execute this plan

This plan is **11 independent modules (M1–M11)**, ordered by priority. It is
designed to be executed **incrementally across many sessions** — you are NOT
expected to do it all at once.

Rules for every session:

1. **One module per session** unless the user explicitly asks for more.
   Modules marked SMALL may be batched 2–3 per session if asked.
2. Each module is self-contained: it has its own scope, files, tests,
   version bump, and CHANGELOG entry. Finish a module completely (including
   tests passing) before touching the next.
3. At the end of each module: run `python -m pytest tests/ -q` from
   `waire_lookup\` — the FULL suite must pass, not just the new tests.
4. Update the **Progress tracker** table at the bottom of THIS file
   (status → `done`, date, actual Server/UI versions) as part of each
   module's commit of work. That is how the next session knows where to
   resume. Never rely on conversation memory.
5. Update `CLAUDE.md`'s navigation map / conventions when a module adds a
   file or a user-facing behavior (one line each, same style as existing
   entries).
6. Version bumps: each module states whether it bumps SERVER (backend),
   UI (frontend), or both — bump MINOR for a new feature, PATCH for
   fix/polish, per existing convention.
7. **Scope guard (global):** do NOT touch `core/search.py` matching logic,
   `core/normalize.py`, `core/view_groups.py`, the SQL connector, or the
   SharePoint sync pipeline except where a module explicitly says so.
   Do NOT reintroduce the removed Excel append-to-tracker flow.
8. If a design question arises that this plan does not answer, ask rather
   than choosing silently.
9. No PyInstaller build as part of any module. Packaging happens once, at
   the end, when the user asks for a release (see `CLAUDE.md` → Packaging).

Priority order (do them in this order unless the user says otherwise):
**M1 → M2 → M3 → M4 → M5 → M6 → M7 → M8 → M9 → M10 → M11.**
M1–M4 are the "changed circumstances" items (distribution to a second user,
GitHub releases now exist). M5–M8 are the highest-value new features.
M9–M11 are polish.

---

## M1 — Encrypt token_cache.json with DPAPI  (SMALL, backend only)

**Why:** `data/token_cache.json` holds the MSAL refresh token in plain text —
a working credential for the user's SharePoint. `core/dpapi.py` already
exists (built for SQL credentials), so this is reuse, not new machinery.

**Files:** `core/graph_auth.py` (edit), `config.py` (no change needed),
`tests/test_graph_auth_cache.py` (new).

**Design:**

- Keep `config.TOKEN_CACHE_FILE` pointing at the same path. The file's
  CONTENT becomes a DPAPI blob instead of plain JSON. Do not rename the file
  (README references it; entry.py redirects it).
- In `graph_auth._save_cache`: serialize as today, then
  `dpapi.protect(text.encode("utf-8"), description="WAIRE token cache")`,
  write bytes (`tmp.write_bytes` + `os.replace`, keep the atomic pattern).
- In `graph_auth._load_cache`: read bytes; try `dpapi.unprotect` →
  `deserialize`. **Migration path:** if `unprotect` raises OR the raw bytes
  start with `{` (legacy plain JSON), fall back to treating the raw bytes as
  plain JSON, deserialize, and let the next `_save_cache` re-write it
  encrypted. Never crash on a corrupt/old cache — fall back to an empty
  cache exactly as the current `except Exception: pass` does.
- `sign_out()` already deletes the file — unchanged.
- Non-Windows: `dpapi.protect/unprotect` already have a sentinel passthrough,
  so tests stay portable. No platform branching needed in graph_auth.

**Tests (new file, monkeypatch `config.TOKEN_CACHE_FILE` to tmp_path):**
- save→load round-trip restores the serialized cache string.
- On-disk bytes after save are NOT the plain serialization (differ from
  `cache.serialize()` bytes) — proves encryption happened (on non-Windows
  the sentinel prefix still makes them differ).
- Legacy plain-JSON file on disk loads successfully (migration).
- Garbage bytes on disk → empty cache, no exception.
Use a real `msal.SerializableTokenCache` (msal is installed) — no fake needed.

**Docs:** README claim "keep it like a password" can be softened next
release; add one line to CHANGELOG + CLAUDE.md nav-map line for
`graph_auth.py` mentioning encrypted-at-rest cache.

**Bump:** SERVER minor.

---

## M2 — Vendor Tabler icons locally  (SMALL, frontend only)

**Why:** Ribbon icons load from jsdelivr CDN; on a machine without internet
(or a locked-down proxy) every icon silently disappears. The app is now
distributed to other machines.

**Files:** `static/vendor/tabler/` (new), `templates/search_c.html` (edit),
`templates/base.html` (edit — the builder uses icons too; check first with
grep for `tabler` across templates), `CLAUDE.md` (edit conventions line).

**Steps:**
1. Download `tabler-icons.min.css` + the woff2 font file(s) of
   `@tabler/icons-webfont@3.24.0` (same pinned version as the current CDN
   link) into `static/vendor/tabler/`. Use `pip download`-style caution:
   fetch from jsdelivr (`https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.24.0/dist/...`)
   with `curl`/`Invoke-WebRequest`. The css references `fonts/tabler-icons.woff2`
   (and .woff) via relative url — preserve that relative layout
   (`static/vendor/tabler/fonts/…`) or rewrite the url() in the css.
   Verify the css's actual url() paths after download; do not assume.
2. Replace the CDN `<link>` in each template with
   `{{ url_for('static', filename='vendor/tabler/tabler-icons.min.css') }}?v={{ ui_version }}`.
3. Verify in the browser (preview_start) that icons render, and check the
   network log shows NO request to jsdelivr.
4. Update the `CLAUDE.md` "Ribbon icons" convention line: icons are now
   vendored; no internet needed.

**Tests:** none meaningful (asset change). Manual browser check required.
Note in the summary that the release folder size will grow slightly.

**Bump:** UI patch.

---

## M3 — Template export / import  (MEDIUM, backend + frontend)

**Why:** The exe is on a second machine with an empty `lookup_templates/`.
Template JSONs contain machine-local source paths, so raw file copying
half-works and confuses. This is the lightweight version of the deferred
"multi-user / template sharing" feature.

**Files:** `core/templates_store.py` (edit — add two pure functions),
`app.py` (two routes), `templates/search_c.html` (Source ribbon group + one
modal + JS), `tests/test_template_share.py` (new).

**Design — keep it deliberately dumb:**

- **Export:** `GET /api/template_export?template=<name>` → responds with the
  template JSON as a download (`Content-Disposition: attachment;
  filename=<slug>.waire-template.json`). No zip, no bundle — one template,
  one JSON file. Strip nothing: the source path travels as-is (the import
  side fixes it). SQL templates: strip `connection_id` → replace with
  `{"connection_id": ""}` and include a top-level marker
  `"needs_connection": true` (connections/credentials are machine-local and
  MUST NOT be exported; the importer will tell the user to pick one).
- **Import:** `POST /api/template_import` with the JSON body of the file
  (client reads the file with FileReader, POSTs it). Server:
  `validate_template` (schema-level); if a template with that name exists →
  400 `"A template named '<name>' already exists — rename it first or delete
  the old one."` (no silent overwrite, no auto-rename). Save it via the
  existing `save_template`.
- **Path fixing on import (local/sharepoint file sources only):** after a
  successful import, the client checks the source: for `type` local, call
  the existing `/api/sheets` with the imported path — if it errors (file not
  found on this machine), open a small dialog: "This template points to
  `<path>`, which doesn't exist on this machine. Browse to the file…" with a
  Browse button reusing `/api/browse_file`, then `POST /api/save_template`
  with the corrected path. For `sharepoint`, no path fix needed (drive/item
  ids are machine-independent; the user just needs to sign in). For `sql`,
  show: "Pick a SQL connection for this template in the template editor."
  and link to `/templates/<name>/edit`.
- **UI:** in the ribbon Source group: an "Export" option is a small
  download icon button next to Edit (visible when a template is selected);
  "Import…" sits next to New Template (a hidden `<input type=file
  accept=".json,.waire-template.json">` triggered by the button).

**Tests:**
- export of a local template returns the JSON with the path intact;
- export of a SQL template blanks `connection_id` and sets `needs_connection`;
- import of a valid template saves it (file appears in the store);
- import with an existing name → 400 with the exact message;
- import of invalid JSON/schema → 400 listing validation problems.
Use the `clean_env` fixture pattern from `tests/test_send_routes.py`.

**Bump:** SERVER minor + UI minor.

---

## M4 — Update checker against GitHub Releases  (MEDIUM, backend + frontend)

**Why:** Distributed copies go stale silently. Releases now live at
`github.com/laviavi/WAIRE_LOOKUP` — checking is one unauthenticated API call.

**Files:** `core/update_check.py` (new), `version.py` (read), `app.py` (one
route), `templates/search_c.html` (small JS + statusbar chip), `config.py`
(add `UPDATE_REPO = "laviavi/WAIRE_LOOKUP"`), `tests/test_update_check.py`
(new).

**Design:**

- `core/update_check.py`:
  ```python
  def fetch_latest_release(repo: str, timeout: float = 5.0) -> dict | None
      # GET https://api.github.com/repos/{repo}/releases/latest  (requests,
      # no auth). Returns {"tag": "v1.2.0", "url": html_url} or None on ANY
      # failure (network, 4xx/5xx, JSON shape). Never raises.
  def is_newer(latest_tag: str, current: str) -> bool
      # strip leading v, compare as int tuples; malformed → False.
  ```
- Route `GET /api/update_check` → calls `fetch_latest_release`, compares to
  `RELEASE_VERSION`, returns
  `{"update_available": bool, "latest": tag_or_null, "url": url_or_null}`.
  **Cache the result in-module for 6 hours** (module-level `(ts, result)`
  tuple) so the UI polling never hammers GitHub. The live check happens at
  most a few times a day.
- Frontend: on DOMContentLoaded, `fetch('/api/update_check')` once (fire and
  forget — never block anything on it). If `update_available`, render a
  small chip in the footer statusbar next to the versions:
  `⬆ v1.3.0 available` linking to `url` (target=_blank). No toast, no modal,
  no nagging. Offline/no-response → chip never appears; zero errors surfaced.
- **Never auto-download, never auto-install.** Display-only.

**Tests (monkeypatch `requests.get` — no live network in tests):**
- happy path: fake 200 with tag_name/html_url → correct dict;
- network exception / non-200 / missing keys → None;
- `is_newer`: "v1.3.0" vs "1.2.0" → True; equal → False; malformed → False;
- route: monkeypatch `fetch_latest_release`, check JSON shape both ways;
- cache: second call within TTL does not re-invoke the fetch (count calls).

**Bump:** SERVER minor + UI patch.

---

## M5 — Batch lookup with not-found report  (LARGE, the flagship feature)

**Why:** The tool's real-world job is "check this list of 200 IDs against
the source." Today the textarea accepts lists, but the *misses* — the values
that found nothing — are only a chip in the header, and results can't be
exported together with a miss list.

**Files:** `app.py` (extend `do_search` result payload — carefully),
`templates/search_c.html` (results header + export), `core/search.py`
(**read-only** — `SearchResult.not_found` already exists; do NOT change the
search function), `tests/test_batch_report.py` (new).

**Design — build on what exists, add no new search path:**

1. **Not-found panel.** Today `result.not_found` renders as one truncated
   chip. Replace with: chip shows count (`14 not found`); clicking it
   expands a panel (below res-head) listing every missed value, one per
   line, with a "Copy list" button (clipboard, newline-separated). Data is
   already in the render context — this is template/JS only.
2. **Export with misses.** In the existing `/export` CSV flow, append the
   not-found report: after the data rows, one blank line, then a
   `NOT FOUND` header line and one row per missed value. To do this the
   snapshot must carry the misses: add `not_found: list[str]` to
   `snapshot_store.save_snapshot(...)` (new optional kwarg, default `[]`,
   stored in the same JSON — backward compatible: `load_snapshot` uses
   `.get("not_found", [])`). `do_search` passes `sr.not_found` for the
   primary group. `/export` writes the extra section only when non-empty.
3. **Input counter.** Under each key textarea, a live count:
   `217 values` (JS, parse on input with the same comma/newline/quote rules
   as `parse_values` — approximate client-side split is fine, it's a hint).
4. Cap-awareness: when `truncated` is true the header chip already says
   "showing first 50 — export for all". Unchanged; M6 addresses display.

**Explicitly not building:** a file-upload input (paste covers it; the
textareas accept thousands of lines), a separate "batch mode" page, any
change to matching logic.

**Tests:**
- snapshot round-trip with `not_found` populated and absent (legacy);
- `/export` CSV contains the `NOT FOUND` section when misses exist and not
  when they don't (extend the fixture pattern from `test_app_snapshot.py`);
- search with a mix of hits and misses renders every missed value in the
  page HTML (test client, check response body).

**Bump:** SERVER minor + UI minor.

---

## M6 — "Show more" pagination from the snapshot  (MEDIUM)

**Why:** The 50-row display cap is the tool's most visible limitation. The
FULL result set already sits in the snapshot on disk — display is the only
gap.

**Files:** `app.py` (one new JSON route), `templates/search_c.html` (button
+ row-append JS), `tests/test_show_more.py` (new).

**Design:**

- Route `GET /api/more_rows?group_key=<k>&offset=<n>&limit=50`:
  look up `session["snapshot_ids"][group_key]` (same logic as `/export`),
  `load_snapshot`, slice `df.iloc[offset:offset+limit]`, restrict to the
  snapshot's `result_columns`, return
  `{"rows": [[...], ...], "columns": [...], "total": len(df),
    "has_more": bool}`. Values stringified (`astype(str)`, NaN→"").
  Missing/expired snapshot → 410 `{"error": "Results expired — run the
  search again."}`.
- UI: when a group's `truncated` is true, show a `Show 50 more (1069 total)`
  button after the table. Clicking fetches and appends `<tr>` rows to the
  active group's table (build cells with `data-col` attributes matching the
  existing header so view-switching and the column filter still work). Cards
  view: do NOT append cards (cards are a detail view; keep them capped) —
  after an append, the cards toggle shows table only for the appended rows;
  simplest correct behavior: appended rows exist only in table view, and
  that is fine. Selection/copy/send must work for appended rows — they need
  `data-cid` values; continue the `group::index` scheme offset by the
  snapshot offset so cids stay unique (`g1::50`, `g1::51`, …).
- Note honestly in the module summary: appended rows do not have card
  equivalents and do not appear in Found Items (cards/found-list stay
  first-50); tooltips/copy/export-selected work because they read the table.
- The `_matched_on` column exists only for the displayed subset (search
  computes it before truncation on `full_rows`? — CHECK: `full_rows` in
  `SearchResult` retains `_matched_on`; verify by reading `core/search.py`
  lines 70–90 before implementing; if full_rows lacks it, render the
  mo-cell empty for appended rows rather than recomputing).

**Tests:**
- big-CSV fixture (reuse `test_app_snapshot.py` helpers): search caps at 50,
  `/api/more_rows offset=50` returns the next 50 with correct total/has_more;
- offset beyond end → empty rows, has_more false;
- no session snapshot → 410;
- columns match the snapshot's result_columns.

**Bump:** SERVER minor + UI minor.

---

## M7 — Cross-template search  (MEDIUM)

**Why:** "Where does this value appear?" across every saved template —
fits the lookup identity; reuses everything.

**Files:** `app.py` (one route + small render support),
`templates/search_c.html` (UI entry point + results rendering),
`tests/test_cross_search.py` (new).

**Design — search-all is a convenience sweep, not a new engine:**

- UI entry: a small `Search all templates` checkbox (or toggle button)
  beside the existing Search button, enabled only when a template is
  selected and exactly ONE key value is entered (keep scope tight: one
  value, all templates; multi-value cross-search is out of scope).
- Route `POST /api/cross_search` body `{"value": "...", "mode": "exact|partial"}`:
  loop `list_templates()`; for each template, for each of its `key_columns`,
  run the existing `search()` with `[(col, [value])]` against the template's
  primary source (`_get_source(t)`, `_ensure_loaded`, apply default filter —
  reuse the primary-group slice of the `do_search` flow; factor a tiny
  helper if needed but do NOT restructure `do_search`). Collect per template:
  `{"template", "column", "matches": int, "sample": [up to 3 matched_on strings]}`.
  Skip (and report `"error": "<friendly msg>"`) any template whose source
  fails to load — one broken source must not kill the sweep. Cap total work:
  `limit=5` per search call (we only need counts + samples).
  **SQL templates: skip by default** (`"skipped": "SQL source"`) — a sweep
  must not fire N live SQL queries; note it in the row.
- Response renders client-side into a simple modal/panel: one line per
  template with hits — template name (click → deep link
  `/?template=X&key_0=<value>&mode=<mode>&run=1`, reusing M-none, it exists),
  which key column hit, match count, sample values. Templates with 0 hits
  collapsed under "No matches in N other templates".
- Timing: sweep loads every workbook lazily (first run may take seconds) —
  show a spinner in the panel while the fetch is in flight.

**Tests:** two tmp templates over two CSVs; cross_search for a value in one
of them → correct template flagged, other reports 0; a template with a
missing source file reports its error but the response is still 200 with the
other results; SQL-source template (fixture JSON with type sql) is skipped.

**Bump:** SERVER minor + UI minor.

---

## M8 — Quick filter box over results  (SMALL, frontend only)

**Why:** Post-search narrowing without re-searching, same spirit as the
existing client-side sort/resize.

**Files:** `templates/search_c.html`, `static/option_c.css`.

**Design:**
- A small text input in the res-head (right side): placeholder `Filter…`,
  visible only when a result is showing.
- On input (debounced ~150ms): case-insensitive substring test against the
  concatenated visible-cell text of each row in the ACTIVE group's table;
  non-matching rows get `display:none`; matching count shown as
  `n of N shown` next to the box. Also filter cards (`.record-card`) and
  Found Items entries by the same predicate (match against card text).
- Clearing the box restores everything (including previously closed-card
  state — do NOT resurrect `_closed` cards; the filter must compose with
  `_closed`, i.e. row hidden if closed OR filtered out).
- Interplay: `_rowsForAction()` already filters by `display !== 'none'`, so
  Copy TSV / Send / Export-selected automatically respect the filter —
  verify this and state it in the summary; the send-all confirm count will
  reflect filtered rows, which is the desired behavior.
- Filter resets on new search (page re-render does this for free).

**Tests:** none server-side (pure client JS). Manual browser verification:
type a value, rows hide, count updates, Copy TSV copies only visible rows,
clear restores.

**Bump:** UI minor.

---

## M9 — Source-change notification to Teams  (MEDIUM, opt-in)

**Why:** The poller already detects changes; Teams webhooks already exist.
This wires them together for users who want a push instead of the banner.

**Files:** `core/poller.py` (edit `_check_source` carefully — scope-guard
exception granted for THIS file only), `core/settings_store.py` (one new
key), `core/send_format.py` (one new pure function), `app.py` (settings
plumbing if needed), `templates/search_c.html` (one select in the existing
settings/webhook manage modal), `tests/test_poll_notify.py` (new).

**Design:**
- New setting `notify_webhook_id: str` (default `""` = off). Validate: must
  be `""` or an id present in `teams_webhooks` (validate_settings enforces
  when both provided; if the webhook was deleted later, poller treats
  missing id as off — never crash).
- `core/send_format.build_change_card(template_name, when_iso) -> dict`:
  tiny MessageCard: title "WAIRE LookUp — source updated", one fact line,
  no deep link required (template-only link is fine:
  `http://127.0.0.1:2305/?template=<name>` — note in card text it only works
  on the machine running the app).
- In `poller._check_source`, at the exact point where a source is detected
  as UPDATED (where `log_source_update` fires): if `notify_webhook_id` set,
  look up the webhook, `send_teams.post_card(...)` inside its own
  try/except — a Teams failure logs `log_source_error(key, "notify: <msg>")`
  and NEVER affects the poll result. **Debounce:** keep a module-level
  `dict key→last_notified_version`; only notify when the version actually
  changed since the last notification (poller runs every N minutes; a flappy
  mtime must not spam the channel).
- UI: in the Teams "Manage…" modal, a dropdown "Notify this webhook when a
  source updates: [Off / <saved webhooks>]" that POSTs
  `{"notify_webhook_id": ...}` to `/settings`.

**Tests:** fake `send_teams.post_card` (monkeypatch): notify fires on
version change once, not twice for same version; disabled by default;
missing webhook id → no call, no exception; post_card raising → poll status
still recorded as updated.

**Bump:** SERVER minor + UI patch.

---

## M10 — In-app log viewer  (SMALL)

**Why:** The second user can self-serve "what happened" instead of zipping
files for a bug report.

**Files:** `app.py` (one route), `templates/search_c.html` (statusbar link +
modal), `tests/test_log_view.py` (new).

**Design:**
- Route `GET /api/log_tail?lines=200` → last N lines of `config.LOG_FILE`
  (clamp N to 1000; read with `errors="replace"`; missing file → `[]`).
  Return `{"lines": [...]}`. Log content is already secret-free by design
  (webhook URLs, client ids, passwords are never logged) — state this in the
  module summary after re-verifying `logger.py` still holds that property.
- UI: clicking the version text in the footer statusbar opens a modal with
  the log tail in a `<pre>` (monospace, scrollable, newest at the bottom,
  auto-scrolled down), a Refresh button, and a "Copy all" button. Read-only.
- Efficient tail: `deque(f, maxlen=n)` over the file handle is fine at this
  log size; do not build seek-from-end machinery.

**Tests:** route returns last N lines in order; clamps lines param; empty/
missing file → empty list; non-UTF8 byte in the file does not 500.

**Bump:** SERVER patch + UI patch.

---

## M11 — SharePoint "Test connection" button  (SMALL)

**Why:** Deferred twice; turns a colleague's silent SharePoint failure into
a self-explanatory message.

**Files:** `app.py` (one route), `templates/search_c.html` (button in the
existing SharePoint setup modal), `tests/test_auth_test.py` (new).

**Design:**
- Route `POST /api/auth_test`:
  - not configured → `{"ok": false, "stage": "config", "message": "No Client ID set."}`
  - configured, `get_token_silent()` → None →
    `{"ok": false, "stage": "signin", "message": "Not signed in. Click Sign in first."}`
  - token present → call Graph `GET /me` via a new tiny
    `graph_client.whoami(token) -> str` (display name or UPN; typed
    `GraphError` on failure like the rest of graph_client) →
    `{"ok": true, "message": "Connected as <name>."}` or
    `{"ok": false, "stage": "graph", "message": <friendly GraphError msg>}`.
- UI: "Test" button in the setup modal next to Save; result renders in the
  modal's existing ok/error banners. Never blocks Save.

**Tests:** monkeypatch `graph_auth.is_configured/get_token_silent` and
`graph_client.whoami` — four outcomes (unconfigured, unsigned, Graph error,
success) map to the exact JSON shapes above.

**Bump:** SERVER patch + UI patch.

---

## Explicitly NOT in this roadmap (do not build, even if tempting)

- Excel append-to-tracker (removed at Avi's request — stays removed).
- Multi-workbook joins; pagination beyond M6's show-more; file-upload batch
  input; auto-update/auto-download of releases; WAM broker SSO; Windows
  Integrated Auth for SQL (pyodbc migration); log rotation; dark mode;
  authentication on the Flask app.

## Progress tracker  (update this table as part of every module)

| Module | Feature                          | Status | Date | Shipped in (Server/UI) |
|--------|----------------------------------|--------|------|------------------------|
| M1     | DPAPI-encrypt token cache        | done   | 2026-07-14 | 1.17.0 / —      |
| M2     | Vendor Tabler icons              | done   | 2026-07-14 | — / 2.22.0      |
| M3     | Template export / import         | done   | 2026-07-14 | 1.17.0 / 2.22.0 |
| M4     | Update checker (GitHub Releases) | done   | 2026-07-14 | 1.17.0 / 2.22.0 |
| M5     | Batch lookup + not-found report  | done   | 2026-07-14 | 1.17.0 / 2.22.0 |
| M6     | Show-more pagination             | done   | 2026-07-14 | 1.17.0 / 2.22.0 |
| M7     | Cross-template search            | done   | 2026-07-14 | 1.17.0 / 2.22.0 |
| M8     | Quick filter box                 | done   | 2026-07-14 | 1.17.0 / 2.22.0 |
| M9     | Teams source-change notification | done   | 2026-07-14 | 1.17.0 / 2.22.0 |
| M10    | In-app log viewer                | done   | 2026-07-14 | 1.17.0 / 2.22.0 |
| M11    | SharePoint Test connection       | done   | 2026-07-14 | 1.17.0 / 2.22.0 |

When all modules are done (or the user calls it), the next packaged release
is **v1.3.0** — follow `CLAUDE.md` → Packaging (absolute `--add-data` paths,
the three `--collect` flags, kill running exe first, verify msal/pymssql/
win32com in the frozen build).
