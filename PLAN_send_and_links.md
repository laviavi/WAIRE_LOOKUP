# Implementation Plan — Phase 1 "Send to…" + Phase 2 "Deep links"

Target executor: Sonnet-class model. Follow this plan literally; where the plan
gives code, use it as written. Read `CLAUDE.md` first — all its conventions
(minimal diffs, versioning, work-silently) apply.

**Scope guard:** Do NOT touch: search logic (`core/search.py`,
`core/normalize.py`), view groups, SQL connector, SharePoint sync, snapshot
store. This plan only ADDS a send pipeline and deep-link support.

---

## Architecture overview

One shared concept: a **SendPayload** — the rows the user selected (or all
displayed rows if none selected), plus column headers, template name, and a
deep-link URL. The client builds it once in JS; three server endpoints each
consume the same JSON shape:

```
POST /api/send/outlook   → opens a pre-filled Outlook draft (COM)
POST /api/send/excel     → appends rows to the template's target workbook
POST /api/send/teams     → posts a card to a Teams incoming webhook
```

Payload JSON (client → server), identical for all three:

```json
{
  "template": "costar",
  "columns": ["PropertyID", "Property Address", "City"],
  "rows": [["0012345", "1000 W Rincon St", "Corona"], ...],
  "deep_link": "http://127.0.0.1:2305/?template=costar&key_0=0012345&mode=exact&run=1",
  "target": "optional — teams webhook id or excel override, see per-endpoint"
}
```

Serializers (payload → HTML table / worksheet rows / Teams card JSON) are
**pure functions in `core/send_format.py`** so they are unit-testable without
Outlook/Excel/network.

---

## Part 1 — Backend

### 1.1 New file `waire_lookup/core/send_format.py` (pure, no I/O)

```python
"""Serializers for the Send-to pipeline. Pure functions — no COM, no network."""
import html


def rows_to_html_table(columns: list[str], rows: list[list[str]]) -> str:
    """Compact HTML table for an Outlook mail body. Inline styles only
    (Outlook ignores <style> blocks)."""
    th = "".join(
        f'<th style="border:1px solid #ccc;padding:4px 8px;background:#f0f0f0;'
        f'text-align:left;font-family:Segoe UI,sans-serif;font-size:13px">'
        f"{html.escape(str(c))}</th>" for c in columns)
    trs = []
    for r in rows:
        tds = "".join(
            f'<td style="border:1px solid #ccc;padding:4px 8px;'
            f'font-family:Segoe UI,sans-serif;font-size:13px">'
            f"{html.escape(str(v))}</td>" for v in r)
        trs.append(f"<tr>{tds}</tr>")
    return (f'<table style="border-collapse:collapse">'
            f"<tr>{th}</tr>{''.join(trs)}</table>")


def build_mail_html(template_name: str, columns: list[str],
                    rows: list[list[str]], deep_link: str) -> str:
    body = rows_to_html_table(columns, rows)
    n = len(rows)
    header = (f'<p style="font-family:Segoe UI,sans-serif;font-size:13px">'
              f"{n} result{'s' if n != 1 else ''} from WAIRE LookUp "
              f"template <b>{html.escape(template_name)}</b>:</p>")
    footer = ""
    if deep_link:
        footer = (f'<p style="font-family:Segoe UI,sans-serif;font-size:12px">'
                  f'<a href="{html.escape(deep_link)}">Open this search in '
                  f"WAIRE LookUp</a> (requires the app running locally)</p>")
    return header + body + footer


def build_teams_card(template_name: str, columns: list[str],
                     rows: list[list[str]], deep_link: str) -> dict:
    """Legacy MessageCard JSON — accepted by Teams incoming webhooks and by
    Workflows-based webhooks. Rows rendered as facts (col: value) per row,
    capped at 10 rows to stay under the 28 KB webhook limit."""
    sections = []
    for r in rows[:10]:
        sections.append({
            "facts": [{"name": str(c), "value": str(v)}
                      for c, v in zip(columns, r)]
        })
    if len(rows) > 10:
        sections.append({"text": f"…and {len(rows) - 10} more rows (see app)."})
    card = {
        "@type": "MessageCard",
        "@context": "http://schema.org/extensions",
        "summary": f"WAIRE LookUp — {template_name}",
        "title": f"WAIRE LookUp: {len(rows)} result(s) — {template_name}",
        "sections": sections,
    }
    if deep_link:
        card["potentialAction"] = [{
            "@type": "OpenUri", "name": "Open in WAIRE LookUp",
            "targets": [{"os": "default", "uri": deep_link}],
        }]
    return card
```

