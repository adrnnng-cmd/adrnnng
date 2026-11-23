import json
import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import hk_movers_returns as ret  # noqa: E402


def weekdays(start: str, end: str, skip=()):
    day, last, out = date.fromisoformat(start), date.fromisoformat(end), []
    while day <= last:
        if day.weekday() < 5 and day.isoformat() not in skip:
            out.append(day.isoformat())
        day += timedelta(days=1)
    return out


# Deterministic calendar: weekdays only, with the 2025 year-end and a few other days off.
HOLIDAYS = {"2025-12-25", "2025-12-26", "2026-01-01", "2026-10-07"}
DAYS = weekdays("2025-12-01", "2026-11-23", HOLIDAYS)


def bars_for(days, price=100.0, step=0.5):
    return [(d, price + step * i) for i, d in enumerate(days)]


class ReferenceDates(unittest.TestCase):
    def test_monday_snapshot(self):
        refs = ret.reference_dates(DAYS)
        self.assertEqual(refs["as_of"], "2026-11-23")
        self.assertEqual(refs["d5"], "2026-11-16", "five trading days before Monday 23 Nov is Monday 16 Nov")
        self.assertEqual(refs["m1"], "2026-10-23")
        self.assertEqual(refs["ytd"], "2025-12-31", "last trading day of 2025")

    def test_d5_counts_trading_days_not_calendar_days_across_a_holiday(self):
        days = weekdays("2026-09-25", "2026-10-12", {"2026-10-01", "2026-10-07"})
        refs = ret.reference_dates(days)
        self.assertEqual(refs["as_of"], "2026-10-12")
        self.assertEqual(days[-6], refs["d5"])
        self.assertEqual(refs["d5"], "2026-10-02", "sessions back: 9, 8, 6, 5 Oct then 2 Oct; 1 and 7 Oct were closed")

    def test_month_end_clamps_and_weekend_targets_use_the_last_trading_day(self):
        days = weekdays("2026-01-02", "2026-03-31")
        refs = ret.reference_dates(days)
        self.assertEqual(ret.one_month_before(date(2026, 3, 31)), date(2026, 2, 28))
        self.assertEqual(refs["m1"], "2026-02-27", "28 Feb 2026 is a Saturday")
        self.assertEqual(ret.one_month_before(date(2026, 1, 15)), date(2025, 12, 15))
        self.assertEqual(ret.one_month_before(date(2024, 3, 31)), date(2024, 2, 29), "leap year")

    def test_ytd_uses_the_last_trading_day_before_the_year_even_when_31_dec_is_closed(self):
        days = weekdays("2025-12-20", "2026-02-10", {"2025-12-31", "2026-01-01"})
        self.assertEqual(ret.reference_dates(days)["ytd"], "2025-12-30")

    def test_first_trading_day_of_the_year_measures_from_the_old_year_end(self):
        days = weekdays("2025-12-15", "2026-01-02", {"2025-12-25", "2025-12-26", "2026-01-01"})
        refs = ret.reference_dates(days)
        self.assertEqual(refs["as_of"], "2026-01-02")
        self.assertEqual(refs["ytd"], "2025-12-31")
        self.assertEqual(refs["m1"], "2025-12-02" if "2025-12-02" in days else None)

    def test_short_history_gives_none_instead_of_a_wrong_date(self):
        refs = ret.reference_dates(["2026-11-19", "2026-11-20", "2026-11-23"])
        self.assertIsNone(refs["d5"])
        self.assertIsNone(refs["m1"])
        self.assertIsNone(refs["ytd"], "no bar from the previous year")
        self.assertIsNone(ret.reference_dates([]))

    def test_unsorted_and_duplicate_days(self):
        refs = ret.reference_dates(list(reversed(DAYS)) + DAYS[:5] + [d + " 00:00:00" for d in DAYS[-3:]])
        self.assertEqual(refs, ret.reference_dates(DAYS))


