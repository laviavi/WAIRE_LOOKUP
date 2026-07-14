"""Create an Outlook draft via COM. Windows + classic desktop Outlook only."""

import sys


def create_draft(subject: str, html_body: str) -> None:
    if sys.platform != "win32":
        raise ValueError("Outlook drafts require Windows.")

    import pythoncom
    pythoncom.CoInitialize()          # Flask worker thread has no COM apartment
    try:
        import win32com.client
        try:
            outlook = win32com.client.Dispatch("Outlook.Application")
        except Exception:
            raise ValueError("Outlook is not installed or could not be started.")
        mail = outlook.CreateItem(0)  # olMailItem
        mail.Subject = subject
        mail.HTMLBody = html_body
        mail.Display(False)           # open the draft window, non-modal — never call mail.Send()
    finally:
        pythoncom.CoUninitialize()
