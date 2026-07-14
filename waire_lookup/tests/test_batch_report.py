"""M5: Batch lookup — not-found in snapshot + export CSV."""

import json
import pandas as pd
import pytest

import config
from core import snapshot_store


@pytest.fixture()
def snap_dir(tmp_path, monkeypatch):
    d = tmp_path / "snapshots"
    d.mkdir()
    monkeypatch.setattr(config, "SNAPSHOTS_DIR", d)
    return d


def test_snapshot_roundtrip_with_not_found(snap_dir):
    df = pd.DataFrame({"A": ["x"]})
    sid = snapshot_store.save_snapshot(df, "t", ["A"], not_found=["missing1", "missing2"])
    snap = snapshot_store.load_snapshot(sid)
    assert snap["not_found"] == ["missing1", "missing2"]


def test_snapshot_legacy_no_not_found(snap_dir):
    df = pd.DataFrame({"A": ["x"]})
    sid = snapshot_store.save_snapshot(df, "t", ["A"])
    snap = snapshot_store.load_snapshot(sid)
    assert snap["not_found"] == []


def test_export_csv_includes_not_found(tmp_path, monkeypatch):
    snap_dir = tmp_path / "snapshots"
    snap_dir.mkdir()
    monkeypatch.setattr(config, "SNAPSHOTS_DIR", snap_dir)
    monkeypatch.setattr(config, "EXPORTS_DIR", tmp_path / "exports")
    monkeypatch.setattr(config, "LOOKUP_TEMPLATES_DIR", tmp_path / "tpl")
    (tmp_path / "tpl").mkdir()
    monkeypatch.setattr(config, "SETTINGS_FILE", tmp_path / "settings.json")
    monkeypatch.setattr(config, "SOURCE_STATUS_FILE", tmp_path / "ss.json")
    monkeypatch.setattr(config, "LOGS_DIR", tmp_path / "logs")
    monkeypatch.setattr(config, "LOG_FILE", tmp_path / "logs" / "lookups.log")

    df = pd.DataFrame({"Name": ["Alice", "Bob"]})
    sid = snapshot_store.save_snapshot(df, "test", ["Name"], not_found=["Charlie", "Dave"])

    from app import app
    app.config["TESTING"] = True
    with app.test_client() as c:
        with c.session_transaction() as sess:
            sess["snapshot_ids"] = {"primary": sid}
        r = c.post("/export", data={"group_key": "primary"})
        assert r.status_code == 200
        text = r.data.decode("utf-8-sig")
        assert "NOT FOUND" in text
        assert "Charlie" in text
        assert "Dave" in text
