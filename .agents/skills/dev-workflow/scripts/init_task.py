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


class TaskError(RuntimeError):
    pass


def validate_segment(value: str, label: str, action_slug: bool = False) -> str:
    if not SEGMENT_RE.fullmatch(value):
        raise TaskError(f"{label} must already be lowercase kebab-case: {value!r}")
    if action_slug and "-" not in value:
        raise TaskError("task slug must include an action prefix")
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

- Pull request / CI / merge: Not started.
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
        f"- [{title}]({task_link(domain, slug)}) — `intake`: {goal}",
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
    states = re.findall(r"^- State: `([^`]+)`$", task_text, re.MULTILINE)
    if len(states) != 1 or states[0] not in STATES:
        raise TaskError("task README has no supported workflow state")
    print(f"Task record OK: .agents/tasks/{domain_name(domain)}/{slug}")
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
    check_parser.add_argument("--repo-root", help=argparse.SUPPRESS)
    check_parser.set_defaults(handler=check)
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
