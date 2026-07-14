# Azure Setup — WAIRE LookUp Tool (SharePoint access)

**When you need this:** only if a template points at a **SharePoint URL**.
Local Excel/CSV files (including OneDrive-synced ones) work with no
registration and no sign-in — you can skip this entire document.

## What this does

Adds read-only access to SharePoint files via Microsoft Graph, using
delegated sign-in. Each colleague signs in as themselves; Graph enforces
their own file permissions. **Zero write scopes** — the app cannot edit,
upload, or delete SharePoint content.

## One-time registration (about 10 minutes)

1. Go to <https://portal.azure.com/> → **Microsoft Entra ID** → **App
   registrations** → **New registration**.
2. Name: **`WAIRE LookUp Tool`**.
3. Supported account types: **Accounts in this organizational directory only**
   (single tenant) if you're deploying only inside one organization; or
   **Accounts in any organizational directory** (multi-tenant) if colleagues
   sign in from multiple tenants. Either works.
4. Redirect URI: platform = **Public client / native (mobile & desktop)**,
   URI = `http://localhost`. (MSAL picks a random port under `localhost`.)
5. Click **Register**.

## Configure the registration

1. Under **Authentication**:
   - Confirm the redirect URI is `http://localhost`.
   - **Advanced settings → Allow public client flows** = **Yes**.
   - Save.
2. Under **API permissions → Add a permission → Microsoft Graph →
   Delegated permissions**, add:
   - **`Files.Read.All`**
   - **`Sites.Read.All`**

   Some tenants show "admin consent required" for these. If your admin
   won't grant it, try the smaller `Files.Read` (works when the file has
   been shared into your OneDrive / "Shared with me"; team-site files
   generally still need `Sites.Read.All` and admin consent).
3. Copy the **Application (client) ID** from the **Overview** page.

## Put the Client ID into the app

1. Open the app.
2. Open `data/settings.json` next to `WAIRELookUp.exe`. If it's missing,
   create it:
   ```json
   {
     "card_max": 1,
     "poll_minutes": 5,
     "graph_client_id": "11111111-2222-3333-4444-555555555555",
     "graph_tenant": "organizations"
   }
   ```
   Paste your Client ID as the value of `graph_client_id`.
3. For a single-tenant registration, set `graph_tenant` to your **Tenant
   ID** (visible on the app's Overview page). For a multi-tenant
   registration, leave it as `"organizations"`.
4. Save and restart the app (ribbon → Server → Restart).

## First sign-in

1. In the app ribbon, click **Account → Sign in**.
2. A browser window opens. Sign in with your Microsoft 365 account and
   approve the two read-only scopes.
3. The ribbon should show **"Signed in: your.name@…"**.

You can now create a template of type **SharePoint URL** — paste any
SharePoint sharing link or direct file URL, click **Connect & load**, and
the rest of the builder flow (sheets → tables → columns → save) is
identical to a local file.

## Colleague hand-off

The Client ID is safe to ship inside the packaged build's
`data/settings.json`. Public-client registrations have no secret; the
Client ID by itself grants no access. Each colleague signs in as
themselves and Graph enforces their existing file permissions.

## Troubleshooting

- **AADSTS65001 "The user or administrator has not consented"** — your
  admin must grant consent for the delegated scopes (or you must use a
  more restricted scope set as described above).
- **AADSTS50011 "The reply URL specified in the request does not match"** —
  the registration is missing `http://localhost` as a *public client*
  redirect URI, or "Allow public client flows" is set to No.
- **Sign-in window never closes / times out** — a corporate proxy may be
  blocking the localhost callback. Try from a network without the proxy,
  or ask IT to allow `http://localhost` for MSAL.
- **"Not signed in" after restart** — the token cache lives in
  `data/token_cache.json`. If you delete or clear that folder, you must
  sign in again.

## Security note

`data/token_cache.json` stores a refresh token in plain text. This is
acceptable for a single-user local tool where the OS user account is the
trust boundary. If you need at-rest encryption, consider adding
`msal-extensions` (DPAPI on Windows); happy to layer that in on request.
