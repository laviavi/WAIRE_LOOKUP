"""Build a fresh Excel workbook for Send-to-Excel and open it directly in
Excel via COM — no browser download, no manual double-click afterward.
Windows + Excel only, same pattern as core/send_outlook.py."""

import io
import sys
import tempfile

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


def open_in_excel(columns: list[str], rows: list[list]) -> None:
    """Write the workbook to a temp .xlsx and open it in Excel. Never looks
    for or appends to any existing tracker workbook — always a fresh file."""
    if sys.platform != "win32":
        raise ValueError("Opening Excel requires Windows.")

    xlsx_bytes = build_workbook(columns, rows)
    with tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False) as f:
        f.write(xlsx_bytes)
        path = f.name

    import pythoncom
    pythoncom.CoInitialize()          # Flask worker thread has no COM apartment
    try:
        import win32com.client
        try:
            excel = win32com.client.Dispatch("Excel.Application")
        except Exception:
            raise ValueError("Excel is not installed or could not be started.")
        excel.Visible = True
        excel.Workbooks.Open(path)
    finally:
        pythoncom.CoUninitialize()
