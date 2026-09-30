#!/usr/bin/env python3
"""CF Simplify library builder.

Turns finished Codeforces problems into simplified statements and stores them in
library/, which GitHub Pages serves to every user of the extension.

    python builder/build.py check                 test your .env settings
    python builder/build.py problem 4A 1850B      convert specific problems
    python builder/build.py contest 1850          convert a whole contest
    python builder/build.py update --limit 200    convert what's missing, newest first
    python builder/build.py configure             put your library address into the extension
    python builder/build.py package               zip the extension for Chrome and Firefox
    python builder/build.py stats | review | accept 1850A
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import OrderedDict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from cfsimplify.codeforces import Blocked, Codeforces, CodeforcesError  # noqa: E402
from cfsimplify.config import (  # noqa: E402
    EXTENSION_CONFIG_PATH, SettingsError, extension_config, load_settings,
)
from cfsimplify.library import Library, split_pid  # noqa: E402
from cfsimplify.llm import AllProvidersExhausted, LLMConfigError, LLMError, build_chain  # noqa: E402
from cfsimplify.pipeline import Simplifier  # noqa: E402
from cfsimplify.state import State  # noqa: E402

IN_CI = os.environ.get("GITHUB_ACTIONS") == "true"
URL_RE = re.compile(r"/(?:contest|gym|problemset/problem|problemset/gymProblem)/(\d+)/(?:problem/)?([A-Za-z][A-Za-z0-9]*)")


def log(message: str = "") -> None:
    print(message, flush=True)


def index_key(index: str) -> tuple[str, int]:
    m = re.match(r"([A-Za-z]+)(\d*)", index)
    return (m.group(1), int(m.group(2) or 0)) if m else (index, 0)


def parse_target(raw: str) -> tuple[int, str]:
    m = URL_RE.search(raw)
    if m:
        return int(m.group(1)), m.group(2).upper()
    return split_pid(raw)


def contest_phase(cf: Codeforces, contest_id: int) -> str:
    if contest_id >= 100000:
        try:
            return cf.api("contest.standings", contestId=contest_id, **{"from": 1}, count=1)["contest"]["phase"]
        except CodeforcesError:
            return "UNKNOWN"
    contest = cf.contests().get(contest_id)
    return contest["phase"] if contest else "UNKNOWN"


def report(position: str, pid: str, name: str, outcome) -> None:
    label = {"saved": "saved", "reused": "reused", "review": "REVIEW", "skipped": "skipped"}.get(outcome.status, outcome.status)
    log(f"{position:>11} {pid:<9} {name[:38]:<38} {label}  {outcome.detail}".rstrip())


# ---------------------------------------------------------------------------- commands
def cmd_check(args) -> int:
    settings = load_settings(require_llm=True)
    ok = True
    log("Settings")
    for n, p in enumerate(settings.providers):
        role = "main" if n == 0 else "fallback"
        log(f"  AI provider ({role}): {p.name}, model {p.model}, " + ("key set" if p.api_key else "no key"))
    log(f"  Library folder: {settings.library_dir}")
    log(f"  Public library address: {settings.library_public_url or '(not set; fill GITHUB_REPO in .env when you publish)'}")

    log("\nAI provider test (uses one request per provider)")
    chain = build_chain(settings, log=log)
    for client in chain.clients:
        try:
            reply = client.chat([{"role": "user", "content": "Reply with the single word OK."}])
            log(f"  {client.name}: working (replied {reply[:30]!r})")
        except LLMError as exc:
            ok = False
            log(f"  {client.name}: NOT working - {exc}")

    log("\nCodeforces test")
    cf = Codeforces(settings, log=log)
    try:
        log(f"  API: working ({len(cf.contests())} contests listed)")
        parsed = cf.statement(4, "A")
        if parsed and len(parsed.text) > 40:
            log(f"  Problem pages: working (read 4A \"{parsed.name}\")")
        else:
            ok = False
            log("  Problem pages: the page loaded but no statement was found")
    except Blocked as exc:
        ok = False
        log("  Problem pages: BLOCKED\n" + str(exc))
    except CodeforcesError as exc:
        ok = False
        log(f"  Codeforces: NOT working - {exc}")
    finally:
        cf.close()
    log("\nAll good. Try: python builder/build.py problem 4A" if ok else "\nFix the items above, then run check again.")
    return 0 if ok else 1


def run_batch(cf: Codeforces, sim: Simplifier, library: Library, state: State, items: list[dict]) -> None:
    groups: OrderedDict[int, list[dict]] = OrderedDict()
    for p in items:
        groups.setdefault(p["contestId"], []).append(p)
    total = len(items)
    done = 0
    try:
        for contest_id, problems in groups.items():
            statements = {}
            try:
                statements = cf.contest_statements(contest_id)
            except Blocked:
                raise
            except CodeforcesError as exc:
                log(f"  contest {contest_id}: {exc}; trying problem pages one by one")
            for p in problems:
                done += 1
                index = p["index"].upper()
                pid = f"{contest_id}{index}"
                parsed = statements.get(index) or cf.statement(contest_id, index)
                if parsed is None:
                    state.skip(pid, "no statement found on the problem page")
                    log(f"{f'[{done}/{total}]':>11} {pid:<9} {'':<38} skipped  no statement on the page")
                    continue
                outcome = sim.process(contest_id, index, p.get("name", ""), parsed, force=p.get("force", False))
                report(f"[{done}/{total}]", pid, p.get("name") or parsed.name, outcome)
            library.write_index()
            state.save()
    finally:
        library.write_index()
        state.save()


def cmd_update(args) -> int:
    settings = load_settings(require_llm=not args.dry_run)
    library = Library(settings.library_dir)
    state = State(settings.state_dir)
    cf = Codeforces(settings, log=log)
    try:
        log("Loading the problem list from Codeforces...")
        contests = cf.contests()
        todo = []
        for p in cf.problemset():
            contest_id, index = p.get("contestId"), str(p.get("index", "")).upper()
            if not contest_id or not index:
                continue
            contest = contests.get(contest_id)
            if not contest or contest.get("phase") != "FINISHED":
                continue
            if args.since_contest and contest_id < args.since_contest:
                continue
            pid = f"{contest_id}{index}"
            if library.has(contest_id, index) or pid in state.skipped:
                continue
            if pid in state.review and not args.retry_review:
                continue
            if "april fools" in contest.get("name", "").lower() or "*special" in (p.get("tags") or []):
                state.skip(pid, "special or April Fools problem: the story is part of the puzzle")
                continue
            todo.append({"contestId": contest_id, "index": index, "name": p.get("name", "")})
        state.save()
        todo.sort(key=lambda p: (-p["contestId"], index_key(p["index"])))
        if args.limit:
            todo = todo[: args.limit]
        log(f"{len(todo)} problems to convert now. The library has {library.count()}.")
        if args.dry_run:
            for p in todo[:40]:
                log(f"  {p['contestId']}{p['index']}  {p['name']}")
            if len(todo) > 40:
                log(f"  ... and {len(todo) - 40} more")
            return 0
        if not todo:
            return 0
        sim = Simplifier(build_chain(settings, log=log), library, state, log=log)
        run_batch(cf, sim, library, state, todo)
        log(f"Done. The library now has {library.count()} problems.")
        return 0
    finally:
        cf.close()


def cmd_problem(args) -> int:
    settings = load_settings(require_llm=True)
    library = Library(settings.library_dir)
    state = State(settings.state_dir)
    cf = Codeforces(settings, log=log)
    try:
        items = []
        for raw in args.ids:
            try:
                contest_id, index = parse_target(raw)
            except ValueError:
                log(f"  {raw}: not a problem id (use something like 1850A or a problem URL)")
                continue
            phase = contest_phase(cf, contest_id)
            if phase != "FINISHED":
                log(f"  {contest_id}{index}: contest is not finished ({phase}); skipped")
                continue
            items.append({"contestId": contest_id, "index": index, "name": "", "force": True})
        if not items:
            return 1
        sim = Simplifier(build_chain(settings, log=log), library, state, log=log)
        for n, item in enumerate(items, 1):
            contest_id, index = item["contestId"], item["index"]
            parsed = cf.statement(contest_id, index)
            if parsed is None:
                log(f"  {contest_id}{index}: no statement found on the page")
                continue
            outcome = sim.process(contest_id, index, parsed.name, parsed, force=True)
            report(f"[{n}/{len(items)}]", f"{contest_id}{index}", parsed.name, outcome)
            library.write_index()
            state.save()
            if args.show and outcome.status == "saved":
                log("\n" + library.get(contest_id, index)["simplified"] + "\n")
            elif args.show and outcome.status == "review":
                log("\n" + state.review[f"{contest_id}{index}"]["simplified"] + "\n")
        return 0
    finally:
        library.write_index()
        state.save()
        cf.close()


def cmd_contest(args) -> int:
    settings = load_settings(require_llm=True)
    library = Library(settings.library_dir)
    state = State(settings.state_dir)
    cf = Codeforces(settings, log=log)
    try:
        items = []
        for contest_id in args.ids:
            phase = contest_phase(cf, contest_id)
            if phase != "FINISHED":
                log(f"  contest {contest_id}: not finished ({phase}); skipped")
                continue
            statements = cf.contest_statements(contest_id)
            if not statements:
                log(f"  contest {contest_id}: no statements found")
                continue
            for index in sorted(statements, key=index_key):
                if args.force or not library.has(contest_id, index):
                    items.append({"contestId": contest_id, "index": index, "name": statements[index].name, "force": args.force})
        if not items:
            log("Nothing to convert.")
            return 0
        sim = Simplifier(build_chain(settings, log=log), library, state, log=log)
        run_batch(cf, sim, library, state, items)
        return 0
    finally:
        cf.close()


def cmd_configure(args) -> int:
    settings = load_settings(require_llm=False)
    if not settings.library_public_url:
        log("Set GITHUB_REPO (for example your-name/cf-simplify) or LIBRARY_PUBLIC_URL in .env first.")
        return 1
    config = extension_config()
    config["libraryUrl"] = settings.library_public_url
    if settings.github_repo:
        config["reportUrl"] = f"https://github.com/{settings.github_repo}/issues/new"
    config.setdefault("reportUrl", "")
    config.setdefault("promptVersion", 1)
    EXTENSION_CONFIG_PATH.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    log(f"extension/config.json now points to {config['libraryUrl']}")
    if config.get("reportUrl"):
        log(f"'Report a mistake' links open {config['reportUrl']}")
    log("Reload the extension (chrome://extensions) to use it.")
    return 0


FIREFOX_ID = "cf-simplify@cf-simplify.extension"


def firefox_manifest(manifest: dict) -> dict:
    """Chrome's manifest adapted for Firefox 128+ (the first with MAIN-world content scripts)."""
    manifest = json.loads(json.dumps(manifest))
    manifest["background"] = {"scripts": ["shared/providers.js", "shared/checks.js", "background.js"]}
    manifest["browser_specific_settings"] = {
        "gecko": {
            "id": FIREFOX_ID,
            "strict_min_version": "128.0",
            # With a personal key, the statement text goes to the AI service the person chose.
            "data_collection_permissions": {"required": ["websiteContent"]},
        }
    }
    return manifest


