# WAIRE Lookup Tool — v1 Build Specification

Target: local Flask application replacing Excel-based lookups against a SharePoint workbook synced locally via OneDrive.
Model guidance: this spec is written for **Claude Sonnet 4.6 in Claude Code**. Implement strictly **one phase at a time, in order**. Do not start a phase until the previous phase's acceptance criteria pass. Do not refactor code outside the current phase's scope. Do not add features not listed here. If a requirement is ambiguous, ask before implementing.

---

## 1. Project layout (create exactly this)

```
waire_lookup/
  app.py                  # Flask app, routes only — no business logic
  config.py               # paths, constants
  core/
    __init__.py
    normalize.py          # key normalization functions
    search.py             # search engine (pure functions, no I/O)
    templates_store.py    # template load/save/validate
    logger.py             # lookup logging
  connectors/
    __init__.py
    base.py               # abstract DataSource interface
    synced_file.py        # OneDrive-synced xlsx connector
  templates/              # Flask HTML templates (Jinja2)
    base.html
    search.html
    template_builder.html
  static/
    style.css
  lookup_templates/       # saved JSON lookup templates (Git-syncable)
  exports/                # ALL exports land here, nowhere else
  logs/
    lookups.log
  tests/
    test_normalize.py
    test_search.py
    test_templates_store.py
  requirements.txt
  run.bat                 # start server on 127.0.0.1:5000 and open browser
```

`requirements.txt`: flask, pandas, openpyxl, pytest. Pin major versions. No other dependencies in v1.

---

## 2. Phase plan (implement in this order)

### Phase 1 — Data access layer
Files: `connectors/base.py`, `connectors/synced_file.py`, `config.py`.

`base.py` defines:

```python
class DataSource(ABC):
    @abstractmethod
    def load(self) -> pd.DataFrame: ...
    @abstractmethod
    def columns(self) -> list[str]: ...
    @abstractmethod
    def source_timestamp(self) -> datetime: ...   # file mtime or equivalent
    @abstractmethod
    def is_stale(self) -> bool:                   # source changed since load
```

`synced_file.py` implements it for a local xlsx path:
- Constructor takes `path`, optional `sheet_name`, optional `table_name`, optional `header_row` (default 0).
- If `table_name` is given, read the named Excel Table via openpyxl and construct the DataFrame from it. If not, read `sheet_name` with `header_row`. If neither is given, read the first sheet.
- Read all columns as `dtype=str` (`dtype=str` in `pd.read_excel`) to preserve leading zeros. Replace NaN with empty string after load.
- Cache the DataFrame and the file mtime at load time. `is_stale()` compares current mtime to cached mtime and returns a boolean; it must be cheap (stat call only, no file parse).
- Loading is in-memory only. Never write any cache of the workbook to disk.

Acceptance: unit-testable load of a sample xlsx; `is_stale()` flips to True after the file is touched; leading zeros preserved.

### Phase 2 — Normalization and search engine
Files: `core/normalize.py`, `core/search.py`, tests.

`normalize.py`:
- `normalize_key(value: str) -> str`: strip whitespace, casefold, collapse internal runs of whitespace to single spaces, strip a trailing `.0` if the string matches `^\d+\.0$` (Excel float artifact).
- Applied identically to search input values and to key-column cell values.

`search.py` — pure functions, DataFrame in, DataFrame out:
- `search(df, key_columns: list[str], values: list[str], mode: Literal["exact","partial"]) -> SearchResult`
- Multi-value: `values` is a list (UI splits textarea on newlines, drops blanks, dedupes while preserving order).
- Exact mode: a row matches if any key column's normalized value equals any normalized input value.
- Partial mode: substring containment on normalized values.
- Duplicates: return ALL matching rows. Add a boolean column `_duplicate` set True on every row whose matched key value matched more than one row.
- Add a column `_matched_on` naming the key column and input value that matched (first match wins for the label only; the row still counts once).
- `SearchResult` dataclass: `rows: pd.DataFrame`, `total_matches: int`, `not_found: list[str]` (input values that matched zero rows), `truncated: bool`.
- Display cap: the caller passes `limit=50`; `rows` holds at most 50 rows, `truncated=True` when `total_matches > 50`. The full untruncated frame must remain retrievable for export (return it as `full_rows`).

Acceptance: pytest suite covering exact vs partial, multi-value, duplicate flagging, not-found reporting, cap/truncation, and normalization edge cases (leading zeros, trailing spaces, mixed case, `104512.0`).

### Phase 3 — Template store
Files: `core/templates_store.py`, tests.

Template JSON schema (one file per template in `lookup_templates/`, filename = slugified template name):

```json
{
  "schema_version": 1,
  "name": "Facility PIN lookup",
  "source": {
    "path": "C:/Users/.../OneDrive - South Coast AQMD/WAIRE_Tracker.xlsx",
    "sheet_name": "Facilities",
    "table_name": null,
    "header_row": 0
  },
  "key_columns": ["FacilityID", "Facility Address"],
  "result_columns": ["FacilityID", "PIN", "Compliance Status"],
  "labels": {"FacilityID": "Facility ID"},
  "default_filter": {"column": "Phase", "equals": "1"},
  "default_match_mode": "exact"
}
```

