# Lean Development Task and GitHub Solution Review

- **Status:** Accepted
- **Date:** 2026-08-13
- **Affects:** `.agents/tasks/dreamux`, `.agents/skills/dev-workflow`
- **PR / Issue:** [PR #332](https://github.com/excitedjs/dreamux/pull/332)

## Context

Repository development needs a durable requirement lineage, a bounded current-state
record, reviewed technical solutions, and enough delivery evidence for another
TeamLeader to resume. The public repository must not depend on private collaboration
documents or repository-specific deployment infrastructure.

## Decision

Keep one lean local task directory per requirement lineage. Its README is the sole
current-state authority; `requirement.md`, `technical-design/final.md`, and
`verification.md` own their detailed artifacts. Initialize only the README and
requirement, then create later artifacts when their stages begin.

For every reviewed non-fast-path solution, create or update one public GitHub Issue
as the operator review surface. The local final solution remains authoritative; the
Issue mirrors it for review and links back to the task without becoming a parallel
state record. For an undisclosed vulnerability or other operator-marked embargoed
task, keep restricted evidence and remediation details in a GitHub Security Advisory
or another approved private review surface until the operator explicitly clears a
sanitized public boundary; the local task remains the current-state authority.

## Consequences

- Task discovery stays bounded through hierarchical README indexes.
- Requirements and final solutions survive conversation compression without
  making GitHub comments the task database.
- Operator solution review uses the repository's public collaboration surface.
- Embargoed security details never enter a public task, Issue, branch, commit, or PR
  before explicit disclosure clearance.
- Every task and Issue update must omit private transport metadata, internal URLs,
  private source identifiers, and other non-public context.

## Alternatives Considered

- **Use chat history as the task record:** rejected because it is not a stable,
  repository-visible handoff surface.
- **Use only a GitHub Issue for all task state and artifacts:** rejected because it
  collapses task lineage, requirement, solution, and verification ownership into
  one mutable body.
- **Use a separate private solution document by default:** rejected because the
  public GitHub Issue already provides the ordinary operator review surface. An
  access-controlled private surface remains mandatory while a security embargo is
  active.
