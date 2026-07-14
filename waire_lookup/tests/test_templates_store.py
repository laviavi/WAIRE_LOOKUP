import sys
import json
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest
import config


@pytest.fixture(autouse=True)
def temp_template_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "LOOKUP_TEMPLATES_DIR", tmp_path)
    import importlib
    import core.templates_store as ts
    importlib.reload(ts)
    return tmp_path


def make_template(**overrides):
    t = {
        "name": "Test Template",
        "source": {
            "path": "C:/fake/path.xlsx",
            "sheet_name": "Sheet1",
            "table_name": None,
            "header_row": 0,
        },
        "key_columns": ["ID"],
        "result_columns": ["ID", "Name"],
        "labels": {},
        "default_filter": None,
        "default_match_mode": "exact",
    }
    t.update(overrides)
    return t


def test_save_and_load():
    from core.templates_store import save_template, load_template
    t = make_template()
    save_template(t)
    loaded = load_template("Test Template")
    assert loaded["name"] == "Test Template"
    assert loaded["key_columns"] == ["ID"]


def test_list_templates():
    from core.templates_store import save_template, list_templates
    save_template(make_template(name="Alpha"))
    save_template(make_template(name="Beta"))
    names = [t["name"] for t in list_templates()]
    assert "Alpha" in names
    assert "Beta" in names


def test_delete_template():
    from core.templates_store import save_template, delete_template, list_templates
    save_template(make_template(name="ToDelete"))
    delete_template("ToDelete")
    names = [t["name"] for t in list_templates()]
    assert "ToDelete" not in names


def test_validate_no_key_columns():
    from core.templates_store import validate_template
    t = make_template(key_columns=[])
    problems = validate_template(t)
    assert any("key column" in p.lower() for p in problems)


def test_validate_no_result_columns():
    from core.templates_store import validate_template
    t = make_template(result_columns=[])
    problems = validate_template(t)
    assert any("result column" in p.lower() for p in problems)


def test_validate_renamed_column():
    from core.templates_store import validate_template
    t = make_template(key_columns=["WON"])
    problems = validate_template(t, available_columns=["ID", "Name"])
    assert any("WON" in p for p in problems)
    assert any("renamed" in p for p in problems)


def test_validate_passes_when_columns_present():
    from core.templates_store import validate_template
    t = make_template()
    problems = validate_template(t, available_columns=["ID", "Name"])
    assert problems == []


def test_malformed_json_skipped(tmp_path, monkeypatch):
    import config
    monkeypatch.setattr(config, "LOOKUP_TEMPLATES_DIR", tmp_path)
    import importlib
    import core.templates_store as ts
    importlib.reload(ts)

    # Write a valid template and a broken one
    (tmp_path / "valid.json").write_text(json.dumps({
        "schema_version": 1,
        "name": "Valid",
        "source": {"path": "x.xlsx", "sheet_name": None, "table_name": None, "header_row": 0},
        "key_columns": ["ID"],
        "result_columns": ["ID"],
        "labels": {},
        "default_filter": None,
        "default_match_mode": "exact",
    }), encoding="utf-8")
    (tmp_path / "broken.json").write_text("{not valid json", encoding="utf-8")

    from core.templates_store import list_templates
    templates = list_templates()
    names = [t["name"] for t in templates]
    assert "Valid" in names
    assert len(templates) == 1  # broken one skipped, no crash


def test_save_rejects_zero_key_columns():
    from core.templates_store import save_template
    with pytest.raises(ValueError, match="Invalid template"):
        save_template(make_template(key_columns=[]))
