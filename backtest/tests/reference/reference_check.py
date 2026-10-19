"""Independent cross-check of the Backtest engine on real data.

    node backtest/tests/reference/run-engine.mjs SPY > /tmp/engine-SPY.json
    python3 backtest/tests/reference/reference_check.py SPY /tmp/engine-SPY.json

This file re-implements dividend adjustment, resampling, TD Sequential, the SMA cross, order
execution and every metric from the written rules in backtest/README.md, using only the Python
standard library and without sharing code with the JavaScript engine. It then compares trade
lists and metrics case by case and prints a hand-checkable walk-through of the first TD trade.
Exit status 1 on any mismatch.
"""
from __future__ import annotations

import csv
import json
import math
import statistics
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOL = 1e-7


# ---------------------------------------------------------------- data
def load(symbol: str) -> list[dict]:
    manifest = json.loads((ROOT / "data/prices/manifest.json").read_text())
    entry = next(s for s in manifest["symbols"] if s["symbol"] == symbol)
    with open(ROOT / "data/prices" / entry["file"]) as f:
        rows = [
            {"t": r["date"], "o": float(r["open"]), "h": float(r["high"]), "l": float(r["low"]),
             "c": float(r["close"]), "div": float(r["dividend"] or 0)}
            for r in csv.DictReader(f)
        ]
    return rows


def adjust(rows: list[dict]) -> list[dict]:
    events = [(i, r["div"] / rows[i - 1]["c"]) for i, r in enumerate(rows) if r["div"] > 0 and i > 0]
    out = []
    for i, r in enumerate(rows):
        f = 1.0
        for j, frac in events:
            if j > i:
                f *= 1 - frac
        out.append({**r, "o": r["o"] * f, "h": r["h"] * f, "l": r["l"] * f, "c": r["c"] * f})
    return out


def weekly(rows: list[dict]) -> list[dict]:
    groups: dict[tuple, list[dict]] = {}
    for r in rows:
        y, w, _ = date.fromisoformat(r["t"]).isocalendar()
        groups.setdefault((y, w), []).append(r)
    return [
        {"t": g[-1]["t"], "o": g[0]["o"], "h": max(x["h"] for x in g), "l": min(x["l"] for x in g), "c": g[-1]["c"]}
        for _, g in sorted(groups.items())
    ]


# ---------------------------------------------------------------- TD Sequential
def td_signals(rows: list[dict], lookback=4, setup_len=9, cd_len=13, cd_lb=2):
    """Return (buy9, sell9, buy13, sell13) as sets of bar indices."""
    c = [r["c"] for r in rows]
    h = [r["h"] for r in rows]
    lo = [r["l"] for r in rows]
    n = len(rows)

    def run_length(i, cond):
        k = 0
        while i - k >= lookback and cond(i - k):
            k += 1
        return k

    buy9, sell9 = set(), set()
    for i in range(lookback, n):
        for cond, flip, dest in (
            (lambda j: c[j] < c[j - lookback], lambda s: s - 1 - lookback >= 0 and c[s - 1] > c[s - 1 - lookback], buy9),
            (lambda j: c[j] > c[j - lookback], lambda s: s - 1 - lookback >= 0 and c[s - 1] < c[s - 1 - lookback], sell9),
        ):
            k = run_length(i, cond)
            if k >= setup_len and flip(i - k + 1) and (i - k + 1) + setup_len - 1 == i:
                dest.add(i)

    buy13, sell13 = set(), set()
    # One pass per direction. A countdown starts at its setup's bar 9, is cancelled by the
    # opposite setup or a close through TDST, and is not restarted by a same-side setup.
    for side in ("buy", "sell"):
        mine, theirs = (buy9, sell9) if side == "buy" else (sell9, buy9)
        active, count, close8, tdst = False, 0, None, None
        for i in range(n):
            if i in mine:
                if not active:
                    active, count, close8 = True, 0, None
                    window = range(i - setup_len + 1, i + 1)
                    tdst = max(h[j] for j in window) if side == "buy" else min(lo[j] for j in window)
            if i in theirs:
                active = False
            if not active or i < cd_lb:
                continue
            if (side == "buy" and c[i] > tdst) or (side == "sell" and c[i] < tdst):
                active = False
                continue
            ok = c[i] <= lo[i - cd_lb] if side == "buy" else c[i] >= h[i - cd_lb]
            if not ok:
                continue
            if count < cd_len - 1:
                count += 1
                if count == 8:
                    close8 = c[i]
            elif close8 is None or (lo[i] <= close8 if side == "buy" else h[i] >= close8):
                (buy13 if side == "buy" else sell13).add(i)
                active = False
    return buy9, sell9, buy13, sell13


