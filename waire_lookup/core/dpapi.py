"""Windows DPAPI wrapper for at-rest encryption bound to the current user.

Uses CryptProtectData / CryptUnprotectData via ctypes. No external dependency.
Only runs on Windows. On non-Windows machines, `protect`/`unprotect` fall back
to a no-op passthrough (marked with a fixed sentinel prefix so unprotect can
still tell the difference) — this keeps unit tests portable.

Rationale: matches the app's existing "never store raw secrets in
settings.json" precedent from graph_auth.py, without pulling in a new pip
dependency (no keyring/cryptography).
"""

import ctypes
import ctypes.wintypes as wt
import sys


_FALLBACK_MAGIC = b"WAIRE-PLAIN\0"


class _DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", wt.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _blob(data: bytes) -> _DATA_BLOB:
    b = ctypes.create_string_buffer(data, len(data))
    return _DATA_BLOB(len(data), ctypes.cast(b, ctypes.POINTER(ctypes.c_char)))


def _blob_to_bytes(blob: _DATA_BLOB) -> bytes:
    out = ctypes.string_at(blob.pbData, blob.cbData)
    ctypes.windll.kernel32.LocalFree(blob.pbData)
    return out


def is_available() -> bool:
    return sys.platform == "win32"


def protect(data: bytes, description: str = "") -> bytes:
    """Encrypt with DPAPI bound to the current Windows user.

    On non-Windows, returns the plaintext with a sentinel prefix so
    `unprotect` remains symmetric (test portability).
    """
    if not is_available():
        return _FALLBACK_MAGIC + data
    in_blob = _blob(data)
    out_blob = _DATA_BLOB()
    desc = ctypes.c_wchar_p(description) if description else None
    ok = ctypes.windll.crypt32.CryptProtectData(
        ctypes.byref(in_blob), desc, None, None, None, 0, ctypes.byref(out_blob)
    )
    if not ok:
        raise OSError(f"CryptProtectData failed: {ctypes.windll.kernel32.GetLastError()}")
    return _blob_to_bytes(out_blob)


def unprotect(blob: bytes) -> bytes:
    """Decrypt a blob produced by `protect` (Windows) or its fallback."""
    if blob.startswith(_FALLBACK_MAGIC):
        return blob[len(_FALLBACK_MAGIC):]
    if not is_available():
        raise OSError("DPAPI blob but running on non-Windows platform.")
    in_blob = _blob(blob)
    out_blob = _DATA_BLOB()
    ok = ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(in_blob), None, None, None, None, 0, ctypes.byref(out_blob)
    )
    if not ok:
        raise OSError(f"CryptUnprotectData failed: {ctypes.windll.kernel32.GetLastError()}")
    return _blob_to_bytes(out_blob)
