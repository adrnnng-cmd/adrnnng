import importlib.util
import json
import os
import re
import sys
import tempfile
import types
import unittest
import zipfile
from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

import hk_movers_demo as demo  # noqa: E402
import hk_movers_names as names_mod  # noqa: E402
import hk_movers_news as news_mod  # noqa: E402
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
        committed = json.loads((ROOT / "movers/data/sample.json").read_text(encoding="utf-8"))
        self.assertEqual(demo.build_demo(), committed, "run: python3 scripts/hk_movers_demo.py --out hk-movers/data/sample.json")

    def test_sample_is_marked_and_vendor_free(self):
        text = (ROOT / "movers/data/sample.json").read_text(encoding="utf-8")
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


OPEND_PLATES = [
    'Advertising Agencies', 'Aerospace & Defense', 'Agricultural Inputs', 'Agriculture', 'Air Cargo & Logistics', 'Airlines',
    'Alcoholic Beverages', 'Alternative/Renewable Energy', 'Aluminum', 'Apparel Manufacturing', 'Apparel Retailers',
    'Application Software', 'Auto Parts', 'Auto Retailers', 'Automobiles', 'Banks', 'Biotechnology', 'Broadcasting', 'Catering',
    'Coal', 'Commercial vehicles and trucks', 'Computers & Equipment', 'Conglomerates', 'Construction Materials',
    'Consumer Electronics', 'Consumer telecommunications equipment and parts', 'Copper', 'Credit Services', 'Dairy',
    'Digital Solution Services', 'Diversified Retailers', 'Education', 'Electric Utilities',
    'Electrical and electronic components', 'Energy Storage Systems', 'Engineering & Construction', 'Entertainment',
    'Environmental Services', 'Food Additives', 'Footwear', 'Forestry & Timber', 'Gaming', 'Gas Utilities',
    'Gold & Precious Metals', 'Heavy Infrastructure', 'Heavy Machinery', 'Home Appliances', 'Home Improvement Retail',
    'Hotels & Resorts', 'Industrial Parts & Equipment', 'Insurance', 'Interactive media and services',
    'Internet services and infrastructure', 'Investment & Asset Management', 'Jewelry & Watches', 'Livestock Feed',
    'Meat & Poultry', 'Medical Equipment & Supplies', 'Medical Services', 'Motorcycles and others', 'New Energy Materials',
    'Non-Alcoholic Beverages', 'Oil & Gas Producers', 'Oil & Gas Services', 'Online Retailers', 'Other Clothing Accessories',
    'Other Financial Services', 'Other Metals & Minerals', 'Other Retailers', 'Other Support Services', 'Paper & Packaging',
    'Payment services', 'Personal Care', 'Pharmaceutical Distribution',
    'Pharmaceutical and Biotechnology Contract Services', 'Pharmaceuticals', 'Printing & Packaging',
    'Procurement & Supply Chain Management', 'Property Services & Management', 'Public Transport', 'REITs',
    'Railroads & Highways', 'Real Estate Developers', 'Real Estate Investment', 'Real Estate Services', 'Resorts & Casinos',
    'Robotics Systems and Solutions', 'Satellite & Wireless Services', 'Securities & Brokerage',
    'Semiconductor Equipment & Materials', 'Semiconductors', 'Shipping & Ports', 'Skincare and cosmetics',
    'Speciality Chemicals', 'Sports & Recreation Facilities', 'Steel', 'Supermarkets & Convenience Stores', 'Telecom Services',
    'Telecommunication network infrastructure', 'Textiles & Fabrics', 'Tobacco', 'Toys & Leisure',
    'Track and train equipment', 'Traditional Chinese Medicine', 'Transport & Logistics', 'Travel & Sightseeing',
    'Water Utilities', 'dietary supplements', 'furniture', 'household consumables', 'nuclear', 'packaged food', 'publishing',
]


class EnglishPlates(unittest.TestCase):
    def test_the_measured_plate_list_has_113_names(self):
        self.assertEqual(len(OPEND_PLATES), 113)
        self.assertEqual(len(set(OPEND_PLATES)), 113)

    def test_every_measured_plate_is_mapped_translated_and_grouped(self):
        m = mapper()
        table = {e["en"]: e for e in MAPPER_MAP["english"]}
        self.assertEqual(set(table), set(OPEND_PLATES), "the table holds exactly the measured names")
        for plate in OPEND_PLATES:
            zh = m.industry_zh(plate)
            self.assertRegex(zh, r"[\u4e00-\u9fff]", plate)
            self.assertNotEqual(zh, "其他", plate)
            self.assertEqual(zh, table[plate]["zh"])
            self.assertEqual(m.sector_for(plate), table[plate]["sector"], plate)
            self.assertEqual(m.sector_for(zh), table[plate]["sector"], f"Chinese alias {zh} agrees with {plate}")
        self.assertEqual(m.unmapped, set(), "nothing falls through to the fallback by accident")

    def test_plates_spread_over_all_twelve_sectors(self):
        m = mapper()
        used = {m.sector_for(p) for p in OPEND_PLATES}
        self.assertEqual(used, {s["id"] for s in MAPPER_MAP["sectors"]})

    def test_known_examples(self):
        m = mapper()
        self.assertEqual((m.industry_zh("Online Retailers"), m.sector_for("Online Retailers")), ("線上零售", "consumer"))
        self.assertEqual((m.industry_zh("Banks"), m.sector_for("Banks")), ("銀行", "finance"))
        self.assertEqual(m.sector_for("Semiconductors"), "tech")
        self.assertEqual(m.sector_for("Automobiles"), "auto")
        self.assertEqual(m.sector_for("Real Estate Developers"), "property")
        self.assertEqual(m.sector_for("Oil & Gas Producers"), "energy")

    def test_lookup_is_case_insensitive_and_trims(self):
        m = mapper()
        self.assertEqual(m.industry_zh("  DIETARY SUPPLEMENTS "), "膳食補充劑")
        self.assertEqual(m.sector_for("Nuclear"), "energy")

    def test_chinese_aliases_are_unique_across_sectors(self):
        seen = {}
        for s in MAPPER_MAP["sectors"]:
            for name in s["industries"]:
                self.assertNotIn(name, seen)
                seen[name] = s["id"]
        for e in MAPPER_MAP["english"]:
            self.assertEqual(seen[e["zh"]], e["sector"], e["en"])

    def test_unknown_english_plate_is_recorded_and_shown_as_other(self):
        m = mapper()
        self.assertEqual(m.industry_zh("Space Mining"), "其他")
        self.assertEqual(m.sector_for("Space Mining"), "other")
        self.assertIn("Space Mining", m.unmapped)
        self.assertEqual(m.sector_for("Specialty Retail Chains"), "consumer", "English keyword fallback")

    def test_stock_rows_carry_chinese_industry_and_name(self):
        m = mapper()
        r = raw("00700", 110, 100, industry="Interactive media and services", name="TENCENT")
        r["name_tc"] = "騰訊控股"
        row = sync.build_stock(r, m)
        self.assertEqual((row["name"], row["industry"], row["sector"]), ("騰訊控股", "互動媒體及服務", "tech"))
        plain = sync.build_stock(raw("00005", 110, 100, industry="Banks", name="HSBC HOLDINGS"), m)
        self.assertEqual((plain["name"], plain["industry"], plain["sector"]), ("HSBC HOLDINGS", "銀行", "finance"))

    def test_heat_map_rows_are_translated_and_merged(self):
        m = mapper()
        heat = [
            {"name": "Banks", "change_pct": 2.0, "turnover_hkd": 3e9, "market_cap_hkd": 6e10, "up": 10, "down": 2, "flat": 0},
            {"name": "Pharmaceuticals", "change_pct": 1.0, "turnover_hkd": 1e9, "market_cap_hkd": 2e10, "up": 4, "down": 1, "flat": 0},
            {"name": "Traditional Chinese Medicine", "change_pct": -1.0, "turnover_hkd": 5e8, "market_cap_hkd": 2e10, "up": 1, "down": 3, "flat": 0},
            {"name": "Mystery Plate", "change_pct": 0.5, "turnover_hkd": 1e8, "market_cap_hkd": 1e9, "up": None, "down": None, "flat": None},
            {"name": "Another Mystery", "change_pct": 1.5, "turnover_hkd": 1e8, "market_cap_hkd": 1e9, "up": 1, "down": 0, "flat": 0},
        ]
        out = {i["name"]: i for i in sync.localize_industries(heat, m)}
        self.assertEqual(set(out), {"銀行", "西藥", "中藥", "其他"})
        self.assertEqual(out["銀行"]["up"], 10)
        merged = out["其他"]
        self.assertEqual(merged["turnover_hkd"], 2e8)
        self.assertAlmostEqual(merged["change_pct"], 1.0)
        self.assertIsNone(merged["up"], "counts stay unknown when any merged row lacks them")

    def test_snapshot_from_english_heat_map_lands_in_chinese_sectors(self):
        m = mapper()
        stocks = [sync.build_stock(raw("00001", 110, 100, industry="Banks"), m),
                  sync.build_stock(raw("00002", 95, 100, industry="Online Retailers"), m)]
        heat = [{"name": "Banks", "change_pct": 1.0, "turnover_hkd": 3e9, "market_cap_hkd": 6e10, "up": 9, "down": 1, "flat": 0},
                {"name": "Online Retailers", "change_pct": -1.0, "turnover_hkd": 2e9, "market_cap_hkd": 3e10, "up": 2, "down": 5, "flat": 0}]
        doc = sync.build_snapshot(now=datetime(2026, 11, 20, 11, 0, tzinfo=sync.HKT), hsi_index=None, hsi_rows=stocks,
                                  stocks=stocks, industries=heat, news=None, mapper=m)
        by_id = {s["id"]: s for s in doc["macro_sectors"]}
        self.assertEqual(by_id["finance"]["industries"][0]["name"], "銀行")
        self.assertEqual(by_id["consumer"]["industries"][0]["name"], "線上零售")
        self.assertEqual(by_id["finance"]["leader"]["code"], "00001")
        self.assertNotRegex(json.dumps(doc, ensure_ascii=False), r"Banks|Online Retailers")


