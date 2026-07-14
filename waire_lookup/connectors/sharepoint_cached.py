"""A SharePoint-backed DataSource that reads from the local cache.

Downloads the file once (on first use) into `config.SOURCE_CACHE_DIR`, then
delegates all parsing/staleness to the existing `SyncedFileSource` pointed at
the cache path. The cache path is derived from the driveItem id — never
stored in the template — so templates stay portable across machines.
"""

from pathlib import Path

from .synced_file import SyncedFileSource
from core import source_sync


class SharePointCachedSource(SyncedFileSource):
    def __init__(self, *, drive_id: str, item_id: str, name: str,
                 sheet_name: str | None = None, table_name: str | None = None,
                 header_row: int = 0, template_name: str = ""):
        self._drive_id = drive_id
        self._item_id = item_id
        self._name = name
        self._template_name = template_name
        cache_path = source_sync.cache_path_for(item_id, name)
        super().__init__(
            path=str(cache_path),
            sheet_name=sheet_name,
            table_name=table_name,
            header_row=header_row,
        )

    def ensure_cached(self) -> None:
        """Trigger a download if the cache file doesn't exist yet."""
        if self._path.exists():
            return
        source_sync.sync_sharepoint_source({
            "type": "sharepoint",
            "drive_id": self._drive_id,
            "item_id": self._item_id,
            "name": self._name,
        }, self._template_name)

    def load(self):  # pragma: no cover - trivial passthrough
        self.ensure_cached()
        return super().load()
