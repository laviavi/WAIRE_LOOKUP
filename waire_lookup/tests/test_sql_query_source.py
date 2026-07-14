"""Test SqlQuerySource with a fake pymssql (no real DB needed)."""

import sys
import types

import pandas as pd

from connectors.sql_query import SqlQuerySource, check_query


class _FakeCursor:
    def __init__(self, description, rows, raise_on=None):
        self.description = description
        self._rows = rows
        self._raise = raise_on

    def execute(self, sql):
        if self._raise:
            raise self._raise
        self.last_sql = sql

    def fetchall(self):
        return self._rows

    def close(self):
        pass


class _FakeConn:
    def __init__(self, cursor):
        self._cursor = cursor
        self.closed = False

    def cursor(self):
        return self._cursor

    def close(self):
        self.closed = True


def _install_fake_pymssql(monkeypatch, cursor, connect_error=None):
    mod = types.ModuleType("pymssql")

    def _connect(**kwargs):
        if connect_error:
            raise connect_error
        return _FakeConn(cursor)

    mod.connect = _connect
    monkeypatch.setitem(sys.modules, "pymssql", mod)


def _install_fake_pandas_read_sql(monkeypatch, df):
    import connectors.sql_query as mod
    def fake_read_sql(query, conn):
        return df
    monkeypatch.setattr(mod.pd, "read_sql", fake_read_sql)


def test_load_populates_dataframe(monkeypatch):
    cur = _FakeCursor([("a",), ("b",)], [("1", "x"), ("2", "y")])
    _install_fake_pymssql(monkeypatch, cur)
    df = pd.DataFrame({"a": [1, 2], "b": ["x", "y"]})
    _install_fake_pandas_read_sql(monkeypatch, df)

    src = SqlQuerySource(
        connection={"server": "s", "database": "d", "username": "u", "password": "p"},
        query="SELECT a, b FROM t",
    )
    out = src.load()
    assert list(out.columns) == ["a", "b"]
    # All values coerced to str, no NaN
    assert (out.dtypes == object).all()
    assert src.columns() == ["a", "b"]


def test_is_stale_always_true(monkeypatch):
    cur = _FakeCursor([("a",)], [])
    _install_fake_pymssql(monkeypatch, cur)
    _install_fake_pandas_read_sql(monkeypatch, pd.DataFrame({"a": []}))
    src = SqlQuerySource(connection={}, query="SELECT 1 AS a")
    assert src.is_stale() is True
    src.load()
    assert src.is_stale() is True  # still stale after load


def test_check_query_success(monkeypatch):
    cur = _FakeCursor([("col1", None), ("col2", None)], [])
    _install_fake_pymssql(monkeypatch, cur)
    r = check_query({"server": "s"}, "SELECT 1")
    assert r["ok"] is True
    assert r["columns"] == ["col1", "col2"]


def test_check_query_syntax_error(monkeypatch):
    cur = _FakeCursor([], [], raise_on=Exception("Incorrect syntax near 'FRRM'."))
    _install_fake_pymssql(monkeypatch, cur)
    r = check_query({"server": "s"}, "SELECT FRRM t")
    assert r["ok"] is False
    assert "Incorrect syntax" in r["error"]


def test_check_query_connect_failure(monkeypatch):
    _install_fake_pymssql(monkeypatch, None, connect_error=Exception("Login failed for user 'x'."))
    r = check_query({"server": "s"}, "SELECT 1")
    assert r["ok"] is False
    assert "Login failed" in r["error"]
