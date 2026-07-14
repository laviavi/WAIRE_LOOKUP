"""SQL Server DataSource — runs a free-form query via pymssql.

Always re-queries on `load()` — no staleness signal exists for live SQL data
like there is for file mtime, so `is_stale()` returns True. In practice, the
_sources cache in app.py holds this instance for identity only; the DataFrame
inside is invalidated every search via source.load() being called freshly.

pymssql is intentionally imported lazily so the app can start up even when
the driver isn't installed yet (Excel/SharePoint templates keep working).
"""

from datetime import datetime

import pandas as pd

from connectors.base import DataSource


class SqlQuerySource(DataSource):
    def __init__(self, connection: dict, query: str):
        self._conn = connection
        self._query = query
        self._df: pd.DataFrame | None = None
        self._loaded_at: datetime | None = None

    def _connect(self):
        import pymssql  # lazy import — see module docstring
        return pymssql.connect(
            server=self._conn.get("server", ""),
            port=int(self._conn.get("port", 1433)),
            database=self._conn.get("database", ""),
            user=self._conn.get("username", ""),
            password=self._conn.get("password", ""),
            login_timeout=15,
            timeout=120,
        )

    def load(self) -> pd.DataFrame:
        conn = self._connect()
        try:
            df = pd.read_sql(self._query, conn)
        finally:
            try:
                conn.close()
            except Exception:
                pass
        # Match Excel/CSV connectors: everything as string, no NaN, so the
        # normalize/search pipeline treats SQL rows identically to file rows.
        self._df = df.fillna("").astype(str)
        self._loaded_at = datetime.now()
        return self._df

    def columns(self) -> list[str]:
        if self._df is None:
            self.load()
        return list(self._df.columns)

    def source_timestamp(self) -> datetime:
        return self._loaded_at or datetime.now()

    def is_stale(self) -> bool:
        # No cheap freshness signal for a live query — always re-run.
        return True

    @property
    def dataframe(self) -> pd.DataFrame | None:
        return self._df


def check_query(connection: dict, query: str) -> dict:
    """Run the query wrapped as `SELECT TOP 0` so no data is fetched.

    Returns {"ok": True, "columns": [...]} on success, or
    {"ok": False, "error": "<raw pymssql error>"} on failure.
    """
    wrapped = f"SELECT TOP 0 * FROM (\n{query}\n) AS q"
    try:
        import pymssql
    except Exception as e:
        return {"ok": False, "error": f"pymssql driver not installed: {e}"}
    try:
        conn = pymssql.connect(
            server=connection.get("server", ""),
            port=int(connection.get("port", 1433)),
            database=connection.get("database", ""),
            user=connection.get("username", ""),
            password=connection.get("password", ""),
            login_timeout=15,
            timeout=30,
        )
    except Exception as e:
        return {"ok": False, "error": str(e)}
    try:
        cur = conn.cursor()
        cur.execute(wrapped)
        # cur.description is (name, type_code, ...) tuples
        cols = [d[0] for d in (cur.description or [])]
        return {"ok": True, "columns": cols}
    except Exception as e:
        return {"ok": False, "error": str(e)}
    finally:
        try:
            conn.close()
        except Exception:
            pass
