"""Offline tests for the price fetcher. The payload below is a hand-made fixture in the
shape of Yahoo's chart response; it is never written to the site."""
import unittest
from datetime import datetime, timezone

from prices import yahoo
from prices.__main__ import file_name, num

NY = 1704205800  # 2024-01-02 14:30 UTC = 09:30 New York


def payload(end_ts):
    day = 86400
    ts = [NY, NY + day, NY + 2 * day, NY + 3 * day]
    return {
        "chart": {
            "result": [{
                "meta": {
                    "symbol": "TEST", "longName": "Test Corp", "currency": "USD", "fullExchangeName": "NasdaqGS",
                    "instrumentType": "EQUITY", "exchangeTimezoneName": "America/New_York",
                    "currentTradingPeriod": {"regular": {"start": ts[3], "end": end_ts}},
                },
                "timestamp": ts,
                "events": {
                    "dividends": {str(ts[2]): {"amount": 0.5, "date": ts[2]}},
                    "splits": {str(ts[1]): {"date": ts[1], "numerator": 4, "denominator": 1}},
                },
                "indicators": {
                    "quote": [{
                        "open": [10, 11, None, 12],
                        "high": [10.5, 11.5, None, 12.5],
                        "low": [9.5, 10.5, None, 11.5],
                        "close": [10, 11, None, 12],
                        "volume": [100, 200, None, 300],
                    }],
                    "adjclose": [{"adjclose": [9.5, 10.5, None, 12]}],
                },
            }]
        }
    }


class ParseTest(unittest.TestCase):
    def test_bars_events_and_null_rows(self):
        after_close = NY + 3 * 86400 + 7 * 3600
        s = yahoo.parse(payload(NY + 3 * 86400 + 6.5 * 3600), now=datetime.fromtimestamp(after_close, timezone.utc))
        self.assertEqual([b.date for b in s.bars], ["2024-01-02", "2024-01-03", "2024-01-05"])
        self.assertEqual(s.bars[1].split, 4.0)
        self.assertEqual(s.bars[0].dividend, 0.0)
        self.assertEqual(s.name, "Test Corp")
        self.assertEqual(s.timezone, "America/New_York")

    def test_dividend_on_a_null_quote_day_moves_to_the_next_bar(self):
        s = yahoo.parse(payload(0))
        self.assertEqual([b.dividend for b in s.bars], [0.0, 0.0, 0.5])

    def test_unfinished_session_is_dropped(self):
        end = NY + 3 * 86400 + 6.5 * 3600
        during = datetime.fromtimestamp(end - 3600, timezone.utc)
        s = yahoo.parse(payload(end), now=during)
        self.assertEqual(s.bars[-1].date, "2024-01-03")

    def test_error_payload(self):
        with self.assertRaises(ValueError):
            yahoo.parse({"chart": {"result": None, "error": {"code": "Not Found"}}})


class AdjustTest(unittest.TestCase):
    def test_back_adjustment(self):
        bars = [yahoo.Bar("d0", 0, 0, 0, 100, 0), yahoo.Bar("d1", 0, 0, 0, 102, 0),
                yahoo.Bar("d2", 0, 0, 0, 98, 0, dividend=2), yahoo.Bar("d3", 0, 0, 0, 99, 0)]
        adj = yahoo.dividend_adjusted_closes(bars)
        f = 1 - 2 / 102
        self.assertAlmostEqual(adj[0], 100 * f)
        self.assertAlmostEqual(adj[1], 100.0)
        self.assertEqual(adj[2:], [98, 99])


class FormatTest(unittest.TestCase):
    def test_file_name_and_numbers(self):
        self.assertEqual(file_name("^GSPC"), "_GSPC.csv")
        self.assertEqual(file_name("0700.HK"), "0700.HK.csv")
        self.assertEqual(file_name("BRK-B"), "BRK-B.csv")
        self.assertEqual(num(343.459991455), "343.46")
        self.assertEqual(num(0.0123456789), "0.012346")
        self.assertEqual(num(12.0), "12")
        self.assertEqual(num(0), "0")


if __name__ == "__main__":
    unittest.main()
