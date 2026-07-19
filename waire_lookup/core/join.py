"""Left-join two sheets of the SAME workbook for a merged builder view.

Pure (pandas + normalize only, no Flask/IO) so it's unit-testable without a
workbook. Matching uses the same normalize_key as search() so messy-Excel key
variants ("123 Main St " vs "123 main st") still line up.

Column naming: join-sheet columns are ALWAYS suffixed " (SheetName)" in the
merged frame (not only on collision) so the builder can reverse a display name
back to its sheet unambiguously. Join-key columns are dropped from the join
side (redundant with the base copy after the join).
"""

import pandas as pd

from .normalize import normalize_key


def join_suffix(join_label: str) -> str:
    return f" ({join_label})"


def join_column_names(join_cols: list[str], right_keys: list[str], join_label: str) -> dict:
    """Ordered {original_join_col: final_display_name} for the columns the join
    sheet contributes. Join-key columns are excluded; everything else is
    suffixed with the join sheet's name."""
    right_key_set = set(right_keys)
    suffix = join_suffix(join_label)
    return {c: c + suffix for c in join_cols if c not in right_key_set}


def left_join(base_df: pd.DataFrame, join_df: pd.DataFrame,
              on: list[dict], join_label: str) -> pd.DataFrame:
    """base LEFT JOIN join_df on the (left,right) column pairs in `on`,
    matched on normalized keys. One row per base row (first match wins on the
    join side). Join-sheet columns are renamed per join_column_names and
    appended; unmatched base rows get '' in those columns.

    on: [{"left": <base col>, "right": <join col>}, ...]
    """
    base = base_df.reset_index(drop=True).copy()
    join = join_df.copy()

    tmp_keys = []
    for i, pair in enumerate(on):
        tk = f"__jk_{i}__"
        base[tk] = base[pair["left"]].apply(normalize_key)
        join[tk] = join[pair["right"]].apply(normalize_key)
        tmp_keys.append(tk)

    colmap = join_column_names(
        list(join_df.columns), [p["right"] for p in on], join_label,
    )
    # ponytail: first match wins — dedupe the join side so a base row can't
    # fan out to multiple rows. Upgrade to explicit one-to-many only if a real
    # workbook needs it.
    join_slim = join.drop_duplicates(subset=tmp_keys, keep="first")
    join_slim = join_slim[tmp_keys + list(colmap.keys())].rename(columns=colmap)

    merged = base.merge(join_slim, how="left", on=tmp_keys)
    merged = merged.drop(columns=tmp_keys)
    return merged.fillna("")


if __name__ == "__main__":  # tiny self-check
    b = pd.DataFrame({"Addr": ["1 A st", "2 B st", "9 Z st"], "City": ["LA", "SF", "SD"]})
    j = pd.DataFrame({"Addr": ["1 a st ", "2 B ST"], "City": ["x", "y"], "Owner": ["Ann", "Bob"]})
    m = left_join(b, j, [{"left": "Addr", "right": "Addr"}], "Sheet2")
    assert list(m.columns) == ["Addr", "City", "City (Sheet2)", "Owner (Sheet2)"], list(m.columns)
    assert m.loc[0, "Owner (Sheet2)"] == "Ann"     # normalized match despite case/space
    assert m.loc[1, "Owner (Sheet2)"] == "Bob"
    assert m.loc[2, "Owner (Sheet2)"] == ""        # no match -> blank, base row kept
    assert list(m["City"]) == ["LA", "SF", "SD"]   # base City untouched
    print("core/join.py self-check passed")
