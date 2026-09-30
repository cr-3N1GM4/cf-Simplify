"""Talks to Codeforces: the public API (problem list, contest phases) and the
problem pages (statements are not available through the API)."""
from __future__ import annotations

import json
import re
import time
from urllib.parse import urlencode, urlparse

import requests

from .extract import ParsedProblem, parse_problems

DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)
CHALLENGE_MARKERS = ("cf-chl", "challenge-platform", "Just a moment...", "cf_chl_opt", "Attention Required! | Cloudflare")

BLOCKED_HELP = """Codeforces answered with a browser check (Cloudflare) instead of the page.
Fix it in one of these ways:
  1. Browser mode (easiest): run
         pip install playwright
         python -m playwright install chromium
     then run the same command again. A browser window opens; if it shows a check, click it once.
  2. Or reuse your own browser's session: open codeforces.com in Chrome, press F12, open the Network tab,
     reload, click the first request, and copy the whole "cookie" request header into CF_COOKIE in .env
     and the "user-agent" header into CF_USER_AGENT. (These expire after a while.)"""


class CodeforcesError(Exception):
    pass


class Blocked(CodeforcesError):
    pass


def solve_rcpc(html: str) -> str | None:
    """Codeforces' older anti-bot page sets an RCPC cookie computed with AES-128-CBC."""
    values = re.findall(r'toNumbers\("([0-9a-fA-F]+)"\)', html)
    if len(values) < 3:
        return None
    try:
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    except ImportError:
        return None
    key, iv, data = (bytes.fromhex(v) for v in values[:3])
    if len(data) % 16:
        return None
    decryptor = Cipher(algorithms.AES(key), modes.CBC(iv)).decryptor()
    return (decryptor.update(data) + decryptor.finalize()).hex()


def is_challenge(text: str) -> bool:
    head = text[:20000]
    return any(marker in head for marker in CHALLENGE_MARKERS)


class BrowserFetcher:
    """Loads pages in a real Chromium window (optional; needs `pip install playwright`)."""

    def __init__(self, profile_dir, headless: bool, log=print):
        from playwright.sync_api import sync_playwright  # noqa: import inside so it stays optional

        profile_dir.mkdir(parents=True, exist_ok=True)
        self._pw = sync_playwright().start()
        self._context = self._pw.chromium.launch_persistent_context(str(profile_dir), headless=headless)
        self._page = self._context.pages[0] if self._context.pages else self._context.new_page()
        self.log = log

    def get(self, url: str, wait_for: str | None, timeout_s: float = 120) -> str:
        self._page.goto(url, wait_until="domcontentloaded", timeout=90_000)
        if wait_for:
            try:
                self._page.wait_for_selector(wait_for, timeout=timeout_s * 1000)
            except Exception:  # noqa: BLE001 - playwright raises its own TimeoutError
                pass
        return self._page.content()

    def get_json(self, url: str) -> dict:
        self._page.goto(url, wait_until="domcontentloaded", timeout=90_000)
        return json.loads(self._page.inner_text("body"))

    def close(self) -> None:
        try:
            self._context.close()
        finally:
            self._pw.stop()


