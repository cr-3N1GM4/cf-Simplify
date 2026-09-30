"""Builder bookkeeping kept in builder/state/ (committed, but not published).

skipped.json - problems that can't be converted (no statement, April Fools...)
review.json  - rewrites that still looked like they contained hints after a retry;
               they are NOT published until you accept them (build.py review / accept)
"""
from __future__ import annotations

import json
from pathlib import Path

from .library import now_iso


def _load(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


class State:
    def __init__(self, directory: Path):
        self.dir = Path(directory)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.skipped_path = self.dir / "skipped.json"
        self.review_path = self.dir / "review.json"
        self.skipped = _load(self.skipped_path)
        self.review = _load(self.review_path)

    def skip(self, pid: str, reason: str) -> None:
        self.skipped[pid] = {"reason": reason, "at": now_iso()}

    def add_review(self, pid: str, item: dict) -> None:
        self.review[pid] = {**item, "at": now_iso()}

    def resolve(self, pid: str) -> None:
        self.skipped.pop(pid, None)
        self.review.pop(pid, None)

    def save(self) -> None:
        for path, data in ((self.skipped_path, self.skipped), (self.review_path, self.review)):
            ordered = dict(sorted(data.items()))
            path.write_text(json.dumps(ordered, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
