"""Convert one problem: statement -> simplified text -> checks -> library entry."""
from __future__ import annotations

import hashlib
from dataclasses import dataclass

from .checks import Issues, build_user_message, feedback, load_terms, run_checks
from .config import PROMPT_PATH, prompt_version
from .extract import ParsedProblem
from .library import Library, now_iso
from .llm import LLMChain
from .state import State

MIN_STATEMENT_CHARS = 40


def statement_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:20]


@dataclass
class Outcome:
    status: str  # saved | reused | review | skipped
    detail: str = ""


class Simplifier:
    def __init__(self, chain: LLMChain, library: Library, state: State, log=print):
        self.chain = chain
        self.library = library
        self.state = state
        self.log = log
        self.system_prompt = PROMPT_PATH.read_text(encoding="utf-8").strip()
        self.terms = load_terms()
        self.prompt_version = prompt_version()

    def simplify(self, pid: str, name: str, text: str):
        """Ask the model, check the answer, and give it one chance to fix problems."""
        messages = [
            {"role": "system", "content": self.system_prompt},
            {"role": "user", "content": build_user_message(pid, name, text)},
        ]
        output, client = self.chain.chat(messages)
        issues: Issues = run_checks(text, output, self.terms)
        if issues.any():
            messages += [
                {"role": "assistant", "content": output},
                {"role": "user", "content": feedback(issues)},
            ]
            output, client = self.chain.chat(messages)
            issues = run_checks(text, output, self.terms)
        return output, issues, client

    def process(self, contest_id: int, index: str, name: str, parsed: ParsedProblem, force: bool = False) -> Outcome:
        index = index.upper()
        pid = f"{contest_id}{index}"
        name = name or parsed.name
        text = parsed.text
        if len(text) < MIN_STATEMENT_CHARS:
            self.state.skip(pid, "statement missing or too short (it may be PDF-only)")
            return Outcome("skipped", "no statement text on the page")

        source_hash = statement_hash(text)
        if not force:
            twin = self.library.find_by_hash(source_hash)
            if twin and twin.get("id") != pid:
                entry = {
                    **twin,
                    "id": pid,
                    "contestId": contest_id,
                    "index": index,
                    "name": name,
                    "reusedFrom": twin.get("reusedFrom") or twin["id"],
                    "createdAt": now_iso(),
                }
                self.library.save(entry)
                self.state.resolve(pid)
                return Outcome("reused", f"same statement as {entry['reusedFrom']}")

        output, issues, client = self.simplify(pid, name, text)
        if issues.hints:
            self.state.add_review(pid, {
                "contestId": contest_id,
                "index": index,
                "name": name,
                "simplified": output,
                "hints": issues.hints,
                "missing": issues.missing,
                "model": client.model,
                "provider": client.name,
                "sourceHash": source_hash,
            })
            return Outcome("review", "held for review, possible hints: " + ", ".join(issues.hints))

        warnings = []
        if issues.missing:
            warnings.append("missing-limits")
        if issues.format:
            warnings.append("format")
        entry = {
            "id": pid,
            "contestId": contest_id,
            "index": index,
            "name": name,
            "simplified": output,
            "warnings": warnings,
            "model": client.model,
            "provider": client.name,
            "promptVersion": self.prompt_version,
            "sourceHash": source_hash,
            "createdAt": now_iso(),
        }
        self.library.save(entry)
        self.state.resolve(pid)
        detail = client.model + (f", check: {', '.join(issues.missing)} missing" if issues.missing else "")
        return Outcome("saved", detail)

    def accept(self, pid: str) -> bool:
        """Publish a rewrite from the review queue after a human has read it."""
        item = self.state.review.get(pid)
        if not item:
            return False
        entry = {
            "id": pid,
            "contestId": item["contestId"],
            "index": item["index"],
            "name": item.get("name", ""),
            "simplified": item["simplified"],
            "warnings": ["missing-limits"] if item.get("missing") else [],
            "model": item.get("model", ""),
            "provider": item.get("provider", ""),
            "promptVersion": self.prompt_version,
            "sourceHash": item.get("sourceHash", ""),
            "createdAt": now_iso(),
            "reviewed": True,
        }
        self.library.save(entry)
        self.state.resolve(pid)
        return True