### 1.2 New file `waire_lookup/core/send_targets.py`

Per-template Excel target store. **Deliberately NOT in the template JSON** —
target paths are machine-local (each user's tracker lives at a different
path), while templates will later be shared across machines (Phase 3).

- File: `config.SEND_TARGETS_FILE` → `data/send_targets.json`
  (add the constant to `config.py`, mirroring `SETTINGS_FILE` style; also add
  the redirect in `packaging/entry.py` exactly like the SQL files are handled).
- Shape: `{"<template_name>": {"path": "C:\\...\\tracker.xlsx", "sheet": "Log"}}`
- API (mirror `settings_store.py` style — load/save with atomic tmp+`os.replace`):

```python
def get_target(template_name: str) -> dict | None
def set_target(template_name: str, path: str, sheet: str) -> None
def delete_target(template_name: str) -> None
```

Validate on `set_target`: path non-empty, ends with `.xlsx`/`.xlsm`; sheet
may be empty (means "first sheet"). Raise `ValueError` with a plain message.

### 1.3 New file `waire_lookup/core/send_excel.py`

```python
def append_rows(path, sheet, columns, rows) -> dict
```

Behavior (use openpyxl, already a dependency):
1. If the file does not exist → create a new workbook, name the sheet, write
   `columns` as row 1, then the rows. Return `{"ok": True, "appended": n, "created": True}`.
2. If it exists → `openpyxl.load_workbook(path)` (NOT read-only). Pick the
   named sheet (or active if sheet empty; `ValueError` if named sheet missing).
3. Header check: read row 1. If row 1 is empty → write `columns` there.
   If row 1 differs from `columns` → **do not guess a mapping**: append cells
   in the order of the *existing* header where column names match, leave
   non-matching target columns blank, and ignore payload columns the target
   doesn't have. Include `"skipped_columns": [...]` in the response.
4. Append after the last used row (`ws.max_row + 1`, but treat a sheet whose
   `max_row == 1` and row 1 empty as empty).
5. `wb.save(path)`. Catch `PermissionError` → raise
   `ValueError("Target workbook is open in Excel — close it and retry.")`
   (openpyxl cannot save a file Excel has locked; do not try workarounds).
6. Never touch formatting of existing rows; write values only.

### 1.4 New file `waire_lookup/core/send_outlook.py`

Uses Outlook desktop via COM. Add dependency `pywin32==310` to
`requirements.txt`.

```python
def create_draft(subject: str, html_body: str) -> None:
    import pythoncom
    pythoncom.CoInitialize()          # Flask worker thread has no COM apartment
    try:
        import win32com.client
        outlook = win32com.client.Dispatch("Outlook.Application")
        mail = outlook.CreateItem(0)  # olMailItem
        mail.Subject = subject
        mail.HTMLBody = html_body
        mail.Display(False)           # open the draft window, non-modal
    finally:
        pythoncom.CoUninitialize()
```

- Wrap `Dispatch` failure into
  `ValueError("Outlook is not installed or could not be started.")`.
- **Never call `mail.Send()`** — the user reviews and sends manually. This is
  a hard rule; do not add a "send immediately" option.
- Non-Windows guard at the top: `if sys.platform != "win32": raise ValueError(...)`
  (keeps the test suite importable on any OS — import win32com lazily inside
  the function, exactly as shown).

### 1.5 New file `waire_lookup/core/send_teams.py`

```python
def post_card(webhook_url: str, card: dict) -> None
```

- Use `requests` (already installed as an MSAL dependency) with `timeout=10`.
- Success = HTTP 200/202. Anything else → `ValueError` including status code
  and first 200 chars of the response body.
- Validate the URL starts with `https://` before posting.

