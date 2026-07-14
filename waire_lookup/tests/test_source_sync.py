import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

import io
import zipfile

import pytest

import config
from core import graph_client, source_sync, source_status


VALID_XLSX_BYTES = None


def _make_valid_xlsx_bytes():
    """Minimal but zipfile-valid file with the sentinel xl/workbook.xml entry."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("xl/workbook.xml", "<x/>")
    return buf.getvalue()


class FakeGraphClient:
    """Test double for the graph_client module: patched in via monkeypatch."""

    def __init__(self, etag="e1", body=None, error=None):
        self.etag = etag
        self.body = body if body is not None else _make_valid_xlsx_bytes()
        self.error = error
        self.download_calls = 0

    def get_item_metadata(self, drive_id, item_id, token, session=None):
        if self.error == "metadata":
            raise graph_client.GraphError("transient", "boom")
        return graph_client.DriveItemRef(
            drive_id=drive_id, item_id=item_id, name="f.xlsx",
            etag=self.etag, last_modified="2026-07-10T09:00:00Z",
        )

    def download_item(self, drive_id, item_id, token, dest_path, session=None):
        self.download_calls += 1
        if self.error == "download":
            raise graph_client.GraphError("transient", "boom")
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        dest_path.write_bytes(self.body)


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "SOURCE_STATUS_FILE", tmp_path / "source_status.json")
    monkeypatch.setattr(config, "SOURCE_CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(config, "LOG_FILE", tmp_path / "log.txt")
    (tmp_path / "cache").mkdir()

    # Fake auth: always configured and token available
    from core import graph_auth
    monkeypatch.setattr(graph_auth, "is_configured", lambda: True)
    monkeypatch.setattr(graph_auth, "get_token_silent", lambda: "TOKEN")

    return tmp_path


def _install_fake(monkeypatch, fake):
    monkeypatch.setattr(graph_client, "get_item_metadata", fake.get_item_metadata)
    monkeypatch.setattr(graph_client, "download_item", fake.download_item)


def _src(): return {"drive_id": "drv", "item_id": "itm", "name": "f.xlsx"}


def test_unchanged_etag_no_download(env, monkeypatch):
    fake = FakeGraphClient(etag="e1")
    _install_fake(monkeypatch, fake)
    # First sync writes cache
    changed = source_sync.sync_sharepoint_source(_src(), "t1")
    assert changed is True
    assert fake.download_calls == 1
    # Second sync sees same etag → no download
    changed = source_sync.sync_sharepoint_source(_src(), "t1")
    assert changed is False
    assert fake.download_calls == 1


def test_changed_etag_swaps_cache(env, monkeypatch):
    fake = FakeGraphClient(etag="e1")
    _install_fake(monkeypatch, fake)
    source_sync.sync_sharepoint_source(_src(), "t1")
    # New etag & new body
    fake.etag = "e2"
    fake.body = _make_valid_xlsx_bytes()  # still valid
    changed = source_sync.sync_sharepoint_source(_src(), "t1")
    assert changed is True
    assert source_status.get_status("t1")["etag"] == "e2"


def test_invalid_download_keeps_previous_cache(env, monkeypatch):
    fake = FakeGraphClient(etag="e1")
    _install_fake(monkeypatch, fake)
    # Establish good cache
    source_sync.sync_sharepoint_source(_src(), "t1")
    cache = source_sync.cache_path_for("itm", "f.xlsx")
    good_bytes = cache.read_bytes()
    # Now serve garbage with a new etag
    fake.etag = "e2"
    fake.body = b"not a zip file"
    changed = source_sync.sync_sharepoint_source(_src(), "t1")
    assert changed is False
    assert cache.read_bytes() == good_bytes  # PRESERVED
    assert "validation" in (source_status.get_status("t1")["last_error"] or "").lower()


def test_transient_download_error_keeps_cache(env, monkeypatch):
    fake = FakeGraphClient(etag="e1")
    _install_fake(monkeypatch, fake)
    source_sync.sync_sharepoint_source(_src(), "t1")
    cache = source_sync.cache_path_for("itm", "f.xlsx")
    good = cache.read_bytes()
    fake.etag = "e2"
    fake.error = "download"
    changed = source_sync.sync_sharepoint_source(_src(), "t1")
    assert changed is False
    assert cache.read_bytes() == good
    assert source_status.get_status("t1")["last_error"]


def test_not_signed_in(env, monkeypatch):
    from core import graph_auth
    monkeypatch.setattr(graph_auth, "get_token_silent", lambda: None)
    changed = source_sync.sync_sharepoint_source(_src(), "t1")
    assert changed is False
    assert source_status.get_status("t1")["last_error"] == "Not signed in"
