import re
from dataclasses import dataclass
from functools import lru_cache
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


@lru_cache(maxsize=512)
def _value_matcher(norm_v: str, mode: str):
    """The single matching definition for a normalized search value, shared by
    the mask loop, the not_found loop, and _matched_on_for_row so the three
    sites can never disagree.

    Returns (series_match, cell_match):
      series_match(norm_col: pd.Series[str]) -> pd.Series[bool]
      cell_match(norm_cell: str) -> bool

    exact: equality (wildcards are literal characters).
    partial: anchored wildcard pattern when the value contains * (any chars)
    or ? (exactly one char); plain substring otherwise (backward compatible).
    """
    if mode == "exact":
        return (lambda col: col == norm_v), (lambda cell: cell == norm_v)
    if "*" in norm_v or "?" in norm_v:
        pat = re.compile("".join(
            ".*" if ch == "*" else "." if ch == "?" else re.escape(ch)
            for ch in norm_v
        ))
        return (
            lambda col: col.str.fullmatch(pat),
            lambda cell: pat.fullmatch(cell) is not None,
        )
    return (
        lambda col: col.str.contains(norm_v, regex=False),
        lambda cell: norm_v in cell,
    )


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
    empty["_card_title"] = pd.Series(dtype=str)
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
            series_match, _ = _value_matcher(normalize_key(value), mode)
            col_mask = col_mask | series_match(norm_col)
        mask = mask & col_mask

    result_df = df[mask].copy()

    # Values that match no row in the dataset (checked against full df, not AND result)
    not_found: list[str] = []
    for col, values in column_queries:
        if col not in df.columns:
            continue
        norm_col = df[col].apply(normalize_key)
        for value in values:
            series_match, _ = _value_matcher(normalize_key(value), mode)
            if not series_match(norm_col).any():
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
    # Card title: the record's own value in the matched key column, tagged
    # "(partial match)" when the record value isn't equal to the searched value.
    result_df["_card_title"] = result_df.apply(
        lambda row: _card_title_for_row(row, column_queries), axis=1
    )

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
            _, cell_match = _value_matcher(normalize_key(v), mode)
            if cell_match(norm_cell):
                parts.append(f"{col} = {v}")
                break
    return " & ".join(parts)


def _card_title_for_row(row: pd.Series, column_queries: list[tuple[str, list[str]]]) -> str:
    """The record's actual value(s) in the matched key column(s). Appends
    '(partial match)' when the record value differs from the searched value
    (i.e. a substring hit rather than an exact one)."""
    parts = []
    any_partial = False
    for col, values in column_queries:
        if col not in row.index:
            continue
        cell = str(row[col])
        norm_cell = normalize_key(cell)
        exact = any(normalize_key(v) == norm_cell for v in values)
        if not exact:
            any_partial = True
        parts.append(cell)
    title = " & ".join(parts)
    if any_partial:
        title += " (partial match)"
    return title