class SdkShapes(unittest.TestCase):
    def test_ok_accepts_two_and_longer_tuples(self):
        self.assertEqual(sync._ok((0, "data"), "x"), "data")
        self.assertEqual(sync._ok((0, "df", None, 113), "x"), "df")
        with self.assertRaises(RuntimeError):
            sync._ok((-1, "boom"), "x")
        with self.assertRaises(RuntimeError):
            sync._ok((-1, "boom", None, 0), "x")

    def test_heat_map_four_tuple_and_count(self):
        calls = []

        class Ctx:
            def get_heat_map_data(self, market, count=0):
                calls.append((market, count))
                return 0, [{"plate_name": "Banks", "change_rate": 1.2, "turnover": 5e9, "total_market_val": 9e10}], None, 113

        rows = sync.fetch_heatmap(Ctx(), "HK")
        self.assertEqual(calls, [("HK", 200)])
        self.assertEqual(rows[0]["name"], "Banks")
        self.assertEqual(rows[0]["change_pct"], 1.2)

    def test_top_movers_signature_tuple_data_and_security_column(self):
        calls = []

        class Ctx:
            def get_top_movers_rank(self, market, sort_dir=None, count=10, offset=None, filter_list=None):
                calls.append((market, sort_dir, count))
                rows = [{"security": "HK.00700"}, {"security": "HK.09988"}] if sort_dir == "DESC" else [{"code": "HK.00005"}, {"security": "HK.00700"}]
                return 0, (len(rows), rows)

        codes = sync.fetch_top_movers(Ctx(), "HK", 50, ("DESC", "ASC"))
        self.assertEqual(calls, [("HK", "DESC", 50), ("HK", "ASC", 50)])
        self.assertEqual(codes, ["HK.00700", "HK.09988", "HK.00005"], "both column names read, duplicates dropped")

    def test_top_movers_error_is_raised(self):
        class Ctx:
            def get_top_movers_rank(self, *a, **k):
                return -1, "no rights"

        with self.assertRaises(RuntimeError):
            sync.fetch_top_movers(Ctx(), "HK", 5, ("DESC",))

    def test_stock_basicinfo_codes(self):
        class Ctx:
            def get_stock_basicinfo(self, market, sec_type):
                assert (market, sec_type) == ("HK", "STOCK")
                return 0, [{"code": "HK.00700"}, {"code": "HK.00005"}]

        self.assertEqual(sync.fetch_hk_stock_codes(Ctx(), "HK", "STOCK"), {"00700", "00005"})

    def test_candidates_keep_only_hk_dollar_shares(self):
        names = {"07200": {"name": "二南方恒指", "category": "交易所買賣產品"}, "00700": {"name": "騰訊控股", "category": "股本"}}
        codes = ["HK.00700", "HK.80700", "HK.07200", "HK.00005", "HK.12345", "HK.09988"]
        listed = {"00700", "00005", "07200", "80700"}
        self.assertEqual(sync.keep_candidates(codes, listed, names), ["HK.00700", "HK.00005"])
        self.assertEqual(sync.keep_candidates(codes, set(), names), ["HK.00700", "HK.00005", "HK.09988"])

    def test_owner_industries_read_english_plate_names(self):
        class Ctx:
            def get_owner_plate(self, codes):
                return 0, [{"code": "HK.00700", "plate_name": "Interactive media and services", "plate_type": "INDUSTRY"},
                           {"code": "HK.00700", "plate_name": "Hang Seng Index", "plate_type": "OTHER"},
                           {"code": "HK.00005", "plate_name": "Banks", "plate_type": "PlateType.INDUSTRY"}]

        self.assertEqual(sync.fetch_owner_industries(Ctx(), ["HK.00700", "HK.00005"]),
                         {"HK.00700": "Interactive media and services", "HK.00005": "Banks"})

    def test_owner_industries_match_other_typed_plates_by_known_name(self):
        rows = [
            {"code": "HK.00700", "plate_name": "Hang Seng Index", "plate_type": "OTHER"},
            {"code": "HK.00700", "plate_name": "Digital Solution Services", "plate_type": "OTHER"},
            {"code": "HK.00700", "plate_name": "Some Concept", "plate_type": "CONCEPT"},
            {"code": "HK.00005", "plate_name": "HK Dividend", "plate_type": "OTHER"},
            {"code": "HK.00005", "plate_name": "Banks", "plate_type": "OTHER"},
            {"code": "HK.01299", "plate_name": "Unknown Plate", "plate_type": "OTHER"},
        ]

        class Ctx:
            def get_owner_plate(self, codes):
                return 0, rows

        m = mapper()
        heat = {"digital solution services"}
        got = sync.fetch_owner_industries(
            Ctx(), ["HK.00700", "HK.00005", "HK.01299"], known=lambda n: n.casefold() in heat or m.knows(n))
        self.assertEqual(got, {"HK.00700": "Digital Solution Services", "HK.00005": "Banks"})

    def test_owner_industries_known_name_beats_an_industry_typed_row(self):
        class Ctx:
            def get_owner_plate(self, codes):
                return 0, [{"code": "HK.00005", "plate_name": "Odd Plate", "plate_type": "INDUSTRY"},
                           {"code": "HK.00005", "plate_name": "Banks", "plate_type": "OTHER"}]

        self.assertEqual(sync.fetch_owner_industries(Ctx(), ["HK.00005"], known=mapper().knows), {"HK.00005": "Banks"})

    def test_owner_plate_batch_error_is_bisected_to_skip_the_bad_code(self):
        calls = []

        class Ctx:
            def get_owner_plate(self, codes):
                calls.append(list(codes))
                if "HK.00823" in codes:
                    return -1, "Get Stock's Sector interface does not support ETFs type."
                return 0, [{"code": c, "plate_name": "Banks", "plate_type": "OTHER"} for c in codes]

        codes = ["HK.00005", "HK.00011", "HK.00823", "HK.01299", "HK.02388"]
        got = sync.fetch_owner_industries(Ctx(), codes, known=mapper().knows)
        self.assertEqual(set(got), {"HK.00005", "HK.00011", "HK.01299", "HK.02388"})
        self.assertLess(len(calls), 12)
        self.assertEqual(calls[0], codes, "a healthy batch is one call")

    def test_owner_plate_all_bad_codes_return_nothing(self):
        class Ctx:
            def get_owner_plate(self, codes):
                return -1, "no"

        self.assertEqual(sync.fetch_owner_industries(Ctx(), ["HK.00823", "HK.02800"], known=mapper().knows), {})

    def test_is_reit_uses_the_exchange_category(self):
        names = {"00823": {"name": "領展房產基金", "category": "房地產投資信託基金"}, "00700": {"name": "騰訊控股", "category": "股本"}}
        self.assertTrue(sync.is_reit("HK.00823", names))
        self.assertFalse(sync.is_reit("HK.00700", names))
        self.assertFalse(sync.is_reit("HK.09999", names))


