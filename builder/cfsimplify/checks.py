"""Automatic checks for a simplified statement.

Mirrors extension/shared/checks.js; keep the two in step.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

from .config import HINT_TERMS_PATH

FORMAL_RE = re.compile(r"^(input|output|interaction|входные|выходные|протокол)")
NOTE_RE = re.compile(r"^(note|notes|example|examples|примечание|пример)")


def load_terms() -> dict:
    return json.loads(HINT_TERMS_PATH.read_text(encoding="utf-8"))


def clean_output(text: str) -> str:
    s = re.sub(r"<think>.*?</think>", "", text or "", flags=re.S | re.I)
    fenced = re.match(r"^\s*```(?:markdown|md)?[ \t]*\n(.*?)\n\s*```\s*$", s, flags=re.S | re.I)
    if fenced:
        s = fenced.group(1)
    return s.strip()


def build_user_message(pid: str, name: str, statement: str) -> str:
    title = f' "{name}"' if name else ""
    return (
        "Rewrite this Codeforces problem statement following your instructions.\n\n"
        f"Problem: {pid}{title}\n\n"
        f"<statement>\n{statement.strip()}\n</statement>"
    )


def _split_sections(text: str) -> list[tuple[str, list[str]]]:
    sections: list[tuple[str, list[str]]] = []
    title, lines = "", []
    for line in text.split("\n"):
        m = re.match(r"^#{2,4}\s+(.*)$", line)
        if m:
            sections.append((title, lines))
            title, lines = m.group(1).strip().lower(), []
        else:
            lines.append(line)
    sections.append((title, lines))
    return sections


def formal_sections(text: str) -> str:
    """The parts of a statement where the formal limits live (not the story, not the notes)."""
    sections = _split_sections(text)
    formal = [s for s in sections if FORMAL_RE.match(s[0])]
    use = formal or [s for s in sections if not NOTE_RE.match(s[0])]
    return "\n".join("\n".join(lines) for _, lines in use)


def _normalize_numbers(text: str) -> str:
    s = re.sub(r"\\[,;!:]|~", " ", text)
    s = re.sub(r"\\(?:cdot|times)(?![a-zA-Z])|[·×⋅]", "*", s)
    s = s.replace("{,}", ",")
    s = re.sub(r"\{\s*(\d+)\s*\}", r"\1", s)
    s = re.sub(r"(\d),(?=\d{3}(?!\d))", r"\1", s)
    s = re.sub(r"\s*\^\s*", "^", s)
    s = re.sub(r"\s*\*\s*", "*", s)
    return s


def number_values(text: str) -> dict[int, str]:
    """value -> how it was written, for every number >= 100."""
    s = _normalize_numbers(text)
    found: dict[int, str] = {}

    def add(value: int, form: str) -> None:
        if value >= 100 and value not in found:
            found[value] = form

    def coefficient(m: re.Match) -> str:
        a, b, c = m.groups()
        if int(c) <= 60:
            add(int(a) * int(b) ** int(c), m.group(0))
        return " "

    def power(m: re.Match) -> str:
        b, c = m.groups()
        if int(c) <= 60:
            add(int(b) ** int(c), m.group(0))
        return " "

    s = re.sub(r"(\d+)\*(\d+)\^(\d+)", coefficient, s)
    s = re.sub(r"(\d+)\^(\d+)", power, s)
    for m in re.finditer(r"\d{3,}", s):
        add(int(m.group(0)), m.group(0))
    return found


def missing_numbers(original: str, output: str) -> list[str]:
    want = number_values(formal_sections(original))
    have = number_values(output)
    return [form for value, form in want.items() if value not in have]


def find_hints(original: str, output: str, terms: dict) -> list[str]:
    orig = original.lower()
    out = output.lower()
    hits: list[str] = []
    for term in terms.get("terms", []):
        t = term.lower()
        if t in orig:
            continue
        if re.search(r"(?<![a-z0-9])" + re.escape(t) + r"(?:s|es)?(?![a-z0-9])", out):
            hits.append(term)
    for pattern in terms.get("patterns", []):
        m = re.search(pattern, output, flags=re.I)
        if m and not re.search(pattern, original, flags=re.I):
            hits.append(m.group(0).strip())
    return hits


def check_format(output: str) -> list[str]:
    if not output.strip():
        return ["empty"]
    problems = []

    def has(name: str) -> bool:
        return re.search(rf"^#{{2,3}}\s*{name}\b", output, flags=re.I | re.M) is not None

    if not has("task"):
        problems.append('missing "## Task"')
    if not has("interaction") and not (has("input") and has("output")):
        problems.append('missing "## Input"/"## Output"')
    return problems


@dataclass
class Issues:
    hints: list[str] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)
    format: list[str] = field(default_factory=list)

    def any(self) -> bool:
        return bool(self.hints or self.missing or self.format)


def run_checks(original: str, output: str, terms: dict) -> Issues:
    return Issues(
        hints=find_hints(original, output, terms),
        missing=missing_numbers(original, output),
        format=check_format(output),
    )


def feedback(issues: Issues) -> str:
    lines = ["Your rewrite needs fixing:"]
    if issues.hints:
        quoted = ", ".join(f'"{h}"' for h in issues.hints)
        lines.append(
            f"- It uses words that can act as hints or add claims the statement does not make: {quoted}. "
            "Remove them and describe only what the statement says."
        )
    if issues.missing:
        lines.append(
            f"- These numbers or limits from the statement are missing: {', '.join(issues.missing)}. "
            "Include every limit exactly as written."
        )
    if issues.format:
        lines.append(
            "- It does not follow the required format (## Task, ## Details, ## Input, ## Output, "
            "or ## Interaction for interactive problems)."
        )
    lines.append("Reply with the corrected rewrite only, in the same format.")
    return "\n".join(lines)
