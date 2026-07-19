"""Group a template's views by the sheet/table they read from.

Views in a template can now (schema v4) override the primary source's
sheet_name/table_name. Views that share the same effective sheet/table
also share a single loaded DataFrame and a single search() call. This
module resolves each view's effective (sheet, table) and buckets views
accordingly. Pure Python — no Flask, no pandas, no file IO — so it's
trivially unit-testable.
"""

from dataclasses import dataclass, field


@dataclass
class ViewGroup:
    key: str                    # stable identifier: "sheet|table" (+ join suffix)
    sheet_name: str | None
    table_name: str | None
    views: list[dict] = field(default_factory=list)  # original view dicts
    is_primary: bool = False    # True iff this group matches the template's primary source
    # Same-workbook merge (left join): when set, this group's base sheet is
    # left-joined to join_sheet_name on join_on before searching/display.
    join_sheet_name: str | None = None
    join_on: list = field(default_factory=list)   # [{"left": col, "right": col}, ...]


def _norm(v):
    """Normalize sheet/table for comparison — None/'' collapse to None."""
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def _group_key(sheet: str | None, table: str | None) -> str:
    return f"{sheet or ''}|{table or ''}"


def group_views_by_source(template: dict) -> list[ViewGroup]:
    """Return one ViewGroup per unique (sheet_name, table_name) tuple.

    Order: primary-source group first, then remaining groups in first-seen order.
    If the template has no views, synthesizes a single primary group from
    result_columns (or all source columns) — matches the existing fallback
    in api_search.
    """
    src = template.get("source", {}) or {}
    primary_sheet = _norm(src.get("sheet_name"))
    primary_table = _norm(src.get("table_name"))
    primary_key = _group_key(primary_sheet, primary_table)

    views = template.get("views") or []
    if not views:
        # Synthesize a default view — matches api_search's fallback.
        default_cols = template.get("result_columns", [])
        views = [{"name": "Default", "columns": list(default_cols)}]

    by_key: dict[str, ViewGroup] = {}
    order: list[str] = []
    for v in views:
        vsheet = _norm(v.get("sheet_name")) if v.get("sheet_name") is not None else primary_sheet
        vtable = _norm(v.get("table_name")) if v.get("table_name") is not None else primary_table
        # A view that explicitly sets sheet_name but not table_name should NOT
        # inherit the primary table_name (choosing a different sheet means
        # forget the table from the old sheet).
        if v.get("sheet_name") is not None and v.get("table_name") is None:
            vtable = None

        # A merged (left-join) view spans two sheets, so it can't share a
        # single-sheet bucket — it gets its own group keyed with the join.
        join = v.get("join") or {}
        join_sheet = _norm(join.get("sheet_name"))
        if join_sheet:
            join_on = join.get("on") or []
            key = _group_key(vsheet, vtable) + "|JOIN|" + join_sheet
            if key not in by_key:
                by_key[key] = ViewGroup(
                    key=key, sheet_name=vsheet, table_name=vtable, views=[],
                    is_primary=False, join_sheet_name=join_sheet, join_on=join_on,
                )
                order.append(key)
            by_key[key].views.append(v)
            continue

        key = _group_key(vsheet, vtable)
        if key not in by_key:
            by_key[key] = ViewGroup(
                key=key,
                sheet_name=vsheet,
                table_name=vtable,
                views=[],
                is_primary=(key == primary_key),
            )
            order.append(key)
        by_key[key].views.append(v)

    # Primary group first if it exists among the resolved groups.
    ordered_keys = ([primary_key] if primary_key in by_key else []) + [
        k for k in order if k != primary_key
    ]
    return [by_key[k] for k in ordered_keys]
