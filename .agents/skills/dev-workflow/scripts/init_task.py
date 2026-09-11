#!/usr/bin/env python3
"""Create or check a lean development task record."""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path


SEGMENT_RE = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*\Z")
STATES = {
    "intake",
    "clarification",
    "solution",
    "awaiting-development-approval",
    "implementation",
    "review",
    "knowledge-closeout",
    "done",
    "blocked",
}

# The states a task record may be committed to the integration trunk in.
#
# A record is committed inside the pull request that delivers it, so it can
# never contain the result of its own merge. The rule that follows from that:
# a state may land on `next` only if nothing happening outside the repository
# can turn it false. `intake` (nothing has started), `blocked` (waiting on a
# named blocker), and `done` (the work is finished and submitted) are all
# self-consistent — they stay true whatever the pull request does next.
#
# The six middle states describe a process in flight. `review` stops being true
# the moment a reviewer answers; `implementation` stops being true when the
# branch is pushed. They are useful on a working branch, which is a working
# copy, and they are a lie the moment that branch merges. Merge facts belong to
# git and GitHub, which record them authoritatively and for free; copying them
# into a file is what creates staleness, so the record does not try.
TRUNK_STATES = {"intake", "blocked", "done"}


class TaskError(RuntimeError):
    pass


def validate_segment(value: str, label: str, action_slug: bool = False) -> str:
    if not SEGMENT_RE.fullmatch(value):
        raise TaskError(f"{label} must already be lowercase kebab-case: {value!r}")
    if action_slug and "-" not in value:
        raise TaskError(f"{label} must include an action prefix: {value!r}")
    return value


def validate_domain_path(value: str) -> tuple[str, ...]:
    if not value:
        raise TaskError("domain path must not be empty")
    parts = tuple(value.split("/"))
    for part in parts:
        validate_segment(part, "domain path segment")
    return parts


def validate_line(value: str, label: str) -> str:
    value = value.strip()
    if not value or "\n" in value or "\r" in value:
        raise TaskError(f"{label} must be one non-empty line")
    return value


def repo_root(override: str | None) -> Path:
    if override:
        root = Path(override).resolve()
    else:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode:
            raise TaskError("run inside the Dreamux repository")
        root = Path(result.stdout.strip()).resolve()
    if not (root / ".agents/tasks/README.md").is_file():
        raise TaskError(f"missing task index under {root}")
    return root


def read(path: Path) -> str:
    if not path.is_file():
        raise TaskError(f"missing file: {path}")
    return path.read_text(encoding="utf-8")


def add_bullet(text: str, headings: tuple[str, ...], target: str, bullet: str) -> str:
    if f"]({target})" in text:
        return text
    lines = text.splitlines()
    matches = [index for index, line in enumerate(lines) if line in headings]
    if len(matches) != 1:
        raise TaskError(f"expected one {' or '.join(headings)} section")
    end = len(lines)
    for index in range(matches[0] + 1, len(lines)):
        if lines[index].startswith("## "):
            end = index
            break
    while end and lines[end - 1] == "":
        end -= 1
    lines.insert(end, bullet)
    return "\n".join(lines).rstrip() + "\n"


def replace(path: Path, content: str) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(content, encoding="utf-8")
    os.replace(temporary, path)


def domain_name(parts: tuple[str, ...]) -> str:
    return "/".join(parts)


def domain_link(parts: tuple[str, ...]) -> str:
    return f"/.agents/tasks/{domain_name(parts)}/README.md"


def task_link(domain: tuple[str, ...], slug: str, child: str = "README.md") -> str:
    return f"/.agents/tasks/{domain_name(domain)}/{slug}/{child}"


def task_readme(domain: tuple[str, ...], slug: str, title: str, goal: str) -> str:
    return f"""# {title}

## Current state

- Goal: {goal}
- State: `intake`
- Requirement: [Current requirement]({task_link(domain, slug, 'requirement.md')})
- Final solution: Not created.
- Solution review Issue: Not created.
- Blockers: Requirement not yet clarified.
- Next action: Clarify and confirm the requirement with the operator.
- Related tasks: None.

## Development approval

- Status: Not granted.
- Approved implementation boundary: None.

## Delivery

- Pull request: Not opened.
- Knowledge closeout: Pending.
"""