class Codeforces:
    def __init__(self, settings, log=print):
        self.base = settings.cf_base_url.rstrip("/")
        self.host = urlparse(self.base).hostname or "codeforces.com"
        self.delay = settings.cf_delay
        self.mode = settings.cf_fetch_mode
        self.headless = settings.cf_browser_headless
        self.profile_dir = settings.state_dir / "browser-profile"
        self.log = log
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": settings.cf_user_agent or DEFAULT_USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        })
        for part in settings.cf_cookie.split(";"):
            name, _, value = part.strip().partition("=")
            if name and value:
                self.session.cookies.set(name.strip(), value.strip(), domain=self.host, path="/")
        self._browser: BrowserFetcher | None = None
        self._last_page = 0.0
        self._last_api = 0.0
        self._contests: dict[int, dict] | None = None

    # ------------------------------------------------------------------ helpers
    def _wait(self, attr: str, gap: float) -> None:
        wait = getattr(self, attr) + gap - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        setattr(self, attr, time.monotonic())

    def _browser_available(self) -> bool:
        try:
            import playwright  # noqa: F401
        except ImportError:
            return False
        return True

    def _use_browser(self) -> BrowserFetcher:
        if self._browser is None:
            if not self._browser_available():
                raise Blocked(BLOCKED_HELP)
            self.log("  Opening a browser window for Codeforces (browser mode)...")
            self._browser = BrowserFetcher(self.profile_dir, self.headless, self.log)
        return self._browser

    def close(self) -> None:
        if self._browser is not None:
            self._browser.close()
            self._browser = None

    # ------------------------------------------------------------------ API
    def api(self, method: str, **params):
        url = f"{self.base}/api/{method}"
        for attempt in range(5):
            self._wait("_last_api", 2.1)  # Codeforces allows one API call per 2 seconds
            if self.mode == "browser":
                data = self._use_browser().get_json(url + ("?" + urlencode(params) if params else ""))
            else:
                try:
                    resp = self.session.get(url, params=params, timeout=90)
                except requests.RequestException as exc:
                    self.log(f"  Codeforces API network error ({exc}); retrying...")
                    time.sleep(5 * (attempt + 1))
                    continue
                if is_challenge(resp.text):
                    if self.mode == "auto" and self._browser_available():
                        self.mode = "browser"
                        continue
                    raise Blocked(BLOCKED_HELP)
                try:
                    data = resp.json()
                except ValueError:
                    self.log(f"  Codeforces API sent HTTP {resp.status_code} without JSON; retrying...")
                    time.sleep(5 * (attempt + 1))
                    continue
            if data.get("status") == "OK":
                return data["result"]
            comment = str(data.get("comment", ""))
            if "limit exceeded" in comment.lower():
                time.sleep(3)
                continue
            raise CodeforcesError(f"Codeforces API {method}: {comment or 'failed'}")
        raise CodeforcesError(f"Codeforces API {method} kept failing. Try again later.")

    def contests(self) -> dict[int, dict]:
        if self._contests is None:
            self._contests = {c["id"]: c for c in self.api("contest.list", gym="false")}
        return self._contests

    def problemset(self) -> list[dict]:
        return self.api("problemset.problems")["problems"]

    # ------------------------------------------------------------------ pages
    def page(self, path: str, wait_for: str | None = ".problem-statement") -> str:
        url = f"{self.base}{path}"
        if self.mode == "browser":
            self._wait("_last_page", self.delay)
            return self._use_browser().get(url, wait_for)
        for attempt in range(4):
            self._wait("_last_page", self.delay)
            try:
                resp = self.session.get(url, timeout=90)
            except requests.RequestException as exc:
                self.log(f"  Network error loading {url} ({exc}); retrying...")
                time.sleep(5 * (attempt + 1))
                continue
            text = resp.text
            if "aes.min.js" in text and "toNumbers" in text:
                rcpc = solve_rcpc(text)
                if rcpc:
                    self.session.cookies.set("RCPC", rcpc, domain=self.host, path="/")
                    continue
            if is_challenge(text) or resp.status_code == 403:
                if self.mode == "auto" and self._browser_available():
                    self.log("  Codeforces asked for a browser check; switching to browser mode.")
                    self.mode = "browser"
                    return self._use_browser().get(url, wait_for)
                raise Blocked(BLOCKED_HELP)
            if resp.status_code == 200:
                return text
            if resp.status_code == 404:
                return ""
            if resp.status_code in (429, 500, 502, 503, 504):
                time.sleep(10 * (attempt + 1))
                continue
            raise CodeforcesError(f"HTTP {resp.status_code} for {url}")
        raise CodeforcesError(f"Couldn't load {url} after several tries.")

    def contest_statements(self, contest_id: int) -> dict[str, ParsedProblem]:
        """All statements of a contest from its one-page 'complete problemset' view."""
        html = self.page(f"/contest/{contest_id}/problems?locale=en")
        return {p.index: p for p in parse_problems(html)}

    def statement(self, contest_id: int, index: str) -> ParsedProblem | None:
        html = self.page(f"/contest/{contest_id}/problem/{index}?locale=en")
        found = parse_problems(html)
        for parsed in found:
            if parsed.index == index.upper():
                return parsed
        return found[0] if found else None
