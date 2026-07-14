"""Thin, read-only wrapper over Microsoft Graph endpoints.

- Resolves sharing links and direct SharePoint URLs to a driveItem.
- Reads driveItem metadata (eTag + lastModifiedDateTime) for change detection.
- Streams file content to a local path.

No write endpoints are called anywhere. Errors are normalised into a small
`GraphError(kind, message)` taxonomy that the UI translates into actionable
messages via friendly_read_error.
"""

import base64
from dataclasses import dataclass
from pathlib import Path


API_BASE = "https://graph.microsoft.com/v1.0"


class GraphError(Exception):
    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind
        self.message = message


@dataclass
class DriveItemRef:
    drive_id: str
    item_id: str
    name: str
    etag: str | None
    last_modified: str | None


def encode_share_url(url: str) -> str:
    """Encode a URL for Graph's /shares/{share_id} endpoint.

    share_id = "u!" + base64url(url) with padding stripped, per Microsoft docs.
    """
    if not isinstance(url, str) or not url.strip():
        raise GraphError("not_found", "Empty SharePoint URL.")
    b64 = base64.urlsafe_b64encode(url.encode("utf-8")).decode("ascii").rstrip("=")
    return "u!" + b64


def _map_response(r) -> None:
    """Translate an HTTP response's status code into a typed error."""
    if r.status_code == 401:
        raise GraphError("auth", "Not signed in to Microsoft.")
    if r.status_code == 403:
        raise GraphError("forbidden", "You don't have permission to open this file in SharePoint.")
    if r.status_code == 404:
        raise GraphError("not_found", "File not found in SharePoint.")
    if r.status_code == 429 or 500 <= r.status_code < 600:
        raise GraphError("transient", "SharePoint is busy or unavailable — try again in a minute.")
    if not 200 <= r.status_code < 300:
        raise GraphError("transient", f"SharePoint returned {r.status_code}.")


def _get(url: str, token: str, session=None, **kwargs):
    import requests
    s = session or requests
    try:
        r = s.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=30, **kwargs)
    except Exception as e:
        raise GraphError("network", f"Couldn't reach Microsoft 365: {e}")
    return r


def resolve_share_url(url: str, token: str, session=None) -> DriveItemRef:
    """Given a sharing link or direct URL, return the DriveItemRef."""
    share_id = encode_share_url(url)
    api = f"{API_BASE}/shares/{share_id}/driveItem?$select=id,name,eTag,lastModifiedDateTime,parentReference,size"
    r = _get(api, token, session=session)
    _map_response(r)
    try:
        j = r.json()
    except Exception:
        raise GraphError("transient", "Malformed response from SharePoint.")
    parent = j.get("parentReference") or {}
    drive_id = parent.get("driveId")
    item_id = j.get("id")
    if not drive_id or not item_id:
        raise GraphError("not_found", "Could not resolve that link to a SharePoint file.")
    return DriveItemRef(
        drive_id=drive_id, item_id=item_id,
        name=j.get("name") or "file",
        etag=j.get("eTag"),
        last_modified=j.get("lastModifiedDateTime"),
    )


def get_item_metadata(drive_id: str, item_id: str, token: str, session=None) -> DriveItemRef:
    api = f"{API_BASE}/drives/{drive_id}/items/{item_id}?$select=id,name,eTag,lastModifiedDateTime,size"
    r = _get(api, token, session=session)
    _map_response(r)
    j = r.json()
    return DriveItemRef(
        drive_id=drive_id, item_id=item_id,
        name=j.get("name") or "file",
        etag=j.get("eTag"),
        last_modified=j.get("lastModifiedDateTime"),
    )


def whoami(token: str, session=None) -> str:
    """Return the signed-in user's display name or UPN."""
    r = _get(f"{API_BASE}/me?$select=displayName,userPrincipalName", token, session=session)
    _map_response(r)
    j = r.json()
    return j.get("displayName") or j.get("userPrincipalName") or "Unknown user"


def download_item(drive_id: str, item_id: str, token: str, dest_path: Path, session=None) -> None:
    """Stream the file's bytes to dest_path (overwrites)."""
    api = f"{API_BASE}/drives/{drive_id}/items/{item_id}/content"
    r = _get(api, token, session=session, stream=True, allow_redirects=True)
    _map_response(r)
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    with open(dest_path, "wb") as f:
        for chunk in r.iter_content(chunk_size=64 * 1024):
            if chunk:
                f.write(chunk)
