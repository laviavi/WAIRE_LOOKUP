"""Sync a SharePoint-backed source into the local cache.

Metadata poll → eTag/lastModified compared → download to `.tmp` → validate
(xlsx zip integrity or CSV parseable) → `os.replace` into cache. A bad or
failed download NEVER clobbers an existing valid cache — the tmp is deleted
and `last_error` is recorded on the source status.
"""

import io
import os
import re
import zipfile
from pathlib import Path

import config
from core import graph_auth, graph_client, logger as log, source_status


def cache_path_for(item_id: str, name: str) -> Path:
    """Cache filename derived from the driveItem id (stable across renames)."""
    safe_id = re.sub(r"[^A-Za-z0-9_.-]", "_", item_id or "unknown")[:64]
    ext = ".xlsx"
    if isinstance(name, str) and name.lower().endswith(".csv"):
        ext = ".csv"
    return config.SOURCE_CACHE_DIR / f"{safe_id}{ext}"


def _validate(tmp_path: Path) -> bool:
    """Return True if the file looks like a real xlsx/csv, else False."""
    try:
        if tmp_path.suffix.lower() == ".csv":
            import pandas as pd
            pd.read_csv(tmp_path, nrows=0)
            return True
        with zipfile.ZipFile(tmp_path) as zf:
            return "xl/workbook.xml" in zf.namelist()
    except Exception:
        return False


def sync_sharepoint_source(source: dict, template_name: str) -> bool:
    """One sync attempt. Returns True if cache was replaced with new content."""
    now = source_status.now_iso()
    if not graph_auth.is_configured():
        source_status.set_status(template_name, type="sharepoint",
                                 last_checked=now, last_error="Not configured")
        return False

    token = graph_auth.get_token_silent()
    if not token:
        source_status.set_status(template_name, type="sharepoint",
                                 last_checked=now, last_error="Not signed in")
        return False

    drive_id = source.get("drive_id")
    item_id = source.get("item_id")
    name = source.get("name") or "file.xlsx"
    if not drive_id or not item_id:
        source_status.set_status(template_name, type="sharepoint",
                                 last_checked=now,
                                 last_error="Template missing drive/item id.")
        return False

    prev = source_status.get_status(template_name)

    try:
        meta = graph_client.get_item_metadata(drive_id, item_id, token)
    except graph_client.GraphError as e:
        source_status.set_status(template_name, type="sharepoint",
                                 last_checked=now, last_error=e.message)
        log.log_source_error(template_name, f"metadata: {e.message}")
        return False

    dest = cache_path_for(item_id, name)
    unchanged = prev.get("etag") == meta.etag and dest.exists()
    if unchanged:
        source_status.set_status(template_name, type="sharepoint",
                                 last_checked=now, last_error=None,
                                 etag=meta.etag, last_modified=meta.last_modified)
        return False

    tmp = dest.with_suffix(dest.suffix + ".tmp")
    # Sweep any stale .tmp from a prior crash
    try: tmp.unlink()
    except FileNotFoundError: pass

    try:
        graph_client.download_item(drive_id, item_id, token, tmp)
    except graph_client.GraphError as e:
        try: tmp.unlink()
        except FileNotFoundError: pass
        source_status.set_status(template_name, type="sharepoint",
                                 last_checked=now, last_error=e.message)
        log.log_source_error(template_name, f"download: {e.message}")
        return False

    if not _validate(tmp):
        try: tmp.unlink()
        except FileNotFoundError: pass
        source_status.set_status(template_name, type="sharepoint",
                                 last_checked=now,
                                 last_error="Downloaded file failed validation; kept previous cache.")
        log.log_source_error(template_name, "invalid download; cache preserved")
        return False

    os.replace(tmp, dest)
    source_status.set_status(template_name, type="sharepoint",
                             last_checked=now, last_updated=now, last_error=None,
                             etag=meta.etag, last_modified=meta.last_modified)
    log.log_source_update(template_name, meta.etag or meta.last_modified or "")
    return True
