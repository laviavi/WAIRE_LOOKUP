"""Check GitHub Releases for a newer version. Never raises."""

import time

_cache: tuple[float, dict | None] = (0.0, None)
_CACHE_TTL = 6 * 3600


def fetch_latest_release(repo: str, timeout: float = 5.0) -> dict | None:
    try:
        import requests
        r = requests.get(
            f"https://api.github.com/repos/{repo}/releases/latest",
            timeout=timeout,
            headers={"Accept": "application/vnd.github+json"},
        )
        if r.status_code != 200:
            return None
        j = r.json()
        tag = j.get("tag_name")
        url = j.get("html_url")
        if not tag:
            return None
        return {"tag": tag, "url": url or ""}
    except Exception:
        return None


def is_newer(latest_tag: str, current: str) -> bool:
    try:
        def _ints(v: str) -> tuple[int, ...]:
            return tuple(int(x) for x in v.lstrip("v").split("."))
        return _ints(latest_tag) > _ints(current)
    except Exception:
        return False


def check_update(repo: str, current_version: str) -> dict:
    global _cache
    now = time.monotonic()
    if _cache[1] is not None and (now - _cache[0]) < _CACHE_TTL:
        return _cache[1]
    latest = fetch_latest_release(repo)
    if latest is None:
        result = {"update_available": False, "latest": None, "url": None}
    else:
        result = {
            "update_available": is_newer(latest["tag"], current_version),
            "latest": latest["tag"],
            "url": latest["url"],
        }
    _cache = (now, result)
    return result