def td_target(rows, entry):
    b9, s9, b13, s13 = td_signals(rows)
    buys = (b9 if entry in ("setup9", "either") else set()) | (b13 if entry in ("countdown13", "either") else set())
    sells = (s9 if entry in ("setup9", "either") else set()) | (s13 if entry in ("countdown13", "either") else set())
    return {i: (1 if i in buys else -1) for i in buys ^ sells}  # bars with both signals are ignored


def sma_target(rows, fast, slow):
    c = [r["c"] for r in rows]
    out = {}
    for i in range(slow - 1, len(rows)):
        f = sum(c[i - fast + 1:i + 1]) / fast
        s = sum(c[i - slow + 1:i + 1]) / slow
        out[i] = 1 if f > s else -1
    return out


# ---------------------------------------------------------------- execution
def simulate(rows, target: dict, start, end, capital, comm_bps, slip_bps, allow_short, stop_pct=0.0):
    cm, sl = comm_bps / 1e4, slip_bps / 1e4
    cash, units, pos = capital, 0.0, 0
    entry = None  # (index, fill, equity_at_entry, entry_commission)
    order = None
    locked = 0
    eq, trades = [], []
    for i in range(start, end + 1):
        r = rows[i]
        if order is not None and order[0] != pos:
            want, why = order
            if pos != 0:
                px = r["o"] * (1 - pos * sl)
                fee = abs(units) * px * cm
                cash += units * px - fee
                pnl = pos * (px - entry[1]) * abs(units) - entry[3] - fee
                trades.append({"side": "long" if pos == 1 else "short", "entryTime": rows[entry[0]]["t"], "entryPrice": entry[1],
                               "exitTime": r["t"], "exitPrice": px, "pnl": pnl, "returnPct": pnl / entry[2] * 100, "reason": why,
                               "bars": i - entry[0]})
                units, pos = 0.0, 0
            if want != 0:
                px = r["o"] * (1 + want * sl)
                alloc = cash / (1 + cm)
                fee = alloc * cm
                entry = (i, px, cash, fee)
                units = want * alloc / px
                cash -= want * alloc + fee
                pos = want
        order = None
        eq.append(cash + units * r["c"])
        if i == end:
            break
        want, why = pos, "signal"
        raw = target.get(i)
        if raw is None:
            locked = 0
        else:
            t = 0 if (raw == -1 and not allow_short) else raw
            if locked and t != locked:
                locked = 0
            if not (locked and t == locked):
                want = t
        if pos != 0 and stop_pct > 0 and pos * (r["c"] / entry[1] - 1) <= -stop_pct / 100 and want == pos:
            want, why, locked = 0, "stop loss", pos
        if want != pos:
            order = (want, why)
    return eq, trades, pos


def metrics(times, eq, trades):
    n = len(eq)
    yrs = (date.fromisoformat(times[-1]) - date.fromisoformat(times[0])).days / 365.25
    ppy = (n - 1) / yrs
    rets = [eq[i] / eq[i - 1] - 1 for i in range(1, n)]
    sd = statistics.stdev(rets)
    mu = statistics.fmean(rets)
    dsd = math.sqrt(sum(min(0.0, x) ** 2 for x in rets) / len(rets))
    peak, mdd = eq[0], 0.0
    for v in eq:
        peak = max(peak, v)
        mdd = min(mdd, v / peak - 1)
    cagr = (eq[-1] / eq[0]) ** (1 / yrs) - 1
    wins = [t for t in trades if t["pnl"] > 0]
    losses = [t for t in trades if t["pnl"] < 0]
    gl = -sum(t["pnl"] for t in losses)
    return {
        "totalReturn": eq[-1] / eq[0] - 1,
        "cagr": cagr,
        "volatility": sd * math.sqrt(ppy),
        "sharpe": mu / sd * math.sqrt(ppy),
        "sortino": mu / dsd * math.sqrt(ppy),
        "maxDrawdown": mdd,
        "calmar": cagr / -mdd if mdd < 0 else float("nan"),
        "trades": len(trades),
        "winRate": len(wins) / len(trades) if trades else float("nan"),
        "profitFactor": sum(t["pnl"] for t in wins) / gl if gl > 0 else float("inf"),
        "avgTradePct": statistics.fmean(t["returnPct"] for t in trades) if trades else float("nan"),
    }


# ---------------------------------------------------------------- compare
def rel_close(a, b):
    if isinstance(a, str) or isinstance(b, str):
        return str(a) == str(b)
    if a == b or (math.isnan(a) and math.isnan(b)):
        return True
    return abs(a - b) <= TOL * max(1.0, abs(a), abs(b))


