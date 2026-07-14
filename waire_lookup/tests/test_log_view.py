"""M10: In-app log viewer tests."""

import json
import pytest
import config


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "LOOKUP_TEMPLATES_DIR", tmp_path / "tpl")
    (tmp_path / "tpl").mkdir()
    monkeypatch.setattr(config, "SETTINGS_FILE", tmp_path / "settings.json")
    monkeypatch.setattr(config, "SNAPSHOTS_DIR", tmp_path / "snap")
    monkeypatch.setattr(config, "SOURCE_STATUS_FILE", tmp_path / "ss.json")
    monkeypatch.setattr(config, "EXPORTS_DIR", tmp_path / "exports")
    monkeypatch.setattr(config, "LOGS_DIR", tmp_path / "logs")
    monkeypatch.setattr(config, "LOG_FILE", tmp_path / "logs" / "lookups.log")
    from app import app
    app.config["TESTING"] = True
    return app.test_client()


def test_log_tail_returns_lines(client, tmp_path):
    log_dir = tmp_path / "logs"
    log_dir.mkdir(exist_ok=True)
    log_file = log_dir / "lookups.log"
    log_file.write_text("line1\nline2\nline3\n", encoding="utf-8")
    r = client.get("/api/log_tail?lines=2")
    j = json.loads(r.data)
    assert j["lines"] == ["line2", "line3"]


def test_log_tail_missing_file(client):
    r = client.get("/api/log_tail?lines=10")
    j = json.loads(r.data)
    assert j["lines"] == []


def test_log_tail_clamps(client, tmp_path):
    log_dir = tmp_path / "logs"
    log_dir.mkdir(exist_ok=True)
    log_file = log_dir / "lookups.log"
    log_file.write_text("a\n", encoding="utf-8")
    r = client.get("/api/log_tail?lines=9999")
    j = json.loads(r.data)
    assert len(j["lines"]) <= 1000