def cmd_package(args) -> int:
    import zipfile

    ext_dir = EXTENSION_CONFIG_PATH.parent
    out_dir = ext_dir.parent / "dist"
    out_dir.mkdir(exist_ok=True)
    manifest = json.loads((ext_dir / "manifest.json").read_text(encoding="utf-8"))
    files = sorted(p for p in ext_dir.rglob("*") if p.is_file() and p.name != "manifest.json")
    variants = {"chrome": manifest, "firefox": firefox_manifest(manifest)}
    for browser, variant in variants.items():
        target = out_dir / f"cf-simplify-{browser}-{manifest['version']}.zip"
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("manifest.json", json.dumps(variant, indent=2) + "\n")
            for path in files:
                zf.write(path, path.relative_to(ext_dir).as_posix())
        log(f"  {browser:<8} {target}")
    if not extension_config().get("libraryUrl"):
        log("\nNote: extension/config.json has no library address, so every user needs their own API key.\n"
            "Run `python builder/build.py configure` first to ship the shared library.")
    return 0


def cmd_stats(args) -> int:
    settings = load_settings(require_llm=False)
    library = Library(settings.library_dir)
    state = State(settings.state_dir)
    total = library.rebuild_index()
    models: dict[str, int] = {}
    warnings = 0
    for path in library.problems_dir.glob("*/*.json"):
        entry = json.loads(path.read_text(encoding="utf-8"))
        models[entry.get("model") or "?"] = models.get(entry.get("model") or "?", 0) + 1
        warnings += bool(entry.get("warnings"))
    log(f"Problems in the library: {total}")
    for model, count in sorted(models.items(), key=lambda kv: -kv[1]):
        log(f"  {model}: {count}")
    log(f"With a warning (possibly missing limits): {warnings}")
    log(f"Waiting for review: {len(state.review)}   Skipped: {len(state.skipped)}")
    return 0


