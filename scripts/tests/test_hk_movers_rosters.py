import json
import re
import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import hk_movers_rosters as rosters  # noqa: E402

DOC = rosters.load_rosters()
HAS_CJK = re.compile(r"[\u4e00-\u9fff]")

SAMPLE_TEXT = """=====PAGE 4=====
Appendix 1
Hang Seng Index
Constituent List (Assuming the rebalancing had been taken place on 18 November 2026)
Weighting (%) *
Stock Code Company FAF (%)^
Before After **
Financials (2 constituents) 60.00 60.00
5 HSBC HOLDINGS 100 30.00 30.00
981 SMIC 85# 30.00 30.00
Total (2 constituents) 100.00 100.00
"""


class ParsingRows(unittest.TestCase):
    def test_parses_codes_flags_dashes_and_names_with_digits(self):
        rows = rosters.parse_rows([
            "5 HSBC HOLDINGS 100 7.37 8.00",
            "981 SMIC 85# 1.42 1.55",
            "6869 YOFC (H) 100 - 0.94",
            "9888 BIDU - W 80 # 0.70 0.95",
            "1 CKH HOLDINGS 70 1.18 1.13",
            "Financials (10 constituents) 34.60 34.15",
            "Total (95 constituents) 100.00 100.00",
        ])
        by = {r["code"]: r for r in rows}
        self.assertEqual(sorted(by), ["00001", "00005", "00981", "06869", "09888"])
        self.assertEqual(by["00005"]["name_en"], "HSBC HOLDINGS")
        self.assertEqual((by["00005"]["faf_pct"], by["00005"]["before"], by["00005"]["after"]), (100.0, 7.37, 8.0))
        self.assertEqual(by["06869"]["before"], None)
        self.assertEqual(by["06869"]["after"], 0.94)
        self.assertEqual(by["09888"]["name_en"], "BIDU - W")

    def test_appendix_checks_count_and_weight_totals(self):
        with self.assertRaises(rosters.RosterError):
            rosters.parse_appendix(SAMPLE_TEXT, "hsi")  # 2 rows, not 95
        with self.assertRaises(rosters.RosterError):
            rosters.parse_appendix("=====PAGE 4=====\nnothing", "hsi")


class CommittedRosters(unittest.TestCase):
    def versions(self, index_id):
        return {v["status"]: v for v in DOC["indices"][index_id]["versions"]}

    def test_source_is_the_official_announcement(self):
        src = DOC["source"]
        self.assertEqual(src["publisher"], "Hang Seng Indexes Company")
        self.assertEqual(src["announced"], "2026-11-20")
        self.assertTrue(src["url"].endswith("20261120T174500.pdf"))
        self.assertEqual(src["weights_reference_date"], "2026-11-18")

    def test_hsi_counts_dates_and_weights(self):
        v = self.versions("hsi")
        self.assertEqual((v["current"]["count"], v["announced"]["count"]), (95, 95))
        self.assertIsNone(v["current"]["effective_from"])
        self.assertEqual(v["announced"]["effective_from"], "2026-12-07")
        self.assertEqual(v["announced"]["implemented_after_close"], "2026-12-04")
        self.assertEqual(v["announced"]["added"], [])
        self.assertEqual(v["announced"]["removed"], [])
        self.assertEqual({m["code"] for m in v["current"]["members"]}, {m["code"] for m in v["announced"]["members"]})
        for status in ("current", "announced"):
            self.assertAlmostEqual(sum(m["weight_pct"] for m in v[status]["members"]), 100, delta=0.6)
        top = {m["code"]: m["weight_pct"] for m in v["current"]["members"]}
        self.assertEqual((top["00005"], top["00700"], top["09988"], top["00939"]), (7.37, 7.35, 6.72, 6.46))
        capped = {m["code"]: m["weight_pct"] for m in v["announced"]["members"]}
        self.assertEqual((capped["00005"], capped["00700"], capped["09988"]), (8.0, 8.0, 8.0))
        self.assertEqual(max(capped.values()), 8.0)

    def test_hstech_current_is_30_and_the_future_roster_is_50(self):
        v = self.versions("hstech")
        self.assertEqual((v["current"]["count"], v["announced"]["count"]), (30, 50))
        cur = {m["code"] for m in v["current"]["members"]}
        fut = {m["code"] for m in v["announced"]["members"]}
        self.assertEqual(len(cur), 30)
        self.assertEqual(len(fut), 50)
        self.assertTrue(cur <= fut)
        self.assertEqual(sorted(fut - cur), v["announced"]["added"])
        self.assertEqual(len(v["announced"]["added"]), 20)
        self.assertEqual(v["announced"]["removed"], [])
        for code in ("00148", "00522", "02475", "03750", "09880"):
            self.assertNotIn(code, cur, "announced inclusions must not be in the current roster")
            self.assertIn(code, fut)
        for status in ("current", "announced"):
            self.assertAlmostEqual(sum(m["weight_pct"] for m in v[status]["members"]), 100, delta=0.6)

    def test_every_member_has_a_name_code_weight_and_page(self):
        for index_id, index in DOC["indices"].items():
            for v in index["versions"]:
                codes = [m["code"] for m in v["members"]]
                self.assertEqual(len(codes), len(set(codes)), index_id)
                for m in v["members"]:
                    self.assertRegex(m["code"], r"^\d{5}$")
                    self.assertTrue(m["name"] and m["name_en"])
                    self.assertGreater(m["weight_pct"], 0)
                    self.assertIn(m["page"], (4, 5, 8, 9))
                self.assertEqual(codes, [m["code"] for m in sorted(v["members"], key=lambda m: (-m["weight_pct"], m["code"]))])

    def test_names_are_traditional_chinese_except_brand_names(self):
        roman = {m["code"] for ix in DOC["indices"].values() for v in ix["versions"] for m in v["members"]
                 if not HAS_CJK.search(m["name"])}
        self.assertLessEqual(roman, {"00100", "00522"}, "only MINIMAX-W and ASMPT are listed under Latin names")
        self.assertFalse(re.search(r"[价涨额汇资业医药网专这们两东车银证债险类盘场营续]", json.dumps(DOC, ensure_ascii=False)))

    def test_no_vendor_name_in_the_roster(self):
        self.assertIsNone(re.search(r"futu|富途|moomoo|yahoo|雅虎", json.dumps(DOC, ensure_ascii=False), re.I))


