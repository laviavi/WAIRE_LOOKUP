import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

import config
from core import settings_store


@pytest.fixture
def tmp_settings(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "SETTINGS_FILE", tmp_path / "settings.json")
    return tmp_path


def test_defaults_when_missing(tmp_settings):
    got = settings_store.load_settings()
    assert got["card_max"] == 1
    assert got["poll_minutes"] == 5
    # SharePoint enabled out of the box via the well-known Client ID
    assert got["graph_client_id"] == "14d82eec-204b-4c2f-b7e8-296a70dab67e"
    assert got["graph_tenant"] == "organizations"


def test_save_and_load_roundtrip(tmp_settings):
    settings_store.save_settings({"card_max": 5})
    assert settings_store.load_settings()["card_max"] == 5


def test_validate_rejects_below_one():
    with pytest.raises(ValueError):
        settings_store.validate_settings({"card_max": 0})


def test_validate_rejects_non_integer():
    with pytest.raises(ValueError):
        settings_store.validate_settings({"card_max": "abc"})


def test_validate_coerces_numeric_string():
    assert settings_store.validate_settings({"card_max": "3"})["card_max"] == 3


def test_blank_falls_back_to_default():
    assert settings_store.validate_settings({"card_max": ""})["card_max"] == 1


def test_corrupt_file_falls_back(tmp_settings):
    (tmp_settings / "settings.json").write_text("{not json", encoding="utf-8")
    got = settings_store.load_settings()
    assert got["card_max"] == 1
    assert got["poll_minutes"] == 5
    assert got["graph_client_id"] == "14d82eec-204b-4c2f-b7e8-296a70dab67e"


def test_validate_clamps_above_99():
    assert settings_store.validate_settings({"card_max": 500})["card_max"] == 99


def test_validate_allows_exactly_99():
    assert settings_store.validate_settings({"card_max": 99})["card_max"] == 99


def test_poll_minutes_default(tmp_settings):
    assert settings_store.load_settings()["poll_minutes"] == 5


def test_poll_minutes_clamps_high():
    assert settings_store.validate_settings({"poll_minutes": 9999})["poll_minutes"] == 120


def test_poll_minutes_rejects_below_one():
    with pytest.raises(ValueError):
        settings_store.validate_settings({"poll_minutes": 0})


def test_save_settings_merge_preserves_other_keys(tmp_settings):
    # Establish both keys
    settings_store.save_settings({"card_max": 7, "poll_minutes": 42})
    # Now update only one — the other must survive
    settings_store.save_settings({"card_max": 12})
    got = settings_store.load_settings()
    assert got["card_max"] == 12
    assert got["poll_minutes"] == 42


def test_save_settings_blank_field_is_no_op(tmp_settings):
    settings_store.save_settings({"card_max": 5, "poll_minutes": 30})
    settings_store.save_settings({"card_max": "", "poll_minutes": ""})
    got = settings_store.load_settings()
    assert got["card_max"] == 5
    assert got["poll_minutes"] == 30


def test_graph_client_id_default_is_ms_shared_public():
    got = settings_store.validate_settings({})
    # Default is Microsoft's own published "Graph Command Line Tools" public
    # client (well-known ID) — so users need no Azure portal registration.
    assert got["graph_client_id"] == "14d82eec-204b-4c2f-b7e8-296a70dab67e"
    assert got["graph_tenant"] == "organizations"


def test_graph_client_id_valid_guid_accepted():
    guid = "11111111-2222-3333-4444-555555555555"
    got = settings_store.validate_settings({"graph_client_id": guid})
    assert got["graph_client_id"] == guid


def test_graph_client_id_invalid_rejected():
    with pytest.raises(ValueError):
        settings_store.validate_settings({"graph_client_id": "not-a-guid"})


def test_graph_client_id_empty_string_allowed():
    got = settings_store.validate_settings({"graph_client_id": ""})
    assert got["graph_client_id"] == ""


def test_save_clears_graph_client_id(tmp_settings):
    # Establish a Client ID, then clear it — must actually clear.
    guid = "11111111-2222-3333-4444-555555555555"
    settings_store.save_settings({"graph_client_id": guid})
    assert settings_store.load_settings()["graph_client_id"] == guid
    settings_store.save_settings({"graph_client_id": ""})
    assert settings_store.load_settings()["graph_client_id"] == ""
