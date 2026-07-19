"""Same-workbook merged view: a view can left-join a second sheet and show
columns from both in one table. Exercises core/join.left_join in isolation and
end-to-end through the /api/search route (merged group + qualified columns).
"""
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

import pandas as pd
import pytest

from core.join import left_join, join_column_names


def test_left_join_qualifies_and_keeps_base_rows():
    base = pd.DataFrame({"Addr": ["1 A", "2 B", "9 Z"], "City": ["LA", "SF", "SD"]})
    join = pd.DataFrame({"Addr": ["1 a ", "2 B"], "City": ["x", "y"], "Owner": ["Ann", "Bob"]})
    m = left_join(base, join, [{"left": "Addr", "right": "Addr"}], "Sheet1")
    assert list(m.columns) == ["Addr", "City", "City (Sheet1)", "Owner (Sheet1)"]
    assert list(m["Owner (Sheet1)"]) == ["Ann", "Bob", ""]   # left join keeps 9 Z
    assert list(m["City"]) == ["LA", "SF", "SD"]              # base City untouched


def test_join_column_names_drops_keys_and_suffixes_rest():
    m = join_column_names(["Addr", "Owner", "Phone"], ["Addr"], "S2")
    assert m == {"Owner": "Owner (S2)", "Phone": "Phone (S2)"}


# ── End-to-end through the route ───────────────────────────────────────────

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
    raise AssertionError(f"no 'result' SSE event: {text[:500]!r}")


def _make_workbook(path: Path):
    with pd.ExcelWriter(path, engine="openpyxl") as xw:
        pd.DataFrame({
            "PropertyID": ["001", "002"],
            "Property Address": ["1 Main St", "2 Oak Ave"],
            "Owner Name": ["Alpha LLC", "Beta LLC"],
        }).to_excel(xw, sheet_name="Export072722", index=False)
        pd.DataFrame({
            "Property Address": ["1 main st", "2 Oak Ave"],
            "County Name": ["Orange", "Kern"],
        }).to_excel(xw, sheet_name="Sheet1", index=False)


def _write_template(dir_: Path, xlsx_path: Path):
    (dir_ / "merged.json").write_text(json.dumps({
        "name": "merged",
        "source": {"path": str(xlsx_path), "sheet_name": "Export072722",
                   "table_name": None, "header_row": 1},
        "key_columns": ["PropertyID", "Property Address"],
        "result_columns": ["Owner Name"],
        "views": [
            {"name": "owner", "columns": ["Owner Name"]},
            {"name": "Combined", "columns": ["Owner Name", "County Name (Sheet1)"],
             "join": {"sheet_name": "Sheet1",
                      "on": [{"left": "Property Address", "right": "Property Address"}]}},
        ],
        "labels": {}, "default_filter": None, "default_match_mode": "partial",
        "schema_version": 4,
    }), encoding="utf-8")


def test_merged_view_returns_joined_columns(clean_env):
    import app as _app
    xlsx = clean_env / "wb.xlsx"
    _make_workbook(xlsx)
    _write_template(clean_env / "templates", xlsx)

    client = _app.app.test_client()
    rv = client.post("/api/search", data={
        "template": "merged", "mode": "partial",
        "key_0": "", "key_1": "1 Main St",   # search by Property Address
    })
    data = _sse_result(rv)
    groups = data["result"]["groups"]

    # The merged group is the one whose cols include the qualified join column.
    merged = next(g for g in groups if "County Name (Sheet1)" in (g["all_view_cols"] or []))
    assert merged["disabled_reason"] is None
    assert merged["total_matches"] == 1
    row = merged["display_rows"][0]
    assert row["Owner Name"] == "Alpha LLC"
    assert row["County Name (Sheet1)"] == "Orange"   # left-joined despite case diff
