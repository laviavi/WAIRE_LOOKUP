import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

import time

import pandas as pd
import pytest

import config
from core import snapshot_store


@pytest.fixture
def tmp_snaps(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "SNAPSHOTS_DIR", tmp_path)
    return tmp_path


def _df():
    return pd.DataFrame({"a": ["1", "2"], "b": ["x", "y"]})


def test_roundtrip_preserves_frame(tmp_snaps):
    sid = snapshot_store.save_snapshot(_df(), "t", ["a", "b"])
    got = snapshot_store.load_snapshot(sid)
    assert got is not None
    assert list(got["df"].columns) == ["a", "b"]
    assert got["template_name"] == "t"
    assert got["result_columns"] == ["a", "b"]


def test_save_replace_leaves_one_file(tmp_snaps):
    sid1 = snapshot_store.save_snapshot(_df(), "t", ["a"])
    snapshot_store.delete_snapshot(sid1)
    sid2 = snapshot_store.save_snapshot(_df(), "t", ["a"])
    files = list(tmp_snaps.glob("*.json"))
    assert len(files) == 1
    assert files[0].stem == sid2


def test_invalid_ids_rejected(tmp_snaps):
    assert snapshot_store.load_snapshot("../etc/passwd") is None
    assert snapshot_store.load_snapshot("ABCDEF") is None
    assert snapshot_store.load_snapshot("short") is None
    assert snapshot_store.load_snapshot(None) is None
    # Should not raise or delete anything unexpected
    snapshot_store.delete_snapshot("../etc/passwd")


def test_ttl_cleanup(tmp_snaps):
    sid = snapshot_store.save_snapshot(_df(), "t", ["a"])
    p = tmp_snaps / f"{sid}.json"
    old = time.time() - 48 * 3600
    import os
    os.utime(p, (old, old))
    removed = snapshot_store.cleanup_snapshots(24)
    assert removed == 1
    assert not p.exists()


def test_ttl_cleanup_keeps_fresh(tmp_snaps):
    sid = snapshot_store.save_snapshot(_df(), "t", ["a"])
    removed = snapshot_store.cleanup_snapshots(24)
    assert removed == 0
    assert (tmp_snaps / f"{sid}.json").exists()


def test_corrupt_file_returns_none(tmp_snaps):
    sid = snapshot_store.save_snapshot(_df(), "t", ["a"])
    (tmp_snaps / f"{sid}.json").write_text("{ not json", encoding="utf-8")
    assert snapshot_store.load_snapshot(sid) is None
