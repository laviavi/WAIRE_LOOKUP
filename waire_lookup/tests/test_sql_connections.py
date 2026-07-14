import config
from core import sql_connections, sql_credentials


def _setup(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "SQL_CONNECTIONS_FILE", tmp_path / "conn.json")
    monkeypatch.setattr(config, "SQL_CREDENTIALS_FILE", tmp_path / "creds.dat")


def test_save_and_list(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    cid = sql_connections.save_connection(
        name="isr_db_prod", server="server1", port=1433,
        database="ISR", username="ro_user", password="p!",
    )
    all_ = sql_connections.list_connections()
    assert len(all_) == 1
    assert all_[0]["id"] == cid
    assert all_[0]["name"] == "isr_db_prod"
    assert "password" not in all_[0]  # never exposed on list


def test_load_returns_metadata_only(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    cid = sql_connections.save_connection(
        name="c1", server="s", port=1433, database="d", username="u", password="pw",
    )
    got = sql_connections.load_connection(cid)
    assert got["username"] == "u"
    assert "password" not in got
    # Credential id resolves back to real password via sql_credentials
    cred = sql_credentials.load_credential(got["credential_id"])
    assert cred == ("u", "pw")


def test_delete_removes_credential_too(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    cid = sql_connections.save_connection(
        name="c1", server="s", port=1433, database="d", username="u", password="pw",
    )
    cred_id = sql_connections.load_connection(cid)["credential_id"]
    sql_connections.delete_connection(cid)
    assert sql_connections.load_connection(cid) is None
    assert sql_credentials.load_credential(cred_id) is None


def test_update_without_password_keeps_old(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    cid = sql_connections.save_connection(
        name="c1", server="s", port=1433, database="d", username="u", password="pw",
    )
    old_cred_id = sql_connections.load_connection(cid)["credential_id"]
    # Update with blank password → password preserved, credential_id preserved
    sql_connections.save_connection(
        connection_id=cid, name="c1-renamed", server="s2", port=1433,
        database="d", username="u", password="",
    )
    updated = sql_connections.load_connection(cid)
    assert updated["name"] == "c1-renamed"
    assert updated["server"] == "s2"
    assert updated["credential_id"] == old_cred_id
    assert sql_credentials.load_credential(old_cred_id) == ("u", "pw")


def test_missing_password_on_new_raises(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    import pytest
    with pytest.raises(ValueError):
        sql_connections.save_connection(
            name="c1", server="s", port=1433, database="d", username="u", password="",
        )
