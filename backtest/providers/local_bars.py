#!/usr/bin/env python3
"""Decode a local parquet (or CSV) bar file to a normalized CSV.

Stdout is unused for data. The second argument is the output CSV path.
time_key is the bar open. Naive timestamps are Asia/Hong_Kong wall time.
Timezone-aware timestamps are converted to Asia/Hong_Kong (UTC+8, no DST).

Parquet needs one of pyarrow, polars, or duckdb, which are not installed by
this repo. CSV input uses the standard library. This script does not fetch
market data and is only invoked by backtest/providers/local-bars.js.
"""

from __future__ import annotations

import csv
import sys
from datetime import date, datetime, timedelta, timezone

HKT = timezone(timedelta(hours=8))

TIME_NAMES = ('time_key', 'time', 'datetime', 'timestamp', 'date')
PRICE_NAMES = {
    'open': ('open',),
    'high': ('high',),
    'low': ('low',),
    'close': ('close',),
    'volume': ('volume', 'vol'),
}


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def pick(columns: list[str], names: tuple[str, ...]) -> str | None:
    folded = {c.lower().replace(' ', '').replace('_', ''): c for c in columns}
    for name in names:
        key = name.replace('_', '')
        if key in folded:
            return folded[key]
    return None


def epoch_to_hkt(n: float) -> datetime:
    n = float(n)
    abs_n = abs(n)
    if abs_n > 1e17:
        seconds = n / 1e9
    elif abs_n > 1e14:
        seconds = n / 1e6
    elif abs_n > 1e11:
        seconds = n / 1e3
    else:
        seconds = n
    return datetime.fromtimestamp(seconds, tz=timezone.utc).astimezone(HKT)


def as_hkt(value) -> datetime | None:
    if value is None:
        return None
    if hasattr(value, 'to_pydatetime'):
        value = value.to_pydatetime()
    if isinstance(value, str):
        return parse_time_string(value)
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=HKT)
        return value.astimezone(HKT)
    if isinstance(value, date):
        return None
    if isinstance(value, (int, float)):
        return epoch_to_hkt(value)
    return None


def parse_time_string(raw: str) -> datetime | None:
    s = raw.strip().replace('Z', '+00:00')
    if not s:
        return None
    if s[:1].isdigit() and 'T' not in s and ' ' not in s and '-' not in s[1:] and '/' not in s:
        try:
            return epoch_to_hkt(float(s))
        except ValueError:
            return None
    s = s.replace('/', '-').replace(' ', 'T', 1)
    try:
        if len(s) >= 6 and (s[-6] in '+-') and s[-3] != ':':
            s = s[:-2] + ':' + s[-2:]
        if len(s) == 16:
            s += ':00'
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=HKT)
    return dt.astimezone(HKT)


def stamp(dt: datetime) -> str:
    wall = dt.astimezone(HKT)
    return wall.strftime('%Y-%m-%dT%H:%M:%S')


def load_parquet(path: str) -> tuple[list[str], list[dict]]:
    missing = []
    try:
        import pyarrow.parquet as pq
    except ImportError as exc:
        missing.append(f'pyarrow ({exc})')
    else:
        try:
            table = pq.read_table(path)
        except Exception as exc:
            fail(f'pyarrow could not read {path}: {exc}')
        columns = list(table.column_names)
        data = table.to_pydict()
        rows = [{c: data[c][i] for c in columns} for i in range(table.num_rows)]
        return columns, rows
    try:
        import polars as pl
    except ImportError as exc:
        missing.append(f'polars ({exc})')
    else:
        try:
            frame = pl.read_parquet(path)
        except Exception as exc:
            fail(f'polars could not read {path}: {exc}')
        return list(frame.columns), frame.to_dicts()
    try:
        import duckdb
    except ImportError as exc:
        missing.append(f'duckdb ({exc})')
    else:
        try:
            con = duckdb.connect()
            rel = con.execute('SELECT * FROM read_parquet(?)', [path])
            columns = [d[0] for d in rel.description]
            rows = [dict(zip(columns, rec)) for rec in rel.fetchall()]
        except Exception as exc:
            fail(f'duckdb could not read {path}: {exc}')
        return columns, rows
    fail(
        'Reading parquet needs pyarrow, polars, or duckdb '
        f'(none importable: {", ".join(missing)}). '
        'Export a CSV or install one of those, then rerun. This repo does not install them.'
    )


def load_csv(path: str) -> tuple[list[str], list[dict]]:
    with open(path, newline='', encoding='utf-8-sig') as fh:
        reader = csv.DictReader(fh)
        if not reader.fieldnames:
            fail('CSV has no header')
        columns = list(reader.fieldnames)
        return columns, list(reader)


def write_normalized(columns: list[str], rows: list[dict], dest: str) -> int:
    names = {role: pick(columns, PRICE_NAMES[role] if role != 'time' else TIME_NAMES) for role in ('time', 'open', 'high', 'low', 'close', 'volume')}
    # pick() for time uses TIME_NAMES via the ternary above; prices use PRICE_NAMES.
    missing = [role for role, col in names.items() if col is None]
    if missing:
        label = 'time_key' if missing == ['time'] else ', '.join('time_key' if r == 'time' else r for r in missing)
        fail(f'Missing column(s): {label}. Need time_key, open, high, low, close, volume.')
    kept = 0
    with open(dest, 'w', newline='', encoding='utf-8') as fh:
        writer = csv.writer(fh)
        writer.writerow(['time', 'open', 'high', 'low', 'close', 'volume'])
        for row in rows:
            dt = as_hkt(row.get(names['time']))
            if dt is None:
                continue
            try:
                prices = [float(row.get(names[k])) for k in ('open', 'high', 'low', 'close', 'volume')]
            except (TypeError, ValueError):
                continue
            writer.writerow([stamp(dt), *prices])
            kept += 1
    if kept == 0:
        fail('No valid bars after reading the file.')
    return kept


def main(argv: list[str]) -> None:
    if len(argv) != 3:
        fail(f'usage: {argv[0] if argv else "local_bars.py"} <input.csv|input.parquet> <output.csv>')
    src, dest = argv[1], argv[2]
    lower = src.lower()
    if lower.endswith('.parquet') or lower.endswith('.pq'):
        columns, rows = load_parquet(src)
    elif lower.endswith('.csv') or lower.endswith('.txt'):
        columns, rows = load_csv(src)
    else:
        fail('Expected a .csv or .parquet file.')
    kept = write_normalized(columns, rows, dest)
    print(f'wrote {kept} bars to {dest}', file=sys.stderr)


if __name__ == '__main__':
    main(sys.argv)
