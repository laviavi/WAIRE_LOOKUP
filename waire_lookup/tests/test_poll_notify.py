"""M9: Source-change notification to Teams tests."""

import pytest
from core import poller


@pytest.fixture(autouse=True)
def reset_notify():
    poller._notified_versions.clear()
    yield
    poller._notified_versions.clear()


def test_notify_fires_on_version_change(monkeypatch):
    calls = []
    monkeypatch.setattr("core.send_teams.post_card", lambda url, card: calls.append((url, card)))
    monkeypatch.setattr("core.poller.load_settings", lambda: {
        "notify_webhook_id": "wh1",
        "teams_webhooks": [{"id": "wh1", "name": "ops", "url": "https://hook"}],
        "poll_minutes": 5, "card_max": 1, "graph_client_id": "", "graph_tenant": "organizations",
    })
    poller._try_notify("tpl1", "v1", "2026-07-14T10:00:00")
    assert len(calls) == 1
    assert "https://hook" == calls[0][0]


def test_no_double_notify_same_version(monkeypatch):
    calls = []
    monkeypatch.setattr("core.send_teams.post_card", lambda url, card: calls.append(1))
    monkeypatch.setattr("core.poller.load_settings", lambda: {
        "notify_webhook_id": "wh1",
        "teams_webhooks": [{"id": "wh1", "name": "ops", "url": "https://hook"}],
        "poll_minutes": 5, "card_max": 1, "graph_client_id": "", "graph_tenant": "organizations",
    })
    poller._try_notify("tpl1", "v1", "2026-07-14T10:00:00")
    poller._try_notify("tpl1", "v1", "2026-07-14T10:00:00")
    assert len(calls) == 1


def test_notify_disabled_by_default(monkeypatch):
    calls = []
    monkeypatch.setattr("core.send_teams.post_card", lambda url, card: calls.append(1))
    monkeypatch.setattr("core.poller.load_settings", lambda: {
        "notify_webhook_id": "",
        "teams_webhooks": [], "poll_minutes": 5, "card_max": 1,
        "graph_client_id": "", "graph_tenant": "organizations",
    })
    poller._try_notify("tpl1", "v1", "2026-07-14T10:00:00")
    assert len(calls) == 0


def test_post_card_failure_no_crash(monkeypatch):
    def boom(url, card):
        raise RuntimeError("network down")
    monkeypatch.setattr("core.send_teams.post_card", boom)
    monkeypatch.setattr("core.poller.load_settings", lambda: {
        "notify_webhook_id": "wh1",
        "teams_webhooks": [{"id": "wh1", "name": "ops", "url": "https://hook"}],
        "poll_minutes": 5, "card_max": 1, "graph_client_id": "", "graph_tenant": "organizations",
    })
    logged = []
    monkeypatch.setattr("core.poller.log.log_source_error", lambda k, m: logged.append(m))
    poller._try_notify("tpl1", "v1", "2026-07-14T10:00:00")
    assert any("notify" in m for m in logged)
