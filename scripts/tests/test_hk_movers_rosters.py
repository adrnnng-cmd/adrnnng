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


# Written out from the PDF's "After" column (Appendix 3, pages 8-9) by a separate parse of the PDF itself, so the
# committed roster file is checked against an independent copy and not only against its own parser.
HSTECH_AFTER = {
    "00700": 8.0, "01810": 8.0, "03690": 8.0, "09988": 8.0, "09999": 8.0, "00981": 7.12, "01211": 6.67, "09888": 4.38,
    "09618": 4.28, "00992": 3.74, "09961": 3.35, "01024": 2.2, "03750": 2.17, "09868": 1.82, "00300": 1.79, "01347": 1.75,
    "02015": 1.59, "06690": 1.5, "02382": 1.21, "09660": 1.17, "06618": 1.1, "00020": 1.07, "02513": 0.96, "06869": 0.94,
    "01888": 0.91, "09626": 0.89, "00522": 0.87, "00148": 0.86, "02018": 0.71, "09880": 0.67, "00100": 0.66, "09863": 0.57,
    "03308": 0.54, "00241": 0.5, "06082": 0.43, "00285": 0.42, "09866": 0.4, "02525": 0.38, "02577": 0.34, "09903": 0.32,
    "06809": 0.3, "03896": 0.27, "02475": 0.26, "01729": 0.25, "02476": 0.21, "09698": 0.15, "01698": 0.1, "03317": 0.06,
    "09678": 0.05, "02706": 0.03,
}


class FutureHstechRoster(unittest.TestCase):
    """The announced 50-member HSTECH roster is stored in full, with its official weights, ready for 2026-12-07."""

    def future(self):
        return next(v for v in DOC["indices"]["hstech"]["versions"] if v["status"] == "announced")

    def test_all_50_constituents_and_weights_match_the_independent_copy(self):
        members = self.future()["members"]
        self.assertEqual(len(members), 50)
        self.assertEqual(len(HSTECH_AFTER), 50)
        self.assertEqual({m["code"]: m["weight_pct"] for m in members}, HSTECH_AFTER)

    def test_future_roster_carries_names_groups_pages_and_group_totals(self):
        members = self.future()["members"]
        groups = {}
        for m in members:
            self.assertTrue(m["name"] and m["name_en"], m["code"])
            self.assertIn(m["page"], (8, 9))
            groups.setdefault(m["group"], []).append(m["weight_pct"])
        self.assertEqual({g: len(w) for g, w in groups.items()},
                         {"Information Technology": 29, "Consumer Discretionary": 15, "Industrials": 4, "Healthcare": 2})
        # The PDF prints group totals of 48.69 / 45.56 / 4.15 / 1.60 (rounded separately), so allow rounding slack.
        for group, printed in {"Information Technology": 48.69, "Consumer Discretionary": 45.56, "Industrials": 4.15, "Healthcare": 1.60}.items():
            self.assertAlmostEqual(sum(groups[group]), printed, delta=0.06, msg=group)
        self.assertEqual(sorted(m["code"] for m in members if m["weight_pct"] == 8.0), ["00700", "01810", "03690", "09988", "09999"])

    def test_the_20_additions_are_exactly_the_pdf_change_list_with_weights(self):
        v = self.future()
        current = {m["code"] for m in next(x for x in DOC["indices"]["hstech"]["versions"] if x["status"] == "current")["members"]}
        added = sorted(m["code"] for m in v["members"] if m["code"] not in current)
        self.assertEqual(added, v["added"])
        self.assertEqual(added, ["00148", "00522", "01729", "01888", "02018", "02475", "02476", "02525", "02577", "02706",
                                 "03308", "03317", "03750", "03896", "06082", "06809", "06869", "09678", "09698", "09880"])
        self.assertTrue(all(HSTECH_AFTER[c] > 0 for c in added))
        self.assertEqual(v["effective_from"], "2026-12-07")
        self.assertEqual(v["implemented_after_close"], "2026-12-04")

    def test_roster_meta_never_publishes_the_future_members_or_weights(self):
        index = DOC["indices"]["hstech"]
        for day in (date(2026, 11, 23), date(2026, 12, 4), date(2026, 12, 6)):
            version, upcoming = rosters.select_version(index, day)
            meta = rosters.roster_meta(version, upcoming, DOC["source"])
            text = json.dumps(meta, ensure_ascii=False)
            self.assertEqual((meta["status"], meta["count"], meta["weights_stage"]), ("current", 30, "pre_review"))
            self.assertEqual(meta["upcoming"], {"effective_from": "2026-12-07", "count": 50, "added_count": 20, "removed_count": 0, "announced": "2026-11-20"})
            for code in self.future()["added"]:
                self.assertNotIn(code, text, day)
            self.assertNotIn("members", text)

    def test_meta_after_the_effective_date_describes_the_new_roster_as_in_force(self):
        version, upcoming = rosters.select_version(DOC["indices"]["hstech"], date(2026, 12, 7))
        meta = rosters.roster_meta(version, upcoming, DOC["source"])
        self.assertEqual((meta["status"], meta["count"], meta["effective_from"], meta["weights_stage"]), ("current", 50, "2026-12-07", "post_review_pro_forma"))
        self.assertIsNone(meta["upcoming"])


class DateAwareSelection(unittest.TestCase):
    def test_current_roster_until_the_effective_date(self):
        hstech = DOC["indices"]["hstech"]
        for day in (date(2026, 11, 20), date(2026, 11, 23), date(2026, 12, 4), date(2026, 12, 6)):
            active, upcoming = rosters.select_version(hstech, day)
            self.assertEqual((active["status"], active["count"]), ("current", 30), day)
            self.assertEqual(upcoming["effective_from"], "2026-12-07")

    def test_announced_roster_from_the_effective_date(self):
        hstech = DOC["indices"]["hstech"]
        for day in (date(2026, 12, 7), date(2026, 12, 8), date(2027, 1, 4)):
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
