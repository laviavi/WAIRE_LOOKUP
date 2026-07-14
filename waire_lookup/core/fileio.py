"""Shared, lock-tolerant file reading and format detection.

Reading a source file into memory (rather than letting pandas/openpyxl open the
path directly, several times over) lets us read files that are currently open in
Excel or being synced/shared via OneDrive. Python's open() on Windows requests
FILE_SHARE_READ|WRITE|DELETE, so a file another process holds open for reading
can still be read here. If the holder denies read sharing, we fall back to a
temp-file copy; only a true exclusive lock will still fail.
"""

import os
import shutil
import tempfile
from pathlib import Path

EXCEL_EXTS = (".xlsx", ".xlsm", ".xls")
CSV_EXTS = (".csv",)


def is_csv(path) -> bool:
    return str(path).lower().endswith(CSV_EXTS)


def read_shared_bytes(path) -> bytes:
    """Return the file's bytes, tolerating the file being open elsewhere."""
    try:
        with open(path, "rb") as f:
            return f.read()
    except PermissionError:
        # Fallback: copy to a temp file (also a shared read) and read the copy.
        fd, tmp = tempfile.mkstemp(suffix=Path(path).suffix)
        os.close(fd)
        try:
            shutil.copy2(path, tmp)
            with open(tmp, "rb") as f:
                return f.read()
        finally:
            try:
                os.remove(tmp)
            except OSError:
                pass


def friendly_read_error(e: Exception) -> str:
    """Turn a low-level read failure into a message a user can act on."""
    if isinstance(e, PermissionError):
        return (
            "The file is open and locked by another program (or another user on a "
            "shared file). Close it and try again, or point the template at a copy "
            "of the file."
        )
    if isinstance(e, FileNotFoundError):
        return "File not found. Check the path — if it's on OneDrive, make sure it's synced locally."
    # Graph-side errors: import guarded so this stays usable without msal/requests.
    try:
        from core.graph_client import GraphError
        if isinstance(e, GraphError):
            if e.kind == "auth":
                return "Not signed in to Microsoft. Sign in (Account → Sign in) and try again."
            if e.kind == "forbidden":
                return "You don't have permission to open this file in SharePoint. Ask the owner to share it with you."
            if e.kind == "not_found":
                return "File not found in SharePoint. Check the link — it may have moved, been renamed, or you may not have access."
            if e.kind == "transient":
                return "SharePoint is busy or unavailable — try again in a minute."
            if e.kind == "network":
                return "Couldn't reach Microsoft 365. Check your internet connection."
            return e.message
    except ImportError:
        pass
    return str(e)
