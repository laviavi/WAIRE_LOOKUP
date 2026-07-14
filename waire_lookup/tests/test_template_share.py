"""M3: Template export / import tests."""

import json
import pytest
from pathlib import Path

import config


@pytest.fixture()
def clean_env(tmp_path, monkeypatch):
    tpl_dir = tmp_path / "lookup_templates"
    tpl_dir.mkdir()
    monkeypatch.setattr(config, "LOOKUP_TEMPLATES_DIR", tpl_dir)
    monkeypatch.setattr(config, "EXPORTS_DIR", tmp_path / "exports")
    monkeypatch.setattr(config, "LOGS_DIR", tmp_path / "logs")
    monkeypatch.setattr(config, "LOG_FILE", tmp_path / "logs" / "lookups.log")
    monkeypatch.setattr(config, "SETTINGS_FILE", tmp_path / "settings.json")
    monkeypatch.setattr(config, "SNAPSHOTS_DIR", tmp_path / "snapshots")
    monkeypatch.setattr(config, "SOURCE_STATUS_FILE", tmp_path / "source_status.json")
    from app import app
    app.config["TESTING"] = True
    return app.test_client()


VALID_TEMPLATE = {
    "name": "demo",
    "source": {"path": "C:/data/test.xlsx", "sheet_name": "Sheet1", "header_row": 1},
    "key_columns": ["ID"],
    "result_columns": ["Name"],
    "views": [{"name": "Default", "columns": ["Name"]}],
}

SQL_TEMPLATE = {
    "name": "sql_demo",
    "source": {"type": "sql", "connection_id": "conn-123", "query": "SELECT * FROM t"},
    "key_columns": ["ID"],
    "result_columns": ["Name"],
    "views": [{"name": "Default", "columns": ["Name"]}],
}


def _save(client, t):
    client.post("/api/save_template", json=t)


def test_export_local_returns_json(clean_env):
    _save(clean_env, VALID_TEMPLATE)
    r = clean_env.get("/api/template_export?template=demo")
    assert r.status_code == 200
    data = json.loads(r.data)
    assert data["source"]["path"] == "C:/data/test.xlsx"
    assert "attachment" in r.headers.get("Content-Disposition", "")


def test_export_sql_blanks_connection(clean_env):
    _save(clean_env, SQL_TEMPLATE)
    r = clean_env.get("/api/template_export?template=sql_demo")
    assert r.status_code == 200
    data = json.loads(r.data)
    assert data["source"]["connection_id"] == ""
    assert data["needs_connection"] is True


def test_import_valid_saves(clean_env):
    r = clean_env.post("/api/template_import", json=VALID_TEMPLATE,
                       content_type="application/json")
    assert r.status_code == 200
    j = json.loads(r.data)
    assert j["ok"] is True
    assert (config.LOOKUP_TEMPLATES_DIR / "demo.json").exists()


def test_import_duplicate_name_400(clean_env):
    _save(clean_env, VALID_TEMPLATE)
    r = clean_env.post("/api/template_import", json=VALID_TEMPLATE,
                       content_type="application/json")
    assert r.status_code == 400
    assert "already exists" in json.loads(r.data)["error"]


def test_import_invalid_schema_400(clean_env):
    bad = {"name": "bad", "source": {}, "key_columns": [], "result_columns": []}
    r = clean_env.post("/api/template_import", json=bad,
                       content_type="application/json")
    assert r.status_code == 400
