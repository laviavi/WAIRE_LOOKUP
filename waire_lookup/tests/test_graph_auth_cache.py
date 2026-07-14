"""M1: DPAPI-encrypted token cache round-trip tests."""

import importlib
from pathlib import Path

import pytest
from msal import SerializableTokenCache

import config
from core import dpapi


@pytest.fixture()
def cache_dir(tmp_path, monkeypatch):
    f = tmp_path / "token_cache.json"
    monkeypatch.setattr(config, "TOKEN_CACHE_FILE", f)
    return f


def _reload_graph_auth():
    import core.graph_auth as ga
    importlib.reload(ga)
    return ga


def test_save_load_roundtrip(cache_dir):
    from core import graph_auth

    cache = SerializableTokenCache()
    cache.deserialize('{"AccessToken": {}, "RefreshToken": {"rt1": {"secret": "tok123"}}}')
    cache.has_state_changed = True
    graph_auth._save_cache(cache)

    loaded = graph_auth._load_cache()
    assert "tok123" in loaded.serialize()


def test_on_disk_bytes_differ_from_plain(cache_dir):
    from core import graph_auth

    cache = SerializableTokenCache()
    plain = '{"AccessToken": {}, "RefreshToken": {"rt1": {"secret": "abc"}}}'
    cache.deserialize(plain)
    cache.has_state_changed = True
    graph_auth._save_cache(cache)

    raw = cache_dir.read_bytes()
    assert raw != plain.encode("utf-8")


def test_legacy_plain_json_loads(cache_dir):
    from core import graph_auth

    plain = '{"AccessToken": {}, "RefreshToken": {"rt1": {"secret": "legacy"}}}'
    cache_dir.write_text(plain, encoding="utf-8")

    loaded = graph_auth._load_cache()
    assert "legacy" in loaded.serialize()


def test_garbage_bytes_returns_empty_cache(cache_dir):
    from core import graph_auth

    cache_dir.write_bytes(b"\x00\x01\x02garbage")

    loaded = graph_auth._load_cache()
    assert loaded.serialize() == "{}"
