from datetime import datetime
from pathlib import Path

import config


def _write(line: str) -> None:
    config.LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(config.LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def log_search(
    template_name: str,
    mode: str,
    value_count: int,
    match_count: int,
    not_found: list[str],
    duration_ms: int,
) -> None:
    not_found_str = ",".join(not_found) if not_found else ""
    ts = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    _write(
        f"{ts} | template={template_name} | mode={mode} | values={value_count} "
        f"| matches={match_count} | not_found={not_found_str} | duration_ms={duration_ms}"
    )


def log_refresh(source_path: str) -> None:
    ts = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    _write(f"{ts} | event=refresh | source={source_path}")


def log_template_save(template_name: str) -> None:
    ts = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    _write(f"{ts} | event=template_save | template={template_name}")


def log_template_edit(template_name: str) -> None:
    ts = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    _write(f"{ts} | event=template_edit | template={template_name}")


def log_settings_change(settings: dict) -> None:
    ts = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    pairs = " ".join(f"{k}={v}" for k, v in settings.items())
    _write(f"{ts} | event=settings_change | {pairs}")


def log_source_update(source_key: str, version: str) -> None:
    ts = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    _write(f"{ts} | event=source_update | source={source_key} | version={version}")


def log_source_error(source_key: str, msg: str) -> None:
    ts = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    _write(f"{ts} | event=source_error | source={source_key} | error={msg}")


def log_send(kind: str, template_name: str, row_count: int) -> None:
    ts = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    _write(f"{ts} | event=send | kind={kind} | template={template_name} | rows={row_count}")
