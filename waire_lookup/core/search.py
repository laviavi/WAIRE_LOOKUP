from dataclasses import dataclass
from typing import Literal

import pandas as pd

from .normalize import normalize_key


@dataclass
class SearchResult:
    rows: pd.DataFrame
    full_rows: pd.DataFrame
    total_matches: int
    not_found: list[str]
    truncated: bool


def search(
    df: pd.DataFrame,
    column_queries: list[tuple[str, list[str]]],
    mode: Literal["exact", "partial"],
    limit: int = 50,
) -> SearchResult:
    """
    AND across columns, OR within each column's value list.
    A row matches when every column matches at least one of its values.
    """
    empty = df.iloc[0:0].copy()
    empty["_matched_on"] = pd.Series(dtype=str)
    empty["_duplicate"] = pd.Series(dtype=bool)
    empty_result = SearchResult(rows=empty, full_rows=empty, total_matches=0, not_found=[], truncated=False)

    if not column_queries:
        return empty_result

    # AND mask: start all-True, narrow per column
    mask = pd.Series(True, index=df.index)
    for col, values in column_queries:
        if col not in df.columns:
            continue
        norm_col = df[col].apply(normalize_key)
        col_mask = pd.Series(False, index=df.index)
        for value in values:
            norm_v = normalize_key(value)
            if mode == "exact":
                col_mask = col_mask | (norm_col == norm_v)
            else:
                col_mask = col_mask | norm_col.str.contains(norm_v, regex=False)
        mask = mask & col_mask

    result_df = df[mask].copy()

    # Values that match no row in the dataset (checked against full df, not AND result)
    not_found: list[str] = []
    for col, values in column_queries:
        if col not in df.columns:
            continue
        norm_col = df[col].apply(normalize_key)
        for value in values:
            norm_v = normalize_key(value)
            if mode == "exact":
                found = (norm_col == norm_v).any()
            else:
                found = norm_col.str.contains(norm_v, regex=False).any()
            if not found:
                not_found.append(value)

    if result_df.empty:
        return SearchResult(rows=empty, full_rows=empty, total_matches=0, not_found=not_found, truncated=False)

    matched_on = result_df.apply(
        lambda row: _matched_on_for_row(row, column_queries, mode), axis=1
    )
    result_df["_matched_on"] = matched_on
    # A row is a duplicate when the value it matched on also matched other rows.
    counts = matched_on.value_counts()
    result_df["_duplicate"] = matched_on.map(lambda m: counts.get(m, 0) > 1)

    total = len(result_df)
    truncated = total > limit
    display_df = result_df.iloc[:limit] if truncated else result_df

    return SearchResult(
        rows=display_df,
        full_rows=result_df,
        total_matches=total,
        not_found=not_found,
        truncated=truncated,
    )


def _matched_on_for_row(row: pd.Series, column_queries: list[tuple[str, list[str]]], mode: str) -> str:
    parts = []
    for col, values in column_queries:
        if col not in row.index:
            continue
        norm_cell = normalize_key(str(row[col]))
        for v in values:
            norm_v = normalize_key(v)
            matched = (norm_cell == norm_v) if mode == "exact" else (norm_v in norm_cell)
            if matched:
                parts.append(f"{col} = {v}")
                break
    return " & ".join(parts)
