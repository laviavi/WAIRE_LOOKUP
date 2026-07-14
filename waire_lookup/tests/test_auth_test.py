"""M11: SharePoint auth test endpoint tests."""

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


def test_unconfigured(client, monkeypatch):
    monkeypatch.setattr("core.graph_auth.is_configured", lambda: False)
    r = client.post("/api/auth_test")
    j = json.loads(r.data)
    assert j["ok"] is False
    assert "client id" in j["message"].lower()


def test_not_signed_in(client, monkeypatch):
    monkeypatch.setattr("core.graph_auth.is_configured", lambda: True)
    monkeypatch.setattr("core.graph_auth.get_token_silent", lambda: None)
    r = client.post("/api/auth_test")
    j = json.loads(r.data)
    assert j["ok"] is False
    assert "sign" in j["message"].lower()


def test_graph_error(client, monkeypatch):
    monkeypatch.setattr("core.graph_auth.is_configured", lambda: True)
    monkeypatch.setattr("core.graph_auth.get_token_silent", lambda: "tok")
    from core.graph_client import GraphError
    monkeypatch.setattr("core.graph_client.whoami", lambda t, session=None: (_ for _ in ()).throw(GraphError("auth", "Token expired")))
    r = client.post("/api/auth_test")
    j = json.loads(r.data)
    assert j["ok"] is False
    assert "Token expired" in j["message"]


def test_success(client, monkeypatch):
    monkeypatch.setattr("core.graph_auth.is_configured", lambda: True)
    monkeypatch.setattr("core.graph_auth.get_token_silent", lambda: "tok")
    monkeypatch.setattr("core.graph_client.whoami", lambda t, session=None: "Avi Lavi")
    r = client.post("/api/auth_test")
    j = json.loads(r.data)
    assert j["ok"] is True
    assert "Avi Lavi" in j["message"]
