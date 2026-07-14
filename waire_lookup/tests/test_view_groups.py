from core.view_groups import group_views_by_source


def test_single_view_no_override_uses_primary():
    t = {
        "source": {"path": "x.xlsx", "sheet_name": "S1", "table_name": None},
        "views": [{"name": "v1", "columns": ["A", "B"]}],
    }
    gs = group_views_by_source(t)
    assert len(gs) == 1
    g = gs[0]
    assert g.sheet_name == "S1" and g.table_name is None
    assert g.is_primary is True
    assert [v["name"] for v in g.views] == ["v1"]


def test_two_views_same_primary_share_one_group():
    t = {
        "source": {"path": "x.xlsx", "sheet_name": "S1"},
        "views": [
            {"name": "owner", "columns": ["A"]},
            {"name": "dealer", "columns": ["B"]},
        ],
    }
    gs = group_views_by_source(t)
    assert len(gs) == 1
    assert [v["name"] for v in gs[0].views] == ["owner", "dealer"]


def test_view_overrides_sheet_creates_second_group():
    t = {
        "source": {"path": "x.xlsx", "sheet_name": "S1"},
        "views": [
            {"name": "owner", "columns": ["A"]},
            {"name": "dealer", "columns": ["B"], "sheet_name": "S2"},
        ],
    }
    gs = group_views_by_source(t)
    assert len(gs) == 2
    # Primary group first
    assert gs[0].is_primary and gs[0].sheet_name == "S1"
    assert [v["name"] for v in gs[0].views] == ["owner"]
    assert gs[1].sheet_name == "S2" and gs[1].is_primary is False
    assert [v["name"] for v in gs[1].views] == ["dealer"]


def test_view_override_sheet_drops_primary_table():
    """A view choosing a new sheet should not inherit the primary table_name."""
    t = {
        "source": {"path": "x.xlsx", "sheet_name": "S1", "table_name": "T1"},
        "views": [
            {"name": "a", "columns": ["A"]},
            {"name": "b", "columns": ["B"], "sheet_name": "S2"},
        ],
    }
    gs = group_views_by_source(t)
    assert len(gs) == 2
    assert gs[1].sheet_name == "S2" and gs[1].table_name is None


def test_no_views_synthesizes_default_group():
    t = {
        "source": {"path": "x.xlsx", "sheet_name": "S1"},
        "result_columns": ["A", "B"],
    }
    gs = group_views_by_source(t)
    assert len(gs) == 1
    assert gs[0].views[0]["name"] == "Default"
    assert gs[0].views[0]["columns"] == ["A", "B"]


def test_primary_group_ordered_first_even_when_secondary_defined_first():
    t = {
        "source": {"path": "x.xlsx", "sheet_name": "S1"},
        "views": [
            {"name": "b", "columns": ["B"], "sheet_name": "S2"},
            {"name": "a", "columns": ["A"]},
        ],
    }
    gs = group_views_by_source(t)
    assert gs[0].is_primary and gs[0].sheet_name == "S1"
    assert gs[1].sheet_name == "S2"


def test_empty_string_sheet_override_treated_as_none():
    t = {
        "source": {"path": "x.xlsx", "sheet_name": "S1"},
        "views": [{"name": "v", "columns": ["A"], "sheet_name": "   "}],
    }
    gs = group_views_by_source(t)
    # Whitespace override collapses to None (default sheet), so is_primary False since primary is "S1"
    assert gs[0].sheet_name is None
