"""Build a fresh Excel workbook for the Send-to-Excel download."""

import io

import openpyxl


def build_workbook(columns: list[str], rows: list[list]) -> bytes:
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(columns)
    for r in rows:
        ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