- `save_template(t)`, `load_template(name)`, `list_templates()`, `delete_template(name)`.
- `validate_template(t, available_columns) -> list[str]`: returns human-readable problems, e.g. `Key column 'WON' not found in source (columns may have been renamed)`. Called every time a template is selected; problems render as a warning banner, never as a stack trace.
- `default_filter` is optional; when present, applied (normalized equality) before searching.
- Reject saving a template with zero key columns or zero result columns.

Acceptance: round-trip save/load; validation catches a renamed column; malformed JSON in the folder is skipped with a logged warning, not a crash.

### Phase 4 — Flask app and search screen
Files: `app.py`, `templates/base.html`, `templates/search.html`, `static/style.css`.

Routes:
- `GET /` — search screen: template dropdown, match mode select (default from template), multi-line textarea for values, Search button, Refresh data button, freshness controls (Section 3), results area.
- `POST /search` — runs the search, renders results table showing only `result_columns` with friendly labels, `_duplicate` rows visually marked, footer line: `N matches · M values not found: <list> · data as of <timestamp>`. When truncated: warning `Showing first 50 of N matches — export to get all rows.`
- `POST /refresh` — reloads the data source, returns to search screen with new timestamp.
- `POST /export` — writes the FULL (untruncated) result set as CSV (UTF-8 BOM, for Excel) into `exports/`, filename `<template>_<YYYYMMDD_HHMMSS>.csv`, and offers it as a download. Never write exports anywhere else.
- Copy-to-clipboard button implemented client-side (copies the rendered table as TSV).

Behavior:
- App state holds one loaded DataSource per source path (simple dict keyed by path). Data loads lazily on first search against that source.
- Server binds to `127.0.0.1` only.
- Plain, readable styling. No CSS frameworks. No JavaScript frameworks. Vanilla JS only, and only for clipboard copy and the freshness toggle description.

Acceptance: end-to-end search against a real workbook path works from the browser; export file opens cleanly in Excel; not-found values display.

### Phase 5 — Freshness option (user decision — implement exactly as specified)
Default behavior: data is loaded once and cached; the user refreshes manually with the Refresh button. The header always shows `data as of <timestamp>`.

Optional per-session toggle on the search screen, labeled:

> **Auto-check source for changes before each search** (off by default)

Help text next to the toggle, verbatim:

> When enabled, the app checks whether the source file changed before every search and reloads it if so. This can make searches noticeably slower on large workbooks. Leave this off unless you specifically need up-to-the-minute data.

Implementation: when the toggle is on, `POST /search` first calls `is_stale()`; if True, calls `load()` before searching. When off, no stat check occurs. The toggle state lives in the Flask session, resets to off on restart, and is never stored in templates.

Acceptance: with toggle off, editing the source file does not change results until Refresh is clicked; with toggle on, the next search picks up the edit.

### Phase 6 — Template builder screen
Files: `templates/template_builder.html`, routes in `app.py`.

- `GET /templates/new` and `GET /templates/<name>/edit`.
- User enters/edits: name, source path, sheet or table name, header row.
- A "Load columns" action instantiates the connector, reads headers only, and renders two checkbox lists (key columns, result columns), a labels editor (simple `column → label` text inputs), optional default filter (one column + one value in v1), and default match mode.
- Save writes the JSON per the Phase 3 schema. Validation problems block save with a clear message.

Acceptance: create a template entirely from the browser, then use it on the search screen without editing JSON by hand.

### Phase 7 — Logging
File: `core/logger.py`.

Append one line per search to `logs/lookups.log`:

```
2026-07-09T14:12:03 | template=Facility PIN lookup | mode=exact | values=3 | matches=5 | not_found=104333 | duration_ms=41
```

- Log the not-found VALUES (they drive template refinement) and counts only. Never log result rows or result column contents.
- Also log template save/edit events and data refreshes (`event=refresh | source=<path>`).
- Plain text append, no logging frameworks, rotate manually (out of scope for v1).

Acceptance: log lines appear for search, refresh, and template save; no result data ever appears in the log.

---

## 3. Explicit non-goals for v1 (do not build these)
- Microsoft Graph / MSAL connector (v2.5 — the `DataSource` interface exists so it can be added without UI changes).
- SQL connector.
- Multi-workbook joins.
- Pagination (the 50-row cap plus export covers v1).
- Authentication on the Flask app itself (localhost only).
- Persistent disk caching of workbook data.
- Log rotation.

## 4. Working rules for the coding session
1. Implement one phase per request. After each phase, run the tests and show me the results before moving on.
2. When I report a bug, fix only that bug with a targeted edit; do not rewrite files.
3. Never use `CONCAT`-style shortcuts contrary to conventions already in this spec; follow the schema and function signatures exactly as written.
4. All new code needs a test in `tests/` where a pure function is involved (normalize, search, templates_store).
5. If a design question arises that this spec does not answer, stop and ask rather than choosing silently.