def requirement(goal: str) -> str:
    return f"""# Requirement

## Initial request

- {goal}

## Current alignment

- Status: Draft; clarification has not converged.
- Confirmed current behavior and evidence: Not yet confirmed.
- Desired outcome: {goal}
- Desired behavior: Not yet confirmed.
- Scope: Not yet confirmed.
- Non-goals: Not yet confirmed.
- Constraints and invariants: Not yet confirmed.

## Acceptance criteria

- Not yet confirmed.

## Decisions and unknowns

- Confirmed operator decisions: None yet.
- Assumptions: None yet.
- Blocking unknowns: Clarify the requirement with the operator.
"""


def domain_readme(domain: str, summary: str, signals: list[str]) -> str:
    rows = []
    for signal in signals:
        if "=" not in signal:
            raise TaskError("--code-signal must use LABEL=REPOSITORY_PATH")
        label, path = map(str.strip, signal.split("=", 1))
        if not label or not path:
            raise TaskError("--code-signal must use LABEL=REPOSITORY_PATH")
        rows.append(f"| {label} | `{path}` |")
    if not rows:
        raise TaskError("a new domain requires at least one --code-signal")
    title = domain.replace("-", " ").title()
    return f"""# {title} Tasks

## Scope

- {summary}

## Code signals

| Area | Current code signal |
| --- | --- |
{chr(10).join(rows)}

## Child Scopes

## Tasks
"""


def existing_title(path: Path) -> str:
    first = read(path).splitlines()[0]
    if not first.startswith("# "):
        raise TaskError(f"task README has no title: {path}")
    return first[2:].strip()


def assert_domain_chain(tasks: Path, domain: tuple[str, ...]) -> None:
    for depth in range(1, len(domain) + 1):
        current = domain[:depth]
        domain_index = tasks.joinpath(*current, "README.md")
        parent_index = tasks.joinpath(*current[:-1], "README.md")
        read(domain_index)
        parent_text = read(parent_index)
        target = domain_link(current)
        if f"]({target})" not in parent_text:
            raise TaskError(f"domain is missing from its parent task index: {target}")


def create_domain(
    tasks: Path,
    domain: tuple[str, ...],
    summary: str,
    signals: list[str],
) -> None:
    assert_domain_chain(tasks, domain[:-1])
    domain_dir = tasks.joinpath(*domain)
    if domain_dir.exists():
        raise TaskError(f"domain already exists: {domain_name(domain)}")
    domain_text = domain_readme(domain[-1], summary, signals)
    parent_index = tasks.joinpath(*domain[:-1], "README.md")
    parent_text = add_bullet(
        read(parent_index),
        ("## Child Scopes",),
        domain_link(domain),
        f"- [{domain[-1].replace('-', ' ').title()}]({domain_link(domain)}): {summary}",
    )
    domain_dir.mkdir()
    (domain_dir / "README.md").write_text(domain_text, encoding="utf-8")
    replace(parent_index, parent_text)


def create_domain_only(args: argparse.Namespace) -> int:
    domain = validate_domain_path(args.domain)
    summary = validate_line(args.domain_summary, "domain summary")
    root = repo_root(args.repo_root)
    tasks = root / ".agents/tasks"
    create_domain(tasks, domain, summary, args.code_signal)
    print(f"Created task domain: .agents/tasks/{domain_name(domain)}")
    return 0


