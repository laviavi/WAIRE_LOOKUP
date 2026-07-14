import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

from core.normalize import normalize_key


def test_strips_whitespace():
    assert normalize_key("  hello  ") == "hello"

def test_casefold():
    assert normalize_key("FACILITY") == "facility"

def test_collapses_internal_spaces():
    assert normalize_key("foo   bar") == "foo bar"

def test_strips_trailing_dot_zero():
    assert normalize_key("104512.0") == "104512"

def test_non_integer_dot_zero_unchanged():
    assert normalize_key("3.14") == "3.14"
    assert normalize_key("abc.0") == "abc.0"

def test_leading_zeros_preserved():
    assert normalize_key("00123") == "00123"

def test_mixed():
    assert normalize_key("  South Coast  AQMD  ") == "south coast aqmd"

def test_empty():
    assert normalize_key("") == ""
