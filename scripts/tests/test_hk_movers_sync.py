import json
import re
import sys
import unittest
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

import hk_movers_demo as demo  # noqa: E402
import hk_movers_sync as sync  # noqa: E402

MAPPER_MAP = sync.load_sector_map()


def mapper():
    return sync.SectorMapper(MAPPER_MAP)


def raw(code, last, prev, turnover=5e7, mcap=5e9, industry="軟件服務", name=None, high=None, low=None):
    return {
        "code": f"HK.{code}", "name": name or f"股{code}", "last_price": last, "prev_close_price": prev,
        "turnover": turnover, "total_market_val": mcap, "industry": industry,
        "high_price": high if high is not None else max(last, prev), "low_price": low if low is not None else min(last, prev),
    }


class Pure(unittest.TestCase):
    def test_change_pct_is_computed_from_snapshot_prices(self):
        self.assertAlmostEqual(sync.change_pct(110, 100), 10.0)
        self.assertAlmostEqual(sync.change_pct(95, 100), -5.0)
        self.assertIsNone(sync.change_pct(10, 0))
        self.assertIsNone(sync.change_pct(None, 10))

    def test_amplitude_comes_from_snapshot_not_rank_scale(self):
        self.assertAlmostEqual(sync.amplitude_pct(105, 98, 100), 7.0)
        self.assertIsNone(sync.amplitude_pct(105, 98, 0))

    def test_impact_is_change_times_market_cap(self):
        self.assertAlmostEqual(sync.impact_hkd(2.0, 1e10), 2e8)
        self.assertAlmostEqual(sync.impact_hkd(-1.5, 4e9), -6e7)

    def test_filter_thresholds(self):
        self.assertTrue(sync.qualifies(10_000_000, 1_000_000_001))
        self.assertFalse(sync.qualifies(9_999_999, 5e9))
        self.assertFalse(sync.qualifies(5e7, 1_000_000_000), "market cap must be strictly above HK$1 billion")

    def test_code_normalisation(self):
        self.assertEqual(sync.normalize_code("HK.00700"), "00700")
        self.assertEqual(sync.normalize_code("700"), "00700")
        self.assertEqual(sync.normalize_code("HK.800000"), "800000")

    def test_market_session_follows_hkt(self):
        hkt = sync.HKT

        def at(h, m, day=20):
            return datetime(2026, 11, day, h, m, tzinfo=hkt)

        self.assertEqual(sync.market_session(at(9, 10)), "pre_open")
        self.assertEqual(sync.market_session(at(10, 0)), "morning")
        self.assertEqual(sync.market_session(at(12, 30)), "lunch")
        self.assertEqual(sync.market_session(at(14, 0)), "afternoon")
        self.assertEqual(sync.market_session(at(16, 5)), "closing_auction")
        self.assertEqual(sync.market_session(at(17, 0)), "closed")
        self.assertEqual(sync.market_session(at(10, 0, day=21)), "closed", "Saturday")

    def test_rank_orders_and_skips_flat(self):
        m = mapper()
        rows = [sync.build_stock(raw(f"0000{i}", 100 + p, 100), m) for i, p in enumerate([5, -3, 0, 2, -7, 0.001])]
        up = sync.rank(rows, "up")
        down = sync.rank(rows, "down")
        self.assertEqual([r["change_pct"] for r in up], [5.0, 2.0])
        self.assertEqual([r["change_pct"] for r in down], [-7.0, -3.0])
        self.assertEqual(sync.breadth(rows), {"up": 2, "down": 2, "flat": 2})

    def test_build_stock_rejects_unpriced_rows(self):
        self.assertIsNone(sync.build_stock(raw("00001", 0, 10), mapper()))
        self.assertIsNone(sync.build_stock(raw("00001", 10, 0), mapper()))


