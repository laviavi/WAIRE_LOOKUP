"""Background source poller.

Every `poll_minutes` (live setting, re-read each cycle) it checks each
template's source, records status, and tidies expired snapshots.
`poll_once()` is thread-free and unit-testable. `start_poller()` is
idempotent and starts a daemon thread — safe with the app's os._exit
restart because every store it touches writes atomically.

Phase 1 covers local sources (mtime). Phase 2 adds the SharePoint branch.
"""

import threading
import time
from pathlib import Path

import config
from core import logger as log
from core import snapshot_store, source_status
from core.settings_store import load_settings
from core.templates_store import list_templates

_started = False
_stop = threading.Event()
_last_tick = 0.0
_notified_versions: dict[str, str] = {}


def poll_once() -> None:
    """One full pass over all template sources + snapshot cleanup."""
    for t in list_templates():
        key = t.get("name", "")
        src = t.get("source", {})
        try:
            _check_source(key, src)
        except Exception as e:
            source_status.set_status(
                key, last_checked=source_status.now_iso(), last_error=str(e)
            )
            log.log_source_error(key, str(e))
    snapshot_store.cleanup_snapshots(config.SNAPSHOT_TTL_HOURS)


def _check_source(key: str, src: dict) -> None:
    stype = src.get("type") or "local"
    if stype == "sharepoint":
        try:
            from core import source_sync
            source_sync.sync_sharepoint_source(src, key)
        except Exception as e:
            source_status.set_status(
                key, type="sharepoint",
                last_checked=source_status.now_iso(), last_error=str(e)
            )
            log.log_source_error(key, str(e))
        return
    now = source_status.now_iso()
    path = Path(src.get("path") or "")
    if not src.get("path") or not path.exists():
        source_status.set_status(
            key, type="local", last_checked=now, last_error="File not found"
        )
        return
    mtime = path.stat().st_mtime
    prev = source_status.get_status(key)
    fields = {"type": "local", "last_checked": now, "last_error": None, "last_modified": mtime}
    if prev.get("last_modified") != mtime:
        fields["last_updated"] = now
        if prev:  # first-ever observation is not an "update"
            log.log_source_update(key, str(mtime))
            _try_notify(key, str(mtime), now)
    source_status.set_status(key, **fields)


def _try_notify(key: str, version: str, when_iso: str) -> None:
    if _notified_versions.get(key) == version:
        return
    settings = load_settings()
    wh_id = settings.get("notify_webhook_id", "")
    if not wh_id:
        return
    hook = next((h for h in settings.get("teams_webhooks", []) if h.get("id") == wh_id), None)
    if not hook:
        return
    try:
        from core import send_format, send_teams
        card = send_format.build_change_card(key, when_iso)
        send_teams.post_card(hook["url"], card)
        _notified_versions[key] = version
    except Exception as e:
        log.log_source_error(key, f"notify: {e}")


def _due() -> bool:
    global _last_tick
    minutes = load_settings().get("poll_minutes", 5)
    if time.monotonic() - _last_tick >= minutes * 60:
        _last_tick = time.monotonic()
        return True
    return False


def _run() -> None:
    while not _stop.wait(1.0):
        if _due():
            try:
                poll_once()
            except Exception as e:
                log.log_source_error("poller", str(e))


def start_poller() -> None:
    """Idempotent; first poll fires within ~1s of start, then every poll_minutes."""
    global _started, _last_tick
    if _started:
        return
    _started = True
    _last_tick = -10 ** 9  # force an immediate first tick
    threading.Thread(target=_run, name="source-poller", daemon=True).start()
