"""Per-source status records, persisted to source_status.json.

One entry per template name: {type, etag, last_modified, last_checked,
last_updated, last_error}. Written atomically (tmp + os.replace) so an
abrupt restart never leaves a torn file. Lazy `config.X` access for
frozen-build path redirection.
"""

import json
import os
from datetime import datetime

import config


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _load() -> dict:
    try:
        data = json.loads(config.SOURCE_STATUS_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _write(data: dict) -> None:
    config.SOURCE_STATUS_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = config.SOURCE_STATUS_FILE.with_name(config.SOURCE_STATUS_FILE.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    os.replace(tmp, config.SOURCE_STATUS_FILE)


def get_status(key: str) -> dict:
    return _load().get(key, {})


def set_status(key: str, **fields) -> dict:
    data = _load()
    entry = data.get(key, {})
    entry.update(fields)
    data[key] = entry
    _write(data)
    return entry


def all_statuses() -> dict:
    return _load()