def cmd_review(args) -> int:
    settings = load_settings(require_llm=False)
    state = State(settings.state_dir)
    if args.pid:
        item = state.review.get(args.pid.upper())
        if not item:
            log(f"{args.pid} is not in the review queue.")
            return 1
        log(f"{args.pid}  {item.get('name', '')}\nFlagged words: {', '.join(item.get('hints', []))}\n")
        log(item["simplified"])
        log(f"\nIf it contains no hint: python builder/build.py accept {args.pid}\n"
            f"To try again:            python builder/build.py problem {args.pid}")
        return 0
    if not state.review:
        log("The review queue is empty.")
        return 0
    log("Held back because the automatic check saw possible hints:")
    for pid, item in state.review.items():
        log(f"  {pid:<9} {item.get('name', '')[:40]:<40} {', '.join(item.get('hints', []))}")
    log("\nRead one with: python builder/build.py review <id>")
    return 0


def cmd_accept(args) -> int:
    settings = load_settings(require_llm=False)
    library = Library(settings.library_dir)
    state = State(settings.state_dir)
    sim = Simplifier(None, library, state, log=log)
    for raw in args.ids:
        pid = raw.upper()
        log(f"  {pid}: " + ("published" if sim.accept(pid) else "not in the review queue"))
    library.write_index()
    state.save()
    return 0


