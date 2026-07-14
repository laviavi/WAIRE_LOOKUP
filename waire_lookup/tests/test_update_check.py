"""M4: Update checker tests."""

import json
import time
import types

import pytest

from core import update_check


class FakeResponse:
    def __init__(self, status_code=200, data=None):
        self.status_code = status_code
        self._data = data or {}
    def json(self):
        return self._data


def test_fetch_happy(monkeypatch):
    def fake_get(url, **kw):
        return FakeResponse(200, {"tag_name": "v1.3.0", "html_url": "https://x"})
    import requests
    monkeypatch.setattr(requests, "get", fake_get)
    result = update_check.fetch_latest_release("owner/repo")
    assert result == {"tag": "v1.3.0", "url": "https://x"}


def test_fetch_non200(monkeypatch):
    import requests
    monkeypatch.setattr(requests, "get", lambda *a, **kw: FakeResponse(404))
    assert update_check.fetch_latest_release("owner/repo") is None


def test_fetch_network_error(monkeypatch):
    import requests
    monkeypatch.setattr(requests, "get", lambda *a, **kw: (_ for _ in ()).throw(OSError("no net")))
    assert update_check.fetch_latest_release("owner/repo") is None


def test_is_newer():
    assert update_check.is_newer("v1.3.0", "1.2.0") is True
    assert update_check.is_newer("v1.2.0", "1.2.0") is False
    assert update_check.is_newer("1.1.0", "1.2.0") is False
    assert update_check.is_newer("garbage", "1.2.0") is False


def test_cache_prevents_refetch(monkeypatch):
    calls = []
    def fake_fetch(repo, timeout=5.0):
        calls.append(1)
        return {"tag": "v2.0.0", "url": "https://x"}
    monkeypatch.setattr(update_check, "fetch_latest_release", fake_fetch)
    update_check._cache = (0.0, None)  # reset
    update_check.check_update("owner/repo", "1.0.0")
    update_check.check_update("owner/repo", "1.0.0")
    assert len(calls) == 1


def test_route_shape(monkeypatch, tmp_path):
    import config
    monkeypatch.setattr(config, "LOOKUP_TEMPLATES_DIR", tmp_path / "tpl")
    (tmp_path / "tpl").mkdir()
    monkeypatch.setattr(config, "SETTINGS_FILE", tmp_path / "settings.json")
    monkeypatch.setattr(config, "SNAPSHOTS_DIR", tmp_path / "snap")
    monkeypatch.setattr(config, "SOURCE_STATUS_FILE", tmp_path / "ss.json")
    monkeypatch.setattr(config, "LOGS_DIR", tmp_path / "logs")
    monkeypatch.setattr(config, "LOG_FILE", tmp_path / "logs" / "lookups.log")
    update_check._cache = (0.0, None)
    monkeypatch.setattr(update_check, "fetch_latest_release",
                        lambda *a, **kw: {"tag": "v9.0.0", "url": "https://y"})
    from app import app
    app.config["TESTING"] = True
    c = app.test_client()
    r = c.get("/api/update_check")
    j = json.loads(r.data)
    assert j["update_available"] is True
    assert j["latest"] == "v9.0.0"
