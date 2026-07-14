import re


def parse_values(raw: str) -> list[str]:
    """
    Split a field input into a list of search values.
    Delimiter: commas and newlines.
    Wrap a value in ' or " to include literal commas inside it.
    """
    values: list[str] = []
    current: list[str] = []
    in_quote: str | None = None

    for ch in raw:
        if in_quote:
            if ch == in_quote:
                in_quote = None
            else:
                current.append(ch)
        elif ch in ('"', "'"):
            in_quote = ch
        elif ch in (',', '\n', '\r'):
            val = ''.join(current).strip()
            if val:
                values.append(val)
            current = []
        else:
            current.append(ch)

    val = ''.join(current).strip()
    if val:
        values.append(val)

    return values


def normalize_key(value: str) -> str:
    value = value.strip()
    if re.match(r"^\d+\.0$", value):
        value = value[:-2]
    value = value.casefold()
    value = re.sub(r"\s+", " ", value)
    return value
