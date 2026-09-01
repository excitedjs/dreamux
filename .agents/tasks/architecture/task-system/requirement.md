# Backfilled decision records: task system records

> Backfilled 2026-09-01 from the dissolved `.agents/decisions/` tree on
> operator instruction: task records are the single derivation layer. Each
> section preserves one record verbatim (original heading, status, and date;
> headings demoted one level for nesting). Later reality is recorded only in
> dated "Since this was recorded" subsections; historical text is never edited.

## capability-domain-task-routing

## Capability-Domain Task Routing

- **Status:** Accepted
- **Date:** 2026-08-14
- **Affects:** `.agents/tasks`, `.agents/skills/dev-workflow`
- **Related task:** [Remove cron run-now capability](/.agents/tasks/mcp/scheduler/remove-cron-run-now/README.md)

### Context

This repository already supplies the Dreamux boundary, so a fixed
`.agents/tasks/dreamux/` layer duplicates context without helping discovery.
Development tasks need capability-oriented routing that can narrow from a broad
surface to its owning subdomain before listing concrete requirement lineages.

### Decision

Root development-task discovery at `.agents/tasks/README.md`. Route every task
through one or more capability-domain segments, with a README index at each level.
Do not add a repository-name segment. For example, scheduler-backed MCP work lives
under `.agents/tasks/mcp/scheduler/<task-slug>/`.

The task initializer accepts slash-separated domain paths, validates the complete
root-to-leaf README chain, and can create an empty domain index explicitly before
the first real task is added below a deeper child.

This supersedes only the fixed `.agents/tasks/dreamux/` routing path in
[Lean Development Task and GitHub Solution Review](/.agents/tasks/architecture/task-system/requirement.md#lean-development-task-and-github-solution-review).
Its lean artifact shape, README authority, and GitHub solution-review decision
remain current.

### Consequences

- README-first discovery remains bounded while supporting nested capability
  ownership.
- Every task move or domain creation must update all parent indexes.
- A broken parent link is rejected by both task creation and task validation.
- The existing lean task-record shape and workflow states remain unchanged.

---

## lean-development-task-and-github-solution-review

## Lean Development Task and GitHub Solution Review

- **Status:** Accepted; task-routing path superseded by
  [Capability-domain task routing](/.agents/tasks/architecture/task-system/requirement.md#capability-domain-task-routing)
- **Date:** 2026-08-13
- **Affects:** `.agents/tasks/dreamux`, `.agents/skills/dev-workflow`
- **PR / Issue:** [PR #332](https://github.com/excitedjs/dreamux/pull/332)

### Context

Repository development needs a durable requirement lineage, a bounded current-state
record, reviewed technical solutions, and enough delivery evidence for another
TeamLeader to resume. The public repository must not depend on private collaboration
documents or repository-specific deployment infrastructure.

### Decision

Keep one lean local task directory per requirement lineage. Its README is the sole
current-state authority; `requirement.md`, `technical-design/final.md`, and
`verification.md` own their detailed artifacts. Initialize only the README and
requirement, then create later artifacts when their stages begin.

For every reviewed non-fast-path solution, create or update one public GitHub Issue
as the operator review surface. The local final solution remains authoritative;
the Issue mirrors it for review and links back to the task without becoming a
parallel state record.

### Consequences

- Task discovery stays bounded through hierarchical README indexes.
- Requirements and final solutions survive conversation compression without
  making GitHub comments the task database.
- Operator solution review uses the repository's public collaboration surface.
- Every task and Issue update must omit private transport metadata, internal URLs,
  private source identifiers, and other non-public context.

### Alternatives Considered

- **Use chat history as the task record:** rejected because it is not a stable,
  repository-visible handoff surface.
- **Use only a GitHub Issue for all task state and artifacts:** rejected because it
  collapses task lineage, requirement, solution, and verification ownership into
  one mutable body.
- **Use a separate private solution document:** rejected because the public GitHub
  Issue already provides the required operator review surface.
