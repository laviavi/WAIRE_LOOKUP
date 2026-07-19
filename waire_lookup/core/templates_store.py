import json
import logging
import re
from pathlib import Path
from typing import Any

import config
from .view_groups import group_views_by_source

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 4
# Schema notes:
#   v3: views: [{name, columns}]
#   v4: views may optionally override sheet_name/table_name to point at a
#       different sheet/table in the SAME workbook (source.path/url unchanged).
#       Omitted → the view uses the template's primary source sheet/table.
#       v3 templates on disk keep working unchanged (per-view overrides absent).
#       A view may also carry join: {sheet_name, on:[{left,right}]} to LEFT JOIN
#       a second sheet of the same workbook (merged view — see core/join.py);
#       the template carries sheet_joins:[{left_sheet,right_sheet,on}] for the
#       declared joins so the builder round-trips them on edit.


def _slug(name: str) -> str:
    return re.sub(r"[^\w\-]", "_", name).lower()


def _template_path(name: str) -> Path:
    return config.LOOKUP_TEMPLATES_DIR / f"{_slug(name)}.json"


def validate_template(t: dict, available_columns: list[str] | None = None) -> list[str]:
    problems = []

    if not t.get("name", "").strip():
        problems.append("Template name is required.")

    source = t.get("source", {})
    stype = (source.get("type") or "local").strip()
    if stype == "sharepoint":
        if not (source.get("url") or "").strip():
            problems.append("SharePoint URL is required.")
        if not (source.get("drive_id") or "").strip() or not (source.get("item_id") or "").strip():
            problems.append("SharePoint file could not be resolved (drive_id/item_id missing).")
    elif stype == "sql":
        if not (source.get("connection_id") or "").strip():
            problems.append("SQL connection is required.")
        if not (source.get("query") or "").strip():
            problems.append("SQL query is required.")
    else:
        if not (source.get("path") or "").strip():
            problems.append("Source path is required.")

    key_columns = t.get("key_columns", [])
    result_columns = t.get("result_columns", [])
    views = t.get("views", [])

    if not key_columns:
        problems.append("At least one key column is required.")

    # Views take priority; result_columns required only when no views defined.
    if views:
        for i, v in enumerate(views):
            if not v.get("name", "").strip():
                problems.append(f"View {i+1} must have a name.")
            if not v.get("columns"):
                problems.append(f"View '{v.get('name', i+1)}' must have at least one column.")
    else:
        if not result_columns:
            problems.append("At least one result column is required.")

    if available_columns is not None:
        col_set = set(available_columns)
        # available_columns is always the PRIMARY source's columns only. A
        # multi-sheet template (schema v4) can have keys and view columns that
        # live on a different sheet entirely, which this check has no way to
        # verify cheaply — so only enforce it when there's nowhere else a
        # column could legitimately be hiding (a single-sheet template).
        groups = group_views_by_source(t)
        single_sheet = len(groups) <= 1
        for col in key_columns:
            if col not in col_set and single_sheet:
                problems.append(f"Key column '{col}' not found in source (columns may have been renamed).")
        check_cols = []
        if views:
            primary_group = next((g for g in groups if g.is_primary), None)
            primary_views = primary_group.views if primary_group else views
            for v in views:
                if v in primary_views:
                    check_cols.extend(v.get("columns", []))
        else:
            check_cols = result_columns
        for col in check_cols:
            if col not in col_set:
                problems.append(f"Result column '{col}' not found in source (columns may have been renamed).")
        df_filter = t.get("default_filter")
        if df_filter and df_filter.get("column") and df_filter["column"] not in col_set:
            problems.append(f"Filter column '{df_filter['column']}' not found in source.")

    return problems


def save_template(t: dict) -> None:
    problems = validate_template(t)
    if problems:
        raise ValueError("Invalid template: " + "; ".join(problems))

    t = dict(t)
    t["schema_version"] = SCHEMA_VERSION
    # Keep result_columns mirroring views[0] for backward compat with old readers.
    if t.get("views"):
        t["result_columns"] = list(t["views"][0]["columns"])

    config.LOOKUP_TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)
    path = _template_path(t["name"])
    path.write_text(json.dumps(t, indent=2), encoding="utf-8")


def load_template(name: str) -> dict:
    path = _template_path(name)
    return json.loads(path.read_text(encoding="utf-8"))


def list_templates() -> list[dict]:
    templates = []
    for path in sorted(config.LOOKUP_TEMPLATES_DIR.glob("*.json")):
        try:
            templates.append(json.loads(path.read_text(encoding="utf-8")))
        except Exception as e:
            logger.warning("Skipping malformed template %s: %s", path.name, e)
    return templates


def delete_template(name: str) -> None:
    path = _template_path(name)
    if path.exists():
        path.unlink()
