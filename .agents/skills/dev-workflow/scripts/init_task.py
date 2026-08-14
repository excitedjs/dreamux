#!/usr/bin/env python3
"""Create or check a lean Dreamux task record."""

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
    if not (root / ".agents/tasks/dreamux/README.md").is_file():
        raise TaskError(f"missing Dreamux task index under {root}")
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


def task_link(domain: str, slug: str, child: str = "README.md") -> str:
    return f"/.agents/tasks/dreamux/{domain}/{slug}/{child}"


def task_readme(domain: str, slug: str, title: str, goal: str) -> str:
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

## Tasks
"""


def existing_title(path: Path) -> str:
    first = read(path).splitlines()[0]
    if not first.startswith("# "):
        raise TaskError(f"task README has no title: {path}")
    return first[2:].strip()


def create(args: argparse.Namespace) -> int:
    domain = validate_segment(args.domain, "domain")
    slug = validate_segment(args.slug, "task slug", action_slug=True)
    title = validate_line(args.title, "title")
    goal = validate_line(args.goal, "goal")
    root = repo_root(args.repo_root)
    tasks = root / ".agents/tasks/dreamux"
    root_index = tasks / "README.md"
    domain_dir = tasks / domain
    domain_index = domain_dir / "README.md"
    task_dir = domain_dir / slug
    root_text = read(root_index)
    domain_target = f"/.agents/tasks/dreamux/{domain}/README.md"

    if domain_dir.exists():
        domain_text = read(domain_index)
        if f"]({domain_target})" not in root_text:
            raise TaskError(f"domain is missing from the root task index: {domain_target}")
    else:
        if not args.create_domain:
            raise TaskError("domain does not exist; confirm it and pass --create-domain")
        summary = validate_line(args.domain_summary or "", "domain summary")
        domain_text = domain_readme(domain, summary, args.code_signal)
        domain_dir.mkdir()
        root_text = add_bullet(
            root_text,
            ("## Child Scopes",),
            domain_target,
            f"- [{domain.replace('-', ' ').title()}]({domain_target}): {summary}",
        )

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
    if domain_index.exists():
        replace(domain_index, domain_text)
    else:
        domain_index.write_text(domain_text, encoding="utf-8")
    replace(root_index, root_text)
    print(f"Created lean task record: {task_dir}")
    return 0


def check(args: argparse.Namespace) -> int:
    domain = validate_segment(args.domain, "domain")
    slug = validate_segment(args.slug, "task slug", action_slug=True)
    root = repo_root(args.repo_root)
    tasks = root / ".agents/tasks/dreamux"
    task_dir = tasks / domain / slug
    root_text = read(tasks / "README.md")
    domain_text = read(tasks / domain / "README.md")
    task_text = read(task_dir / "README.md")
    read(task_dir / "requirement.md")
    expected = {
        f"/.agents/tasks/dreamux/{domain}/README.md": root_text,
        task_link(domain, slug): domain_text,
        task_link(domain, slug, "requirement.md"): task_text,
    }
    for target, text in expected.items():
        if f"]({target})" not in text:
            raise TaskError(f"missing index link: {target}")
    states = re.findall(r"^- State: `([^`]+)`$", task_text, re.MULTILINE)
    if len(states) != 1 or states[0] not in STATES:
        raise TaskError("task README has no supported workflow state")
    print(f"Task record OK: .agents/tasks/dreamux/{domain}/{slug}")
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
