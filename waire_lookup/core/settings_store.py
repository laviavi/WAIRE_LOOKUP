"""App-wide user settings — persisted, validated, not hardcoded.

Mirrors BidFloor's settings convention (a persisted store + validate_settings()
+ change logged), adapted to WAIRE LookUp's file-based architecture: settings
live in a small JSON file in the writable data dir instead of SQLite.
"""

import json

import config

DEFAULTS = {
    # Show results as vertical cards when the match count is <= this number;
    # above it, show the table. A single match is therefore always a card.
    "card_max": 1,
    # How often (minutes) the background poller checks sources for changes.
    "poll_minutes": 5,
    # Azure AD Client ID used to sign in for SharePoint access.
    # Default is Microsoft's own published "Graph Command Line Tools" public
    # client — so the user needs no Azure portal registration. Overrideable
    # via the Setup SharePoint modal for enterprise scenarios where the
    # tenant blocks the well-known ID.
    "graph_client_id": "14d82eec-204b-4c2f-b7e8-296a70dab67e",
    "graph_tenant": "organizations",
    # Saved Teams incoming webhooks: [{"id", "name", "url"}, ...]
    "teams_webhooks": [],
    "notify_webhook_id": "",
}

CARD_MAX_CEILING = 99  # Programmatic cap for now.
POLL_MINUTES_MIN, POLL_MINUTES_MAX = 1, 120
_GUID_RE = __import__("re").compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


def validate_settings(data: dict) -> dict:
    """Return a clean settings dict, applying defaults and raising on bad input."""
    out = dict(DEFAULTS)

    if "card_max" in data and data["card_max"] not in (None, ""):
        try:
            n = int(data["card_max"])
        except (TypeError, ValueError):
            raise ValueError("Card-view limit must be a whole number.")
        if n < 1:
            raise ValueError("Card-view limit must be at least 1.")
        out["card_max"] = min(n, CARD_MAX_CEILING)

    if "poll_minutes" in data and data["poll_minutes"] not in (None, ""):
        try:
            n = int(data["poll_minutes"])
        except (TypeError, ValueError):
            raise ValueError("Poll interval must be a whole number of minutes.")
        if n < POLL_MINUTES_MIN:
            raise ValueError(f"Poll interval must be at least {POLL_MINUTES_MIN} minute.")
        out["poll_minutes"] = min(n, POLL_MINUTES_MAX)

    if "graph_client_id" in data:
        v = (data["graph_client_id"] or "").strip()
        if v and not _GUID_RE.match(v):
            raise ValueError("Client ID must be a valid GUID (e.g. 11111111-2222-3333-4444-555555555555).")
        out["graph_client_id"] = v

    if "graph_tenant" in data:
        v = (data["graph_tenant"] or "").strip()
        out["graph_tenant"] = v or "organizations"

    if "teams_webhooks" in data:
        hooks = data["teams_webhooks"]
        if not isinstance(hooks, list):
            raise ValueError("teams_webhooks must be a list.")
        for h in hooks:
            if not isinstance(h, dict) or not h.get("id") or not h.get("url"):
                raise ValueError("Each Teams webhook needs an id and a url.")
        out["teams_webhooks"] = hooks

    if "notify_webhook_id" in data:
        out["notify_webhook_id"] = (data["notify_webhook_id"] or "").strip()

    return out


def load_settings() -> dict:
    """Load settings, falling back to defaults if missing or unreadable."""
    try:
        raw = json.loads(config.SETTINGS_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError, OSError):
        return dict(DEFAULTS)
    try:
        return validate_settings(raw)
    except ValueError:
        return dict(DEFAULTS)


def save_settings(data: dict) -> dict:
    """Validate and persist settings; returns the saved dict.

    Merges over the currently stored settings first, so posting a single
    field (the UI's per-control fetch pattern) never resets the others.

    For numeric fields (card_max, poll_minutes), blank/None means "keep
    current" — the UI's per-control fetch pattern shouldn't overwrite an
    unrelated numeric setting with junk.

    For string fields (graph_client_id, graph_tenant), None means "keep
    current" but blank IS a meaningful value (empty Client ID = SharePoint
    disabled). Otherwise there'd be no way to reset the Client ID.
    """
    numeric_keys = {"card_max", "poll_minutes"}
    merged = dict(load_settings())
    for k, v in data.items():
        if v is None:
            continue
        if k in numeric_keys and v == "":
            continue
        merged[k] = v
    validated = validate_settings(merged)
    config.SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    config.SETTINGS_FILE.write_text(json.dumps(validated, indent=2), encoding="utf-8")
    return validated
