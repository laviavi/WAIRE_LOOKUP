"""Server-side snapshots of full search results.

The full (uncapped) result set of the last search used to live in the Flask
session cookie, which explodes response headers on large results
(ERR_RESPONSE_HEADERS_TOO_BIG). Instead, each successful search writes one
snapshot file here and the session keeps only the opaque 32-hex id — the id
is unguessable and only ever lives inside the signed session cookie, which
gives per-session isolation without extra bookkeeping.

Uses lazy `config.X` attribute access so the frozen build's entry.py path
redirection applies (same convention as settings_store).
"""

import io
import json
import os
import re
import time
import uuid
from datetime import datetime
from pathlib import Path

import pandas as pd

import config

_ID_RE = re.compile(r"^[0-9a-f]{32}$")


def _valid_id(sid) -> bool:
    return isinstance(sid, str) and bool(_ID_RE.fullmatch(sid))


def _path(sid: str) -> Path:
    return config.SNAPSHOTS_DIR / f"{sid}.json"


def save_snapshot(df: pd.DataFrame, template_name: str, result_columns: list[str],
                  not_found: list[str] | None = None) -> str:
    """Atomically persist a full result set; returns the snapshot id."""
    sid = uuid.uuid4().hex
    config.SNAPSHOTS_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "created": datetime.now().isoformat(timespec="seconds"),
        "template_name": template_name,
        "result_columns": list(result_columns),
        "not_found": list(not_found or []),
        "rows": json.loads(df.to_json(orient="split")),
    }
    dest = _path(sid)
    tmp = Path(str(dest) + ".tmp")
    tmp.write_text(json.dumps(payload), encoding="utf-8")
    os.replace(tmp, dest)
    return sid


def load_snapshot(sid) -> dict | None:
    """Return {df, template_name, result_columns, created} or None."""
    if not _valid_id(sid):
        return None
    try:
        payload = json.loads(_path(sid).read_text(encoding="utf-8"))
        df = pd.read_json(io.StringIO(json.dumps(payload["rows"])), orient="split")
        return {
            "df": df,
            "template_name": payload.get("template_name") or "export",
            "result_columns": payload.get("result_columns", []),
            "created": payload.get("created"),
            "not_found": payload.get("not_found", []),
        }
    except (OSError, ValueError, KeyError):
        return None


def delete_snapshot(sid) -> None:
    if not _valid_id(sid):
        return
    try:
        _path(sid).unlink(missing_ok=True)
    except OSError:
        pass


def cleanup_snapshots(ttl_hours: float) -> int:
    """Delete snapshot (and orphaned .tmp) files older than ttl_hours."""
    removed = 0
    cutoff = time.time() - ttl_hours * 3600
    try:
        entries = list(config.SNAPSHOTS_DIR.iterdir())
    except OSError:
        return 0
    for p in entries:
        if p.suffix not in (".json", ".tmp"):
            continue
        try:
            if p.stat().st_mtime < cutoff:
                p.unlink()
                removed += 1
        except OSError:
            continue
    return removed
