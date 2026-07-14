import config
from core import sql_credentials


def test_save_load_delete(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "SQL_CREDENTIALS_FILE", tmp_path / "creds.dat")
    cid = sql_credentials.save_credential("alice", "hunter2")
    assert cid
    got = sql_credentials.load_credential(cid)
    assert got == ("alice", "hunter2")
    sql_credentials.delete_credential(cid)
    assert sql_credentials.load_credential(cid) is None


def test_missing_id_returns_none(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "SQL_CREDENTIALS_FILE", tmp_path / "creds.dat")
    assert sql_credentials.load_credential("nope") is None


def test_update_in_place(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "SQL_CREDENTIALS_FILE", tmp_path / "creds.dat")
    cid = sql_credentials.save_credential("alice", "old")
    sql_credentials.save_credential("alice", "new", credential_id=cid)
    assert sql_credentials.load_credential(cid) == ("alice", "new")


def test_two_credentials_isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "SQL_CREDENTIALS_FILE", tmp_path / "creds.dat")
    a = sql_credentials.save_credential("alice", "pw_a")
    b = sql_credentials.save_credential("bob", "pw_b")
    assert sql_credentials.load_credential(a) == ("alice", "pw_a")
    assert sql_credentials.load_credential(b) == ("bob", "pw_b")
