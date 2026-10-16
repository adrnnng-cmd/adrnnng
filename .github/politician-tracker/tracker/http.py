from __future__ import annotations

import http.cookiejar
import json
import logging
import time
import urllib.error
import urllib.parse
import urllib.request

log = logging.getLogger(__name__)

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0 Safari/537.36 adrnnng-politician-tracker/1.0"
)


class Client:
    """Tiny urllib wrapper with cookies, retries and a polite delay between requests."""

    def __init__(self, timeout: float = 30, retries: int = 3, delay: float = 0.4):
        self.timeout = timeout
        self.retries = retries
        self.delay = delay
        self.cookies = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cookies))
        self._last = 0.0

    def request(self, url: str, data: dict | None = None, headers: dict | None = None) -> bytes:
        body = urllib.parse.urlencode(data).encode() if data is not None else None
        hdrs = {"User-Agent": USER_AGENT, "Accept": "*/*", **(headers or {})}
        err: Exception | None = None
        for attempt in range(self.retries):
            wait = self.delay - (time.monotonic() - self._last)
            if wait > 0:
                time.sleep(wait)
            try:
                req = urllib.request.Request(url, data=body, headers=hdrs)
                with self.opener.open(req, timeout=self.timeout) as resp:
                    self._last = time.monotonic()
                    return resp.read()
            except urllib.error.HTTPError as e:
                self._last = time.monotonic()
                err = e
                if e.code in (400, 401, 403, 404):
                    break
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                self._last = time.monotonic()
                err = e
            time.sleep(2 ** attempt)
            log.debug("retry %s %s after %s", attempt + 1, url, err)
        raise RuntimeError(f"GET {url} failed: {err}")

    def text(self, url: str, **kw) -> str:
        return self.request(url, **kw).decode("utf-8", "replace")

    def json(self, url: str, **kw):
        return json.loads(self.request(url, **kw))

    def cookie(self, name: str) -> str | None:
        for c in self.cookies:
            if c.name == name:
                return c.value
        return None
