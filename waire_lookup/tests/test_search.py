import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

import pandas as pd
from core.search import search


def make_df():
    return pd.DataFrame({
        "ID": ["00123", "00456", "00789", "00123", "104512"],
        "Name": ["Alpha Corp", "Beta Inc", "Gamma LLC", "Alpha Corp Dup", "Delta Co"],
        "Status": ["Active", "Inactive", "Active", "Active", "Active"],
    })


def test_exact_single_match():
    df = make_df()
    r = search(df, [("ID", ["00456"])], "exact")
    assert r.total_matches == 1
    assert r.not_found == []


def test_exact_no_match():
    df = make_df()
    r = search(df, [("ID", ["99999"])], "exact")
    assert r.total_matches == 0
    assert r.not_found == ["99999"]


def test_partial_match():
    df = make_df()
    r = search(df, [("Name", ["alpha"])], "partial")
    assert r.total_matches == 2
    assert r.not_found == []


def test_duplicate_flagging():
    df = make_df()
    r = search(df, [("ID", ["00123"])], "exact")
    assert r.total_matches == 2
    assert all(r.rows["_duplicate"])


def test_no_duplicate_flag_single_match():
    df = make_df()
    r = search(df, [("ID", ["00456"])], "exact")
    assert not r.rows["_duplicate"].any()


def test_truncation():
    rows = [{"ID": str(i), "Name": f"Name {i}"} for i in range(60)]
    df = pd.DataFrame(rows)
    r = search(df, [("Name", ["name"])], "partial", limit=50)
    assert r.truncated is True
    assert len(r.rows) == 50
    assert r.total_matches == 60
    assert len(r.full_rows) == 60


def test_no_truncation_under_cap():
    df = make_df()
    r = search(df, [("ID", ["00123"])], "exact", limit=50)
    assert r.truncated is False


def test_case_insensitive_exact():
    df = make_df()
    r = search(df, [("Name", ["ALPHA CORP"])], "exact")
    assert r.total_matches == 1


def test_leading_zeros_preserved():
    df = make_df()
    r = search(df, [("ID", ["00123"])], "exact")
    assert r.total_matches == 2


def test_excel_float_artifact():
    df = pd.DataFrame({"ID": ["104512"], "Name": ["Delta Co"]})
    r = search(df, [("ID", ["104512.0"])], "exact")
    assert r.total_matches == 1


def test_matched_on_column():
    df = make_df()
    r = search(df, [("ID", ["00456"])], "exact")
    assert "ID" in r.rows["_matched_on"].iloc[0]
    assert "00456" in r.rows["_matched_on"].iloc[0]


def test_card_title_exact_is_record_value_no_tag():
    df = make_df()
    r = search(df, [("ID", ["00456"])], "exact")
    # Exact match: card title is the record's actual value, no annotation.
    assert r.rows["_card_title"].iloc[0] == "00456"
    assert "(partial match)" not in r.rows["_card_title"].iloc[0]


def test_card_title_partial_shows_record_value_and_tag():
    df = make_df()
    # Searching "1045" partially hits the record whose ID is "104512".
    r = search(df, [("ID", ["1045"])], "partial")
    assert r.total_matches == 1
    title = r.rows["_card_title"].iloc[0]
    assert title == "104512 (partial match)"


def test_card_title_partial_but_exact_value_has_no_tag():
    df = make_df()
    # Partial mode, but the record value equals the search value exactly.
    r = search(df, [("ID", ["00456"])], "partial")
    assert r.rows["_card_title"].iloc[0] == "00456"
    assert "(partial match)" not in r.rows["_card_title"].iloc[0]


def test_multi_value_or_within_column():
    df = make_df()
    r = search(df, [("ID", ["00123", "00456"])], "exact")
    assert r.total_matches == 3  # 00123 matches 2 rows, 00456 matches 1


def test_not_found_reported_per_value():
    df = make_df()
    r = search(df, [("ID", ["00123", "NOPE", "ALSO_NOPE"])], "exact")
    assert set(r.not_found) == {"NOPE", "ALSO_NOPE"}


def test_and_both_fields_must_match():
    df = make_df()
    r = search(df, [("ID", ["00123"]), ("Name", ["Alpha Corp"])], "exact")
    assert r.total_matches == 1


def test_and_narrows_results():
    df = make_df()
    r = search(df, [("Status", ["Active"]), ("Name", ["alpha"])], "partial")
    assert r.total_matches == 2