class NanSafety(unittest.TestCase):
    NAN = float("nan")

    def test_num_turns_bad_values_into_zero(self):
        for bad in (None, self.NAN, float("inf"), float("-inf"), "n/a", "N/A", ""):
            self.assertEqual(sync._num(bad), 0.0, repr(bad))
        self.assertEqual(sync._num("12.5"), 12.5)
        self.assertEqual(sync._num(3), 3.0)
        self.assertEqual(sync._num(None, 7.0), 7.0)

    def test_qualifies_does_not_raise_on_nan_or_none(self):
        self.assertFalse(sync.qualifies(self.NAN, 5e9))
        self.assertFalse(sync.qualifies(5e7, self.NAN))
        self.assertFalse(sync.qualifies(None, None))
        self.assertTrue(sync.qualifies(1e7, 1.1e9))

    def test_build_stock_with_nan_fields(self):
        row = raw("00700", 10.0, 9.0)
        row.update(turnover=self.NAN, total_market_val=self.NAN, high_price=self.NAN, low_price=self.NAN)
        stock = sync.build_stock(row, mapper())
        self.assertEqual(stock["turnover_hkd"], 0)
        self.assertEqual(stock["market_cap_hkd"], 0)
        self.assertEqual(stock["impact_hkd"], 0)
        self.assertNotIn("amplitude_pct", stock)
        self.assertFalse(sync.qualifies(stock["turnover_hkd"], stock["market_cap_hkd"]))
        self.assertIsNone(sync.build_stock(raw("00001", self.NAN, 9.0), mapper()))
        self.assertIsNone(sync.build_stock(raw("00001", 10.0, self.NAN), mapper()))

    def test_rank_and_breadth_tolerate_missing_numbers(self):
        rows = [
            {"code": "00001", "change_pct": 3.0, "turnover_hkd": None},
            {"code": "00002", "change_pct": 3.0, "turnover_hkd": self.NAN},
            {"code": "00003", "change_pct": self.NAN, "turnover_hkd": 5e7},
            {"code": "00004", "change_pct": None, "turnover_hkd": 5e7},
            {"code": "00005", "change_pct": -2.0, "turnover_hkd": 9e7},
        ]
        self.assertEqual([r["code"] for r in sync.rank(rows, "up")], ["00001", "00002"])
        self.assertEqual([r["code"] for r in sync.rank(rows, "down")], ["00005"])
        self.assertEqual(sync.breadth(rows), {"up": 2, "down": 1, "flat": 2})

    def test_heatmap_row_with_nan_values(self):
        row = sync.normalize_heatmap_row({"plate_name": "Banks", "change_rate": self.NAN, "turnover": None, "total_market_val": self.NAN})
        self.assertEqual((row["change_pct"], row["turnover_hkd"], row["market_cap_hkd"]), (0.0, 0.0, 0.0))


def make_xlsx(rows):
    """A minimal workbook: shared strings plus one sheet, like the exchange's list."""
    strings, index = [], {}

    def sid(text):
        if text not in index:
            index[text] = len(strings)
            strings.append(text)
        return index[text]

    def col(i):
        return "ABCDEFGHIJ"[i]

    sheet_rows = []
    for r, row in enumerate(rows, start=1):
        cells = "".join(f'<c r="{col(c)}{r}" t="s"><v>{sid(v)}</v></c>' for c, v in enumerate(row) if v != "")
        sheet_rows.append(f'<row r="{r}">{cells}</row>')
    ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    sheet = f'<?xml version="1.0"?><worksheet {ns}><sheetData>{"".join(sheet_rows)}</sheetData></worksheet>'
    shared = f'<?xml version="1.0"?><sst {ns}>' + "".join(f"<si><t>{t}</t></si>" for t in strings) + "</sst>"
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("xl/sharedStrings.xml", shared)
        zf.writestr("xl/worksheets/sheet1.xml", sheet)
    return buf.getvalue()


SECURITIES = make_xlsx([
    ["上市證券一覽表"],
    ["更新日期: 20/11/2026"],
    [],
    ["股份代號", "股份名稱", "分類", "買賣單位"],
    ["00700", "騰訊控股", "股本", "100"],
    ["09988", "阿里巴巴－Ｗ", "股本", "100"],
    ["07200", "二南方恒指", "交易所買賣產品", "100"],
    ["00823", "領展房產基金", "房地產投資信託基金", "500"],
    ["註: 備註行", "", "", ""],
])


class HkexNames(unittest.TestCase):
    def test_parse_names_with_standard_library_only(self):
        names = names_mod.parse_names(SECURITIES)
        self.assertEqual(names["00700"], {"name": "騰訊控股", "category": "股本"})
        self.assertEqual(names["09988"]["name"], "阿里巴巴-W", "full-width letters and dash are folded")
        self.assertEqual(names["07200"]["category"], "交易所買賣產品")
        self.assertNotIn("註: 備註行", names)
        self.assertEqual(len(names), 4)

    def test_parse_rejects_a_file_without_the_header(self):
        with self.assertRaises(ValueError):
            names_mod.parse_names(make_xlsx([["a", "b"], ["1", "2"]]))

    def test_cache_is_used_for_seven_days_then_refreshed(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp) / "names.json"
            fetches = []

            def fetch(url):
                fetches.append(url)
                return SECURITIES

            first = names_mod.load_names(cache, now=1_000_000, fetch=fetch)
            self.assertEqual(first["00700"]["name"], "騰訊控股")
            self.assertEqual(len(fetches), 1)
            self.assertTrue(fetches[0].endswith("ListOfSecurities_c.xlsx"))
            names_mod.load_names(cache, now=1_000_000 + 6 * 24 * 3600, fetch=fetch)
            self.assertEqual(len(fetches), 1, "fresh cache, no download")
            names_mod.load_names(cache, now=1_000_000 + 8 * 24 * 3600, fetch=fetch)
            self.assertEqual(len(fetches), 2, "stale cache, downloaded again")

    def test_failed_refresh_falls_back_to_stale_cache_then_to_empty(self):
        def boom(url):
            raise OSError("offline")

        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp) / "names.json"
            self.assertEqual(names_mod.load_names(cache, now=5, fetch=boom), {})
            names_mod.load_names(cache, now=10, fetch=lambda u: SECURITIES)
            stale = names_mod.load_names(cache, now=10 + 30 * 24 * 3600, fetch=boom)
            self.assertEqual(stale["00700"]["name"], "騰訊控股")

    def test_equity_filters(self):
        names = names_mod.parse_names(SECURITIES)
        self.assertTrue(names_mod.is_hk_equity_code("HK.00700"))
        self.assertTrue(names_mod.is_hk_equity_code("09999"))
        self.assertFalse(names_mod.is_hk_equity_code("HK.80700"), "RMB counter")
        self.assertFalse(names_mod.is_hk_equity_code("HK.12345"))
        self.assertFalse(names_mod.is_hk_equity_code("00000"))
        self.assertTrue(names_mod.is_listed_equity("HK.00700", names))
        self.assertFalse(names_mod.is_listed_equity("HK.07200", names), "ETF by 分類")
        self.assertTrue(names_mod.is_listed_equity("HK.00823", names), "REIT")
        self.assertTrue(names_mod.is_listed_equity("HK.00005", names), "not in the list: range check only")

    def test_tc_names_replace_english_snapshot_names(self):
        rows = [{"code": "HK.00700", "name": "TENCENT"}, {"code": "HK.00005", "name": "HSBC HOLDINGS"}]
        sync.apply_tc_names(rows, names_mod.parse_names(SECURITIES))
        self.assertEqual(rows[0]["name_tc"], "騰訊控股")
        self.assertNotIn("name_tc", rows[1])


