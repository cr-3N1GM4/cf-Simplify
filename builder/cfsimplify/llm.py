"""A small OpenAI-compatible chat client with pacing, retries and provider fallback.

Works with Gemini, Groq, OpenRouter, Ollama and any other service that speaks
POST {base_url}/chat/completions.
"""
from __future__ import annotations

import datetime as dt
import json
import re
import time
from email.utils import parsedate_to_datetime
from pathlib import Path

import requests

from .checks import clean_output
from .config import ProviderSettings

DAILY_RE = re.compile(r"per[\s_-]?day|perday|\bRPD\b|daily", re.I)
RETRYABLE = {408, 409, 425, 500, 502, 503, 504, 520, 522, 524, 529}


class LLMError(Exception):
    pass


class LLMConfigError(LLMError):
    """The provider rejected our setup (bad key, unknown model...). Retrying won't help."""


class QuotaExhausted(LLMError):
    """The provider's daily allowance is used up."""


class AllProvidersExhausted(LLMError):
    pass


class UsageCounter:
    """Counts successful requests per provider per day (UTC) in a small JSON file."""

    def __init__(self, path: Path):
        self.path = path
        try:
            self.data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.data = {}

    @staticmethod
    def today() -> str:
        return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")

    def count(self, provider: str) -> int:
        return int(self.data.get(self.today(), {}).get(provider, 0))

    def add(self, provider: str) -> None:
        day = self.today()
        self.data = {day: self.data.get(day, {})}  # keep only today
        self.data[day][provider] = self.data[day].get(provider, 0) + 1
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.data, indent=2) + "\n", encoding="utf-8")


def _summarize(body: str) -> str:
    try:
        data = json.loads(body)
        if isinstance(data, list) and data:
            data = data[0]
        err = data.get("error", data) if isinstance(data, dict) else data
        msg = err.get("message") if isinstance(err, dict) else err
        if msg:
            return str(msg)[:300]
    except (ValueError, AttributeError):
        pass
    return re.sub(r"\s+", " ", body)[:300]


def _retry_after(resp: requests.Response) -> float | None:
    raw = resp.headers.get("retry-after")
    if raw:
        try:
            return float(raw)
        except ValueError:
            try:
                return max(0.0, (parsedate_to_datetime(raw) - dt.datetime.now(dt.timezone.utc)).total_seconds())
            except (TypeError, ValueError):
                pass
    m = re.search(r"retry(?:Delay| in| after)[\"':\s]*([\d.]+)\s*s", resp.text, re.I)
    return float(m.group(1)) if m else None


def _message_text(data: dict) -> str:
    try:
        content = data["choices"][0]["message"].get("content")
    except (KeyError, IndexError, TypeError, AttributeError):
        return ""
    if isinstance(content, list):
        return "".join(part if isinstance(part, str) else str(part.get("text", "")) for part in content)
    return content or ""


class ProviderClient:
    def __init__(self, settings: ProviderSettings, usage: UsageCounter, timeout: float = 180.0,
                 sleep=time.sleep, max_attempts: int = 6):
        self.settings = settings
        self.name = settings.name
        self.model = settings.model
        self.usage = usage
        self.timeout = timeout
        self.sleep = sleep
        self.max_attempts = max_attempts
        self.url = settings.base_url.rstrip("/") + "/chat/completions"
        self.session = requests.Session()
        self.headers = {"Content-Type": "application/json"}
        if settings.api_key:
            self.headers["Authorization"] = f"Bearer {settings.api_key}"
        if settings.name == "openrouter":
            self.headers["X-Title"] = "CF Simplify"
        self._last_start = 0.0

    def _pace(self) -> None:
        if self.settings.rpm <= 0:
            return
        gap = 60.0 / self.settings.rpm
        wait = self._last_start + gap - time.monotonic()
        if wait > 0:
            self.sleep(wait)
        self._last_start = time.monotonic()

    def chat(self, messages: list[dict]) -> str:
        limit = self.settings.daily_limit
        if limit and self.usage.count(self.name) >= limit:
            raise QuotaExhausted(f"{self.name}: reached the daily limit of {limit} requests set in .env")
        payload = {"model": self.model, "messages": messages, "temperature": 0.2}
        delay = 2.0
        last = ""
        for _ in range(self.max_attempts):
            self._pace()
            try:
                resp = self.session.post(self.url, json=payload, headers=self.headers, timeout=self.timeout)
            except requests.RequestException as exc:
                last = f"network error: {exc}"
                self.sleep(delay)
                delay = min(delay * 2, 60)
                continue

            if resp.status_code == 200:
                try:
                    text = clean_output(_message_text(resp.json()))
                except ValueError:
                    text = ""
                if text:
                    self.usage.add(self.name)
                    return text
                last = "empty answer"
                self.sleep(delay)
                delay = min(delay * 2, 60)
                continue

            body = resp.text or ""
            if resp.status_code == 429:
                if DAILY_RE.search(body):
                    raise QuotaExhausted(f"{self.name}: daily free quota used up ({_summarize(body)})")
                wait = _retry_after(resp)
                self.sleep(min(wait if wait is not None else delay, 120))
                delay = min(delay * 2, 60)
                last = "rate limited"
                continue
            if resp.status_code in RETRYABLE:
                last = f"HTTP {resp.status_code}"
                self.sleep(delay)
                delay = min(delay * 2, 60)
                continue
            if resp.status_code in (400, 401, 403, 404, 422):
                raise LLMConfigError(
                    f"{self.name} rejected the request (HTTP {resp.status_code}): {_summarize(body)}\n"
                    f"Check the API key and the model name ({self.model}) in .env."
                )
            raise LLMError(f"{self.name}: HTTP {resp.status_code}: {_summarize(body)}")
        raise LLMError(f"{self.name}: giving up after {self.max_attempts} attempts ({last})")


class LLMChain:
    """Uses the first provider until its daily quota runs out, then the next one."""

    def __init__(self, clients: list[ProviderClient], log=print):
        if not clients:
            raise ValueError("no providers configured")
        self.clients = clients
        self.position = 0
        self.log = log

    @property
    def current(self) -> ProviderClient | None:
        return self.clients[self.position] if self.position < len(self.clients) else None

    def chat(self, messages: list[dict]) -> tuple[str, ProviderClient]:
        while self.position < len(self.clients):
            client = self.clients[self.position]
            try:
                return client.chat(messages), client
            except QuotaExhausted as exc:
                self.position += 1
                nxt = self.current
                self.log(f"  {exc}." + (f" Switching to {nxt.name} ({nxt.model})." if nxt else ""))
        raise AllProvidersExhausted(
            "Every configured AI provider has used up its free requests for today. "
            "Progress is saved; run the same command again tomorrow (or add LLM_FALLBACK providers in .env)."
        )


def build_chain(settings, log=print) -> LLMChain:
    usage = UsageCounter(settings.state_dir / "usage.json")
    clients = [ProviderClient(p, usage, timeout=settings.llm_timeout) for p in settings.providers]
    return LLMChain(clients, log=log)
