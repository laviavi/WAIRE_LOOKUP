"""Named SQL Server connection profiles.

Metadata only — the password lives DPAPI-encrypted in sql_credentials.py.
This file's JSON contains just server/port/database/username plus a
`credential_id` pointer to the encrypted store. Reusable across templates.
"""

import json
import os
import secrets
from pathlib import Path

import config
from core import sql_credentials


def _path() -> Path:
    return Path(config.SQL_CONNECTIONS_FILE)


def _load_all() -> dict:
    p = _path()
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_all(store: dict) -> None:
    p = _path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(store, indent=2), encoding="utf-8")
    os.replace(tmp, p)


def list_connections() -> list[dict]:
    """Return public (password-less) view of every saved connection, sorted by name."""
    store = _load_all()
    out = []
    for cid, c in store.items():
        out.append({
            "id": cid,
            "name": c.get("name", ""),
            "server": c.get("server", ""),
            "port": c.get("port", 1433),
            "database": c.get("database", ""),
            "username": c.get("username", ""),
        })
    out.sort(key=lambda x: x["name"].lower())
    return out


def save_connection(*, connection_id: str | None = None, name: str, server: str,
                    port: int, database: str, username: str, password: str) -> str:
    """Create or update a named connection. Returns the connection id."""
    if not (name and server and database and username):
        raise ValueError("Connection needs a name, server, database, and username.")
    port_i = int(port or 1433)

    store = _load_all()
    cid = connection_id or secrets.token_hex(12)
    existing = store.get(cid, {})
    prev_cred = existing.get("credential_id")

    if password:
        # New/changed password → (re)encrypt.
        cred_id = sql_credentials.save_credential(username, password, credential_id=prev_cred)
    elif prev_cred:
        # No password provided but we already have a credential — refresh username in place.
        old = sql_credentials.load_credential(prev_cred)
        old_pw = old[1] if old else ""
        cred_id = sql_credentials.save_credential(username, old_pw, credential_id=prev_cred)
    else:
        raise ValueError("Password is required for a new connection.")

    store[cid] = {
        "name": name,
        "server": server,
        "port": port_i,
        "database": database,
        "username": username,
        "credential_id": cred_id,
    }
    _save_all(store)
    return cid


def load_connection(connection_id: str) -> dict | None:
    """Return the connection metadata (without password) or None."""
    store = _load_all()
    return store.get(connection_id)


def delete_connection(connection_id: str) -> None:
    store = _load_all()
    entry = store.pop(connection_id, None)
    if entry:
        cred_id = entry.get("credential_id")
        if cred_id:
            try:
                sql_credentials.delete_credential(cred_id)
            except Exception:
                pass
        _save_all(store)
