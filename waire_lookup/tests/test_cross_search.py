"""M7: Cross-template search tests."""

import json
import pytest
import config


@pytest.fixture()
def client(tmp_path, monkeypatch):
    tpl_dir = tmp_path / "lookup_templates"
    tpl_dir.mkdir()
    monkeypatch.setattr(config, "LOOKUP_TEMPLATES_DIR", tpl_dir)
    monkeypatch.setattr(config, "EXPORTS_DIR", tmp_path / "exports")
    monkeypatch.setattr(config, "LOGS_DIR", tmp_path / "logs")
    monkeypatch.setattr(config, "LOG_FILE", tmp_path / "logs" / "lookups.log")
    monkeypatch.setattr(config, "SETTINGS_FILE", tmp_path / "settings.json")
    monkeypatch.setattr(config, "SNAPSHOTS_DIR", tmp_path / "snapshots")
    monkeypatch.setattr(config, "SOURCE_STATUS_FILE", tmp_path / "ss.json")

    # Create two CSV test sources
    csv1 = tmp_path / "data1.csv"
    csv1.write_text("ID,Name\n100,Alice\n200,Bob\n", encoding="utf-8")
    csv2 = tmp_path / "data2.csv"
    csv2.write_text("Code,Desc\n100,Widget\n300,Gadget\n", encoding="utf-8")

    from app import app
    app.config["TESTING"] = True
    c = app.test_client()

    t1 = {"name": "tpl1", "source": {"path": str(csv1), "header_row": 1},
           "key_columns": ["ID"], "result_columns": ["Name"],
           "views": [{"name": "Default", "columns": ["Name"]}]}
    t2 = {"name": "tpl2", "source": {"path": str(csv2), "header_row": 1},
           "key_columns": ["Code"], "result_columns": ["Desc"],
           "views": [{"name": "Default", "columns": ["Desc"]}]}
    c.post("/api/save_template", json=t1)
    c.post("/api/save_template", json=t2)
    return c


def test_cross_search_finds_value_in_correct_template(client):
    r = client.post("/api/cross_search", json={"value": "100", "mode": "exact"},
                     content_type="application/json")
    j = json.loads(r.data)
    assert r.status_code == 200
    hits = [x for x in j["results"] if x["matches"] > 0]
    templates_hit = {x["template"] for x in hits}
    assert "tpl1" in templates_hit
    assert "tpl2" in templates_hit


def test_cross_search_missing_value(client):
    r = client.post("/api/cross_search", json={"value": "999", "mode": "exact"},
                     content_type="application/json")
    j = json.loads(r.data)
    hits = [x for x in j["results"] if x["matches"] > 0]
    assert len(hits) == 0


def test_sql_template_skipped(client):
    sql_t = {"name": "sql_tpl",
             "source": {"type": "sql", "connection_id": "c1", "query": "SELECT 1"},
             "key_columns": ["ID"], "result_columns": ["X"],
             "views": [{"name": "Default", "columns": ["X"]}]}
    client.post("/api/save_template", json=sql_t)
    r = client.post("/api/cross_search", json={"value": "100", "mode": "exact"},
                     content_type="application/json")
    j = json.loads(r.data)
    sql_results = [x for x in j["results"] if x["template"] == "sql_tpl"]
    assert sql_results[0]["skipped"] == "SQL source"