def create(args: argparse.Namespace) -> int:
    domain = validate_domain_path(args.domain)
    slug = validate_segment(args.slug, "task slug", action_slug=True)
    title = validate_line(args.title, "title")
    goal = validate_line(args.goal, "goal")
    root = repo_root(args.repo_root)
    tasks = root / ".agents/tasks"
    domain_dir = tasks.joinpath(*domain)
    domain_index = domain_dir / "README.md"
    task_dir = domain_dir / slug

    if domain_dir.exists():
        assert_domain_chain(tasks, domain)
        domain_text = read(domain_index)
    else:
        if not args.create_domain:
            raise TaskError("domain does not exist; confirm it and pass --create-domain")
        summary = validate_line(args.domain_summary or "", "domain summary")
        create_domain(tasks, domain, summary, args.code_signal)
        domain_text = read(domain_index)

    if task_dir.exists():
        if existing_title(task_dir / "README.md") != title:
            raise TaskError("task exists with a different title; inspect and reuse it manually")
        read(task_dir / "requirement.md")
        print(f"Task already exists; reuse it: {task_dir}")
        return 0

    task_dir.mkdir()
    (task_dir / "README.md").write_text(
        task_readme(domain, slug, title, goal), encoding="utf-8"
    )
    (task_dir / "requirement.md").write_text(requirement(goal), encoding="utf-8")
    domain_text = add_bullet(
        domain_text,
        ("## Tasks", "## Active Tasks"),
        task_link(domain, slug),
        f"- [{title}]({task_link(domain, slug)}) — {goal}",
    )
    replace(domain_index, domain_text)
    print(f"Created lean task record: {task_dir}")
    return 0


def check(args: argparse.Namespace) -> int:
    domain = validate_domain_path(args.domain)
    slug = validate_segment(args.slug, "task slug", action_slug=True)
    root = repo_root(args.repo_root)
    tasks = root / ".agents/tasks"
    task_dir = tasks.joinpath(*domain, slug)
    domain_text = read(tasks.joinpath(*domain, "README.md"))
    task_text = read(task_dir / "README.md")
    read(task_dir / "requirement.md")
    assert_domain_chain(tasks, domain)
    expected = {}
    expected[task_link(domain, slug)] = domain_text
    expected[task_link(domain, slug, "requirement.md")] = task_text
    for target, text in expected.items():
        if f"]({target})" not in text:
            raise TaskError(f"missing index link: {target}")
    check_state(task_text, f"{domain_name(domain)}/{slug}", args.allow_in_flight)
    print(f"Task record OK: .agents/tasks/{domain_name(domain)}/{slug}")
    return 0


def check_state(task_text: str, name: str, allow_in_flight: bool) -> None:
    """Validate the one line that says where a task stands.

    The anchored pattern is the format rule: the line carries the state and
    stops. A branch name, a date, a list of green gates, or any other
    parenthetical appended here is a fact that expires while the state around
    it stays put, which is the drift this whole check exists to prevent.
    """
    states = re.findall(r"^- State: `([^`]+)`$", task_text, re.MULTILINE)
    if len(states) != 1 or states[0] not in STATES:
        raise TaskError(
            f"{name}: task README has no supported workflow state. The line must "
            f"read exactly '- State: `<state>`' with nothing after it, and "
            f"<state> must be one of: {', '.join(sorted(STATES))}"
        )
    if not allow_in_flight and states[0] not in TRUNK_STATES:
        raise TaskError(
            f"{name}: state `{states[0]}` describes work in flight, so it cannot "
            f"be committed to the trunk — it stops being true the moment this "
            f"branch merges. Use it while you work; before opening the pull "
            f"request set `done` (finished and submitted), `blocked` (waiting on "
            f"a named blocker), or `intake` (not started). Whether the pull "
            f"request merged is git's fact, not the record's."
        )


# A domain index and a task record are told apart by the headings only one of
# them can carry. Depth cannot do it: a domain may nest inside a domain, so
# `mcp/scheduler` sits exactly where a task record would.
DOMAIN_HEADINGS = frozenset({"## Child Scopes", "## Tasks", "## Active Tasks"})
RECORD_HEADING = "## Current state"


