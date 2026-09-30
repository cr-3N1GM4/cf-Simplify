"""The shared library: one JSON file per problem, plus a small index.

Layout (served as-is by GitHub Pages):
    library/index.json
    library/problems/<contestId>/<INDEX>.json
"""
from __future__ import annotations

import datetime as dt
import json
import re
from pathlib import Path


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


PID_RE = re.compile(r"^(\d+)([A-Za-z][A-Za-z0-9]*)$")


def split_pid(pid: str) -> tuple[int, str]:
    """'1850A' -> (1850, 'A'); '1790F1' -> (1790, 'F1')."""
    m = PID_RE.match(pid.strip())
    if not m:
        raise ValueError(f"not a problem id: {pid!r}")
    return int(m.group(1)), m.group(2).upper()


class Library:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.problems_dir = self.root / "problems"
        self.index_path = self.root / "index.json"
        self.problems_dir.mkdir(parents=True, exist_ok=True)
        self.index = self._load_index()
        self._by_hash: dict[str, str] | None = None

    # ------------------------------------------------------------------ index
    def _load_index(self) -> dict:
        try:
            data = json.loads(self.index_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        if not isinstance(data.get("problems"), dict):
            data["problems"] = {}
        return data

    def write_index(self) -> None:
        problems = dict(sorted(self.index["problems"].items(), key=lambda kv: split_pid(kv[0])))
        data = {
            "version": 1,
            "updatedAt": now_iso(),
            "count": len(problems),
            "problems": problems,
        }
        self.index = data
        self.index_path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")

    def rebuild_index(self) -> int:
        problems: dict[str, dict] = {}
        for path in self.problems_dir.glob("*/*.json"):
            try:
                entry = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            pid = entry.get("id") or f"{path.parent.name}{path.stem}"
            problems[pid] = {"h": entry.get("sourceHash", ""), "p": entry.get("promptVersion", 1)}
        self.index["problems"] = problems
        self._by_hash = None
        self.write_index()
        return len(problems)

    # ------------------------------------------------------------------ entries
    def path(self, contest_id: int, index: str) -> Path:
        return self.problems_dir / str(contest_id) / f"{index.upper()}.json"

    def has(self, contest_id: int, index: str) -> bool:
        return self.path(contest_id, index).exists()

    def get(self, contest_id: int, index: str) -> dict | None:
        try:
            return json.loads(self.path(contest_id, index).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def find_by_hash(self, source_hash: str) -> dict | None:
        """An existing entry made from exactly the same statement (Div. 1 / Div. 2 twins)."""
        if not source_hash:
            return None
        if self._by_hash is None:
            self._by_hash = {meta.get("h"): pid for pid, meta in self.index["problems"].items() if meta.get("h")}
        pid = self._by_hash.get(source_hash)
        if not pid:
            return None
        contest_id, index = split_pid(pid)
        return self.get(contest_id, index)

    def save(self, entry: dict) -> Path:
        path = self.path(entry["contestId"], entry["index"])
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(entry, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        self.index["problems"][entry["id"]] = {"h": entry.get("sourceHash", ""), "p": entry.get("promptVersion", 1)}
        if self._by_hash is not None and entry.get("sourceHash"):
            self._by_hash.setdefault(entry["sourceHash"], entry["id"])
        return path

    def count(self) -> int:
        return len(self.index["problems"])
