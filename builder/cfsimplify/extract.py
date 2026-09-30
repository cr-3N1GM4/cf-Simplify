"""Turn Codeforces problem HTML into plain text with LaTeX math.

Mirrors CFS.extractStatement in extension/content/render.js.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from bs4 import BeautifulSoup, Comment, NavigableString, Tag

BLOCK_TAGS = {
    "p", "div", "ul", "ol", "table", "center", "blockquote", "section",
    "h1", "h2", "h3", "h4", "h5", "h6", "dl", "dt", "dd", "tr",
}
SKIP_CLASSES = {"cfs-card", "header", "sample-tests"}


@dataclass
class ParsedProblem:
    index: str
    name: str
    text: str
    interactive: bool = False
    has_figures: bool = False
    has_formula_images: bool = False


def _classes(tag: Tag) -> set[str]:
    return set(tag.get("class") or [])


def _is_mathjax_output(tag: Tag) -> bool:
    return tag.name == "mjx-container" or any(c.startswith("MathJax") or c.startswith("mjx-") for c in _classes(tag))


def _walk(node: Tag, out: list[str]) -> None:
    for child in node.children:
        if isinstance(child, Comment):
            continue
        if isinstance(child, NavigableString):
            out.append(re.sub(r"\s+", " ", str(child)))
            continue
        if not isinstance(child, Tag):
            continue
        name = child.name.lower()
        classes = _classes(child)
        if classes & SKIP_CLASSES or _is_mathjax_output(child) or name in ("style", "button"):
            continue
        if name == "script":
            kind = (child.get("type") or "").lower()
            if kind.startswith("math/tex"):
                tex = child.get_text().strip()
                out.append(f"\n$${tex}$$\n" if "mode=display" in kind else f"${tex}$")
            continue
        if "section-title" in classes:
            out.append(f"\n\n### {child.get_text(' ', strip=True)}\n\n")
            continue
        if "tex-span" in classes:
            inner: list[str] = []
            _walk(child, inner)
            out.append("$" + "".join(inner).strip() + "$")
            continue
        if "tex-font-style-tt" in classes:
            out.append("`" + child.get_text() + "`")
            continue
        if name == "br":
            out.append("\n")
            continue
        if name == "img":
            if "tex-formula" in classes:
                alt = (child.get("alt") or "").strip()
                out.append(f"${alt}$" if alt else " [formula image] ")
            else:
                out.append(" [figure] ")
            continue
        if name in ("sub", "sup"):
            out.append("_{" if name == "sub" else "^{")
            _walk(child, out)
            out.append("}")
            continue
        if name == "li":
            out.append("\n- ")
            _walk(child, out)
            continue
        if name == "pre":
            out.append("\n```\n" + child.get_text().strip("\n") + "\n```\n")
            continue
        if name in ("td", "th"):
            _walk(child, out)
            out.append(" | ")
            continue
        block = name in BLOCK_TAGS
        if block:
            out.append("\n\n")
        _walk(child, out)
        if block:
            out.append("\n\n")


def finalize_text(text: str) -> str:
    s = text.replace("\u00a0", " ")
    s = re.sub(r"\${6}(.+?)\${6}", lambda m: "\n$$" + m.group(1).strip() + "$$\n", s, flags=re.S)
    s = re.sub(r"\${3}(.+?)\${3}", lambda m: "$" + m.group(1).strip() + "$", s, flags=re.S)
    s = "\n".join(re.sub(r"[ \t]+", " ", line).strip() for line in s.split("\n"))
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def statement_text(statement: Tag) -> str:
    out: list[str] = []
    _walk(statement, out)
    return finalize_text("".join(out))


def _parse_statement(statement: Tag, index_hint: str | None) -> ParsedProblem | None:
    title_tag = statement.select_one(".header .title")
    title = title_tag.get_text(" ", strip=True) if title_tag else ""
    m = re.match(r"^([A-Za-z]\d*)\s*\.\s*(.*)$", title)
    index = (index_hint or (m.group(1) if m else "") or "").upper()
    name = m.group(2).strip() if m else title
    if not index:
        return None
    text = statement_text(statement)
    section_titles = [t.get_text(" ", strip=True).lower() for t in statement.select(".section-title")]
    images = statement.find_all("img")
    return ParsedProblem(
        index=index,
        name=name,
        text=text,
        interactive=any(t.startswith("interaction") or t.startswith("протокол") for t in section_titles),
        has_figures=any("tex-formula" not in _classes(img) for img in images),
        has_formula_images="[formula image]" in text,
    )


def parse_problems(html: str) -> list[ParsedProblem]:
    """All problem statements found on a Codeforces page (one or many)."""
    soup = BeautifulSoup(html or "", "html.parser")
    found: list[ParsedProblem] = []
    holders = soup.select("div.problemindexholder")
    if holders:
        pairs = [(h.get("problemindex"), h.select_one("div.problem-statement")) for h in holders]
    else:
        pairs = [(None, st) for st in soup.select("div.problem-statement")]
    for index_hint, statement in pairs:
        if statement is None:
            continue
        parsed = _parse_statement(statement, index_hint)
        if parsed is not None:
            found.append(parsed)
    return found
