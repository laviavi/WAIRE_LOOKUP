"""M6: Show-more pagination tests."""

import json
import pandas as pd
import pytest

import config
from core import snapshot_store


@pytest.fixture()
def client(tmp_path, monkeypatch):
    d = tmp_path / "snapshots"
    d.mkdir()
    monkeypatch.setattr(config, "SNAPSHOTS_DIR", d)
    monkeypatch.setattr(config, "EXPORTS_DIR", tmp_path / "exports")
    monkeypatch.setattr(config, "LOOKUP_TEMPLATES_DIR", tmp_path / "tpl")
    (tmp_path / "tpl").mkdir()
    monkeypatch.setattr(config, "SETTINGS_FILE", tmp_path / "settings.json")
    monkeypatch.setattr(config, "SOURCE_STATUS_FILE", tmp_path / "ss.json")
    monkeypatch.setattr(config, "LOGS_DIR", tmp_path / "logs")
    monkeypatch.setattr(config, "LOG_FILE", tmp_path / "logs" / "lookups.log")
    from app import app
    app.config["TESTING"] = True
    return app.test_client()


def test_more_rows_returns_next_batch(client):
    df = pd.DataFrame({"Name": [f"row{i}" for i in range(100)]})
    sid = snapshot_store.save_snapshot(df, "t", ["Name"])
    with client.session_transaction() as sess:
        sess["snapshot_ids"] = {"g1": sid}
    r = client.get("/api/more_rows?group_key=g1&offset=50&limit=50")
    j = json.loads(r.data)
    assert len(j["rows"]) == 50
    assert j["total"] == 100
    assert j["has_more"] is False
    assert j["columns"] == ["Name"]


def test_offset_beyond_end(client):
    df = pd.DataFrame({"A": ["x"]})
    sid = snapshot_store.save_snapshot(df, "t", ["A"])
    with client.session_transaction() as sess:
        sess["snapshot_ids"] = {"g1": sid}
    r = client.get("/api/more_rows?group_key=g1&offset=999&limit=50")
    j = json.loads(r.data)
    assert j["rows"] == []
    assert j["has_more"] is False


def test_no_session_snapshot_410(client):
    r = client.get("/api/more_rows?group_key=g1&offset=0&limit=50")
    assert r.status_code == 410
