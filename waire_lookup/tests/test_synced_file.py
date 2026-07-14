import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

import pandas as pd
from connectors.synced_file import SyncedFileSource


def _write_csv(tmp_path, name="data.csv"):
    p = tmp_path / name
    pd.DataFrame({
        "ID": ["00123", "00456"],
        "Name": ["Alpha Corp", "Beta Inc"],
    }).to_csv(p, index=False)
    return p


def test_csv_loads_columns_and_rows(tmp_path):
    p = _write_csv(tmp_path)
    src = SyncedFileSource(path=str(p), header_row=0)
    df = src.load()
    assert list(df.columns) == ["ID", "Name"]
    assert len(df) == 2
    assert df["ID"].tolist() == ["00123", "00456"]  # leading zeros preserved (dtype=str)


def test_csv_columns_method(tmp_path):
    p = _write_csv(tmp_path)
    src = SyncedFileSource(path=str(p), header_row=0)
    assert src.columns() == ["ID", "Name"]


def test_csv_readable_while_open_elsewhere(tmp_path):
    # Simulate the file being held open by another process (read handle).
    p = _write_csv(tmp_path)
    with open(p, "r") as _held:  # keep an open handle during the load
        src = SyncedFileSource(path=str(p), header_row=0)
        df = src.load()
    assert len(df) == 2
