import importlib.util
import tempfile
import unittest
import sys
from pathlib import Path

sys.dont_write_bytecode = True

import pyarrow as pa
import pyarrow.parquet as pq

SOURCE = Path(__file__).resolve().parents[2] / "scripts" / "fabric" / "write-mining-snapshot-parquet.py"
SPEC = importlib.util.spec_from_file_location("snapshot_writer", SOURCE)
WRITER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WRITER)


class SnapshotParquetTests(unittest.TestCase):
    def test_roundtrip_preserves_strings_and_submicrosecond_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.csv"
            source.write_text(
                '"event_id","value","received_at_utc","scheduled_running"\n'
                '"a","37.9600","2026-01-01T00:00:31.1234567Z","true"\n',
                encoding="utf-8",
            )
            first, second = root / "first.parquet", root / "second.parquet"
            WRITER.write_snapshot(source, first)
            WRITER.write_snapshot(source, second)
            table = pq.read_table(first)
            self.assertTrue(all(field.type == pa.string() for field in table.schema))
            self.assertEqual(table.to_pydict()["received_at_utc"], ["2026-01-01T00:00:31.1234567Z"])
            self.assertEqual(table.to_pydict()["value"], ["37.9600"])
            self.assertEqual(table.to_pydict()["scheduled_running"], ["true"])
            self.assertEqual(first.read_bytes(), second.read_bytes())

    def test_rejects_malformed_or_unbounded_input(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for content in ('"a","a"\n"1","2"\n', '"a","b"\n"1"\n', '"a"\n' + '"1"\n' * 2001):
                source = root / "source.csv"
                source.write_text(content, encoding="utf-8")
                with self.assertRaises(ValueError):
                    WRITER.write_snapshot(source, root / "output.parquet")


if __name__ == "__main__":
    unittest.main()
