"""Offline tests for member portrait caching. No network."""
import logging
import tempfile
import unittest

logging.disable(logging.CRITICAL)
from pathlib import Path

from tracker.pipeline import (
    assign_vip_photos,
    fetch_photos,
    is_jpeg,
    member_bioguides,
    photo_urls,
)
from tracker.render import _portrait

JPEG = b"\xff\xd8\xff" + b"portrait" * 40


class FakeClient:
    def __init__(self, responses):
        self.responses = dict(responses)
        self.calls = []

    def request(self, url, data=None, headers=None):
        self.calls.append(url)
        result = self.responses.get(url, RuntimeError(f"unexpected {url}"))
        if isinstance(result, Exception):
            raise result
        return result


class PortraitHtmlTest(unittest.TestCase):
    def test_tracker_photo_uses_local_file_and_placeholder(self):
        html = _portrait(
            "/politician-tracker/img/R000619.jpg",
            "Michael A. Rulli",
            "/politician-tracker/img/placeholder.svg",
        )
        self.assertIn('src="/politician-tracker/img/R000619.jpg"', html)
        self.assertIn("onerror=\"this.onerror=null;this.src='/politician-tracker/img/placeholder.svg'\"", html)
        self.assertNotIn("<img", html.replace("<img", "", 1))


class PhotoUrlTest(unittest.TestCase):
    def test_unitedstates_then_bioguide(self):
        urls = photo_urls("R000619")
        self.assertEqual(urls[0], "https://theunitedstates.io/images/congress/225x275/R000619.jpg")
        self.assertTrue(all("bioguide.congress.gov" in url for url in urls[1:]))
        self.assertIn("https://bioguide.congress.gov/photo/R000619.jpg", urls)
        self.assertIn("https://bioguide.congress.gov/bioguide/photo/R/R000619.jpg", urls)

    def test_jpeg_magic(self):
        self.assertTrue(is_jpeg(JPEG))
        self.assertFalse(is_jpeg(b"\xff\xd8\xff"))
        self.assertFalse(is_jpeg(b"<html>not a photo</html>"))


class FetchPhotosTest(unittest.TestCase):
    def test_skips_portraits_already_on_disk(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            path = out / "img" / "P000197.jpg"
            path.parent.mkdir()
            path.write_bytes(JPEG)
            client = FakeClient({})
            fetch_photos(client, ["P000197", "P000197"], out)
            self.assertEqual(client.calls, [])
            self.assertEqual(path.read_bytes(), JPEG)

    def test_saves_unitedstates_photo_and_does_not_call_bioguide(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            primary = photo_urls("R000619")[0]
            client = FakeClient({primary: JPEG})
            fetch_photos(client, ["R000619"], out)
            self.assertEqual(client.calls, [primary])
            self.assertEqual((out / "img" / "R000619.jpg").read_bytes(), JPEG)

    def test_falls_back_to_bioguide_when_unitedstates_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            urls = photo_urls("S000168")
            client = FakeClient({
                urls[0]: RuntimeError("timeout"),
                urls[1]: b"<html>forbidden</html>",
                urls[2]: JPEG,
            })
            fetch_photos(client, ["S000168"], out)
            self.assertEqual(client.calls, urls)
            self.assertTrue((out / "img" / "S000168.jpg").is_file())

    def test_missing_from_every_source_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            urls = photo_urls("A000383")
            client = FakeClient({url: RuntimeError("nope") for url in urls})
            fetch_photos(client, ["A000383", "not-a-bioguide", ""], out)
            self.assertEqual(client.calls, urls)
            self.assertFalse((out / "img" / "A000383.jpg").exists())

    def test_bioguides_come_from_trades_not_only_vips(self):
        payload = {
            "vip": [{"bioguide": "P000197", "name": "Nancy Pelosi"}],
            "trades": [
                {"bioguide": "R000619", "name": "Michael A. Rulli", "vip": False},
                {"bioguide": "P000197", "name": "Nancy Pelosi", "vip": True},
                {"name": "No id"},
            ],
        }
        self.assertEqual(member_bioguides(payload), ["P000197", "R000619"])

    def test_vip_photo_url_only_when_the_file_exists(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            (out / "img").mkdir()
            (out / "img" / "P000197.jpg").write_bytes(JPEG)
            vips = [{"bioguide": "P000197", "name": "Nancy Pelosi"}, {"bioguide": "R000619", "name": "Michael A. Rulli"}]
            assign_vip_photos(vips, out, "/politician-tracker")
            self.assertEqual(vips[0]["photo"], "/politician-tracker/img/P000197.jpg")
            self.assertNotIn("photo", vips[1])
