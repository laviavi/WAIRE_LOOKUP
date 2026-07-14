import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

import json

import pytest

import config
from core import poller, source_status, templates_store


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "SOURCE_STATUS_FILE", tmp_path / "source_status.json")
    monkeypatch.setattr(config, "LOOKUP_TEMPLATES_DIR", tmp_path / "templates")
    monkeypatch.setattr(config, "SNAPSHOTS_DIR", tmp_path / "snapshots")
    (tmp_path / "templates").mkdir()
    (tmp_path / "snapshots").mkdir()
    return tmp_path


def _write_template(tmp_path, name, source_path):
    p = tmp_path / "templates" / f"{name}.json"
    p.write_text(json.dumps({
        "name": name,
        "source": {"path": str(source_path), "sheet_name": None, "table_name": None, "header_row": 1},
        "key_columns": ["a"],
        "result_columns": ["a"],
        "labels": {},
        "default_filter": None,
        "default_match_mode": "exact",
        "schema_version": 1,
    }), encoding="utf-8")


def test_local_source_records_mtime(env, tmp_path):
    data_file = tmp_path / "d.csv"
    data_file.write_text("a\n1\n", encoding="utf-8")
    _write_template(tmp_path, "t1", data_file)
    poller.poll_once()
    st = source_status.get_status("t1")
    assert st["type"] == "local"
    assert st["last_error"] is None
    assert "last_checked" in st


def test_missing_source_records_error(env, tmp_path):
    _write_template(tmp_path, "gone", tmp_path / "not-here.csv")
    poller.poll_once()
    st = source_status.get_status("gone")
    assert st["last_error"] == "File not found"


def test_change_detection(env, tmp_path):
    import os, time
    data_file = tmp_path / "d.csv"
    data_file.write_text("a\n1\n", encoding="utf-8")
    _write_template(tmp_path, "t1", data_file)
    poller.poll_once()
    st1 = source_status.get_status("t1")
    # Touch the file so mtime differs
    later = time.time() + 10
    os.utime(data_file, (later, later))
    poller.poll_once()
    st2 = source_status.get_status("t1")
    assert st2["last_modified"] != st1["last_modified"]
    assert st2["last_updated"]  # populated on change


def test_exception_in_one_source_does_not_abort_others(env, tmp_path, monkeypatch):
    good = tmp_path / "good.csv"; good.write_text("a\n", encoding="utf-8")
    _write_template(tmp_path, "good", good)
    _write_template(tmp_path, "bad", tmp_path / "nope.csv")
    poller.poll_once()
    assert source_status.get_status("good")["last_error"] is None
    assert source_status.get_status("bad")["last_error"] == "File not found"
