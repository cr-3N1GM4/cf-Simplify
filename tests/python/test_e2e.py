"""End-to-end tests of the builder CLI against a local mock server that plays
both Codeforces (API + problem pages) and an OpenAI-compatible AI service."""
from __future__ import annotations

import contextlib
import io
import json
import os
import re
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures"
sys.path.insert(0, str(ROOT / "builder"))

import build  # noqa: E402
from cfsimplify.config import ProviderSettings  # noqa: E402
from cfsimplify.llm import LLMConfigError, ProviderClient, QuotaExhausted, UsageCounter  # noqa: E402

TWO_PILES_CLEAN = """## Task
Given two integers $x$ and $y$, decide whether $x = y$.

## Input
- One line with two integers $x$ and $y$ ($0 \\le x, y \\le 1000$).

## Output
- Print `YES` if $x = y$, otherwise print `NO`."""

TWO_PILES_WITH_HINT = TWO_PILES_CLEAN.replace("decide whether", "use a greedy check to decide whether")

HIDDEN_CLEAN = """## Task
Find the hidden integer $x$ ($1 \\le x \\le 10^6$).

## Interaction
- Ask at most $25$ queries of the form "? $y$"; the reply is "<" if $x < y$ and ">=" otherwise.
- Print "! $x$" to answer."""

HIDDEN_WITH_HINT = HIDDEN_CLEAN.replace("Find the hidden", "Use binary search to find the hidden")

CHALLENGE = "<html><head><title>Just a moment...</title></head><body><script src='/cdn-cgi/challenge-platform/h/b'></script></body></html>"


class MockServer:
    def __init__(self):
        self.pages: dict[str, tuple[int, str]] = {}
        self.llm_outputs: dict[str, list[str]] = {}
        self.daily_exhausted: set[str] = set()
        self.llm_calls: list[dict] = []
        server = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):  # keep test output quiet
                pass

            def _send(self, status: int, body: str, kind: str = "text/html; charset=utf-8"):
                data = body.encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                path = self.path.split("?", 1)[0]
                status, body = server.pages.get(path, (404, "not found"))
                kind = "application/json" if path.startswith("/api/") else "text/html; charset=utf-8"
                self._send(status, body, kind)

            def do_POST(self):
                length = int(self.headers.get("Content-Length", 0))
                payload = json.loads(self.rfile.read(length) or b"{}")
                prefix = self.path.rsplit("/chat/completions", 1)[0]
                server.llm_calls.append({"prefix": prefix, "payload": payload, "auth": self.headers.get("Authorization")})
                if prefix in server.daily_exhausted:
                    body = {"error": {"code": 429, "message": "Quota exceeded for quota metric GenerateRequestsPerDayPerProjectPerModel-FreeTier"}}
                    return self._send(429, json.dumps(body), "application/json")
                user = next((m["content"] for m in payload["messages"] if m["role"] == "user"), "")
                m = re.search(r'Problem: \S+ "([^"]+)"', user)
                outputs = server.llm_outputs.get(m.group(1) if m else "", ["## Task\nOK\n\n## Input\n- x\n\n## Output\n- y"])
                attempt = sum(1 for msg in payload["messages"] if msg["role"] == "assistant")
                content = outputs[min(attempt, len(outputs) - 1)]
                body = {"choices": [{"message": {"role": "assistant", "content": content}}]}
                self._send(200, json.dumps(body), "application/json")

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


def api(result) -> tuple[int, str]:
    return 200, json.dumps({"status": "OK", "result": result})