RSS = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>q</title>
<item><title>Tencent shares rise on results - Reuters</title><link>https://news.example.com/en</link>
 <pubDate>Fri, 20 Nov 2026 03:00:00 GMT</pubDate><source url="https://www.reuters.com">Reuters</source></item>
<item><title>富途證券下調騰訊目標價 - 富途新聞</title><link>https://news.example.com/futu</link>
 <pubDate>Fri, 20 Nov 2026 06:30:00 GMT</pubDate><source url="https://news.futunn.com">富途新聞</source></item>
<item><title>騰訊控股股價異動 - Yahoo奇摩股市</title><link>https://news.example.com/yahoo</link>
 <pubDate>Fri, 20 Nov 2026 06:20:00 GMT</pubDate><source url="https://hk.finance.yahoo.com">Yahoo奇摩股市</source></item>
<item><title>Moomoo 解讀騰訊業績 - 其他</title><link>https://news.example.com/moomoo</link>
 <pubDate>Fri, 20 Nov 2026 06:10:00 GMT</pubDate><source url="https://www.moomoo.com">其他</source></item>
<item><title>中國互聯網板塊全面反彈 - 信報財經新聞</title><link>https://news.example.com/sector</link>
 <pubDate>Fri, 20 Nov 2026 05:00:00 GMT</pubDate><source url="https://www.hkej.com">信報財經新聞</source></item>
<item><title>騰訊控股回購股份 市場看好 - 香港經濟日報</title><link>https://news.example.com/hket</link>
 <pubDate>Fri, 20 Nov 2026 02:15:00 GMT</pubDate><source url="https://www.hket.com">香港經濟日報</source></item>
<item><title>騰訊控股公佈第三季業績 - 明報財經</title><link>https://news.example.com/mingpao</link>
 <pubDate>Thu, 19 Nov 2026 14:00:00 GMT</pubDate><source url="https://www.mingpao.com">明報財經</source></item>
<item><title>騰訊控股相關 - 壞連結</title><link>javascript:alert(1)</link>
 <pubDate>Fri, 20 Nov 2026 07:00:00 GMT</pubDate><source url="https://x.example">壞連結</source></item>
