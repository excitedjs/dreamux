# Capability-Domain Task Routing

- **Status:** Accepted
- **Date:** 2026-08-14
- **Affects:** `.agents/tasks`, `.agents/skills/dev-workflow`
- **Related task:** [Remove cron run-now capability](../tasks/mcp/scheduler/remove-cron-run-now/README.md)

## Context

This repository already supplies the Dreamux boundary, so a fixed
`.agents/tasks/dreamux/` layer duplicates context without helping discovery.
Development tasks need capability-oriented routing that can narrow from a broad
surface to its owning subdomain before listing concrete requirement lineages.

## Decision

Root development-task discovery at `.agents/tasks/README.md`. Route every task
through one or more capability-domain segments, with a README index at each level.
Do not add a repository-name segment. For example, scheduler-backed MCP work lives
under `.agents/tasks/mcp/scheduler/<task-slug>/`.

The task initializer accepts slash-separated domain paths, validates the complete
root-to-leaf README chain, and can create an empty domain index explicitly before
the first real task is added below a deeper child.

This supersedes only the fixed `.agents/tasks/dreamux/` routing path in
[Lean Development Task and GitHub Solution Review](lean-development-task-and-github-solution-review.md).
Its lean artifact shape, README authority, and GitHub solution-review decision
remain current.

## Consequences

- README-first discovery remains bounded while supporting nested capability
  ownership.
- Every task move or domain creation must update all parent indexes.
- A broken parent link is rejected by both task creation and task validation.
- The existing lean task-record shape and workflow states remain unchanged.