class SectorMap(unittest.TestCase):
    def test_twelve_or_fewer_macro_sectors_with_chinese_names(self):
        sectors = MAPPER_MAP["sectors"]
        self.assertTrue(10 <= len(sectors) <= 12)
        ids = [s["id"] for s in sectors]
        self.assertEqual(len(ids), len(set(ids)))
        for s in sectors:
            self.assertRegex(s["name"], r"[\u4e00-\u9fff]")
        self.assertIn(MAPPER_MAP["fallback"], ids)

    def test_every_listed_industry_maps_once(self):
        seen = {}
        for s in MAPPER_MAP["sectors"]:
            for name in s["industries"]:
                self.assertNotIn(name, seen, f"{name} listed twice")
                seen[name] = s["id"]
        self.assertGreaterEqual(len(seen), 100, "table covers about 113 industries")
        m = mapper()
        for name, sector_id in seen.items():
            self.assertEqual(m.sector_for(name), sector_id)
        self.assertEqual(m.unmapped, set())

    def test_keywords_then_fallback(self):
        m = mapper()
        self.assertEqual(m.sector_for("某某銀行服務"), "finance")
        self.assertEqual(m.sector_for("特殊半導體材料"), "tech")
        self.assertEqual(m.sector_for("完全陌生的行業"), "other")
        self.assertEqual(m.unmapped, {"完全陌生的行業"})
        self.assertEqual(m.sector_for(""), "other")

    def test_keyword_targets_exist(self):
        ids = {s["id"] for s in MAPPER_MAP["sectors"]}
        for keyword, sector_id in MAPPER_MAP["keywords"]:
            self.assertIn(sector_id, ids, keyword)

    def test_heatmap_row_normaliser_accepts_variant_fields(self):
        a = sync.normalize_heatmap_row({"plate_name": "銀行", "change_rate": 1.5, "turnover": 2e9, "total_market_val": 8e10})
        self.assertEqual((a["name"], a["change_pct"], a["turnover_hkd"], a["market_cap_hkd"]), ("銀行", 1.5, 2e9, 8e10))
        b = sync.normalize_heatmap_row({"name": "煤炭", "pct": -2, "amount": 1e9, "market_val": 5e10, "up_count": 3})
        self.assertEqual((b["name"], b["change_pct"], b["up"]), ("煤炭", -2.0, 3))
        self.assertIsNone(sync.normalize_heatmap_row({"change_rate": 1}))


class Snapshot(unittest.TestCase):
    def build(self, **kw):
        m = mapper()
        specs = [
            ("00001", 110, 100, 5e7, 5e9, "銀行", True),
            ("00002", 90, 100, 8e7, 4e9, "保險", True),
            ("00003", 103, 100, 2e7, 3e9, "地產發展商", False),
            ("00004", 99, 100, 1.5e7, 2e9, "地產發展商", False),
            ("00005", 120, 100, 9_999_999, 9e9, "軟件服務", False),
            ("00006", 130, 100, 9e7, 1_000_000_000, "軟件服務", False),
            ("00007", 101, 100, 3e7, 2e9, "神秘行業", False),
        ]
        raws = [raw(c, last, prev, to, mc, ind) for c, last, prev, to, mc, ind, _ in specs]
        built = [(sync.build_stock(r, m), spec[6]) for r, spec in zip(raws, specs)]
        stocks = [s for s, _ in built]
        hsi_rows = [s for s, in_hsi in built if in_hsi]
        args = dict(
            now=datetime(2026, 11, 20, 16, 10, tzinfo=sync.HKT), hsi_index={"prev_close": 20000.0}, hsi_rows=hsi_rows,
            stocks=stocks, industries=None,
            news={"00001": {"title": "測試", "source": "來源", "published_at_hkt": "2026-11-20 10:00", "url": "https://example.com/a"},
                  "00005": {"title": "被過濾", "source": "來源", "published_at_hkt": "2026-11-20 10:00", "url": "https://example.com/b"},
                  "99999": {"title": "不存在", "source": "來源", "published_at_hkt": "2026-11-20 10:00", "url": "https://example.com/c"}},
            mapper=m, universe_count=2600,
        )
        args.update(kw)
        return sync.build_snapshot(**args), m

    def test_document_shape(self):
        doc, _ = self.build()
        for key in ("schema_version", "data_source", "updated_at_hkt", "market_session", "hsi", "hk_market", "macro_sectors", "movers", "news"):
            self.assertIn(key, doc)
        self.assertEqual(doc["schema_version"], 1)
        self.assertEqual(doc["updated_at_hkt"], "2026-11-20 16:10:00")
        self.assertEqual(doc["market_session"], "closed")
        self.assertEqual(doc["data_source"], "live")

    def test_hk_filter_and_counts(self):
        doc, _ = self.build()
        codes = [s["code"] for s in doc["hk_market"]["stocks"]]
        self.assertEqual(sorted(codes), ["00001", "00002", "00003", "00004", "00007"])
        self.assertNotIn("00005", codes, "turnover just under HK$10 million")
        self.assertNotIn("00006", codes, "market cap exactly HK$1 billion")
        self.assertEqual(doc["hk_market"]["qualified_count"], 5)
        self.assertEqual(doc["hk_market"]["universe_count"], 2600)
        self.assertEqual(doc["hk_market"]["filters"], {"min_turnover_hkd": 10_000_000, "min_market_cap_hkd": 1_000_000_000})
        self.assertEqual(doc["hk_market"]["breadth"], {"up": 3, "down": 2, "flat": 0})

    def test_movers_follow_the_filter_and_hsi_scope(self):
        doc, _ = self.build()
        self.assertEqual([r["code"] for r in doc["movers"]["hk"]["gainers"]], ["00001", "00003", "00007"])
        self.assertEqual([r["code"] for r in doc["movers"]["hk"]["losers"]], ["00002", "00004"])
        self.assertEqual([r["code"] for r in doc["movers"]["hsi"]["gainers"]], ["00001"])
        self.assertEqual([r["code"] for r in doc["movers"]["hsi"]["losers"]], ["00002"])
        for pair in doc["movers"].values():
            self.assertLessEqual(len(pair["gainers"]), 10)

    def test_hsi_index_and_impact(self):
        doc, _ = self.build()
        idx = doc["hsi"]["index"]
        self.assertEqual(idx["prev_close"], 20000.0)
        self.assertAlmostEqual(idx["change_pct"], (idx["last"] / 20000.0 - 1) * 100, places=2)
        first = next(r for r in doc["hsi"]["constituents"] if r["code"] == "00001")
        self.assertAlmostEqual(first["impact_hkd"], 10.0 / 100 * 5e9, places=0)
        self.assertEqual(doc["hsi"]["breadth"], {"up": 1, "down": 1, "flat": 0})

    def test_news_is_kept_only_for_published_stocks(self):
        doc, _ = self.build()
        self.assertEqual(list(doc["news"]), ["00001"])

    def test_sectors_derive_from_stocks_when_no_heat_map(self):
        doc, m = self.build()
        ids = [s["id"] for s in doc["macro_sectors"]]
        self.assertIn("finance", ids)
        self.assertIn("property", ids)
        self.assertIn("other", ids, "unknown industry falls into the other sector")
        self.assertIn("神秘行業", m.unmapped)
        prop = next(s for s in doc["macro_sectors"] if s["id"] == "property")
        self.assertEqual((prop["up"], prop["down"]), (1, 1))
        self.assertEqual(prop["leader"]["code"], "00003")
        self.assertEqual(prop["industries"][0]["name"], "地產發展商")

    def test_heat_map_rows_drive_sector_totals(self):
        heat = [
            {"name": "銀行", "change_pct": 1.0, "turnover_hkd": 3e9, "market_cap_hkd": 6e10, "up": 20, "down": 5, "flat": 1},
            {"name": "保險", "change_pct": -1.0, "turnover_hkd": 1e9, "market_cap_hkd": 2e10, "up": 2, "down": 6, "flat": 0},
        ]
        doc, _ = self.build(industries=heat)
        fin = next(s for s in doc["macro_sectors"] if s["id"] == "finance")
        self.assertEqual(fin["turnover_hkd"], 4e9)
        self.assertEqual((fin["up"], fin["down"], fin["flat"]), (22, 11, 1))
        self.assertAlmostEqual(fin["change_pct"], 0.5)

    def test_output_is_json_and_names_no_vendor(self):
        doc, _ = self.build()
        text = json.dumps(doc, ensure_ascii=False)
        self.assertNotRegex(text, r"(?i)\bfutu\b|富途|\byahoo\b")