def is_domain_index(name: str, text: str) -> bool:
    """Decide which kind of file this is, and refuse to guess.

    Headings are matched as whole lines. A substring test would read
    `## Tasks completed` inside a record as the index heading `## Tasks`, and
    because an index is checked far more loosely than a record, that reading
    silently exempts the record from the state rule — the exact bypass this
    walk exists to close.

    Anything that is not an index is treated as a record, so an unrecognized
    file is answered with the field it is missing rather than skipped. The
    asymmetry is deliberate and only safe in that direction: mistaking a record
    for an index is silent, mistaking an index for a record is loud. A file
    carrying both kinds of heading is refused outright rather than resolved by
    precedence, because either reading would be a guess.
    """
    headings = {line.strip() for line in unfenced_lines(text)}
    domain = bool(headings & DOMAIN_HEADINGS)
    record = RECORD_HEADING in headings
    if domain and record:
        raise TaskError(
            f"{name}: README carries both a domain-index heading and "
            f"'{RECORD_HEADING}', so it cannot be checked as either. A domain "
            f"index and a task record are separate files."
        )
    return domain


# Bullet labels that report where delivery stood at the moment of writing.
# The rule is on the label, which is a closed structural token, and never on the
# prose after it, which is not: a phrase list cannot tell a live status from the
# same words quoted inside an operator ruling, and this repository's records
# quote operators verbatim by policy.
DELIVERY_STATUS_LABELS = frozenset({
    "Baseline",
    "Branch",
    "CI",
    "CI / merge",
    "Commit",
    "Current PR",
    "Current next action",
    "Current repair baseline",
    "Current repair branch",
    "Merge",
    "Pull request / CI / merge",
    "Pull request / merge",
})

# A section under this heading is a frozen snapshot of a past round, kept on
# purpose. It records what was true then, which is not a claim about now, so the
# label rule does not reach into it.
FROZEN_SECTION_PREFIX = "## Historical"

LABEL_RE = re.compile(r"^- ([A-Z][A-Za-z0-9 /-]{0,40}):")


def unfenced_lines(text: str) -> list[str]:
    """Everything outside a fenced block.

    A format token inside an example is not document structure. Reading it as
    structure is a real bypass, not a hypothetical one: a record whose body
    contained a fenced `## Tasks` would be classified as a domain index and skip
    the state rule entirely. Structure is read from these lines only.
    """
    lines: list[str] = []
    fenced = False
    for line in text.splitlines():
        if line.startswith("```"):
            fenced = not fenced
            continue
        if not fenced:
            lines.append(line)
    return lines


def live_lines(text: str) -> list[str]:
    """The lines that make a claim about the present.

    Frozen sections are dropped on top of the fenced ones: they describe a past
    round, and a record of what was true then is not a claim about now.
    """
    lines: list[str] = []
    frozen = False
    for line in unfenced_lines(text):
        if line.startswith("## "):
            frozen = line.startswith(FROZEN_SECTION_PREFIX)
        if not frozen:
            lines.append(line)
    return lines


def check_delivery_labels(name: str, lines: list[str]) -> None:
    for line in lines:
        match = LABEL_RE.match(line)
        if match and match.group(1) in DELIVERY_STATUS_LABELS:
            raise TaskError(
                f"{name}: the `- {match.group(1)}:` field reports where delivery "
                f"stood when it was written, so it goes false on its own. git and "
                f"GitHub already record it. Keep the pull request link; drop the "
                f"branch, baseline, commit, CI result, and merge status. A past "
                f"round that is kept on purpose belongs under a "
                f"'{FROZEN_SECTION_PREFIX} ...' heading, which this check skips."
            )


def check_record(directory: Path, name: str, text: str, allow_in_flight: bool) -> None:
    validate_segment(directory.name, f"{name}: task slug", action_slug=True)
    if not (directory / "requirement.md").is_file():
        raise TaskError(f"{name}: missing requirement.md")
    if "\n## Current state" not in text:
        raise TaskError(f"{name}: task README has no '## Current state' section")
    lines = live_lines(text)
    check_state("\n".join(lines), name, allow_in_flight)
    if not allow_in_flight:
        check_delivery_labels(name, lines)
    if f"](/.agents/tasks/{name}/requirement.md)" not in text:
        raise TaskError(f"{name}: the record does not link its own requirement.md")
    link = f"/.agents/tasks/{name}/README.md"
    if f"]({link})" not in read(directory.parent / "README.md"):
        raise TaskError(f"{name}: the parent task index does not link this record")


