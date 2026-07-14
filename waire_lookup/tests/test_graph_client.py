import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from core import graph_client
from core.graph_client import GraphError


class FakeResponse:
    def __init__(self, status_code=200, json_data=None):
        self.status_code = status_code
        self._json = json_data or {}

    def json(self):
        return self._json


class FakeSession:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def get(self, url, headers=None, timeout=None, **kwargs):
        self.calls.append({"url": url, "headers": headers, **kwargs})
        return self.response


def test_encode_share_url_exact_format():
    # Known-good encoding: "u!" + base64url(url).rstrip("=")
    got = graph_client.encode_share_url("https://example.com/a b?c=1")
    assert got.startswith("u!")
    assert "=" not in got  # padding stripped
    # Reversible via urlsafe_b64decode (with padding restored)
    import base64
    payload = got[2:]
    payload += "=" * (-len(payload) % 4)
    assert base64.urlsafe_b64decode(payload).decode("utf-8") == "https://example.com/a b?c=1"


def test_encode_empty_url_raises():
    with pytest.raises(GraphError) as exc:
        graph_client.encode_share_url("")
    assert exc.value.kind == "not_found"


def test_resolve_share_url_returns_ref():
    fake = FakeSession(FakeResponse(200, {
        "id": "01ABC",
        "name": "book.xlsx",
        "eTag": '"{ABC}",1',
        "lastModifiedDateTime": "2026-07-10T09:15:02Z",
        "parentReference": {"driveId": "b!drive"},
    }))
    ref = graph_client.resolve_share_url("https://x/y.xlsx", "TOKEN", session=fake)
    assert ref.drive_id == "b!drive"
    assert ref.item_id == "01ABC"
    assert ref.etag == '"{ABC}",1'
    assert fake.calls[0]["headers"]["Authorization"] == "Bearer TOKEN"


@pytest.mark.parametrize("status,kind", [
    (401, "auth"), (403, "forbidden"), (404, "not_found"),
    (429, "transient"), (500, "transient"), (503, "transient"),
])
def test_error_kinds(status, kind):
    fake = FakeSession(FakeResponse(status, {}))
    with pytest.raises(GraphError) as exc:
        graph_client.resolve_share_url("https://x/y.xlsx", "TOKEN", session=fake)
    assert exc.value.kind == kind


def test_resolve_missing_ids_treated_as_not_found():
    fake = FakeSession(FakeResponse(200, {"id": "", "parentReference": {}}))
    with pytest.raises(GraphError) as exc:
        graph_client.resolve_share_url("https://x/y.xlsx", "T", session=fake)
    assert exc.value.kind == "not_found"


def test_download_writes_file(tmp_path):
    class StreamResponse(FakeResponse):
        def iter_content(self, chunk_size):
            return iter([b"hello ", b"world"])

    fake = FakeSession(StreamResponse(200, {}))
    dest = tmp_path / "out.xlsx"
    graph_client.download_item("drv", "itm", "TOK", dest, session=fake)
    assert dest.read_bytes() == b"hello world"