class Returns(unittest.TestCase):
    REFS = ret.reference_dates(DAYS)

    def test_percent_from_the_reference_close(self):
        closes = dict(bars_for(DAYS))
        last = closes["2026-11-23"] * 1.02
        out = ret.compute_returns(last, bars_for(DAYS), self.REFS)
        self.assertAlmostEqual(out["ret_5d"], (last / closes["2026-11-16"] - 1) * 100, places=3)
        self.assertAlmostEqual(out["ret_1m"], (last / closes["2026-10-23"] - 1) * 100, places=3)
        self.assertAlmostEqual(out["ret_ytd"], (last / closes["2025-12-31"] - 1) * 100, places=3)

    def test_listed_after_a_reference_date_is_null_not_zero(self):
        recent = [(d, 10.0) for d in DAYS if d >= "2026-10-26"]
        out = ret.compute_returns(11.0, recent, self.REFS)
        self.assertAlmostEqual(out["ret_5d"], 10.0, places=3)
        self.assertIsNone(out["ret_1m"], "first bar is after the 1M reference date")
        self.assertIsNone(out["ret_ytd"])

    def test_suspended_stock_uses_its_last_close_on_or_before_the_reference(self):
        bars = [(d, 20.0) for d in DAYS if d <= "2026-11-12"]
        out = ret.compute_returns(20.0, bars, self.REFS)
        self.assertEqual(out["ret_5d"], 0.0)

    def test_bad_inputs_never_become_numbers(self):
        empty = {"ret_5d": None, "ret_1m": None, "ret_ytd": None}
        self.assertEqual(ret.compute_returns(None, bars_for(DAYS), self.REFS), empty)
        self.assertEqual(ret.compute_returns(float("nan"), bars_for(DAYS), self.REFS), empty)
        self.assertEqual(ret.compute_returns(0, bars_for(DAYS), self.REFS), empty)
        self.assertEqual(ret.compute_returns(10, [], self.REFS), empty)
        self.assertEqual(ret.compute_returns(10, bars_for(DAYS), None), empty)
        bad = [(d, 0.0 if i % 2 else float("nan")) for i, d in enumerate(DAYS)]
        self.assertEqual(ret.compute_returns(10, bad, self.REFS), empty)

    def test_normalise_bars_sorts_dedupes_and_drops_bad_rows(self):
        out = ret.normalise_bars([("2026-11-03", 3), ("2026-11-02", 2), ("2026-11-02", 2.5), ("x", "y"), ("2026-11-04", None), ("2026-11-05", -1)])
        self.assertEqual(out, [("2026-11-02", 2.5), ("2026-11-03", 3.0)])

    def test_parse_kline_rows(self):
        rows = [{"time_key": "2026-11-20 00:00:00", "close": 5.5}, {"time_key": "2026-11-19 00:00:00", "close": "5.25"}, {"close": 1}]
        self.assertEqual(ret.parse_kline_rows(rows), [("2026-11-19", 5.25), ("2026-11-20", 5.5)])


class Cache(unittest.TestCase):
    def test_refresh_once_per_day_with_a_budget_and_failure_isolation(self):
        cache = ret.HistoryCache(None)
        calls = []

        def fetch(code, start, end):
            calls.append((code, start, end))
            if code == "HK.BAD":
                raise RuntimeError("quota exceeded")
            return bars_for(DAYS)

        codes = ["HK.A", "HK.BAD", "HK.B", "HK.C", "HK.D"]
        stats = ret.refresh_history(codes, cache, today="2026-11-23", fetch=fetch, budget=3)
        self.assertEqual([c[0] for c in calls], ["HK.A", "HK.B", "HK.BAD"], "never-fetched codes go in code order; the budget caps attempts")
        self.assertEqual(stats["fetched"], 2)
        self.assertEqual(stats["failed"][0]["code"], "HK.BAD")
        self.assertEqual(stats["deferred"], 2)
        self.assertEqual(calls[0][1:], ("2025-12-01", "2026-11-23"))

        calls.clear()
        stats = ret.refresh_history(codes, cache, today="2026-11-23", fetch=fetch, budget=10)
        self.assertEqual(sorted(c[0] for c in calls), ["HK.BAD", "HK.C", "HK.D"], "fetched today: not fetched again")
        self.assertEqual(stats["fetched"], 2)

        calls.clear()
        ret.refresh_history(codes, cache, today="2026-11-24", fetch=fetch, budget=10)
        self.assertEqual(len(calls), 5, "a new HK day refreshes everything once")

    def test_stale_entries_refresh_oldest_first(self):
        cache = ret.HistoryCache(None)
        cache.put("HK.OLD", bars_for(DAYS), "2026-11-10")
        cache.put("HK.NEWER", bars_for(DAYS), "2026-11-20")
        order = []
        ret.refresh_history(["HK.NEWER", "HK.OLD"], cache, today="2026-11-23", fetch=lambda c, s, e: order.append(c) or bars_for(DAYS), budget=5)
        self.assertEqual(order, ["HK.OLD", "HK.NEWER"])

    def test_cache_roundtrip_prunes_old_bars_and_survives_corruption(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "h.json"
            cache = ret.HistoryCache(path)
            cache.put("HK.00700", [("2025-06-02", 1), ("2025-12-01", 2), ("2026-11-20", 3)], "2026-11-23")
            cache.save()
            again = ret.HistoryCache(path)
            self.assertEqual(again.bars("HK.00700"), [("2025-12-01", 2.0), ("2026-11-20", 3.0)])
            self.assertFalse(again.needs_refresh("HK.00700", "2026-11-23"))
            self.assertTrue(again.needs_refresh("HK.00700", "2026-11-24"))
            path.write_text("{not json", encoding="utf-8")
            self.assertEqual(ret.HistoryCache(path).entries, {})
            path.write_text(json.dumps({"version": 99, "entries": {"x": {}}}), encoding="utf-8")
            self.assertEqual(ret.HistoryCache(path).entries, {})

    def test_trading_calendar_prefers_the_index_then_the_longest_history(self):
        cache = ret.HistoryCache(None)
        cache.put("HK.A", bars_for(DAYS[-50:]), "2026-11-23")
        cache.put("HK.B", bars_for(DAYS), "2026-11-23")
        self.assertEqual(ret.trading_days_for(cache, "HK.800000", ["HK.A", "HK.B"]), DAYS)
        cache.put("HK.800000", bars_for(DAYS[-20:]), "2026-11-23")
        self.assertEqual(ret.trading_days_for(cache, "HK.800000", ["HK.A", "HK.B"]), DAYS[-20:])


if __name__ == "__main__":
    unittest.main()