def first_trade_walkthrough(rows, raw, entry_time):
    i = next(k for k, r in enumerate(rows) if r["t"] == entry_time) - 1
    print(f"\n  Hand check of the first trade (signal bar {rows[i]['t']}, filled next open {entry_time}):")
    print("    bar  date        adj close   close 4 bars earlier   close < earlier?")
    for k in range(9):
        j = i - 8 + k
        print(f"    {k + 1:>3}  {rows[j]['t']}  {rows[j]['c']:10.4f}   {rows[j - 4]['c']:10.4f} ({rows[j - 4]['t']})   {rows[j]['c'] < rows[j - 4]['c']}")
    s = i - 8
    print(f"    flip: bar before setup {rows[s - 1]['t']} close {rows[s - 1]['c']:.4f} > close {rows[s - 5]['t']} {rows[s - 5]['c']:.4f}: {rows[s - 1]['c'] > rows[s - 5]['c']}")
    rj = next(r for r in raw if r["t"] == entry_time)
    f = rows[i + 1]["o"] / rj["o"]
    print(f"    fill bar raw open {rj['o']:.4f} × dividend factor {f:.6f} = adjusted open {rows[i + 1]['o']:.4f}")


def main() -> int:
    symbol, engine_path = sys.argv[1], sys.argv[2]
    engine = json.loads(Path(engine_path).read_text())
    cases = json.loads((Path(__file__).parent / "cases.json").read_text())
    raw = load(symbol)
    daily = adjust(raw)
    failures = 0
    for case, got in zip(cases, engine["cases"]):
        rows = weekly(daily) if case["timeframe"] == "1w" else daily
        p, o = case["params"], case["options"]
        target = td_target(rows, p["entry"]) if case["strategy"] == "td-sequential" else sma_target(rows, p["fast"], p["slow"])
        start = next(i for i, r in enumerate(rows) if r["t"] >= case["from"])
        end = max(i for i, r in enumerate(rows) if r["t"] <= case["to"])
        eq, trades, _ = simulate(rows, target, start, end, o["capital"], o["commissionBps"], o["slippageBps"], o["allowShort"], o.get("stopLossPct", 0))
        times = [r["t"] for r in rows[start:end + 1]]
        m = metrics(times, eq, trades)
        bh_units = o["capital"] / (1 + o["commissionBps"] / 1e4) / (rows[start]["c"] * (1 + o["slippageBps"] / 1e4))
        bh = metrics(times, [bh_units * r["c"] for r in rows[start:end + 1]], [])

        print(f"\n== {case['name']}  ({times[0]} → {times[-1]}, {len(times)} bars)")
        bad = []
        if len(trades) != len(got["trades"]):
            bad.append(f"trade count {len(trades)} vs engine {len(got['trades'])}")
        for a, b in zip(trades, got["trades"]):
            for k in ("side", "entryTime", "exitTime", "reason"):
                if a[k] != b[k]:
                    bad.append(f"trade {a['entryTime']}: {k} {a[k]} vs {b[k]}")
            for k in ("entryPrice", "exitPrice", "pnl", "returnPct"):
                if not rel_close(a[k], b[k]):
                    bad.append(f"trade {a['entryTime']}: {k} {a[k]} vs {b[k]}")
        if not rel_close(eq[-1], got["finalEquity"]):
            bad.append(f"final equity {eq[-1]} vs {got['finalEquity']}")
        print(f"  {'metric':<14}{'reference':>14}{'engine':>14}   {'B&H ref':>12}{'B&H engine':>12}")
        for k, v in m.items():
            e = got["metrics"][k]
            e = float(e) if isinstance(e, str) else e
            ok = rel_close(v, e)
            bk = bh[k]
            be = got["benchmarkMetrics"][k]
            be = float(be) if isinstance(be, str) else be
            okb = k in ("trades", "winRate", "profitFactor", "avgTradePct") or rel_close(bk, be)
            if not ok:
                bad.append(f"{k}: {v} vs {e}")
            if not okb:
                bad.append(f"B&H {k}: {bk} vs {be}")
            print(f"  {k:<14}{v:>14.6f}{e:>14.6f}   {bk:>12.6f}{be:>12.6f}  {'ok' if ok and okb else 'MISMATCH'}")
        print(f"  trades matched: {len(trades)}   final equity ref {eq[-1]:.4f} engine {got['finalEquity']:.4f}")
        if case["strategy"] == "td-sequential" and case["timeframe"] == "1d" and trades and case is cases[0]:
            first_trade_walkthrough(rows, raw, trades[0]["entryTime"])
            t = trades[0]
            print(f"    trade: {t['side']} {t['entryTime']} @ {t['entryPrice']:.4f} → {t['exitTime']} @ {t['exitPrice']:.4f} "
                  f"({t['reason']}), return {t['returnPct']:.3f}%")
        for b in bad[:10]:
            print("  MISMATCH", b)
        failures += bool(bad)
    print(f"\n{len(cases) - failures}/{len(cases)} cases match")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
