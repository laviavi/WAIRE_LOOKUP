import os
from pathlib import Path

BASE_DIR = Path(__file__).parent

LOOKUP_TEMPLATES_DIR = BASE_DIR / "lookup_templates"
EXPORTS_DIR = BASE_DIR / "exports"
LOGS_DIR = BASE_DIR / "logs"
LOG_FILE = LOGS_DIR / "lookups.log"
SETTINGS_FILE = BASE_DIR / "settings.json"
SNAPSHOTS_DIR = BASE_DIR / "snapshots"
SOURCE_CACHE_DIR = BASE_DIR / "source_cache"
SOURCE_STATUS_FILE = BASE_DIR / "source_status.json"
TOKEN_CACHE_FILE = BASE_DIR / "token_cache.json"
SQL_CONNECTIONS_FILE = BASE_DIR / "sql_connections.json"
SQL_CREDENTIALS_FILE = BASE_DIR / "sql_credentials.dat"  # DPAPI-encrypted blob

UPDATE_REPO = "laviavi/WAIRE_LOOKUP"

SEARCH_RESULT_CAP = 50
SNAPSHOT_TTL_HOURS = 24

SECRET_KEY = os.environ.get("WAIRE_SECRET_KEY", "waire-lookup-dev-secret")