Webhook storage: extend `core/settings_store.py` with a new settings key
`teams_webhooks` — a list of `{"id": "<uuid4>", "name": "Ops channel",
"url": "https://..."}`. Follow the existing merge-on-save behavior (a POST
that doesn't mention `teams_webhooks` must not erase them). The webhook URL
is functionally a capability token: **never write webhook URLs to the log**
(log the name only) and never render the full URL back into list responses —
return `{"id", "name", "url_tail": url[-8:]}` from the list endpoint.

### 1.6 Routes in `app.py`

All under a new section header comment `# Send-to pipeline`. All return
`{"ok": True, ...}` or `{"ok": False, "error": "<plain message>"}` with
status 400 on `ValueError`, 500 otherwise. Shared helper:

```python
def _parse_send_payload():
    data = request.json or {}
    columns = data.get("columns") or []
    rows = data.get("rows") or []
    if not columns or not rows:
        raise ValueError("Nothing selected to send.")
    return (data.get("template", ""), columns, rows,
            data.get("deep_link", ""), data)
```

- `POST /api/send/outlook` → `build_mail_html` → `create_draft(subject=f"WAIRE LookUp — {template} ({n} results)", ...)`. Log via a new `log.log_send("outlook", template, n)` (add to `core/logger.py`, same style as `log_refresh`).
- `POST /api/send/excel` → target = `send_targets.get_target(template)`; if the payload carries `"target": {"path":..., "sheet":...}` use that instead (used by the "choose file now" flow). No target at all → 400 `"No target workbook set for this template."`. On success also `log.log_send("excel", template, n)`.
- `POST /api/send/teams` → payload carries `"target": "<webhook id>"`; look it up in settings; 400 if missing. Build card, post, log.
- `GET/POST/DELETE /api/send_targets?template=<name>` → thin CRUD over `send_targets` (GET returns the target or `null`; POST body `{path, sheet}`; DELETE removes). POST also accepts `{"browse": true}` to reuse the existing PowerShell file-picker pattern from `api_browse_file` (extract that picker into a small helper so both routes share it — filter `*.xlsx;*.xlsm`).
- `GET/POST/DELETE /api/teams_webhooks` → CRUD over the settings list (POST body `{name, url}`, returns `{id}`; GET returns the tail-masked list).

### 1.7 Deep links (Phase 2, backend half)

Modify `index()` in `app.py` only:

1. Read optional query params `key_0`, `key_1`, … (as many as the selected
   template has key columns), `mode`, and `run`.
2. If any `key_N` present → pass them through as `form_key_values` (list, in
   order) and `form_mode` so the existing template prefill logic renders them
   into the textareas. (Today `index()` passes `form_key_values=[]` — change
   to the parsed list.)
3. Pass a new template var `auto_run = (request.args.get("run") == "1" and any key_N non-empty)`.

That is the whole backend change — the actual search still goes through the
existing `POST /search`, triggered client-side (next section). Do not add a
GET search route.

---

## Part 2 — Frontend (`templates/search_c.html` + `static/option_c.css`)

### 2.1 Ribbon: new **Send** group

Between the existing Export and View groups, add a ribbon group "Send" with
three buttons (Tabler icons in the same style as existing ribbon buttons):

- **Outlook** (`ti-mail`) → `sendTo('outlook')`
- **Excel** (`ti-file-spreadsheet`) → `sendTo('excel')`
- **Teams** (`ti-brand-teams`) → opens a small chooser popup listing saved
  webhooks (fetched from `/api/teams_webhooks`) + a "Manage…" item; clicking a
  webhook calls `sendTo('teams', webhookId)`.

Buttons are disabled (greyed, `disabled` attr) when there is no result on the
page — same condition that governs Export CSV.

### 2.2 JS: payload builder (one function, reused by all three)

```js
function buildSendPayload() {
  // Reuse the SAME row-collection logic Copy TSV uses:
  // selected rows if any are selected, else all rows of the ACTIVE view
  // (respect the current view's column set and the active group).
  // Returns {template, columns, rows, deep_link} or null if nothing to send.
}
```

**Important:** locate the existing Copy TSV implementation in
`search_c.html` and extract its row-collection into a shared helper rather
than duplicating it. Copy TSV then calls the same helper. (Selection state,
active view/group handling and label-mapping already exist there — reuse,
do not reimplement.)

`deep_link` comes from `buildDeepLink()` (see 2.4).

Selection rule (matches Copy TSV): rows selected → send only those; nothing
selected → send ALL visible rows of the active view, but FIRST show a
confirm dialog: `confirm('Nothing selected — send all N rows?')`. Never
silently send-all.

Selection can be made from ANY of the three surfaces — cards, table rows, or
the **Found Items list** — they all write to the same `_selected` set of
cids, so the payload builder must filter by `_selected` (as Copy TSV does),
not by any one view's visual state. Verify Found-Items clicks do populate
`_selected` (they sync visuals today); if they only highlight without adding
to the set, fix that as part of this work.

**Export CSV gets the same rule.** Today `POST /export` always exports the
full server snapshot. Change: when `_selected` is non-empty, build the CSV
client-side from the selected rows (same row-collection helper, CSV-quote
values containing `,` or `"`), download via a Blob + temporary `<a download>`
— no server round-trip, no server change. When nothing is selected, keep the
existing server export (full snapshot, may exceed the 50 displayed rows).
Update the Export CSV button tooltip the same way as the Send buttons.

Discoverability: the Send buttons' tooltip must reflect state, e.g.
`title="Send 3 selected rows to Excel"` vs `title="Send all 27 rows to
Excel"` — update tooltips in `_syncSelectionVisuals()` where the selection
set already changes.

```js
function sendTo(kind, targetId) {
  var p = buildSendPayload();
  if (!p) { showToast('Nothing to send.'); return; }
  if (targetId) p.target = targetId;
  fetch('/api/send/' + kind, {method:'POST',
        headers:{'Content-Type':'application/json'}, body: JSON.stringify(p)})
    .then(r => r.json())
    .then(function(res){
      if (res.ok) { showToast(kindLabel(kind) + ' — sent ' + p.rows.length + ' row(s).'); }
      else if (kind === 'excel' && /No target workbook/.test(res.error || '')) {
        openExcelTargetDialog();   // first-use flow, see 2.3
      } else { showToast('Error: ' + (res.error || 'failed')); }
    })
    .catch(function(){ showToast('Error: server unreachable.'); });
}
```

Reuse the existing `showToast`.

### 2.3 Excel target dialog

A small modal (same pattern as the existing SharePoint settings / SQL
connection dialogs in this file): shows current target for the selected
template (`GET /api/send_targets?template=X`), a "Browse…" button
(`POST {browse:true}` → server file picker), a sheet-name text input, Save /
Remove buttons. After saving from the first-use flow, automatically retry the
send. Also reachable from the Send group via a small caret/settings affordance
next to the Excel button (`title="Set target workbook"`).

### 2.4 Deep links (Phase 2, frontend half)

```js
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
```

- Add a **Copy link** button (`ti-link`) in the Export ribbon group →
  `navigator.clipboard.writeText(buildDeepLink())` + toast "Link copied".
  Disabled when no template selected.
- Auto-run on load: at the end of the existing DOMContentLoaded init block:

```js
{% if auto_run %}
(function(){ var f = document.getElementById('search-form'); if (f) f.submit(); })();
{% endif %}
```

  **Escaping rule (this file has burned us before): any Jinja expression
  inside the `<script>` block must go through `| tojson` — never emit raw
  quotes.** `auto_run` here is used only in a `{% if %}`, which is safe. If
  you need its value in JS, write `var AUTO_RUN = {{ auto_run | tojson }};`.
- One-shot guard: the form submit is a POST, so refresh/back won't loop; no
  extra guard needed. But strip `run=1` from the address bar after triggering:
  `history.replaceState(null, '', location.pathname + '?template=' + ...)` —
  do this just before `f.submit()`.

### 2.5 CSS

Minimal additions to `option_c.css`: styles for the Teams chooser popup and
the Excel target modal — copy the existing modal/dialog classes' look. No
layout changes to results, ribbon grid, or the footer bars.

---

## Part 3 — Tests (`waire_lookup/tests/`)

New file `test_send_format.py` (pure functions — the bulk of coverage):
- `rows_to_html_table`: escapes `<`, `&`, `"` in values; column count matches;
  empty rows list yields header-only table.
- `build_mail_html`: contains the deep link when given, omits the footer `<a>`
  when `deep_link=""`; row count in header text correct for 1 vs many.
- `build_teams_card`: ≤10 rows → no overflow section; 12 rows → overflow
  section with "2 more"; `potentialAction` present only with a deep link;
  facts pair columns with values.

New file `test_send_targets.py`: CRUD round-trip against a tmp file
(monkeypatch `config.SEND_TARGETS_FILE`), validation errors (empty path,
`.docx` path), delete of a missing template is a no-op.

New file `test_send_excel.py` (openpyxl against `tmp_path`, no Excel needed):
- append to a non-existent file creates workbook with header + rows;
- append to an existing file with matching header adds rows after the last;
- header mismatch: reordered target header receives values in the target's
  order, extra payload columns reported in `skipped_columns`;
- named sheet missing → `ValueError`.

New file `test_send_routes.py` (Flask test client, monkeypatch the I/O layer):
- `/api/send/outlook` with an empty payload → 400 "Nothing selected";
- `/api/send/outlook` happy path with `create_draft` monkeypatched → 200 and
  the patched function received HTML containing a row value;
- `/api/send/teams` with an unknown webhook id → 400;
- `/api/send/excel` with no stored target → 400 with the exact
  "No target workbook" message (the client relies on this string — if you
  change it, change the JS regex in `sendTo` too);
- deep link prefill: `GET /?template=X&key_0=abc&mode=partial` (with a tmp
  template as in `test_app_snapshot.py` fixtures) → response HTML contains
  `abc` inside a textarea and `partial` selected; response contains the
  auto-run submit snippet only when `run=1`.

Do NOT write tests that require Outlook, Teams, or the network.

---

## Part 4 — Housekeeping (required)

1. `version.py`: bump **SERVER_VERSION minor** (new routes/modules) and
   **UI_VERSION minor** (ribbon group, dialogs, deep links). One combined
   `CHANGELOG.md` entry describing Send-to + deep links.
2. `requirements.txt`: add `pywin32==310`.
3. `packaging/entry.py`: add the `SEND_TARGETS_FILE` redirect next to the SQL
   file redirects. Add a comment in the PyInstaller section of `CLAUDE.md`
   noting pywin32 needs `--collect-submodules win32com` on the next build
   (do not run a build as part of this plan).
4. `CLAUDE.md`: add the new modules to the navigation map (one line each),
   note the Send ribbon group and deep-link query params
   (`?template=&key_N=&mode=&run=1`) under conventions.
5. Run the full suite: `python -m pytest tests/ -q` from `waire_lookup\` —
   all pre-existing tests must still pass.

## Part 5 — Manual verification (browser, at the end, one pass)

1. Start the app (it self-kills any stale port owner). Select a template, run
   a search.
2. Copy link → open the copied URL in a new tab → inputs prefilled and the
   search auto-runs.
3. Send → Excel with no target → dialog appears; set a scratch .xlsx target;
   send again → rows appear in the workbook (verify by reopening it with
   openpyxl or Excel). Then send once more with the workbook OPEN in Excel →
   toast shows the "close it and retry" error, no corruption.
4. Send → Outlook → a draft window opens with the table and the deep link.
   (If Outlook isn't installed on the dev machine, verify the endpoint returns
   the friendly error instead and note it in the summary.)
5. Teams: without a real webhook, verify the chooser lists a saved dummy
   webhook (add via the manage dialog) and that sending to it surfaces the
   server's error toast cleanly. Real-channel verification is Avi's step.
6. One final screenshot after everything.

## Known risks to state in the final summary (don't solve them)

- pywin32 inside the frozen PyInstaller build is untested until the next
  release build.
- Teams "Incoming Webhook" connectors are being migrated to Workflows by
  Microsoft; the MessageCard shape posted here works with both today, but the
  webhook URL the user creates may come from the Workflows app.
- Outlook COM requires classic desktop Outlook; "new Outlook" (Monarch) has
  no COM surface. CONFIRMED: Avi's environment runs classic Outlook and
  intends to stay on it — COM is the sanctioned route, no Graph fallback
  needed.
