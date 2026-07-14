import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

import config
from core import source_status


@pytest.fixture
def tmp_status(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "SOURCE_STATUS_FILE", tmp_path / "source_status.json")
    return tmp_path


def test_unknown_key_returns_empty(tmp_status):
    assert source_status.get_status("nope") == {}


def test_set_and_get_roundtrip(tmp_status):
    source_status.set_status("k", type="local", last_checked="t1")
    got = source_status.get_status("k")
    assert got["type"] == "local"
    assert got["last_checked"] == "t1"


def test_updates_merge(tmp_status):
    source_status.set_status("k", type="local", last_checked="t1")
    source_status.set_status("k", last_error="oops")
    got = source_status.get_status("k")
    assert got["type"] == "local"
    assert got["last_checked"] == "t1"
    assert got["last_error"] == "oops"


def test_atomic_write_no_tmp_left(tmp_status):
    source_status.set_status("k", type="local")
    assert not (tmp_status / "source_status.json.tmp").exists()


def test_all_statuses(tmp_status):
    source_status.set_status("a", type="local")
    source_status.set_status("b", type="local")
    all_ = source_status.all_statuses()
    assert set(all_.keys()) == {"a", "b"}