def test_and_empty_queries_returns_empty():
    df = make_df()
    r = search(df, [], "exact")
    assert r.total_matches == 0


def test_distinct_values_not_flagged_duplicate():
    df = make_df()
    # 00456 and 00789 each match exactly one row → neither is a duplicate
    r = search(df, [("ID", ["00456", "00789"])], "exact")
    assert r.total_matches == 2
    assert not r.rows["_duplicate"].any()


def test_only_ambiguous_value_flagged_duplicate():
    df = make_df()
    # 00123 matches 2 rows (duplicate), 00456 matches 1 (not)
    r = search(df, [("ID", ["00123", "00456"])], "exact")
    dup = dict(zip(r.rows["_matched_on"], r.rows["_duplicate"]))
    assert dup["ID = 00123"] is True or all(
        v for k, v in zip(r.rows["_matched_on"], r.rows["_duplicate"]) if k == "ID = 00123"
    )
    assert any(k == "ID = 00456" and not v for k, v in zip(r.rows["_matched_on"], r.rows["_duplicate"]))


def test_and_multi_value_or_plus_and():
    df = make_df()
    # ID in (00123, 00456) AND Status=Active
    # 00123 has 2 Active rows, 00456 has 1 Inactive row → 2 matches
    r = search(df, [("ID", ["00123", "00456"]), ("Status", ["Active"])], "exact")
    assert r.total_matches == 2


# ── Wildcard matching in partial mode (Server 1.19.0) ──────────────────────

def test_wildcard_starts_with():
    df = make_df()
    r = search(df, [("Name", ["alpha*"])], "partial")
    assert r.total_matches == 2
    assert r.not_found == []


def test_wildcard_ends_with():
    df = make_df()
    r = search(df, [("Name", ["*corp"])], "partial")
    assert r.total_matches == 1  # "Alpha Corp" only — "Alpha Corp Dup" doesn't end with corp


def test_wildcard_contains_both_ends():
    df = make_df()
    r = search(df, [("Name", ["*corp*"])], "partial")
    assert r.total_matches == 2


def test_wildcard_question_mark():
    df = make_df()
    r = search(df, [("ID", ["0045?"])], "partial")
    assert r.total_matches == 1  # 00456
    r = search(df, [("ID", ["1?4512"])], "partial")
    assert r.total_matches == 1  # 104512


def test_wildcard_question_requires_one_char():
    df = make_df()
    r = search(df, [("ID", ["00123?"])], "partial")
    assert r.total_matches == 0
    assert r.not_found == ["00123?"]


def test_wildcard_multiple():
    df = make_df()
    # Anchored: must START with a — "Beta Inc" contains a and c but doesn't start with a.
    r = search(df, [("Name", ["a*c*"])], "partial")
    assert r.total_matches == 2  # both Alpha Corp rows


def test_wildcard_regex_chars_escaped():
    df = pd.DataFrame({
        "Name": ["acme (usa)", "acme x"],
        "ID": ["1.5", "1x50"],
    })
    r = search(df, [("Name", ["acme (*"])], "partial")
    assert r.total_matches == 1  # parenthesis must be literal, not a regex group
    r = search(df, [("ID", ["1.5*"])], "partial")
    assert r.total_matches == 1  # dot must be literal — must NOT match "1x50"


def test_plain_partial_still_contains():
    df = make_df()
    # Backward compat: no wildcard chars → unanchored substring, exactly as before.
    r = search(df, [("Name", ["alpha"])], "partial")
    assert r.total_matches == 2


def test_exact_mode_wildcard_literal():
    df = make_df()
    r = search(df, [("Name", ["alpha*"])], "exact")
    assert r.total_matches == 0
    assert r.not_found == ["alpha*"]
    df2 = pd.DataFrame({"Name": ["alpha*", "alpha"]})
    r2 = search(df2, [("Name", ["alpha*"])], "exact")
    assert r2.total_matches == 1  # a literal cell "alpha*" matches exactly


def test_wildcard_not_found_consistency():
    df = make_df()
    r = search(df, [("Name", ["alpha*", "zzz*"])], "partial")
    assert r.total_matches == 2
    assert r.not_found == ["zzz*"]


def test_wildcard_matched_on_and_title():
    df = make_df()
    r = search(df, [("Name", ["alpha*"])], "partial")
    assert r.total_matches == 2
    assert all(m == "Name = alpha*" for m in r.rows["_matched_on"])
    assert all("(partial match)" in t for t in r.rows["_card_title"])
