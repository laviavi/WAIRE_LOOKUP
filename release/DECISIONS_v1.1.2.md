# Release v1.1.2 — Build Decisions Log

Date: 2026-07-11
Bundled app internals: Server 1.10.0 / UI 2.14.0
Scope: Zero-setup SharePoint via Microsoft's public shared Client ID

---

## D1. Default Client ID = Microsoft Graph Command Line Tools
**Client ID chosen:** `14d82eec-204b-4c2f-b7e8-296a70dab67e`

**Why:** This is Microsoft's own published Client ID meant to be reused
by scripts and tools. It's the same identity used by:
- Microsoft Graph PowerShell SDK
- Community Python/JavaScript examples in Microsoft's documentation
- Various dev-console tools

Pre-consented for many Graph scopes in most tenants. Bypasses the
Azure portal registration entirely — the recipient just installs the
tool and clicks Sign in.

**Alternatives considered:**
- Azure CLI's Client ID (`04b07795-8ddb-461a-bbee-02f9e1bf7b46`): also
  works but has a broader scope catalog than we need.
- Microsoft Office Client ID: not appropriate for a document reader.
- Custom app registration only: the v1.1.1 status quo — deferred to
  fallback role.

## D2. Consent-dialog wording trade-off accepted
**What the user sees on first sign-in:** "Microsoft Graph Command Line
Tools wants access to your Microsoft 365 data on your behalf."

**Trade-off:** the app's own name doesn't appear in the consent dialog.
Acceptable for a small internal tool distributed to a few colleagues.
Documented in `README.txt` under a section explaining WHY the dialog
says that.

**Not acceptable for:** a commercially branded product shipped to
customers. If that becomes the goal, revert to custom Client ID via
`AZURE_SETUP.md` (still fully supported through the Setup SharePoint
modal).

## D3. Kept the custom-Client-ID modal as fallback
**Why:** three real scenarios need the custom path:
1. A tenant with Conditional Access policy that blocks the shared ID.
2. A user who wants their org's branded consent dialog.
3. Someone whose admin refuses to consent to the shared ID's app
   registration for their tenant.

**How:** unchanged from v1.1.1 — Setup SharePoint modal + gear icon
still work; they just aren't required for the common case.

## D4. Ships with pre-populated settings.json
**What:** `data/settings.json` in the release folder contains the
well-known Client ID as the value of `graph_client_id`.

**Why:** the app's DEFAULTS constant now has this same value, so
strictly speaking, the shipped file is redundant. But an empty
`settings.json` would look "unconfigured" to a curious user peeking
inside; the pre-populated file makes the intent clear.

## D5. AZURE_SETUP.md kept intact, role redefined
**Why:** the doc was correct for v1.1.1 and remains correct for anyone
falling back to a custom registration. It's now labeled internally as
a fallback path rather than the primary onboarding path.

**Left for a future revision:** possibly rename to
`ADVANCED_AZURE_SETUP.md` or add a preamble that says "you probably
don't need this." Deferred as low-value polish.

## D6. Not included (still deferred)
- **WAM broker for silent SSO on Azure AD-joined machines.** Would
  require `allow_broker=True` in MSAL and shipping the broker helper
  binary. Windows-only; requires more test coverage than we can do
  without an Azure AD-joined test machine. Left for a follow-up
  release.
- **DPAPI encryption of token_cache.json** — same as prior releases.

## D7. Verification (v1.1.2 on this machine, packaged .exe)
- Launches, serves 200 on port 2305.
- Footer shows `Release v1.1.2 · Server v1.10.0 · UI v2.14.0`.
- `auth_status` returns `configured:true` on first launch (default
  Client ID is in effect).
- Setup modal DOM present with reworded hint text ("Most users don't
  need to change anything here").
- Well-known Client ID (`14d82eec-…`) present in the rendered page.
- Reset defaults link renders.
- 96/96 unit tests passing (updated 3 tests to assert new default).

**Not verified without a real Microsoft 365 sign-in:**
- Whether the tester's tenant has pre-approved the "Graph Command Line
  Tools" Client ID (common) vs blocks it (rare Conditional Access).
- The actual consent dialog appearance.
- Whether silent WAM SSO would work on the tester's PC (not
  implemented yet either way).
- Real 401/403/404 rendering paths against a live SharePoint file.

## D8. Fallback behavior if the shared Client ID is blocked
1. Sign in fails with a "consent" or "app blocked" AADSTS error.
2. Error text appears in the ribbon Account status.
3. User clicks the gear icon or Setup SharePoint button.
4. Follows AZURE_SETUP.md to register their own app.
5. Pastes the resulting Client ID into the modal → Save.
6. Signs in again.

Every step is discoverable from within the app; no back-and-forth with
the developer needed.
