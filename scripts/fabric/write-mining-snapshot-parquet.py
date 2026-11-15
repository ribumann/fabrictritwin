"""Write a bounded, all-string Parquet file without CSV schema inference."""

import csv
import sys
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq


def write_snapshot(source: Path, destination: Path) -> None:
    if source.stat().st_size > 8 * 1024 * 1024:
        raise ValueError("Snapshot CSV exceeds the supported byte bound.")
    with source.open(encoding="utf-8", newline="") as stream:
        reader = csv.reader(stream, strict=True)
        columns = next(reader)
        if not columns or len(columns) != len(set(columns)):
            raise ValueError("Missing or duplicate snapshot columns.")
        rows = []
        for row in reader:
            if len(row) != len(columns) or any(len(cell.encode("utf-8")) > 8000 for cell in row):
                raise ValueError("Malformed or oversized snapshot field.")
            rows.append(row)
            if len(rows) > 2000:
                raise ValueError("Snapshot exceeds the supported row bound.")
    if not rows:
        raise ValueError("Empty snapshot.")
    table = pa.Table.from_arrays(
        [pa.array([row[index] for row in rows], type=pa.string()) for index in range(len(columns))],
        names=columns,
    )
    pq.write_table(table, destination, compression="NONE", version="1.0", store_schema=True)
    restored = pq.read_table(destination)
    if restored.schema != table.schema or restored.to_pydict() != table.to_pydict():
        raise ValueError("Parquet readback differs from the exact string source.")


if __name__ == "__main__":
    write_snapshot(Path(sys.argv[1]), Path(sys.argv[2]))
