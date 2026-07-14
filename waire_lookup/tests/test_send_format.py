import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

from core.send_format import build_mail_html, build_teams_card, rows_to_html_table


def test_rows_to_html_table_escapes_values():
    html_out = rows_to_html_table(["Name"], [["<script>&\""]])
    assert "&lt;script&gt;" in html_out
    assert "&amp;" in html_out
    assert "&quot;" in html_out


def test_rows_to_html_table_column_count_and_empty_rows():
    html_out = rows_to_html_table(["A", "B", "C"], [])
    assert html_out.count("<th") == 3
    assert "<tr></tr>" not in html_out  # header-only, no body rows
    assert html_out.count("<tr>") == 1


def test_build_mail_html_contains_deep_link():
    html_out = build_mail_html("costar", ["A"], [["1"]], "http://127.0.0.1:2305/?run=1")
    assert "http://127.0.0.1:2305/?run=1" in html_out
    assert "<a href=" in html_out


def test_build_mail_html_omits_footer_without_deep_link():
    html_out = build_mail_html("costar", ["A"], [["1"]], "")
    assert "<a href=" not in html_out


def test_build_mail_html_row_count_singular_vs_plural():
    one = build_mail_html("costar", ["A"], [["1"]], "")
    many = build_mail_html("costar", ["A"], [["1"], ["2"]], "")
    assert "1 result " in one
    assert "2 results " in many


def test_build_teams_card_no_overflow_under_ten_rows():
    rows = [[str(i)] for i in range(10)]
    card = build_teams_card("t", ["A"], rows, "")
    assert len(card["sections"]) == 10
    assert not any("more rows" in s.get("text", "") for s in card["sections"])


def test_build_teams_card_overflow_section_with_count():
    rows = [[str(i)] for i in range(12)]
    card = build_teams_card("t", ["A"], rows, "")
    assert len(card["sections"]) == 11
    assert "2 more" in card["sections"][-1]["text"]


def test_build_teams_card_potential_action_only_with_deep_link():
    no_link = build_teams_card("t", ["A"], [["1"]], "")
    assert "potentialAction" not in no_link
    with_link = build_teams_card("t", ["A"], [["1"]], "http://x/")
    assert with_link["potentialAction"][0]["targets"][0]["uri"] == "http://x/"


def test_build_teams_card_facts_pair_columns_with_values():
    card = build_teams_card("t", ["A", "B"], [["1", "2"]], "")
    facts = card["sections"][0]["facts"]
    assert facts == [{"name": "A", "value": "1"}, {"name": "B", "value": "2"}]