# ---------------------------------------------------------------------------- main
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="build.py", description="Build the CF Simplify shared library.")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("check", help="test your .env settings, the AI provider and Codeforces access")
    p.set_defaults(func=cmd_check)

    p = sub.add_parser("update", help="convert finished problems that are not in the library yet (newest first)")
    p.add_argument("--limit", type=int, default=0, help="convert at most this many problems")
    p.add_argument("--since-contest", type=int, default=0, help="only contests with this id or higher")
    p.add_argument("--retry-review", action="store_true", help="also retry problems waiting for review")
    p.add_argument("--dry-run", action="store_true", help="only list what would be converted")
    p.set_defaults(func=cmd_update)

    p = sub.add_parser("problem", help="convert specific problems, e.g. 4A 1850B or problem URLs (replaces existing)")
    p.add_argument("ids", nargs="+")
    p.add_argument("--show", action="store_true", help="print the result")
    p.set_defaults(func=cmd_problem)

    p = sub.add_parser("contest", help="convert every problem of the given contests")
    p.add_argument("ids", nargs="+", type=int)
    p.add_argument("--force", action="store_true", help="redo problems that are already in the library")
    p.set_defaults(func=cmd_contest)

    p = sub.add_parser("configure", help="write your library address (from .env) into extension/config.json")
    p.set_defaults(func=cmd_configure)

    p = sub.add_parser("package", help="zip the extension for the Chrome Web Store and Firefox Add-ons (into dist/)")
    p.set_defaults(func=cmd_package)

    p = sub.add_parser("stats", help="show library statistics")
    p.set_defaults(func=cmd_stats)

    p = sub.add_parser("review", help="list (or show) rewrites held back by the hint check")
    p.add_argument("pid", nargs="?")
    p.set_defaults(func=cmd_review)

    p = sub.add_parser("accept", help="publish held-back rewrites after reading them")
    p.add_argument("ids", nargs="+")
    p.set_defaults(func=cmd_accept)
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        sys.stdout.reconfigure(errors="replace")  # never crash on odd characters in a Windows console
    except AttributeError:
        pass
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except SettingsError as exc:
        print(f"Settings problem: {exc}", file=sys.stderr)
        return 1
    except Blocked as exc:
        if IN_CI:
            print("::warning::Codeforces blocked the GitHub runner with a browser check. "
                  "Run the builder on your own computer instead (see README).")
            return 0
        print(str(exc), file=sys.stderr)
        return 2
    except LLMConfigError as exc:
        print(f"AI provider problem: {exc}", file=sys.stderr)
        return 3
    except AllProvidersExhausted as exc:
        print(str(exc))
        if IN_CI:
            print("::notice::Free AI quota used up for today; the next scheduled run continues.")
        return 0
    except (CodeforcesError, LLMError) as exc:
        print(f"Stopped: {exc}\nProgress so far is saved; run the same command again to continue.", file=sys.stderr)
        return 4
    except KeyboardInterrupt:
        print("\nStopped. Progress so far is saved; run the same command again to continue.")
        return 130


if __name__ == "__main__":
    sys.exit(main())