INDEX_BULLET_RE = re.compile(
    r"^- \[[^\]]*\]\((/\.agents/tasks/[^)]*README\.md)\)(.*)$", re.MULTILINE
)


def check_index(name: str, text: str) -> None:
    """Validate what a domain index may not repeat.

    An index entry says what a task is for and where to read it. It does not
    carry the task's state. Two copies of one fact in two files is the drift
    itself: the record moves on, the index keeps yesterday's answer, and a
    reader has no way to tell which of the two is stale. That the links resolve
    is checked once for the whole knowledge base by `.agents/scripts/check.sh`.
    """
    for link, rest in INDEX_BULLET_RE.findall("\n".join(unfenced_lines(text))):
        for state in re.findall(r"`([^`]+)`", rest):
            if state in STATES:
                raise TaskError(
                    f"{name}: the index entry for {link} repeats the task's state "
                    f"`{state}`. The state belongs to the record alone; the index "
                    f"entry carries the title, the link, and the goal."
                )


def check_all(args: argparse.Namespace) -> int:
    """Check every task record in the repository.

    A per-task check only runs when someone remembers to run it for that task,
    which is how a record reaches the trunk in a state nobody validated. This
    walks the tree instead, so the gate also covers records nobody is working on.

    Anything that is not a domain index is checked as a task record, so a record
    whose format has drifted is answered with the specific thing it is missing
    instead of being skipped as unrecognized. Silently skipping is how an
    unchecked record hides, which is the failure this gate exists to close.
    """
    root = repo_root(args.repo_root)
    tasks = root / ".agents/tasks"
    failures: list[str] = []
    records = 0
    for readme in sorted(tasks.rglob("README.md")):
        directory = readme.parent
        relative = directory.relative_to(tasks)
        name = relative.as_posix() if relative.parts else "."
        text = read(readme)
        try:
            if is_domain_index(name, text):
                check_index(name, text)
            else:
                records += 1
                check_record(directory, name, text, args.allow_in_flight)
        except TaskError as error:
            failures.append(str(error))
    for failure in failures:
        print(f"error: {failure}", file=sys.stderr)
    if failures:
        print(f"\n{len(failures)} of {records} task records failed.", file=sys.stderr)
        return 1
    print(f"Task records OK: {records} checked")
    return 0


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    commands = result.add_subparsers(dest="command", required=True)
    create_parser = commands.add_parser("create")
    create_parser.add_argument("--domain", required=True)
    create_parser.add_argument("--slug", required=True)
    create_parser.add_argument("--title", required=True)
    create_parser.add_argument("--goal", required=True)
    create_parser.add_argument("--create-domain", action="store_true")
    create_parser.add_argument("--domain-summary")
    create_parser.add_argument("--code-signal", action="append", default=[])
    create_parser.add_argument("--repo-root", help=argparse.SUPPRESS)
    create_parser.set_defaults(handler=create)
    domain_parser = commands.add_parser("create-domain")
    domain_parser.add_argument("--domain", required=True)
    domain_parser.add_argument("--domain-summary", required=True)
    domain_parser.add_argument("--code-signal", action="append", default=[])
    domain_parser.add_argument("--repo-root", help=argparse.SUPPRESS)
    domain_parser.set_defaults(handler=create_domain_only)
    check_parser = commands.add_parser("check")
    check_parser.add_argument("--domain", required=True)
    check_parser.add_argument("--slug", required=True)
    check_parser.add_argument(
        "--allow-in-flight",
        action="store_true",
        help="permit a mid-workflow state; use while the task is on a branch",
    )
    check_parser.add_argument("--repo-root", help=argparse.SUPPRESS)
    check_parser.set_defaults(handler=check)
    check_all_parser = commands.add_parser("check-all")
    check_all_parser.add_argument(
        "--allow-in-flight",
        action="store_true",
        help="permit mid-workflow states; use while tasks are on a branch",
    )
    check_all_parser.add_argument("--repo-root", help=argparse.SUPPRESS)
    check_all_parser.set_defaults(handler=check_all)
    return result


def main() -> int:
    args = parser().parse_args()
    try:
        return args.handler(args)
    except (TaskError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
