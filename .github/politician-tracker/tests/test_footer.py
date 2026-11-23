"""Shared footer links on the tracker page. Page data and logic stay as they are."""

import unittest
from datetime import datetime
from pathlib import Path

from tracker.render import render_page

LINKS = [
    ('/backtest/', 'Backtest'),
    ('/movers/', 'Movers'),
    ('/politician-tracker/', 'Politician Tracker'),
    ('/news/', 'Morning Report'),
    ('/about/', 'About'),
    ('/politician-tracker/data.json', 'data.json'),
]


def _footer(html: str) -> str:
    return html.split('<footer class="foot">', 1)[1].split('</footer>', 1)[0]


class FooterTests(unittest.TestCase):
    def test_rendered_footer_keeps_the_disclaimer_and_adds_the_section_links(self):
        cfg = {
            "site": {
                "base_url": "https://news-chart.com",
                "path": "politician-tracker",
                "home_url": "/",
                "archive_url": "/news/",
            }
        }
        html = render_page(cfg, {"trades": [], "vip": [], "window_start": "2026-06-01"}, datetime(2026, 10, 22, 7, 5))
        footer = _footer(html)
        self.assertIn("非投資建議。 Not investment advice.", footer)
        for href, label in LINKS:
            self.assertIn(f'<a href="{href}">{label}</a>', footer)
        mast = html.split('<div class="mast-r">', 1)[1].split('</div>', 1)[0]
        self.assertNotIn("/about/", mast)
        self.assertIn("Morning Report", mast)

    def test_served_page_footer_matches_the_renderer_and_is_in_the_html(self):
        served = Path(__file__).resolve().parents[3].joinpath("politician-tracker", "index.html").read_text()
        footer = _footer(served)
        for href, label in LINKS:
            self.assertIn(f'<a href="{href}">{label}</a>', footer)
        self.assertIn("非投資建議。 Not investment advice.", footer)