class DateAwareSelection(unittest.TestCase):
    def test_current_roster_until_the_effective_date(self):
        hstech = DOC["indices"]["hstech"]
        for day in (date(2026, 11, 20), date(2026, 11, 23), date(2026, 12, 4), date(2026, 12, 6)):
            active, upcoming = rosters.select_version(hstech, day)
            self.assertEqual((active["status"], active["count"]), ("current", 30), day)
            self.assertEqual(upcoming["effective_from"], "2026-12-07")

    def test_announced_roster_from_the_effective_date(self):
        hstech = DOC["indices"]["hstech"]
        for day in (date(2026, 12, 7), date(2027, 1, 4)):
            active, upcoming = rosters.select_version(hstech, day)
            self.assertEqual((active["status"], active["count"]), ("announced", 50), day)
            self.assertIsNone(upcoming)

    def test_hsi_weights_switch_on_the_same_day_and_the_roster_stays_95(self):
        hsi = DOC["indices"]["hsi"]
        before, _ = rosters.select_version(hsi, date(2026, 12, 4))
        after, _ = rosters.select_version(hsi, date(2026, 12, 7))
        self.assertEqual((before["count"], after["count"]), (95, 95))
        self.assertEqual(before["members"][0]["weight_pct"], 7.37)
        self.assertEqual(after["members"][0]["weight_pct"], 8.0)

    def test_public_meta_never_carries_the_future_member_list(self):
        hstech = DOC["indices"]["hstech"]
        active, upcoming = rosters.select_version(hstech, date(2026, 11, 23))
        meta = rosters.roster_meta(active, upcoming, DOC["source"])
        text = json.dumps(meta, ensure_ascii=False)
        self.assertEqual(meta["count"], 30)
        self.assertEqual(meta["status"], "current")
        self.assertEqual(meta["weights_as_of"], "2026-11-18")
        self.assertEqual(meta["upcoming"]["count"], 50)
        self.assertEqual(meta["upcoming"]["effective_from"], "2026-12-07")
        self.assertNotIn("members", text)
        self.assertEqual(meta["source"]["pages"], "Appendix 3, pp.8-9")

    def test_drift_reports_differences_without_changing_the_roster(self):
        out = rosters.drift(["00700", "00005"], ["HK.00700", "HK.00001"])
        self.assertEqual(out, {"missing_from_gateway": ["00005"], "extra_in_gateway": ["00001"]})


if __name__ == "__main__":
    unittest.main()
