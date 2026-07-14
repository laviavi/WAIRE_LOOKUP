"""Microsoft Graph auth via MSAL.

Public-client, read-only, delegated. The Client ID lives in settings.json so
colleagues can configure their build without editing files. Token cache is
persisted to `config.TOKEN_CACHE_FILE` (atomic writes).

Interactive sign-in blocks (MSAL runs its own localhost listener + system
browser), so `begin_interactive_signin` runs it in a background thread and
`/api/auth_status` reports progress.
"""

import os
import threading
from datetime import datetime

import config
from core.settings_store import load_settings

# Delegated read-only scopes. `openid profile offline_access` are added by
# MSAL automatically — do NOT list them here.
SCOPES = ["Files.Read.All", "Sites.Read.All"]

_state_lock = threading.Lock()
_state = {"running": False, "last_error": None, "last_signed_in": None}


def _client_id() -> str:
    # Env override for dev convenience; settings.json is the source of truth.
    return os.environ.get("WAIRE_GRAPH_CLIENT_ID") or load_settings().get("graph_client_id", "")


def _tenant() -> str:
    return load_settings().get("graph_tenant", "organizations") or "organizations"


def is_configured() -> bool:
    return bool(_client_id())


def _load_cache():
    from msal import SerializableTokenCache
    from core import dpapi
    cache = SerializableTokenCache()
    try:
        if config.TOKEN_CACHE_FILE.exists():
            raw = config.TOKEN_CACHE_FILE.read_bytes()
            if raw.startswith(b"{"):
                text = raw.decode("utf-8")
            else:
                text = dpapi.unprotect(raw).decode("utf-8")
            cache.deserialize(text)
    except Exception:
        pass
    return cache


def _save_cache(cache) -> None:
    if not cache.has_state_changed:
        return
    from core import dpapi
    config.TOKEN_CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = config.TOKEN_CACHE_FILE.with_name(config.TOKEN_CACHE_FILE.name + ".tmp")
    blob = dpapi.protect(cache.serialize().encode("utf-8"), description="WAIRE token cache")
    tmp.write_bytes(blob)
    os.replace(tmp, config.TOKEN_CACHE_FILE)


def _build_app(cache):
    from msal import PublicClientApplication
    authority = f"https://login.microsoftonline.com/{_tenant()}"
    return PublicClientApplication(_client_id(), authority=authority, token_cache=cache)


def _account_name(app) -> str | None:
    accs = app.get_accounts()
    return (accs[0].get("username") if accs else None)


def get_token_silent() -> str | None:
    """Return an access token from the cache, or None if the user must sign in."""
    if not is_configured():
        return None
    cache = _load_cache()
    app = _build_app(cache)
    accs = app.get_accounts()
    if not accs:
        return None
    r = app.acquire_token_silent(SCOPES, account=accs[0])
    _save_cache(cache)
    if r and "access_token" in r:
        return r["access_token"]
    return None


def begin_interactive_signin() -> None:
    """Kick off MSAL's interactive flow in a background thread."""
    if not is_configured():
        with _state_lock:
            _state["last_error"] = "Not configured. Enter your Azure Client ID in Settings."
        return

    def _run():
        with _state_lock:
            _state["running"] = True
            _state["last_error"] = None
        try:
            cache = _load_cache()
            app = _build_app(cache)
            result = app.acquire_token_interactive(SCOPES, timeout=180)
            _save_cache(cache)
            if "access_token" in result:
                with _state_lock:
                    _state["last_signed_in"] = datetime.now().isoformat(timespec="seconds")
            else:
                with _state_lock:
                    _state["last_error"] = result.get("error_description") or result.get("error") or "Sign-in failed."
        except Exception as e:
            with _state_lock:
                _state["last_error"] = str(e)
        finally:
            with _state_lock:
                _state["running"] = False

    threading.Thread(target=_run, name="msal-signin", daemon=True).start()


def sign_out() -> None:
    if not is_configured():
        return
    cache = _load_cache()
    app = _build_app(cache)
    for acc in app.get_accounts():
        app.remove_account(acc)
    _save_cache(cache)


def auth_state() -> dict:
    with _state_lock:
        st = dict(_state)
    if not is_configured():
        return {"configured": False, "signed_in": False, "username": None,
                "running": False, "last_error": st.get("last_error")}
    try:
        cache = _load_cache()
        app = _build_app(cache)
        name = _account_name(app)
    except Exception:
        name = None
    return {"configured": True, "signed_in": name is not None, "username": name,
            "running": st.get("running", False), "last_error": st.get("last_error")}