class Demo(unittest.TestCase):
    def test_committed_sample_is_the_seeded_output(self):
        committed = json.loads((ROOT / "hk-movers/data/sample.json").read_text(encoding="utf-8"))
        self.assertEqual(demo.build_demo(), committed, "run: python3 scripts/hk_movers_demo.py --out hk-movers/data/sample.json")

    def test_sample_is_marked_and_vendor_free(self):
        text = (ROOT / "hk-movers/data/sample.json").read_text(encoding="utf-8")
        doc = json.loads(text)
        self.assertEqual(doc["data_source"], "demo")
        self.assertIn("示範", doc["notice"])
        self.assertNotRegex(text, r"(?i)\bfutu\b|富途|\byahoo\b")
        self.assertTrue(10 <= len(doc["macro_sectors"]) <= 12)
        self.assertTrue(90 <= len(doc["hsi"]["constituents"]) <= 100)

    def test_script_hardcodes_no_credentials(self):
        for name in ("hk_movers_sync.py", "hk_movers_demo.py"):
            text = (ROOT / "scripts" / name).read_text(encoding="utf-8")
            self.assertNotRegex(text, r"(?i)(api[_-]?key|secret|token|password)\s*=\s*['\"][^'\"]{6,}")
            self.assertNotRegex(text, r"[0-9a-f]{32}")

    def test_cli_requires_an_action(self):
        self.assertEqual(sync.main([]), 2)
        self.assertEqual(sync.main(["--push-kv", "--namespace-id", ""]), 2)


if __name__ == "__main__":
    unittest.main()
