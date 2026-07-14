"""Frozen entry point for the packaged WAIRE LookUp Tool.

This wraps the unchanged source app so a PyInstaller build works portably:
- writable data (templates, exports, logs) lives next to the .exe, not inside
  the read-only bundle;
- Flask's template/static folders are pointed at the bundled copies;
- the Restart button relaunches the .exe instead of `python -c` (which does not
  exist in a frozen build).

The original source under waire_lookup/ is imported as-is and never modified.
"""

import os
import sys
import threading
import webbrowser
from pathlib import Path

PORT = 2305


def _is_frozen() -> bool:
    return getattr(sys, "frozen", False)


def _base_dir() -> Path:
    """Folder that holds the .exe (frozen) or this script (dev)."""
    if _is_frozen():
        return Path(sys.executable).parent
    return Path(__file__).resolve().parent


def _bundle_dir() -> Path:
    """Folder that holds bundled templates/static."""
    if _is_frozen():
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parent.parent / "waire_lookup"


# Make the source package importable when running from source (dev).
if not _is_frozen():
    sys.path.insert(0, str(_bundle_dir()))

# ── Writable data next to the exe (portable + persistent across runs) ──
base = _base_dir()
data_dir = base / "data"
templates_data = data_dir / "lookup_templates"
exports_dir = data_dir / "exports"
logs_dir = data_dir / "logs"
snapshots_dir = data_dir / "snapshots"
source_cache_dir = data_dir / "source_cache"
for _d in (templates_data, exports_dir, logs_dir, snapshots_dir, source_cache_dir):
    _d.mkdir(parents=True, exist_ok=True)

# ── Point config at the writable dirs BEFORE importing the app ──
# (config is imported with `from config import X` elsewhere, so these must be
#  set before app/core/connectors get imported.)
import config  # noqa: E402

config.LOOKUP_TEMPLATES_DIR = templates_data
config.EXPORTS_DIR = exports_dir
config.LOGS_DIR = logs_dir
config.LOG_FILE = logs_dir / "lookups.log"
config.SETTINGS_FILE = data_dir / "settings.json"
config.SNAPSHOTS_DIR = snapshots_dir
config.SOURCE_CACHE_DIR = source_cache_dir
config.SOURCE_STATUS_FILE = data_dir / "source_status.json"
config.TOKEN_CACHE_FILE = data_dir / "token_cache.json"
config.SQL_CONNECTIONS_FILE = data_dir / "sql_connections.json"
config.SQL_CREDENTIALS_FILE = data_dir / "sql_credentials.dat"

import app as app_module  # noqa: E402

flask_app = app_module.app

# ── Fix template/static resolution for the frozen bundle ──
if _is_frozen():
    bundle = _bundle_dir()
    flask_app.root_path = str(bundle)
    flask_app.template_folder = str(bundle / "templates")
    flask_app.static_folder = str(bundle / "static")


# ── Frozen-safe restart: relaunch the exe (no python interpreter available) ──
_RESTART_SPLASH = (
    "<!doctype html><meta charset='utf-8'><title>Restarting…</title>"
    "<body style='font-family:system-ui,sans-serif;text-align:center;padding-top:18vh'>"
    "<h3>Restarting server…</h3>"
    "<script>setTimeout(function p(){fetch('/').then(function(r){"
    "if(r.ok){location.href='/';}else{setTimeout(p,400);}})"
    ".catch(function(){setTimeout(p,400);});},1200);</script></body>"
)


def _frozen_restart():
    def _relaunch():
        import subprocess
        import time
        time.sleep(0.5)
        subprocess.Popen([sys.executable], cwd=str(base), close_fds=True)
        os._exit(0)

    threading.Thread(target=_relaunch, daemon=False).start()
    return _RESTART_SPLASH


if _is_frozen():
    flask_app.view_functions["do_restart"] = _frozen_restart


def _open_browser():
    webbrowser.open(f"http://127.0.0.1:{PORT}")


if __name__ == "__main__":
    threading.Timer(1.5, _open_browser).start()
    print(f"WAIRE LookUp Tool — starting on http://127.0.0.1:{PORT}")
    print("Keep this window open while using the app. Close it to stop the server.")
    try:
        app_module.ensure_single_instance(PORT)
        app_module.start_background()
        flask_app.run(host="127.0.0.1", port=PORT, debug=False)
    except OSError as e:
        print(f"\nCould not start on port {PORT}: {e}")
        print("The app may already be running in another window.")
        print("Close the other window (or whatever is using port 2305) and try again.")
        import time
        time.sleep(10)
