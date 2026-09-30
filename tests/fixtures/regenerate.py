"""Regenerate derived test fixtures.

  modern_problem.rendered.html  - modern_problem.html as the browser DOM looks after
                                  Codeforces' MathJax 2 has typeset it (what the extension reads)
  *.expected.txt                - golden statement text produced by the extractor

Run after changing the extractor on purpose:  python tests/fixtures/regenerate.py
"""
from __future__ import annotations

import html
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "builder"))

from cfsimplify.extract import parse_problems  # noqa: E402


def mathjax_render(page: str) -> str:
    counter = [0]

    def frame(n: int) -> str:
        return (f'<span class="MathJax" id="MathJax-Element-{n}-Frame" tabindex="0" role="presentation">'
                f'<nobr aria-hidden="true"><span class="math" id="MathJax-Span-{n}">RENDERED</span></nobr>'
                f'<span class="MJX_Assistive_MathML" role="presentation"><math xmlns="http://www.w3.org/1998/Math/MathML">'
                f'<mi>x</mi></math></span></span>')

    def display(m: re.Match) -> str:
        counter[0] += 1
        n = counter[0]
        tex = html.unescape(m.group(1))
        return (f'<span class="MathJax_Preview" style="color: inherit;"></span>'
                f'<div class="MathJax_Display" style="text-align: center;">{frame(n)}</div>'
                f'<script type="math/tex; mode=display" id="MathJax-Element-{n}">{tex}</script>')

    def inline(m: re.Match) -> str:
        counter[0] += 1
        n = counter[0]
        tex = html.unescape(m.group(1))
        return (f'<span class="MathJax_Preview" style="color: inherit;"></span>{frame(n)}'
                f'<script type="math/tex" id="MathJax-Element-{n}">{tex}</script>')

    page = re.sub(r"\${6}(.+?)\${6}", display, page, flags=re.S)
    return re.sub(r"\${3}(.+?)\${3}", inline, page, flags=re.S)


def main() -> None:
    modern = (HERE / "modern_problem.html").read_text(encoding="utf-8")
    (HERE / "modern_problem.rendered.html").write_text(mathjax_render(modern), encoding="utf-8")
    for name in ("modern_problem", "old_problem", "contest_problems"):
        problems = parse_problems((HERE / f"{name}.html").read_text(encoding="utf-8"))
        text = "\n\n=====\n\n".join(f"[{p.index}] {p.name}\n{p.text}" for p in problems)
        (HERE / f"{name}.expected.txt").write_text(text + "\n", encoding="utf-8")
        print(f"{name}: {len(problems)} problem(s)")


if __name__ == "__main__":
    main()
