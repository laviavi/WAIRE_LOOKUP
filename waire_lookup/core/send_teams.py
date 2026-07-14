"""Post a MessageCard to a Teams incoming webhook."""

import requests


def post_card(webhook_url: str, card: dict) -> None:
    if not webhook_url.startswith("https://"):
        raise ValueError("Webhook URL must start with https://.")
    try:
        resp = requests.post(webhook_url, json=card, timeout=10)
    except requests.RequestException as e:
        raise ValueError(f"Could not reach Teams webhook: {e}")
    if resp.status_code not in (200, 202):
        raise ValueError(f"Teams webhook returned {resp.status_code}: {resp.text[:200]}")
