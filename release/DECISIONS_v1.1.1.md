# Release v1.1.1 — Build Decisions Log

Date: 2026-07-11 (same day as v1.1.0)
Bundled app internals: Server 1.9.0 / UI 2.13.0
Scope: UX polish for the SharePoint first-run experience

Small patch release addressing four deferred items from v1.1.0 that
directly affect the target-machine test session.

---

## D1. In-app SharePoint setup modal
**Why:** The v1.1.0 setup workflow required opening `data/settings.json`
in Notepad, finding the right key, pasting a GUID without breaking JSON
syntax, saving, and hoping the app noticed. Any syntax slip meant silent
fallback to defaults with no visible feedback. That's the #1 friction
point on first use.

**What:** New modal opened from either "Setup SharePoint" (visible when
unconfigured) or a small gear icon (always visible) in the ribbon
Account group. Fields for Client ID + Tenant. Save via `fetch` to
`POST /settings`. Inline validation error (e.g. "not a valid GUID"),
inline "Settings saved." success confirmation, auto-close after 900 ms.

**Alternative rejected:** editing settings.json remains supported for
power users, but hiding it as the default first-run path.

---

## D2. Release version in the footer
**Why:** When the tester screenshots a bug on the other machine, the
footer previously showed only Server/UI versions. Adding the Release
number uniquely identifies which distributable build they're on — vital
when there are multiple releases in circulation.

**What:** New `RELEASE_VERSION = "1.1.1"` constant in `version.py`.
Injected into every template via `inject_versions`. Footer now reads
`Release v1.1.1 · Server v1.9.0 · UI v2.13.0`.

---

## D3. Inline error/success feedback for settings
**Why:** Previously `POST /settings` swallowed all validation errors
with `pass` (or redirected with a query string no UI read). The setup
modal needs live feedback to be usable.

**What:** `POST /settings` now returns JSON:
- On success: `{"ok": true, "settings": {…}}` (200)
- On validation error: `{"ok": false, "error": "…"}` (400)

The existing `card_max` / `poll_minutes` fetches ignored the response
body, so no behavior change there. The setup modal parses the JSON and
shows the error banner or the success banner accordingly.

---

## D4. Hide Sign-in button when unconfigured
**Why:** In v1.1.0 the Sign-in button was always visible but did
nothing until a Client ID was configured, and the label read
"SharePoint not configured." That's confusing — the UI showed an action
the user couldn't take. Better: hide the button entirely, and show
"Setup SharePoint" instead as the actionable next step.

**What:** `renderAuthStatus` in `search_c.html` now hides both signin
and signout buttons when `configured:false`, and shows `setup-btn`
instead. When configured, the setup button hides and the normal
signin/signout logic runs.

---

## D5. `save_settings` merge semantics for string fields
**What:** Discovered during D1 testing: `save_settings` filtered out
both `None` and `""` before merging, meaning an empty Client ID was
treated as "no change" — you could never clear a mistakenly-typed GUID.

**Fix:** Split behavior:
- Numeric fields (`card_max`, `poll_minutes`): blank = no-op (preserves
  the per-control fetch pattern that only sends one field at a time).
- String fields (`graph_client_id`, `graph_tenant`): blank IS
  meaningful (empty Client ID = SharePoint disabled).

New test `test_save_clears_graph_client_id` guards the fix.

---

## D6. Not included in this release
Explicitly left for a future iteration:
- **DPAPI encryption of `data/token_cache.json`** (msal-extensions).
  Nice-to-have; adds a Windows-only dep; not blocking the test.
- **"Test connection" button in the modal** (calls Graph with a live
  token to verify permissions). Would require the user to sign in
  first, then click Test. Deferred until we see whether the base flow
  succeeds.
- **Persisting inline errors across a page navigation** — currently
  errors only appear while the modal is open. Fine, since the modal is
  the only path to setting them.

---

## Verification (v1.1.1 on this machine, packaged .exe)
- Launches, serves 200 on port 2305.
- Footer shows `Release v1.1.1 · Server v1.9.0 · UI v2.13.0`.
- Setup modal DOM present; Setup button present; Client ID field
  present.
- Empty Client ID → `configured:false`, "Setup SharePoint" visible,
  Sign-in hidden.
- POST /settings with valid GUID → 200 `{"ok":true, …}`; auth_status
  flips `configured:true`.
- POST /settings with `graph_client_id=` (empty) → 200; auth_status
  flips back to `configured:false`.
- POST /settings with `graph_client_id=not-a-guid` → 400
  `{"ok":false,"error":"Client ID must be a valid GUID …"}`.
- 96/96 unit tests passing.

**Not verified without Azure registration** (same as v1.1.0):
interactive sign-in UX, real /shares resolution, real 401/403/404
mapping, eTag change detection, corporate-proxy MSAL localhost flow.