class BuilderEndToEnd(unittest.TestCase):
    def setUp(self):
        self.server = MockServer()
        self.tmp = tempfile.TemporaryDirectory()
        self.library_dir = Path(self.tmp.name) / "library"
        self.state_dir = Path(self.tmp.name) / "state"
        contest_page = (FIXTURES / "contest_problems.html").read_text(encoding="utf-8")
        single_b = contest_page[contest_page.index('<div class="problemindexholder" problemindex="B">'):]
        self.server.pages.update({
            "/api/contest.list": api([
                {"id": 1300, "name": "Codeforces Round (Div. 2), live", "phase": "CODING"},
                {"id": 1235, "name": "Codeforces Round (Div. 1)", "phase": "FINISHED"},
                {"id": 1234, "name": "Codeforces Round (Div. 2)", "phase": "FINISHED"},
                {"id": 1111, "name": "April Fools Day Contest", "phase": "FINISHED"},
            ]),
            "/api/problemset.problems": api({"problems": [
                {"contestId": 1300, "index": "A", "name": "Live One", "tags": []},
                {"contestId": 1235, "index": "A", "name": "Two Piles", "tags": []},
                {"contestId": 1234, "index": "A", "name": "Two Piles", "tags": []},
                {"contestId": 1234, "index": "B", "name": "Hidden Number", "tags": ["interactive"]},
                {"contestId": 1111, "index": "A", "name": "Joke", "tags": ["*special"]},
            ], "problemStatistics": []}),
            "/contest/1234/problems": (200, contest_page),
            "/contest/1235/problems": (200, contest_page),
            "/contest/1234/problem/A": (200, contest_page),
            "/contest/1234/problem/B": (200, "<html><body>" + single_b),
        })
        self.server.llm_outputs = {
            "Two Piles": [TWO_PILES_WITH_HINT, TWO_PILES_CLEAN],
            "Hidden Number": [HIDDEN_CLEAN],
        }
        self.env = {
            "LLM_PROVIDER": "custom",
            "LLM_FALLBACK": "",
            "CUSTOM_BASE_URL": self.server.url + "/v1",
            "CUSTOM_API_KEY": "test-key",
            "CUSTOM_MODEL": "mock-model",
            "OLLAMA_BASE_URL": self.server.url + "/fallback/v1",
            "OLLAMA_MODEL": "mock-fallback",
            "CF_BASE_URL": self.server.url,
            "CF_REQUEST_DELAY_SECONDS": "0",
            "CF_FETCH_MODE": "requests",
            "LIBRARY_DIR": str(self.library_dir),
            "BUILDER_STATE_DIR": str(self.state_dir),
            "GITHUB_REPO": "",
            "LIBRARY_PUBLIC_URL": "",
        }
        self.patch = mock.patch.dict(os.environ, self.env)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.server.close()
        self.tmp.cleanup()

    def run_cli(self, *args: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = build.main(list(args))
        return code, out.getvalue(), err.getvalue()

    def entry(self, contest_id: int, index: str) -> dict:
        return json.loads((self.library_dir / "problems" / str(contest_id) / f"{index}.json").read_text(encoding="utf-8"))

    def test_problem_command_retries_once_to_remove_a_hint(self):
        code, out, err = self.run_cli("problem", "1234A", "--show")
        self.assertEqual(code, 0, out + err)
        entry = self.entry(1234, "A")
        self.assertEqual(entry["simplified"], TWO_PILES_CLEAN)
        self.assertEqual((entry["model"], entry["provider"], entry["warnings"]), ("mock-model", "custom", []))
        self.assertEqual(len(self.server.llm_calls), 2)  # first answer had "greedy", so one retry
        retry_messages = self.server.llm_calls[1]["payload"]["messages"]
        self.assertIn('"greedy"', retry_messages[-1]["content"])
        self.assertEqual(self.server.llm_calls[0]["auth"], "Bearer test-key")
        self.assertIn("Given two integers", out)  # --show printed it
        index = json.loads((self.library_dir / "index.json").read_text(encoding="utf-8"))
        self.assertEqual(index["count"], 1)

    def test_problem_command_accepts_urls_and_refuses_running_contests(self):
        self.server.pages["/api/contest.list"] = api([{"id": 1234, "name": "Round", "phase": "CODING"}])
        code, out, _ = self.run_cli("problem", "https://codeforces.com/contest/1234/problem/A")
        self.assertEqual(code, 1)
        self.assertIn("not finished", out)
        self.assertEqual(self.server.llm_calls, [])

    def test_update_converts_skips_and_reuses(self):
        code, out, err = self.run_cli("update")
        self.assertEqual(code, 0, out + err)
        a1234, a1235, b1234 = self.entry(1234, "A"), self.entry(1235, "A"), self.entry(1234, "B")
        self.assertEqual(b1234["simplified"], HIDDEN_CLEAN)
        # Div. 1 / Div. 2 twins share one conversion: 1235 runs first (newest), 1234A reuses it.
        self.assertNotIn("reusedFrom", a1235)
        self.assertEqual(a1234["reusedFrom"], "1235A")
        self.assertFalse((self.library_dir / "problems" / "1300").exists())  # live contest untouched
        skipped = json.loads((self.state_dir / "skipped.json").read_text(encoding="utf-8"))
        self.assertIn("1111A", skipped)  # April Fools
        # Running again converts nothing new.
        calls = len(self.server.llm_calls)
        code, out, _ = self.run_cli("update")
        self.assertEqual(code, 0)
        self.assertIn("0 problems to convert", out)
        self.assertEqual(len(self.server.llm_calls), calls)

    def test_persistent_hint_goes_to_review_and_can_be_accepted(self):
        self.server.llm_outputs["Hidden Number"] = [HIDDEN_WITH_HINT]
        code, out, _ = self.run_cli("problem", "1234B")
        self.assertEqual(code, 0)
        self.assertIn("REVIEW", out)
        self.assertFalse((self.library_dir / "problems" / "1234" / "B.json").exists())
        code, out, _ = self.run_cli("review")
        self.assertIn("1234B", out)
        self.assertIn("binary search", out)
        code, out, _ = self.run_cli("accept", "1234B")
        self.assertIn("published", out)
        self.assertTrue(self.entry(1234, "B")["reviewed"])
        self.assertEqual(json.loads((self.state_dir / "review.json").read_text(encoding="utf-8")), {})

    def test_daily_quota_switches_to_fallback_provider(self):
        os.environ["LLM_FALLBACK"] = "ollama"
        self.server.daily_exhausted.add("/v1")
        code, out, err = self.run_cli("problem", "1234B")
        self.assertEqual(code, 0, out + err)
        self.assertEqual(self.entry(1234, "B")["provider"], "ollama")
        self.assertIn("Switching to ollama", out)

    def test_all_quotas_used_up_stops_cleanly(self):
        self.server.daily_exhausted.add("/v1")
        code, out, _ = self.run_cli("problem", "1234B")
        self.assertEqual(code, 0)
        self.assertIn("free requests for today", out)
        self.assertFalse((self.library_dir / "problems" / "1234" / "B.json").exists())

    def test_cloudflare_block_explains_the_fix(self):
        self.server.pages["/contest/1234/problem/A"] = (403, CHALLENGE)
        code, out, err = self.run_cli("problem", "1234A")
        self.assertEqual(code, 2)
        self.assertIn("browser check", err)
        self.assertIn("CF_COOKIE", err)

    def test_missing_key_is_explained(self):
        os.environ["LLM_PROVIDER"] = "gemini"
        os.environ["GEMINI_API_KEY"] = ""
        code, _, err = self.run_cli("problem", "1234A")
        self.assertEqual(code, 1)
        self.assertIn("GEMINI_API_KEY is empty", err)
        self.assertIn("aistudio.google.com", err)

    def test_configure_writes_the_extension_config(self):
        config_path = ROOT / "extension" / "config.json"
        original = config_path.read_text(encoding="utf-8")
        try:
            os.environ["GITHUB_REPO"] = "Alice/cf-simplify"
            code, out, _ = self.run_cli("configure")
            self.assertEqual(code, 0)
            config = json.loads(config_path.read_text(encoding="utf-8"))
            self.assertEqual(config["libraryUrl"], "https://alice.github.io/cf-simplify")
            self.assertEqual(config["reportUrl"], "https://github.com/Alice/cf-simplify/issues/new")
            self.assertEqual(config["promptVersion"], 1)
        finally:
            config_path.write_text(original, encoding="utf-8")


class ProviderClientTests(unittest.TestCase):
    def setUp(self):
        self.server = MockServer()
        self.tmp = tempfile.TemporaryDirectory()
        self.usage = UsageCounter(Path(self.tmp.name) / "usage.json")

    def tearDown(self):
        self.server.close()
        self.tmp.cleanup()

    def client(self, prefix="/v1", daily_limit=0, key="k"):
        settings = ProviderSettings("custom", self.server.url + prefix, key, "m", rpm=0, daily_limit=daily_limit)
        return ProviderClient(settings, self.usage, timeout=10, sleep=lambda s: None)

    def test_retries_after_a_per_minute_limit(self):
        attempts = {"n": 0}
        original = self.server.httpd.RequestHandlerClass.do_POST

        def flaky(handler):
            attempts["n"] += 1
            if attempts["n"] == 1:
                return handler._send(429, '{"error":{"message":"Rate limit per minute (RPM) reached"}}', "application/json")
            return original(handler)

        self.server.httpd.RequestHandlerClass.do_POST = flaky
        try:
            text = self.client().chat([{"role": "user", "content": "hi"}])
        finally:
            self.server.httpd.RequestHandlerClass.do_POST = original
        self.assertIn("## Task", text)
        self.assertEqual(attempts["n"], 2)
        self.assertEqual(self.usage.count("custom"), 1)

    def test_bad_key_is_a_config_error(self):
        original = self.server.httpd.RequestHandlerClass.do_POST
        self.server.httpd.RequestHandlerClass.do_POST = lambda h: h._send(401, '{"error":{"message":"API key not valid"}}', "application/json")
        try:
            with self.assertRaises(LLMConfigError) as ctx:
                self.client().chat([{"role": "user", "content": "hi"}])
        finally:
            self.server.httpd.RequestHandlerClass.do_POST = original
        self.assertIn("API key not valid", str(ctx.exception))

    def test_own_daily_limit_stops_before_sending(self):
        client = self.client(daily_limit=1)
        client.chat([{"role": "user", "content": "hi"}])
        with self.assertRaises(QuotaExhausted):
            client.chat([{"role": "user", "content": "hi"}])
        self.assertEqual(len(self.server.llm_calls), 1)


if __name__ == "__main__":
    unittest.main()
