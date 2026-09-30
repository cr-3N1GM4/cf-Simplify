"""Tests for statement extraction, the checker, the RCPC solver and library helpers.

Run from the project root:  python -m unittest discover -s tests/python -v
"""
from __future__ import annotations

import json
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures"
sys.path.insert(0, str(ROOT / "builder"))

from cfsimplify import checks  # noqa: E402
from cfsimplify.codeforces import is_challenge, solve_rcpc  # noqa: E402
from cfsimplify.config import library_url_from_repo  # noqa: E402
from cfsimplify.extract import parse_problems  # noqa: E402
from cfsimplify.library import Library, split_pid  # noqa: E402


def squash(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def golden(name: str) -> str:
    return (FIXTURES / f"{name}.expected.txt").read_text(encoding="utf-8").rstrip("\n")


def extracted(html_name: str) -> str:
    problems = parse_problems((FIXTURES / html_name).read_text(encoding="utf-8"))
    return "\n\n=====\n\n".join(f"[{p.index}] {p.name}\n{p.text}" for p in problems)


class ExtractTests(unittest.TestCase):
    def test_modern_problem_matches_golden(self):
        self.assertEqual(extracted("modern_problem.html"), golden("modern_problem"))

    def test_modern_problem_details(self):
        (p,) = parse_problems((FIXTURES / "modern_problem.html").read_text(encoding="utf-8"))
        self.assertEqual((p.index, p.name), ("B", "Lantern Festival"))
        self.assertIn("$1 \\le t \\le 10^4$", p.text)
        self.assertIn("$1 \\le i < n$", p.text)            # HTML entity decoded inside math
        self.assertIn("$$S = \\sum_{i=1}^{n} a_i.$$", p.text)  # display math
        self.assertIn("### Input", p.text)
        self.assertIn("### Note", p.text)
        self.assertNotIn("Examples", p.text)               # sample tests are left out
        self.assertNotIn("3 1 2", p.text)
        self.assertNotIn("time limit", p.text)
        self.assertFalse(p.interactive)

    def test_rendered_page_reads_the_same_as_raw_html(self):
        # What the browser shows after MathJax ran must extract to the same text.
        self.assertEqual(squash(extracted("modern_problem.rendered.html")), squash(golden("modern_problem")))

    def test_old_style_markup(self):
        (p,) = parse_problems((FIXTURES / "old_problem.html").read_text(encoding="utf-8"))
        self.assertEqual(p.index, "C")
        self.assertIn("$h_{i}$", p.text)
        self.assertIn("10^{9}", p.text)
        self.assertIn("`YES`", p.text)
        self.assertIn("[figure]", p.text)
        self.assertTrue(p.has_figures)
        self.assertEqual(extracted("old_problem.html"), golden("old_problem"))

    def test_contest_page_with_interactive_problem(self):
        problems = parse_problems((FIXTURES / "contest_problems.html").read_text(encoding="utf-8"))
        self.assertEqual([p.index for p in problems], ["A", "B"])
        self.assertFalse(problems[0].interactive)
        self.assertTrue(problems[1].interactive)
        self.assertIn("### Interaction", problems[1].text)
        self.assertEqual(extracted("contest_problems.html"), golden("contest_problems"))

    def test_page_without_statement(self):
        self.assertEqual(parse_problems("<html><body>Contest is running</body></html>"), [])


class CheckTests(unittest.TestCase):
    terms = checks.load_terms()

    def test_shared_cases(self):
        cases = json.loads((FIXTURES / "check_cases.json").read_text(encoding="utf-8"))
        for case in cases:
            with self.subTest(case["name"]):
                issues = checks.run_checks(case["original"], case["output"], self.terms)
                self.assertEqual(issues.hints, case["hints"])
                self.assertEqual(issues.missing, case["missing"])
                self.assertEqual(issues.format, case["format"])

    def test_clean_output(self):
        self.assertEqual(checks.clean_output("<think>plan</think>\n## Task\nX"), "## Task\nX")
        self.assertEqual(checks.clean_output("```markdown\n## Task\nX\n```"), "## Task\nX")
        self.assertEqual(checks.clean_output("  ## Task\nX  "), "## Task\nX")

    def test_feedback_mentions_every_problem(self):
        text = checks.feedback(checks.Issues(hints=["greedy"], missing=["10^9"], format=["missing"]))
        self.assertIn('"greedy"', text)
        self.assertIn("10^9", text)
        self.assertIn("format", text)

    def test_user_message(self):
        msg = checks.build_user_message("4A", "Watermelon", "  body  ")
        self.assertIn('Problem: 4A "Watermelon"', msg)
        self.assertTrue(msg.endswith("<statement>\nbody\n</statement>"))


class RcpcTests(unittest.TestCase):
    def test_solves_the_aes_challenge(self):
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

        key, iv, plain = os.urandom(16), os.urandom(16), os.urandom(16)
        encryptor = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
        cipher = encryptor.update(plain) + encryptor.finalize()
        page = (
            '<html><head><script type="text/javascript" src="/aes.min.js"></script></head><body><script>'
            'function toNumbers(d){var e=[];d.replace(/(..)/g,function(d){e.push(parseInt(d,16))});return e}'
            f'var a=toNumbers("{key.hex()}"),b=toNumbers("{iv.hex()}"),c=toNumbers("{cipher.hex()}");'
            'document.cookie="RCPC="+toHex(slowAES.decrypt(c,2,a,b))+"; path=/";</script></body></html>'
        )
        self.assertEqual(solve_rcpc(page), plain.hex())
        self.assertIsNone(solve_rcpc("<html>normal page</html>"))

    def test_detects_cloudflare_challenge(self):
        self.assertTrue(is_challenge("<title>Just a moment...</title><script src='/cdn-cgi/challenge-platform/x'>"))
        self.assertFalse(is_challenge("<div class='problem-statement'>ok</div>"))


class LibraryTests(unittest.TestCase):
    def test_split_pid(self):
        self.assertEqual(split_pid("1850A"), (1850, "A"))
        self.assertEqual(split_pid("1790f1"), (1790, "F1"))
        with self.assertRaises(ValueError):
            split_pid("A1")

    def test_save_index_and_hash_lookup(self):
        with tempfile.TemporaryDirectory() as tmp:
            lib = Library(Path(tmp))
            entry = {"id": "12A", "contestId": 12, "index": "A", "simplified": "## Task\nx", "sourceHash": "abc", "promptVersion": 1}
            lib.save(entry)
            lib.save({**entry, "id": "3B", "contestId": 3, "index": "B", "sourceHash": "def"})
            lib.write_index()
            index = json.loads((Path(tmp) / "index.json").read_text())
            self.assertEqual(list(index["problems"]), ["3B", "12A"])  # numeric order
            self.assertEqual(index["count"], 2)
            reloaded = Library(Path(tmp))
            self.assertEqual(reloaded.find_by_hash("abc")["id"], "12A")
            self.assertIsNone(reloaded.find_by_hash("zzz"))
            self.assertEqual(reloaded.rebuild_index(), 2)

    def test_library_url_from_repo(self):
        self.assertEqual(library_url_from_repo("Alice/cf-simplify"), "https://alice.github.io/cf-simplify")
        self.assertEqual(library_url_from_repo("alice/alice.github.io"), "https://alice.github.io")
        self.assertEqual(library_url_from_repo("nonsense"), "")


if __name__ == "__main__":
    unittest.main()
