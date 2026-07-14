"""End-to-end app tests: the huge-result search no longer breaks the response
(ERR_RESPONSE_HEADERS_TOO_BIG root cause: full rows in the session cookie).
"""

import io
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

import pandas as pd
import pytest


@pytest.fixture
def clean_env(tmp_path, monkeypatch):
    import config
    monkeypatch.setattr(config, "LOOKUP_TEMPLATES_DIR", tmp_path / "templates")
    monkeypatch.setattr(config, "EXPORTS_DIR", tmp_path / "exports")
    monkeypatch.setattr(config, "LOGS_DIR", tmp_path / "logs")
    monkeypatch.setattr(config, "LOG_FILE", tmp_path / "logs" / "lookups.log")
    monkeypatch.setattr(config, "SETTINGS_FILE", tmp_path / "settings.json")
    monkeypatch.setattr(config, "SNAPSHOTS_DIR", tmp_path / "snapshots")
    monkeypatch.setattr(config, "SOURCE_STATUS_FILE", tmp_path / "source_status.json")
    for d in ("templates", "exports", "logs", "snapshots"):
        (tmp_path / d).mkdir()
    return tmp_path


def _make_big_csv(path: Path, rows: int):
    df = pd.DataFrame({
        "PropertyID": [f"{i:07d}" for i in range(rows)],
        "Address": [f"1234 Fake St #{i}" for i in range(rows)],
        "City": ["Los Angeles"] * rows,
        "Owner": ["John Q. Sample"] * rows,
    })
    df.to_csv(path, index=False)


def _write_template(dir_: Path, name: str, csv_path: Path):
    (dir_ / f"{name}.json").write_text(json.dumps({
        "name": name,
        "source": {"path": str(csv_path), "sheet_name": None, "table_name": None, "header_row": 1},
        "key_columns": ["City"],
        "result_columns": ["PropertyID", "Address", "City", "Owner"],
        "labels": {},
        "default_filter": None,
        "default_match_mode": "partial",
        "schema_version": 1,
    }), encoding="utf-8")


def test_large_search_no_header_explosion(clean_env):
    import app as _app
    csv = clean_env / "big.csv"
    _make_big_csv(csv, 5000)
    _write_template(clean_env / "templates", "big", csv)

    client = _app.app.test_client()
    rv = client.post("/search", data={"template": "big", "key_0": "Los", "mode": "partial"})
    assert rv.status_code == 200

    # Every Set-Cookie header must be safely under Chrome's header cap
    for name, val in rv.headers.items():
        if name.lower() == "set-cookie":
            assert len(val) < 4096, f"Set-Cookie too large: {len(val)} bytes"

    # snapshot should exist on disk
    snaps = list((clean_env / "snapshots").glob("*.json"))
    assert len(snaps) == 1


def test_export_returns_all_matches(clean_env):
    import app as _app
    csv = clean_env / "big.csv"
    _make_big_csv(csv, 5000)
    _write_template(clean_env / "templates", "big", csv)

    client = _app.app.test_client()
    client.post("/search", data={"template": "big", "key_0": "Los", "mode": "partial"})
    rv = client.post("/export", data={})
    assert rv.status_code == 200
    text = rv.data.decode("utf-8-sig")
    # Header line + 5000 rows
    line_count = text.count("\n")
    assert line_count >= 5000


def test_second_search_replaces_prior_snapshot(clean_env):
    import app as _app
    csv = clean_env / "big.csv"
    _make_big_csv(csv, 100)
    _write_template(clean_env / "templates", "big", csv)

    client = _app.app.test_client()
    client.post("/search", data={"template": "big", "key_0": "Los", "mode": "partial"})
    snaps1 = set(p.name for p in (clean_env / "snapshots").glob("*.json"))
    assert len(snaps1) == 1

    client.post("/search", data={"template": "big", "key_0": "Los", "mode": "partial"})
    snaps2 = set(p.name for p in (clean_env / "snapshots").glob("*.json"))
    assert len(snaps2) == 1
    assert snaps2 != snaps1  # replaced, not appended


def test_export_without_snapshot_redirects(clean_env):
    import app as _app
    client = _app.app.test_client()
    rv = client.post("/export", data={})
    assert rv.status_code in (301, 302)


def test_column_values_returns_filtered_results(clean_env):
    """Regression: /api/column_values must return substring-filtered values.
    A Jinja auto-escape bug (&#34; in inline <script>) was killing all JS,
    making autocomplete silently do nothing. Verified via this API call."""
    import app as _app
    csv = clean_env / "ac.csv"
    pd.DataFrame({
        "ID": ["1", "2", "3"],
        "City": ["Rincon Valley", "Rialto", "Fontana"],
    }).to_csv(csv, index=False)
    tpl_dir = clean_env / "templates"
    (tpl_dir / "ac.json").write_text(json.dumps({
        "name": "ac",
        "source": {"path": str(csv), "sheet_name": None, "table_name": None, "header_row": 1},
        "key_columns": ["City"],
        "result_columns": ["ID", "City"],
        "labels": {}, "default_filter": None, "default_match_mode": "exact",
        "schema_version": 1,
    }), encoding="utf-8")

    client = _app.app.test_client()

    # No fragment — all values
    rv = client.get("/api/column_values?template=ac&col=City")
    assert rv.status_code == 200
    vals = json.loads(rv.data)
    assert set(vals) == {"Rincon Valley", "Rialto", "Fontana"}

    # Substring fragment "ri" should match Rincon Valley (prefix) and Rialto (prefix), not Fontana
    rv = client.get("/api/column_values?template=ac&col=City&q=ri")
    assert rv.status_code == 200
    vals = json.loads(rv.data)
    assert "Fontana" not in vals
    assert "Rincon Valley" in vals
    assert "Rialto" in vals

    # Fragment with no matches returns empty list
    rv = client.get("/api/column_values?template=ac&col=City&q=xyz")
    assert rv.status_code == 200
    assert json.loads(rv.data) == []

    # Non-key column returns empty list
    rv = client.get("/api/column_values?template=ac&col=ID")
    assert rv.status_code == 200
    assert json.loads(rv.data) == []


def test_index_script_has_no_html_entities(clean_env):
    """Regression: Jinja auto-escape must not produce &#34; or &amp; inside
    the inline <script> block. That broke all JS (autocomplete, view-switching)
    on the no-result page."""
    import app as _app
    csv = clean_env / "ac.csv"
    pd.DataFrame({"City": ["LA"]}).to_csv(csv, index=False)
    tpl_dir = clean_env / "templates"
    (tpl_dir / "ac.json").write_text(json.dumps({
        "name": "ac",
        "source": {"path": str(csv), "sheet_name": None, "table_name": None, "header_row": 1},
        "key_columns": ["City"], "result_columns": ["City"],
        "labels": {}, "default_filter": None, "default_match_mode": "exact",
        "schema_version": 1,
    }), encoding="utf-8")

    client = _app.app.test_client()
    rv = client.get("/?template=ac")
    assert rv.status_code == 200
    html = rv.data.decode("utf-8")

    # Extract the inline script block
    start = html.find("<script>")
    end = html.find("</script>", start)
    assert start >= 0 and end > start
    script = html[start:end]

    # Must contain no HTML-escaped characters
    assert "&#34;" not in script, "double-quote was HTML-escaped in inline script"
    assert "&amp;" not in script, "&amp; found in inline script"
    assert "&lt;" not in script, "&lt; found in inline script"
    assert "&gt;" not in script, "&gt; found in inline script"