</channel></rss>""".encode("utf-8")


HKT = news_mod.HKT
NOW = datetime(2026, 11, 20, 16, 0, tzinfo=HKT)


def rss_item(title, when_hkt, source="香港經濟日報", link=None):
    """One RSS item published at an HKT wall-clock time (string "YYYY-MM-DD HH:MM[:SS]" or datetime)."""
    from email.utils import format_datetime
    from datetime import timezone as tz
    dt = when_hkt if isinstance(when_hkt, datetime) else datetime.strptime(when_hkt, "%Y-%m-%d %H:%M").replace(tzinfo=HKT)
    link = link or f"https://news.example.com/{abs(hash(title)) % 10**8}"
    return (f"<item><title>{title} - {source}</title><link>{link}</link>"
            f"<pubDate>{format_datetime(dt.astimezone(tz.utc), usegmt=True)}</pubDate>"
            f'<source url="https://x.example">{source}</source></item>')


def rss_doc(*items):
    return ('<?xml version="1.0"?><rss><channel>' + "".join(items) + "</channel></rss>").encode("utf-8")


class GoogleNews(unittest.TestCase):
    def test_query_url_is_hong_kong_traditional_chinese(self):
        url = news_mod.rss_url("HK.00700", "騰訊控股")
        self.assertTrue(url.startswith("https://news.google.com/rss/search?q=700+"))
        self.assertIn("%E9%A8%B0%E8%A8%8A", url)
        self.assertIn("hl=zh-HK", url)
        self.assertIn("gl=HK", url)
        self.assertIn("ceid=HK:zh-Hant", url)

    def test_query_carries_the_recency_window(self):
        self.assertIn("when%3A3d", news_mod.rss_url("HK.00700", "騰訊控股"))
        self.assertIn("when%3A1d", news_mod.rss_url("HK.00700", "騰訊控股", "1d"))
        self.assertEqual(news_mod.WINDOWS, ("1d", "3d"))

    def test_outlet_suffix_and_time(self):
        self.assertEqual(news_mod.strip_outlet("標題一二三 - 香港經濟日報", "香港經濟日報"), "標題一二三")
        self.assertEqual(news_mod.strip_outlet("標題 - 副題 - 某報", "某報"), "標題 - 副題")
        self.assertEqual(news_mod.strip_outlet("沒有媒體名的標題", ""), "沒有媒體名的標題")
        self.assertEqual(news_mod.to_hkt_stamp("Fri, 20 Nov 2026 03:00:00 GMT")[0], "2026-11-20 11:00")
        self.assertEqual(news_mod.to_hkt_stamp("Thu, 19 Nov 2026 20:00:00 +0000")[0], "2026-11-20 04:00")
        self.assertEqual(news_mod.to_hkt_stamp("garbage"), ("", 0.0))

    def test_vendor_english_unsafe_links_are_skipped_and_newest_named_item_wins(self):
        item = news_mod.pick_item(news_mod.parse_items(RSS), "騰訊控股", NOW)
        self.assertEqual(item, {
            "title": "騰訊控股回購股份 市場看好", "source": "香港經濟日報",
            "published_at_hkt": "2026-11-20 10:15", "url": "https://news.example.com/hket",
        })

    def test_without_a_named_item_the_newest_usable_one_is_used(self):
        item = news_mod.pick_item(news_mod.parse_items(RSS), "不存在的公司", NOW)
        self.assertEqual(item["title"], "中國互聯網板塊全面反彈")

    def test_banned_wording_is_filtered_everywhere(self):
        for it in news_mod.parse_items(RSS):
            picked = news_mod.pick_item([it], "", NOW)
            if picked:
                blob = json.dumps(picked, ensure_ascii=False)
                self.assertNotRegex(blob, r"(?i)futu|富途|moomoo|yahoo|雅虎")
        only_banned = [i for i in news_mod.parse_items(RSS) if re.search(r"(?i)futu|富途|moomoo|yahoo", i["raw_title"] + i["source"] + i["source_url"])]
        self.assertEqual(len(only_banned), 3)
        self.assertIsNone(news_mod.pick_item(only_banned, "", NOW))

    def test_fetch_news_survives_errors_and_empty_feeds(self):
        def boom(url):
            raise OSError("offline")

        self.assertIsNone(news_mod.fetch_news("00700", "騰訊控股", fetch=boom, now=NOW))
        self.assertIsNone(news_mod.fetch_news("00700", "騰訊控股", fetch=lambda u: b"not xml", now=NOW))
        empty = b'<?xml version="1.0"?><rss><channel></channel></rss>'
        self.assertIsNone(news_mod.fetch_news("00700", "騰訊控股", fetch=lambda u: empty, now=NOW))
        self.assertEqual(news_mod.fetch_news("00700", "騰訊控股", fetch=lambda u: RSS, now=NOW)["source"], "香港經濟日報")

    def test_gateway_news_is_only_a_vendor_free_chinese_backup(self):
        stamp = "2026-11-20 10:30"
        good = {"title": "騰訊業績理想", "url": "https://example.com/a", "source": "某媒體", "published_at_hkt": stamp}
        self.assertEqual(news_mod.usable_backup(good, NOW), good)
        bad = [
            {"title": "Tencent beats", "url": "https://example.com/a", "source": "x"},
            {"title": "騰訊業績理想", "url": "https://news.futunn.com/en/x", "source": "x"},
            {"title": "富途解讀騰訊", "url": "https://example.com/a", "source": "x"},
            {"title": "騰訊業績理想", "url": "javascript:1", "source": "x"},
        ]
        for item in bad:
            self.assertIsNone(news_mod.usable_backup({**item, "published_at_hkt": stamp}, NOW), item)
        self.assertIsNone(news_mod.usable_backup(None, NOW))

    def test_gateway_news_is_age_gated_too(self):
        base = {"title": "騰訊業績理想", "url": "https://example.com/a", "source": "某媒體"}
        for stamp, ok in (("2026-11-20 15:59", True), ("2026-11-17 16:00", True), ("2026-11-17 15:59", False),
                          ("", False), ("昨天", False), ("2026-02-31 10:00", False), ("2026-11-20 16:01", False)):
            got = news_mod.usable_backup({**base, "published_at_hkt": stamp}, NOW)
            self.assertEqual(got is not None, ok, stamp)
        self.assertIsNone(news_mod.usable_backup(dict(base), NOW), "a missing timestamp is rejected")


class NewsFreshness(unittest.TestCase):
    """Strict parsed-timestamp gate: 0 <= age <= 72 hours at the injected now (HKT)."""

    def at(self, **delta):
        return (NOW - timedelta(**delta)).timestamp()

    def test_boundaries(self):
        cases = [
            (dict(seconds=0), True, "published right now"),
            (dict(hours=1), True, "today"),
            (dict(hours=71, minutes=59, seconds=59), True, "just inside 72h"),
            (dict(hours=72), True, "exactly 72h is still accepted"),
            (dict(hours=72, seconds=1), False, "one second over"),
            (dict(days=7), False, "weeks-old"),
            (dict(days=30), False, "weeks-old"),
            (dict(seconds=-1), False, "one second in the future"),
            (dict(hours=-5), False, "future"),
        ]
        for delta, ok, why in cases:
            self.assertEqual(news_mod.is_fresh(self.at(**delta), NOW), ok, why)
        self.assertFalse(news_mod.is_fresh(0.0, NOW), "missing")
        self.assertFalse(news_mod.is_fresh(-5.0, NOW), "invalid")
        self.assertFalse(news_mod.is_fresh(float("nan"), NOW), "nan")

    def test_stamp_parser_is_strict(self):
        self.assertEqual(news_mod.parse_hkt_stamp("2026-11-20 11:00"), datetime(2026, 11, 20, 11, 0, tzinfo=HKT).timestamp())
        self.assertEqual(news_mod.parse_hkt_stamp("2026-11-20T11:00:30"), datetime(2026, 11, 20, 11, 0, 30, tzinfo=HKT).timestamp())
        for bad in ("", None, "2026-11-20", "11:00", "2026/11/20 11:00", "2026-13-01 10:00", "2026-02-30 10:00", "2026-11-20 25:00", "x"):
            self.assertEqual(news_mod.parse_hkt_stamp(bad), 0.0, repr(bad))

    def test_same_day_uses_the_hkt_calendar_day(self):
        self.assertTrue(news_mod.is_same_day(datetime(2026, 11, 20, 0, 5, tzinfo=HKT).timestamp(), NOW))
        self.assertFalse(news_mod.is_same_day(datetime(2026, 11, 19, 23, 55, tzinfo=HKT).timestamp(), NOW))
        utc_evening = datetime(2026, 11, 19, 17, 0, tzinfo=timezone.utc).timestamp()
        self.assertTrue(news_mod.is_same_day(utc_evening, NOW), "01:00 HKT on the 20th is the same HKT day")

    def test_old_missing_and_future_items_never_win(self):
        feed = rss_doc(
            rss_item("騰訊控股半年前舊聞", "2026-05-01 10:00"),
            rss_item("騰訊控股三星期前消息", "2026-10-30 10:00"),
            rss_item("騰訊控股來自未來的消息", "2026-11-21 10:00"),
            "<item><title>騰訊控股沒有時間 - 某報</title><link>https://news.example.com/nodate</link><source url='https://x'>某報</source></item>",
            "<item><title>騰訊控股時間壞掉 - 某報</title><link>https://news.example.com/baddate</link><pubDate>not a date</pubDate><source url='https://x'>某報</source></item>",
        )
        self.assertIsNone(news_mod.pick_item(news_mod.parse_items(feed), "騰訊控股", NOW))
        self.assertIsNone(news_mod.fetch_news("00700", "騰訊控股", fetch=lambda u: feed, now=NOW), "no weeks-old fallback")

    def test_same_day_beats_newer_looking_older_and_named_older(self):
        feed = rss_doc(
            rss_item("騰訊控股昨日公告", "2026-11-19 20:00"),
            rss_item("某板塊今日走勢", "2026-11-20 09:30"),
            rss_item("騰訊控股前日消息", "2026-11-18 18:00"),
        )
        item = news_mod.pick_item(news_mod.parse_items(feed), "騰訊控股", NOW)
        self.assertEqual(item["title"], "某板塊今日走勢", "same-day preferred even when unnamed")

    def test_without_same_day_the_named_then_newest_within_72h_wins(self):
        feed = rss_doc(
            rss_item("騰訊控股前日消息", "2026-11-18 18:00"),
            rss_item("騰訊控股昨日公告", "2026-11-19 20:00"),
            rss_item("某板塊昨日走勢", "2026-11-19 22:00"),
        )
        self.assertEqual(news_mod.pick_item(news_mod.parse_items(feed), "騰訊控股", NOW)["title"], "騰訊控股昨日公告")

    def test_fetch_searches_same_day_first_then_the_three_day_window(self):
        urls = []
        day1 = rss_doc(rss_item("騰訊控股今日公告", "2026-11-20 10:00"))
        day3 = rss_doc(rss_item("騰訊控股前日消息", "2026-11-18 18:00"), rss_item("騰訊控股昨日公告", "2026-11-19 20:00"))

        def fetch(url):
            urls.append(url)
            return day1 if "when%3A1d" in url else day3

        self.assertEqual(news_mod.fetch_news("00700", "騰訊控股", fetch=fetch, now=NOW)["title"], "騰訊控股今日公告")
        self.assertEqual(len(urls), 1, "a same-day hit stops the search")

        urls.clear()

        def only_old(url):
            urls.append(url)
            return rss_doc() if "when%3A1d" in url else day3

        self.assertEqual(news_mod.fetch_news("00700", "騰訊控股", fetch=only_old, now=NOW)["title"], "騰訊控股昨日公告")
        self.assertEqual(len(urls), 2)
        self.assertIn("when%3A1d", urls[0])
        self.assertIn("when%3A3d", urls[1])

    def test_keep_fresh_drops_cached_old_news(self):
        news = {
            "00700": {"title": "今日", "published_at_hkt": "2026-11-20 10:00"},
            "00005": {"title": "邊界", "published_at_hkt": "2026-11-17 16:00"},
            "09988": {"title": "過期一秒", "published_at_hkt": "2026-11-17 15:59"},
            "01211": {"title": "舊聞", "published_at_hkt": "2026-10-01 10:00"},
            "00001": {"title": "沒有時間", "published_at_hkt": ""},
            "00002": {"title": "未來", "published_at_hkt": "2026-11-21 10:00"},
        }
        self.assertEqual(set(news_mod.keep_fresh(news, NOW)), {"00700", "00005"})

    def test_collect_live_drops_old_headlines_from_the_published_document(self):
        old = {"title": "騰訊控股舊聞", "source": "某報", "published_at_hkt": "2026-11-01 10:00", "url": "https://example.com/old"}
        fresh_stamp = datetime.now(HKT).strftime("%Y-%m-%d %H:%M")
        fresh = {"title": "新鮮消息", "source": "某報", "published_at_hkt": fresh_stamp, "url": "https://example.com/new"}
        fake, _ = CollectLive().make_sdk()
        roster_path = CollectLive.roster_file()
        self.addCleanup(os.unlink, roster_path)
        args = sync.parse_args(["--out", "x.json", "--news-delay", "0", "--names-cache", "/nonexistent/names.json",
                                "--rosters", roster_path, "--history-batch", "0"])
        with mock.patch.dict(sys.modules, {"futu": fake}), \
                mock.patch.object(names_mod, "load_names", return_value=CollectLive.NAMES), \
                mock.patch.object(news_mod, "fetch_news", side_effect=lambda code, name, **kw: old if code == "00700" else fresh):
            doc = sync.collect_live(args)
        self.assertNotIn("00700", doc["news"], "a stale headline is dropped even if a lookup returned it")
        self.assertIn("09988", doc["news"])


class Wrangler(unittest.TestCase):
    def run_push(self, **kw):
        calls = []
        with mock.patch.object(sync.subprocess, "run", side_effect=lambda cmd, **k: calls.append((cmd, k))):
            sync.push_kv({"schema_version": 1}, "ns123", **kw)
        return calls[0]

    def test_default_is_npx_wrangler(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("HK_MOVERS_WRANGLER_BIN", None)
            cmd, kwargs = self.run_push()
        self.assertEqual(cmd[:6], ["npx", "wrangler", "kv", "key", "put", "hk-movers:latest.json"])
        self.assertIn("--namespace-id", cmd)
        self.assertEqual(cmd[cmd.index("--namespace-id") + 1], "ns123")
        self.assertIn("--remote", cmd)
        self.assertTrue(kwargs["check"])
        self.assertIsNone(kwargs["cwd"], "no node_modules path: stay in the current directory")

    def test_flag_and_environment_choose_the_binary(self):
        cmd, _ = self.run_push(wrangler_bin="/workspace/digest/tools/cfwrangler")
        self.assertEqual(cmd[0], "/workspace/digest/tools/cfwrangler")
        self.assertEqual(cmd[1:3], ["kv", "key"])
        with mock.patch.dict(os.environ, {"HK_MOVERS_WRANGLER_BIN": "/opt/wr"}):
            self.assertEqual(self.run_push()[0][0], "/opt/wr")
            self.assertEqual(self.run_push(wrangler_bin="/flag/wr")[0][0], "/flag/wr", "the flag wins")
        self.assertEqual(sync.wrangler_command("node /opt/wrangler.js")[:2], ["node", "/opt/wrangler.js"])

    def test_cwd_is_the_directory_above_node_modules(self):
        with tempfile.TemporaryDirectory() as tmp:
            tool = Path(tmp) / "tools" / "cfwrangler"
            (tool / "node_modules" / ".bin").mkdir(parents=True)
            binary = str(tool / "node_modules" / ".bin" / "wrangler")
            cmd, kwargs = self.run_push(wrangler_bin=binary)
            self.assertEqual(cmd[0], binary)
            self.assertEqual(kwargs["cwd"], str(tool))
            with mock.patch.dict(os.environ, {"HK_MOVERS_WRANGLER_BIN": binary}):
                self.assertEqual(self.run_push()[1]["cwd"], str(tool))
            self.assertEqual(sync.wrangler_cwd(f"node {binary}"), str(tool))
            self.assertIsNone(sync.wrangler_cwd(str(Path(tmp) / "bin" / "wrangler")))
            self.assertIsNone(sync.wrangler_cwd("/nonexistent/x/node_modules/.bin/wrangler"), "a missing directory is not used")

    def test_cli_exposes_the_flags(self):
        args = sync.parse_args(["--out", "x.json", "--wrangler-bin", "/w", "--names-cache", "/tmp/n.json"])
        self.assertEqual((args.wrangler_bin, args.names_cache), ("/w", "/tmp/n.json"))


def _weekdays(start, end):
    day, last, out = datetime.fromisoformat(start), datetime.fromisoformat(end), []
    while day <= last:
        if day.weekday() < 5:
            out.append(day.strftime("%Y-%m-%d"))
        day += timedelta(days=1)
    return out


HISTORY_DAYS = _weekdays("2025-12-01", "2026-11-23")


class CollectLive(unittest.TestCase):
    """End to end with a fake SDK that answers in the shapes measured on a real OpenD."""

    LISTED = ("HK.00700", "HK.00005", "HK.09988", "HK.01211", "HK.80700", "HK.07200", "HK.02020", "HK.00999", "HK.00998")

    def make_sdk(self, listed=LISTED):
        nan = float("nan")
        snap = {
            "HK.00700": dict(code="HK.00700", name="TENCENT", last_price=520.0, prev_close_price=500.0, turnover=2e9, total_market_val=4.8e12, high_price=525.0, low_price=498.0),
            "HK.00005": dict(code="HK.00005", name="HSBC HOLDINGS", last_price=95.0, prev_close_price=100.0, turnover=1e9, total_market_val=1.7e12, high_price=100.0, low_price=94.0),
            "HK.00823": dict(code="HK.00823", name="LINK REIT", last_price=40.0, prev_close_price=39.0, turnover=3e8, total_market_val=8e10, high_price=40.5, low_price=39.0),
            "HK.09988": dict(code="HK.09988", name="BABA-W", last_price=130.0, prev_close_price=100.0, turnover=3e9, total_market_val=2.2e12, high_price=131.0, low_price=100.0),
            "HK.01211": dict(code="HK.01211", name="BYD COMPANY", last_price=80.0, prev_close_price=100.0, turnover=2e9, total_market_val=1.0e12, high_price=100.0, low_price=79.0),
            "HK.02020": dict(code="HK.02020", name="MID MOVER", last_price=50.5, prev_close_price=50.0, turnover=5e8, total_market_val=3e10, high_price=51.0, low_price=50.0),
            "HK.00999": dict(code="HK.00999", name="THIN", last_price=11.0, prev_close_price=10.0, turnover=1e6, total_market_val=5e9, high_price=11.0, low_price=10.0),
            "HK.00998": dict(code="HK.00998", name="NAN ROW", last_price=11.0, prev_close_price=10.0, turnover=nan, total_market_val=nan, high_price=nan, low_price=nan),
            "HK.80700": dict(code="HK.80700", name="TENCENT-R", last_price=500.0, prev_close_price=400.0, turnover=1e9, total_market_val=4e12, high_price=500.0, low_price=400.0),
            "HK.07200": dict(code="HK.07200", name="FL2 HSI", last_price=9.0, prev_close_price=5.0, turnover=9e8, total_market_val=5e9, high_price=9.0, low_price=5.0),
            "HK.800000": dict(code="HK.800000", name="HSI", last_price=23200.0, prev_close_price=23000.0, turnover=2.5e11, total_market_val=nan, high_price=23300.0, low_price=22900.0),
            "HK.800700": dict(code="HK.800700", name="HSTECH", last_price=5100.0, prev_close_price=5000.0, turnover=8e10, total_market_val=nan, high_price=5150.0, low_price=4990.0),
        }
        plates = {"HK.00700": "Interactive media and services", "HK.00005": "Banks", "HK.09988": "Online Retailers",
                  "HK.01211": "Automobiles", "HK.02020": "Textiles and Apparel"}
        calls = {"top": [], "heat": [], "snap": [], "owner": [], "kline": []}

        class Ctx:
            def __init__(self, host, port):
                self.closed = False

            def get_plate_stock(self, plate):
                return 0, [{"code": "HK.00700"}, {"code": "HK.00005"}, {"code": "HK.00823"}]

            def get_market_snapshot(self, codes):
                calls["snap"].append(list(codes))
                return 0, [snap[c] for c in codes if c in snap]

            def get_heat_map_data(self, market, count=0):
                calls["heat"].append(count)
                rows = [{"plate_name": "Interactive media and services", "change_rate": 4.0, "turnover": 2e9, "total_market_val": 4.8e12},
                        {"plate_name": "Banks", "change_rate": -5.0, "turnover": 1e9, "total_market_val": 1.7e12},
                        {"plate_name": "Online Retailers", "change_rate": 30.0, "turnover": 3e9, "total_market_val": 2.2e12},
                        {"plate_name": "Automobiles", "change_rate": -20.0, "turnover": 2e9, "total_market_val": 1.0e12}]
                return 0, rows, None, len(rows)

            def get_stock_basicinfo(self, market, sec_type):
                return 0, [{"code": c} for c in listed]

            def get_top_movers_rank(self, market, sort_dir=None, count=10, offset=None, filter_list=None):
                calls["top"].append(sort_dir)
                rows = [{"security": "HK.09988"}, {"security": "HK.80700"}, {"security": "HK.07200"}] if sort_dir == "DESC" else [{"security": "HK.01211"}]
                return 0, (len(rows), rows)

            def get_owner_plate(self, codes):
                calls["owner"].append(list(codes))
                if "HK.00823" in codes:
                    return -1, "Get Stock's Sector interface does not support ETFs type."
                rows = [{"code": c, "plate_name": plates[c], "plate_type": "OTHER"} for c in codes if c in plates]
                rows += [{"code": c, "plate_name": "Hang Seng Index", "plate_type": "OTHER"} for c in codes]
                return 0, rows

            def request_history_kline(self, code, start=None, end=None, ktype=None, autype=None, max_count=None, page_req_key=None):
                calls["kline"].append((code, start, end, ktype, autype))
                if code == "HK.00998":
                    return -1, "quota exhausted", None
                days = [d for d in HISTORY_DAYS if start <= d <= end]
                rows = [{"code": code, "time_key": f"{d} 00:00:00", "close": 100.0 + 0.5 * i} for i, d in enumerate(days)]
                return 0, rows, None

            def get_search_news(self, query):
                return 0, [{"title": "Tencent beats", "url": "https://news.futunn.com/en/1", "source": "futu"}]

            def close(self):
                self.closed = True

        fake = types.ModuleType("futu")
        fake.OpenQuoteContext = Ctx
        fake.Market = types.SimpleNamespace(HK="HK")
        fake.SecurityType = types.SimpleNamespace(STOCK="STOCK")
        fake.RankSortDir = types.SimpleNamespace(DESCENDING="DESC", ASCENDING="ASC")
        fake.KLType = types.SimpleNamespace(K_DAY="K_DAY")
        fake.AuType = types.SimpleNamespace(QFQ="qfq")
        return fake, calls

    NAMES = {"00700": {"name": "騰訊控股", "category": "股本"}, "00005": {"name": "滙豐控股", "category": "股本"},
             "09988": {"name": "阿里巴巴-W", "category": "股本"}, "01211": {"name": "比亞迪股份", "category": "股本"},
             "02020": {"name": "安踏體育", "category": "股本"}, "00999": {"name": "薄成交", "category": "股本"},
             "00998": {"name": "空值行", "category": "股本"}, "00823": {"name": "領展房產基金", "category": "房地產投資信託基金"},
             "07200": {"name": "二南方恒指", "category": "交易所買賣產品"}}

    @staticmethod
    def roster_file():
        member = lambda code, name, w: {"code": code, "name": name, "name_en": name, "weight_pct": w, "faf_pct": 100.0, "group": "x", "page": 4}  # noqa: E731
        version = lambda status, start, members, **extra: {  # noqa: E731
            "id": f"{status}", "status": status, "effective_from": start, "weights_column": "Before", "weights_as_of": "2026-11-18",
            "weights_note": "fixture", "source_pages": "Appendix 1", "count": len(members), "members": members, **extra}
        doc = {"schema": 1, "source": {"publisher": "Hang Seng Indexes Company", "announced": "2026-11-20", "url": "https://example.test/review.pdf",
                                       "weights_reference_date": "2026-11-18"},
               "indices": {
                   "hsi": {"name": "恒生指數", "versions": [version("current", None, [member("00700", "騰訊控股", 60.0), member("00005", "滙豐控股", 30.0), member("00823", "領展房產基金", 10.0)])]},
                   "hstech": {"name": "恒生科技指數", "versions": [
                       version("current", None, [member("00700", "騰訊控股", 50.0), member("09988", "阿里巴巴-W", 30.0), member("01810", "小米集團-W", 20.0)]),
                       version("announced", "2999-01-01", [member("00700", "騰訊控股", 40.0), member("09988", "阿里巴巴-W", 30.0), member("01810", "小米集團-W", 20.0), member("00999", "薄成交", 10.0)],
                               added=["00999"], removed=[])]}}}
        handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
        json.dump(doc, handle, ensure_ascii=False)
        handle.close()
        return handle.name

    def run_collect(self, listed=LISTED, extra=()):
        fake, calls = self.make_sdk(listed)
        roster_path = self.roster_file()
        self.addCleanup(os.unlink, roster_path)
        fetched = []

        def fake_news(code, name, **kw):
            fetched.append((code, name))
            stamp = datetime.now(HKT).strftime("%Y-%m-%d %H:%M")
            return {"title": f"{name}最新消息", "source": "香港經濟日報", "published_at_hkt": stamp, "url": "https://example.com/n"}

        args = sync.parse_args(["--out", "x.json", "--news-delay", "0", "--names-cache", "/nonexistent/names.json",
                                "--rosters", roster_path, "--history-batch", "0", *extra])
        with mock.patch.dict(sys.modules, {"futu": fake}), \
                mock.patch.object(names_mod, "load_names", return_value=self.NAMES), \
                mock.patch.object(news_mod, "fetch_news", side_effect=fake_news):
            doc = sync.collect_live(args, now=datetime(2026, 11, 23, 15, 0, tzinfo=HKT))
        return doc, calls, fetched

    def test_collect_live_end_to_end(self):
        doc, calls, fetched = self.run_collect()

        self.assertEqual(calls["heat"], [200])
        self.assertEqual(calls["top"], [], "the share list replaces the rank endpoint")
        snapped = {c for chunk in calls["snap"] for c in chunk}
        self.assertNotIn("HK.80700", snapped, "RMB counter never reaches the snapshot call")
        self.assertNotIn("HK.07200", snapped, "ETF never reaches the snapshot call")
        self.assertIn("HK.02020", snapped, "a mid-change share outside any rank list is still read")
        self.assertIn("HK.00823", snapped, "HSI constituents are always read")

        owner_asked = {c for chunk in calls["owner"] for c in chunk}
        self.assertEqual(owner_asked, {"HK.00700", "HK.00005", "HK.09988", "HK.01211", "HK.02020"},
                         "owner plate only for HSI or qualifying shares in the share list; never the REIT, thin or NaN rows")

        hsi = {r["code"]: r for r in doc["hsi"]["constituents"]}
        self.assertEqual(set(hsi), {"00700", "00005", "00823"})
        self.assertEqual(hsi["00700"]["name"], "騰訊控股")
        self.assertEqual(hsi["00700"]["industry"], "互動媒體及服務")
        self.assertEqual(hsi["00700"]["sector"], "tech")
        self.assertEqual(hsi["00823"]["industry"], "房地產投資信託基金")
        self.assertEqual(hsi["00823"]["sector"], "property")
        self.assertEqual(doc["hsi"]["index"]["last"], 23200.0)
        self.assertEqual(doc["hk_market"]["universe_count"], len(self.LISTED))

        hk_codes = [r["code"] for r in doc["hk_market"]["stocks"]]
        self.assertEqual(sorted(hk_codes), ["00005", "00700", "00823", "01211", "02020", "09988"],
                         "thin (00999) and NaN (00998) rows fail the liquidity filter")
        self.assertEqual([r["code"] for r in doc["movers"]["hk"]["gainers"]][:2], ["09988", "00700"])
        self.assertEqual(doc["movers"]["hk"]["losers"][0]["code"], "01211")
        self.assertNotIn("00999", [r["code"] for r in doc["movers"]["hk"]["gainers"]], "below the liquidity filter")
        self.assertNotIn("00998", [r["code"] for r in doc["movers"]["hk"]["gainers"]], "NaN turnover is filtered, not a crash")
        self.assertIn("02020", [r["code"] for r in doc["movers"]["hk"]["gainers"]])
        sectors = {s["id"]: s for s in doc["macro_sectors"]}
        self.assertEqual(sectors["finance"]["industries"][0]["name"], "銀行")
        self.assertEqual(sectors["consumer"]["industries"][0]["name"], "線上零售")
        self.assertEqual(doc["news"]["09988"]["title"], "阿里巴巴-W最新消息")
        self.assertIn(("09988", "阿里巴巴-W"), fetched, "news is searched by the Chinese name")
        text = json.dumps(doc, ensure_ascii=False)
        self.assertNotRegex(text, r"(?i)\bfutu|富途|moomoo|yahoo|TENCENT|HSBC|Banks")
        self.assertNotIn("NaN", text)
        json.loads(text)

    def test_snapshot_calls_are_chunked_over_the_whole_share_list(self):
        many = [f"HK.{i:05d}" for i in range(1, 1201)]
        fake, calls = self.make_sdk(many)
        roster_path = self.roster_file()
        self.addCleanup(os.unlink, roster_path)
        args = sync.parse_args(["--out", "x.json", "--news-delay", "0", "--rosters", roster_path, "--history-batch", "0"])
        with mock.patch.dict(sys.modules, {"futu": fake}), \
                mock.patch.object(names_mod, "load_names", return_value={}), \
                mock.patch.object(news_mod, "fetch_news", return_value=None):
            sync.collect_live(args, now=datetime(2026, 11, 23, 15, 0, tzinfo=HKT))
        sizes = [len(c) for c in calls["snap"]]
        self.assertEqual(sizes[0], 2, "both index quotes in one call")
        self.assertEqual(sum(sizes[1:]), 1202, "every share once; roster codes already in the list are not repeated (09988 and 01810 are outside it)")
        self.assertTrue(all(n <= sync.SNAPSHOT_CHUNK for n in sizes))

    def test_empty_share_list_falls_back_to_the_top_movers_rank(self):
        doc, calls, _ = self.run_collect(listed=())
        self.assertEqual(calls["top"], ["DESC", "ASC"])
        snapped = {c for chunk in calls["snap"] for c in chunk}
        self.assertNotIn("HK.80700", snapped)
        self.assertNotIn("HK.07200", snapped)
        self.assertNotIn("HK.02020", snapped, "only rank candidates and HSI codes are read in the fallback")
        self.assertEqual(sorted(r["code"] for r in doc["hk_market"]["stocks"]), ["00005", "00700", "00823", "01211", "09988"])

    def test_hstech_block_members_roster_and_movers(self):
        doc, _, _ = self.run_collect()
        self.assertEqual(doc["schema_version"], 1)
        tech = doc["hstech"]
        self.assertEqual(tech["index"]["name"], "恒生科技指數")
        self.assertEqual(tech["index"]["last"], 5100.0)
        self.assertEqual(tech["index"]["change_pct"], 2.0)
        self.assertEqual({r["code"] for r in tech["constituents"]}, {"00700", "09988"}, "priced current members only")
        self.assertNotIn("00999", {r["code"] for r in tech["constituents"]}, "the announced future member is not in the current universe")
        self.assertEqual(tech["breadth"], {"up": 2, "down": 0, "flat": 0})
        self.assertEqual([r["code"] for r in doc["movers"]["hstech"]["gainers"]], ["09988", "00700"])
        self.assertEqual(doc["movers"]["hstech"]["losers"], [], "no decliner pads the list")

        members = tech["members"]
        self.assertEqual([m["code"] for m in members], ["00700", "09988", "01810"], "every official member, in official order")
        self.assertEqual([m["weight_pct"] for m in members], [50.0, 30.0, 20.0], "current weights, not the announced ones")
        missing = members[2]
        self.assertFalse(missing["available"])
        self.assertTrue(all(missing[k] is None for k in ("last", "change_pct", "ret_5d", "ret_1m", "ret_ytd", "market_cap_hkd")))
        self.assertEqual(missing["name"], "小米集團-W")
        self.assertTrue(members[0]["available"])

        meta = tech["roster"]
        self.assertEqual((meta["status"], meta["count"], meta["weights_as_of"]), ("current", 3, "2026-11-18"))
        self.assertEqual(meta["upcoming"], {"effective_from": "2999-01-01", "count": 4, "added": ["00999"], "removed": [], "announced": "2026-11-20"})
        self.assertNotIn("members", json.dumps(meta))

        hsi = doc["hsi"]
        self.assertEqual([m["code"] for m in hsi["members"]], ["00700", "00005", "00823"])
        self.assertIsNone(hsi["roster"]["upcoming"])
        self.assertTrue(all(m["available"] for m in hsi["members"]))

    @unittest.skipUnless(importlib.util.find_spec("jsonschema"), "jsonschema is not installed")
    def test_collector_output_and_sample_validate_against_schema_json(self):
        import jsonschema
        schema = json.loads((ROOT / "scripts" / "hk-movers" / "schema.json").read_text(encoding="utf-8"))
        validator = jsonschema.Draft202012Validator(schema)
        relaxed = json.loads(json.dumps(schema))
        relaxed["properties"]["macro_sectors"]["minItems"] = 0  # the fake gateway only knows four sectors
        relaxed_validator = jsonschema.Draft202012Validator(relaxed)
        with tempfile.TemporaryDirectory() as tmp:
            doc, _, _ = self.run_collect(extra=("--history-batch", "50", "--history-cache", str(Path(tmp) / "h.json"), "--history-delay", "0"))
        relaxed_validator.validate(json.loads(json.dumps(doc)))
        validator.validate(json.loads((ROOT / "movers" / "data" / "sample.json").read_text(encoding="utf-8")))

    def test_members_include_every_roster_code_even_when_the_filters_would_drop_them(self):
        doc, _, _ = self.run_collect()
        qualified = {r["code"] for r in doc["hk_market"]["stocks"]}
        thin = [m for m in doc["hsi"]["members"] if m["code"] == "00823"][0]
        self.assertTrue(thin["available"])
        self.assertIn("00823", qualified)
        self.assertEqual(len(doc["hsi"]["members"]), 3)

    def test_returns_come_from_cached_history_and_are_not_refetched_the_same_day(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = str(Path(tmp) / "history.json")
            doc, calls, _ = self.run_collect(extra=("--history-batch", "50", "--history-cache", cache, "--history-delay", "0"))
            fetched = {c[0] for c in calls["kline"]}
            self.assertIn("HK.800000", fetched, "the index calendar is fetched too")
            self.assertTrue({"HK.00700", "HK.00005", "HK.09988"} <= fetched)
            self.assertTrue(all(c[3:] == ("K_DAY", "qfq") for c in calls["kline"]), "daily adjusted bars")
            self.assertTrue(all(c[1] == "2025-12-01" and c[2] == "2026-11-23" for c in calls["kline"]))
            ref = doc["returns"]
            self.assertEqual((ref["as_of"], ref["d5"], ref["m1"], ref["ytd"], ref["basis"]), ("2026-11-23", "2026-11-16", "2026-10-23", "2025-12-31", "adjusted_close"))
            tencent = [m for m in doc["hsi"]["members"] if m["code"] == "00700"][0]
            closes = {d: 100.0 + 0.5 * i for i, d in enumerate(HISTORY_DAYS)}
            self.assertAlmostEqual(tencent["ret_5d"], (520.0 / closes["2026-11-16"] - 1) * 100, places=3)
            self.assertAlmostEqual(tencent["ret_1m"], (520.0 / closes["2026-10-23"] - 1) * 100, places=3)
            self.assertAlmostEqual(tencent["ret_ytd"], (520.0 / closes["2025-12-31"] - 1) * 100, places=3)
            self.assertIsNone([m for m in doc["hstech"]["members"] if m["code"] == "01810"][0]["ret_5d"])
            first = len(calls["kline"])

            doc2, calls2, _ = self.run_collect(extra=("--history-batch", "50", "--history-cache", cache, "--history-delay", "0"))
            self.assertEqual(len(calls2["kline"]), 0, "same HK day: served from the cache")
            self.assertEqual(doc2["returns"], ref)
            self.assertGreater(first, 3)

    def test_history_batch_zero_disables_returns_but_prices_still_show(self):
        doc, calls, _ = self.run_collect()
        self.assertEqual(calls["kline"], [])
        self.assertNotIn("returns", doc)
        self.assertTrue(all(m["ret_5d"] is None for m in doc["hsi"]["members"]))
        self.assertTrue(all(m["available"] for m in doc["hsi"]["members"]), "prices still show without returns")

    def test_backup_news_never_returns_a_vendor_headline(self):
        fake, _ = self.make_sdk()
        ctx = fake.OpenQuoteContext("127.0.0.1", 11111)
        self.assertIsNone(sync.fetch_news_backup(ctx, "HK.00700", "騰訊控股"))


if __name__ == "__main__":
    unittest.main()
