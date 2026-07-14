# Release v1.1.0 — Build Decisions Log

Date: 2026-07-11
Bundled app internals: Server 1.8.0 / UI 2.12.0
Scope: SharePoint (Graph) connector + snapshot fix + source polling

Records decisions made during the build so they can be reviewed later.
Each item lists **what**, **why**, and **the alternative** it was chosen over.

---

## D1. New pip dependencies bundled
**What:** Added `msal==1.31.1` and `requests==2.32.3` (with its transitive deps
`urllib3`, `certifi`, `idna`, `charset-normalizer`) to the frozen exe.

**Why:** Both are pure-Python and auto-detected by PyInstaller from the
`import` graph. Total package size increase ~10 MB. `msal` is Microsoft's
official Python SDK for Azure AD auth; `requests` is used only by
`graph_client.py` for HTTPS calls.

**Alternative rejected:** hand-rolled OAuth + `urllib` — would double the
graph-auth code size for no functional gain and no ability to reuse
existing MSAL Azure AD app registration guidance.

---

## D2. Bundle CA certificates via `certifi`
**What:** `requests` uses `certifi`'s CA bundle by default; PyInstaller
detects and bundles it automatically. Verified with an HTTPS smoke call
from the frozen exe.

**Why:** Corporate Windows machines sometimes have a bare certificate
store; using the `certifi` bundle guarantees Graph HTTPS calls succeed
without depending on Windows' cert store.

**Alternative rejected:** disable SSL verification — unacceptable for a
security-adjacent tool.

---

## D3. First-launch validation policy
**What:** Verified the packaged .exe launches with `msal` and `requests`
importable, serves on port 2305, and responds 200 to `/`,
`/api/source_status`, and `/api/auth_status`.

**Why:** Prevents shipping a broken build. This is the same automated
verification the plan requires.

---

## D4. Ships with NO Client ID
**What:** `data/settings.json` is not pre-populated with any Azure Client
ID; the recipient must complete the Azure registration and paste their
own GUID.

**Why:**
1. The Azure app registration is per-tenant policy (some IT departments
   require it be created inside their tenant).
2. The dev machine doesn't have SharePoint credentials to register with,
   so there is no dev-side Client ID to embed.
3. `AZURE_SETUP.md` walks through this step in about 10 minutes.

**Alternative rejected:** ship a placeholder GUID — would look configured
but fail with a confusing "AADSTS700016 application not found" error.

---

## D5. Ships with NO templates and NO source cache
**What:** `data/lookup_templates/` and `data/source_cache/` are created
empty by `entry.py` on first launch.

**Why:** No local templates on this machine make sense on the target
machine (SharePoint URLs will be built there). Matches v1.0.0 policy.

---

## D6. Console error visibility on first launch
**What:** `Run WAIRE LookUp.bat` uses `start ""` which spawns the exe in
a new console window that stays open. If the exe fails immediately,
running `WAIRELookUp.exe` from an already-open Command Prompt keeps
errors visible.

**Why:** SmartScreen or antivirus flagging is the #1 cause of "nothing
happens on double-click." README.txt covers this troubleshooting.

**Alternative rejected:** run windowless — hides all diagnostic output.

---

## D7. Live diagnostics written to disk (no Claude needed on target)
**What:** All runtime state is a plain file next to the exe:
- `data/logs/lookups.log` — timestamped events (search, refresh, source
  update, source error, settings change).
- `data/source_status.json` — last-check time + error per template.
- `data/snapshots/*.json` — last search's full result set (auto-cleaned
  after 24 h).
- `data/token_cache.json` — MSAL token cache (contains refresh token).

**Why:** The other machine has no Claude access. Everything needed to
diagnose a bug is present in files.

**Send-back procedure** (documented in `README.txt`):
1. Zip `data/logs/`, `data/source_status.json`, `data/settings.json`.
2. Redact tenant ID from `settings.json` if sensitive; Client ID is
   safe to share (public-client, no secret).
3. Screenshot the black console window before closing it if the app
   crashes.

---

## D8. Release folder naming and history
**What:** `release/WAIRELookUp_v1.1.0/`. Older `WAIRELookUp_v1.0.0/`
retained. New entry in `release/RELEASES.md`.

**Why:** Convention from CLAUDE.md packaging section.

---

## D9. Version bump: MINOR
**What:** Release v1.0.0 → v1.1.0 (not v2.0.0).

**Why:** New feature (SharePoint) added; backward compatible — existing
templates and local-file flows still work unchanged. No breaking
changes to schema (schema_version 1 templates still load).

---

## D10. NOT DONE this round (deferred to a future iteration)
- **DPAPI encryption of `data/token_cache.json`** (`msal-extensions` hook)
  — nice-to-have; adds a Windows-only dep. Deferred.
- **Inline settings error banner in UI** — validation errors in `POST
  /settings` currently return via a query string that no UI reads.
  Cosmetic; user simply won't see rejected values persist.
- **"Test connection" button next to Client ID field** — no in-app UI
  yet edits Client ID (still `data/settings.json` only). Deferred.
- **Hide Sign-in button when unconfigured** — currently shows "SharePoint
  not configured" with the button visible-but-a-no-op. Chose visible so
  the recipient sees Account UI exists even before Client ID is entered.

---

## D11. Reasonable-decision protocol used
The user was out during build. Any issue that would block launch on the
target machine was resolved with the most conservative option (smallest
behavioural change, most predictable failure mode, clearest error
message). No user data or configuration was modified on the source
tree; only `release/` was written to.
