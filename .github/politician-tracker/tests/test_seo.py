"""The tracker page is indexable unless site.noindex is turned back on."""

import unittest
from datetime import datetime

from tracker.render import render_page


def _page(noindex: bool) -> str:
    cfg = {
        "site": {
            "base_url": "https://news-chart.com",
            "path": "politician-tracker",
            "home_url": "/",
            "archive_url": "/news/",
            "noindex": noindex,
        }
    }
    payload = {"trades": [], "vip": [], "window_start": "2026-06-01"}
    return render_page(cfg, payload, datetime(2026, 10, 22, 7, 5))


class SeoTests(unittest.TestCase):
    def test_default_page_is_indexable_and_has_social_tags(self):
        html = _page(False)
        self.assertNotIn("noindex", html)
        self.assertIn('<link rel="canonical" href="https://news-chart.com/politician-tracker/">', html)
        self.assertIn('<meta property="og:title" content="Politician Tracker', html)
        self.assertIn('<meta property="og:url" content="https://news-chart.com/politician-tracker/">', html)
        self.assertIn('<meta property="og:image" content="https://news-chart.com/assets/brand/og-image.png">', html)
        self.assertIn('"@id":"https://news-chart.com/#organization"', html)
        self.assertIn('"item":"https://news-chart.com/"', html)
        self.assertNotIn("adrnnng.com", html)
        self.assertIn("Adrian&#x27;s Watchlist", html)
        self.assertIn('alt="News Chart"', html)
        self.assertIn("/assets/brand/news-chart-white.svg", html)
        self.assertIn('"author":{"@type":"Organization","name":"ADRRR"}', html)
        self.assertIn('"name":"News Chart"', html)
        self.assertIn('<meta name="twitter:card" content="summary_large_image">', html)
        self.assertIn('name="description"', html)
        self.assertIn('<meta property="og:locale" content="zh_HK">', html)
        self.assertIn('<meta name="twitter:site" content="@adrnnng">', html)
        self.assertIn('"@type":"Organization"', html)
        self.assertIn('"@type":"WebSite"', html)
        self.assertNotIn('SearchAction', html)
        self.assertNotIn('FAQPage', html)

    def test_noindex_flag_still_emits_the_robots_meta(self):
        html = _page(True)
        self.assertIn('<meta name="robots" content="noindex,nofollow,noarchive">', html)
        self.assertIn('<meta name="twitter:card" content="summary_large_image">', html)
