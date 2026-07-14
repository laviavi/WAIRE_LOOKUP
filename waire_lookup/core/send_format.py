"""Serializers for the Send-to pipeline. Pure functions — no COM, no network."""
import html


def rows_to_html_table(columns: list[str], rows: list[list[str]]) -> str:
    """Compact HTML table for an Outlook mail body. Inline styles only
    (Outlook ignores <style> blocks)."""
    th = "".join(
        f'<th style="border:1px solid #ccc;padding:4px 8px;background:#f0f0f0;'
        f'text-align:left;font-family:Segoe UI,sans-serif;font-size:13px">'
        f"{html.escape(str(c))}</th>" for c in columns)
    trs = []
    for r in rows:
        tds = "".join(
            f'<td style="border:1px solid #ccc;padding:4px 8px;'
            f'font-family:Segoe UI,sans-serif;font-size:13px">'
            f"{html.escape(str(v))}</td>" for v in r)
        trs.append(f"<tr>{tds}</tr>")
    return (f'<table style="border-collapse:collapse">'
            f"<tr>{th}</tr>{''.join(trs)}</table>")


def build_mail_html(template_name: str, columns: list[str],
                    rows: list[list[str]], deep_link: str) -> str:
    body = rows_to_html_table(columns, rows)
    n = len(rows)
    header = (f'<p style="font-family:Segoe UI,sans-serif;font-size:13px">'
              f"{n} result{'s' if n != 1 else ''} from WAIRE LookUp "
              f"template <b>{html.escape(template_name)}</b>:</p>")
    footer = ""
    if deep_link:
        footer = (f'<p style="font-family:Segoe UI,sans-serif;font-size:12px">'
                  f'<a href="{html.escape(deep_link)}">Open this search in '
                  f"WAIRE LookUp</a> (requires the app running locally)</p>")
    return header + body + footer


def build_teams_card(template_name: str, columns: list[str],
                     rows: list[list[str]], deep_link: str) -> dict:
    """Legacy MessageCard JSON — accepted by Teams incoming webhooks and by
    Workflows-based webhooks. Rows rendered as facts (col: value) per row,
    capped at 10 rows to stay under the 28 KB webhook limit."""
    sections = []
    for r in rows[:10]:
        sections.append({
            "facts": [{"name": str(c), "value": str(v)}
                      for c, v in zip(columns, r)]
        })
    if len(rows) > 10:
        sections.append({"text": f"…and {len(rows) - 10} more rows (see app)."})
    card = {
        "@type": "MessageCard",
        "@context": "http://schema.org/extensions",
        "summary": f"WAIRE LookUp — {template_name}",
        "title": f"WAIRE LookUp: {len(rows)} result(s) — {template_name}",
        "sections": sections,
    }
    if deep_link:
        card["potentialAction"] = [{
            "@type": "OpenUri", "name": "Open in WAIRE LookUp",
            "targets": [{"os": "default", "uri": deep_link}],
        }]
    return card


def build_change_card(template_name: str, when_iso: str) -> dict:
    return {
        "@type": "MessageCard",
        "@context": "http://schema.org/extensions",
        "summary": f"WAIRE LookUp — source updated",
        "title": "WAIRE LookUp — source updated",
        "sections": [{
            "facts": [
                {"name": "Template", "value": template_name},
                {"name": "Updated at", "value": when_iso},
            ],
            "text": "Open the app at http://127.0.0.1:2305/?template="
                    + template_name.replace(" ", "%20")
                    + " (only works on the machine running the app).",
        }],
    }
