"""A multi-sheet template (schema v4) can configure a key column that only
exists on one of its sheets (e.g. PropertyID on Sheet1, Address on Sheet2).
Regression coverage for the bug where such a sheet was wrongly marked
"not searchable" for ANY configured key it lacked, even one the user never
filled in — see app.py's api_search missing_keys computation.
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


def _sse_result(rv) -> dict:
    text = rv.data.decode("utf-8")
    for block in text.split("\n\n"):
        if block.startswith("event: result"):
            data_line = next(l for l in block.split("\n") if l.startswith("data: "))
            return json.loads(data_line[len("data: "):])
    raise AssertionError(f"no 'result' SSE event in response: {text[:500]!r}")


def _make_workbook(path: Path):
    with pd.ExcelWriter(path, engine="openpyxl") as xw:
        pd.DataFrame({
            "PropertyID": ["0012345"],
            "Name": ["Acme Corp"],
        }).to_excel(xw, sheet_name="Sheet1", index=False)
        pd.DataFrame({
            "Address": ["123 Main St"],
            "Notes": ["export072722"],
        }).to_excel(xw, sheet_name="export072722", index=False)


def _write_template(dir_: Path, xlsx_path: Path):
    (dir_ / "multi.json").write_text(json.dumps({
        "name": "multi",
        "source": {"path": str(xlsx_path), "sheet_name": "Sheet1", "table_name": None, "header_row": 1},
        "key_columns": ["PropertyID", "Address"],
        "result_columns": ["PropertyID", "Name"],
        "views": [
            {"name": "Main", "columns": ["PropertyID", "Name"]},
            {"name": "Other", "sheet_name": "export072722", "columns": ["Address", "Notes"]},
        ],
        "labels": {},
        "default_filter": None,
        "default_match_mode": "partial",
        "schema_version": 4,
    }), encoding="utf-8")


def test_secondary_sheet_searchable_by_its_own_key(clean_env):
    """Searching by Address alone (leaving PropertyID blank) must run fine
    against export072722 even though that sheet has no PropertyID column."""
    import app as _app
    xlsx = clean_env / "wb.xlsx"
    _make_workbook(xlsx)
    _write_template(clean_env / "templates", xlsx)

    client = _app.app.test_client()
    rv = client.post("/api/search", data={
        "template": "multi", "mode": "partial",
        "key_0": "", "key_1": "123 Main",
    })
    data = _sse_result(rv)
    groups = {g["sheet_name"]: g for g in data["result"]["groups"]}

    other = groups["export072722"]
    assert other["disabled_reason"] is None
    assert other["total_matches"] == 1

    # Sheet1 has no Address column, so it's correctly disabled for THIS query
    # (which only searched by Address) — but for the right, query-specific
    # reason, not because it's missing PropertyID (which wasn't even queried).
    primary = groups["Sheet1"]
    assert primary["disabled_reason"] is not None
    assert "Address" in primary["disabled_reason"]


def test_primary_sheet_searchable_by_its_own_key(clean_env):
    """Searching by PropertyID alone must still work against Sheet1, and
    leaves export072722 disabled only because PropertyID isn't queried there
    — not a regression of the normal single-key path."""
    import app as _app
    xlsx = clean_env / "wb.xlsx"
    _make_workbook(xlsx)
    _write_template(clean_env / "templates", xlsx)

    client = _app.app.test_client()
    rv = client.post("/api/search", data={
        "template": "multi", "mode": "partial",
        "key_0": "0012345", "key_1": "",
    })
    data = _sse_result(rv)
    groups = {g["sheet_name"]: g for g in data["result"]["groups"]}

    primary = groups["Sheet1"]
    assert primary["disabled_reason"] is None
    assert primary["total_matches"] == 1
