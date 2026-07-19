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


def _sse_result(rv) -> dict:
    """Parse the "result" event out of an /api/search SSE response."""
    text = rv.data.decode("utf-8")
    for block in text.split("\n\n"):
        if block.startswith("event: result"):
            data_line = next(l for l in block.split("\n") if l.startswith("data: "))
            return json.loads(data_line[len("data: "):])
    raise AssertionError(f"no 'result' SSE event in response: {text[:500]!r}")


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
    rv = client.post("/api/search", data={"template": "big", "key_0": "Los", "mode": "partial"})
    assert rv.status_code == 200
    # /api/search streams its body; the generator (where the search actually
    # runs) only executes once something reads it — status/headers alone
    # don't force that. _sse_result() reads rv.data, draining it.
    _sse_result(rv)

    # Every Set-Cookie header must be safely under Chrome's header cap.
    # (/api/search doesn't write snapshot data to the session at all now — a
    # streaming response's generator body runs after the cookie header is
    # already committed, so any such write would silently never take effect.)
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
    rv = client.post("/api/search", data={"template": "big", "key_0": "Los", "mode": "partial"})
    sid = next(iter(_sse_result(rv)["snapshot_ids"].values()))
    rv = client.post("/export", data={"snapshot_id": sid})
    assert rv.status_code == 200
    text = rv.data.decode("utf-8-sig")
    # Header line + 5000 rows
    line_count = text.count("\n")
    assert line_count >= 5000


def test_second_search_creates_a_new_snapshot(clean_env):
    """Two searches produce two distinct snapshot ids. (Each search's own
    snapshot is cleaned up when the *next* search starts — see ajaxSearch()'s
    prev_snapshot_ids — which this Python-only test can't exercise; disk-level
    cleanup is covered by core/snapshot_store.py's TTL sweep instead.)"""
    import app as _app
    csv = clean_env / "big.csv"
    _make_big_csv(csv, 100)
    _write_template(clean_env / "templates", "big", csv)

    client = _app.app.test_client()
    rv1 = client.post("/api/search", data={"template": "big", "key_0": "Los", "mode": "partial"})
    sid1 = next(iter(_sse_result(rv1)["snapshot_ids"].values()))

    rv2 = client.post("/api/search", data={"template": "big", "key_0": "Los", "mode": "partial"})
    sid2 = next(iter(_sse_result(rv2)["snapshot_ids"].values()))

    assert sid1 != sid2
    assert (clean_env / "snapshots" / f"{sid1}.json").exists()
    assert (clean_env / "snapshots" / f"{sid2}.json").exists()


def test_search_deletes_prev_snapshot_ids_sent_by_client(clean_env):
    """The client tracks its own snapshot ids and sends them back on the next
    search so the server can delete them (see ajaxSearch()'s prev_snapshot_ids)."""
    import app as _app
    csv = clean_env / "big.csv"
    _make_big_csv(csv, 100)
    _write_template(clean_env / "templates", "big", csv)

    client = _app.app.test_client()
    rv1 = client.post("/api/search", data={"template": "big", "key_0": "Los", "mode": "partial"})
    sid1 = next(iter(_sse_result(rv1)["snapshot_ids"].values()))
    assert (clean_env / "snapshots" / f"{sid1}.json").exists()

    client.post("/api/search", data={
        "template": "big", "key_0": "Los", "mode": "partial",
        "prev_snapshot_ids": json.dumps([sid1]),
    })
    assert not (clean_env / "snapshots" / f"{sid1}.json").exists()


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


def test_index_loads_search_js_with_correct_data_attributes(clean_env):
    """Regression (superseded by the Phase-4 JS extraction): the app used to
    have Jinja values interpolated directly into an inline <script> block,
    where auto-escaping produced HTML entities (&#34;, &amp;, ...) that broke
    the JS outright. All results/behavior now live in static/search.js,
    loaded via <script src>, with the page's only remaining dynamic JS
    inputs (auto_run, notify_webhook_id) passed through ordinary — and
    therefore correctly HTML-escaped — data-* attributes on <body>, not
    interpolated into script content at all. This test checks the new
    invariant: search.js is referenced, and the data-* values round-trip
    without being mangled."""
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

    assert '<script src="/static/search.js' in html
    assert 'data-auto-run="false"' in html
    assert 'data-notify-webhook-id=""' in html

    rv2 = client.get("/?template=ac&key_0=LA&mode=exact&run=1")
    assert 'data-auto-run="true"' in rv2.data.decode("utf-8")
