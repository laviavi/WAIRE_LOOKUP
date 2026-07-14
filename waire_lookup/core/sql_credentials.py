"""DPAPI-encrypted store for SQL Server credentials (username + password).

Format on disk: a single DPAPI blob containing UTF-8 JSON of the form
    {"<credential_id>": {"username": "...", "password": "..."}, ...}
Atomic writes (tmp + os.replace). The plaintext password NEVER hits
settings.json — this store is deliberately separate.
"""

import json
import os
import secrets
from pathlib import Path

import config
from core import dpapi


def _path() -> Path:
    return Path(config.SQL_CREDENTIALS_FILE)


def _load_all() -> dict:
    p = _path()
    if not p.exists():
        return {}
    try:
        blob = p.read_bytes()
        if not blob:
            return {}
        raw = dpapi.unprotect(blob)
        return json.loads(raw.decode("utf-8"))
    except Exception:
        # Unreadable / different Windows account / corrupted → treat as empty
        # (safer than crashing the app; user re-enters password).
        return {}


def _save_all(store: dict) -> None:
    p = _path()
    p.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(store).encode("utf-8")
    blob = dpapi.protect(raw, description="WAIRE LookUp SQL credentials")
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_bytes(blob)
    os.replace(tmp, p)


def save_credential(username: str, password: str, credential_id: str | None = None) -> str:
    """Store username+password and return its opaque credential_id."""
    cid = credential_id or secrets.token_hex(16)
    store = _load_all()
    store[cid] = {"username": username, "password": password}
    _save_all(store)
    return cid


def load_credential(credential_id: str) -> tuple[str, str] | None:
    """Return (username, password) or None if not found/unreadable."""
    store = _load_all()
    entry = store.get(credential_id)
    if not entry:
        return None
    return entry.get("username", ""), entry.get("password", "")


def delete_credential(credential_id: str) -> None:
    store = _load_all()
    if credential_id in store:
        store.pop(credential_id, None)
        _save_all(store)
