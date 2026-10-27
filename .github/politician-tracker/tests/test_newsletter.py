"""The tracker page keeps the shared Buttondown card across rebuilds."""

import unittest
from datetime import datetime

from tracker.render import render_page

ACTION = "https://buttondown.com/api/emails/embed-subscribe/adrrr"
COPY = [
    "ADRRR · NEWSLETTER",
    "每朝 9 點前，港美股早報直送信箱",
    "ADRRR News Lab — 隔夜美股、港股盤前、經濟數據與異動股，5 分鐘掌握開市前重點。",
    "免費訂閱",
    "免費 · 隨時取消 · 由",
    "Buttondown",
    "寄送",
    "本報僅供參考，不構成投資建議",
]


class NewsletterTests(unittest.TestCase):
    def test_rendered_page_posts_to_buttondown(self):
        cfg = {
            "site": {
                "base_url": "https://adrnnng.com",
                "path": "politician-tracker",
                "home_url": "/",
                "archive_url": "/news/",
            }
        }
        payload = {"trades": [], "vip": [], "window_start": "2026-06-01"}
        html = render_page(cfg, payload, datetime(2026, 10, 22, 7, 5))
        self.assertIn(f'action="{ACTION}"', html)
        self.assertIn('method="post"', html)
        self.assertIn('name="email"', html)
        self.assertIn("required", html)
        self.assertIn('name="embed" value="1"', html)
        form = html.split('<form class="nl-form"', 1)[1].split("</form>", 1)[0]
        self.assertNotIn("target=", form)
        self.assertNotIn("redirect", form.lower())
        self.assertEqual(form.count('type="hidden"'), 1)
        self.assertIn('href="https://buttondown.com/adrrr"', html)
        self.assertIn('href="/assets/css/newsletter.css"', html)
        for line in COPY:
            self.assertIn(line, html)
