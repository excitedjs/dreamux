# Direct Hardening Solution

## Ownership

- `packages/dreamux/tests/architecture-ownership-gate.test.ts` owns the
  repository-level `transcript_path` source allowlist.
- `TeammateService` and `TeammateCollection` retain direct receipt projection
  ownership; tests pin nullability to session association.
- `@excitedjs/dreamux-utils` owns all neutral transcript field caps and budget
  semantics. Core verifies the same constants.
- Codex owns its native oldest-page determination.
- The TeamLeader owns `.agents/**`; the developer updates product code, tests,
  and the existing Rush change note only.

## Changes

1. Add an exact source-occurrence gate for `transcript_path`. Allow only the
   direct receipt types, spawn/send projections, and MCP direct-receipt schema /
   projector occurrences already required by the public surface. Fail on any
   additional source occurrence, including one added inside an allowed file.
2. Add service tests covering established and never-established associations
   across all submission statuses. Do not infer path availability from status.
3. Remove the stale Turn-store source pointer and duplicate Team-store pointer
   from the current state/config domain page.
4. Amend the existing Dreamux Types breaking note to name
   `AgentRuntime.getLast()` removal.
5. Make Codex determine whether an older completed turn exists rather than
   treating pre-turn metadata bytes as a result. Preserve bounded continuation
   when scanning stopped before reaching the oldest result.
6. In `budgetTranscriptTurns()`, merge a candidate's intrinsic truncation into
   the page flag only after that candidate is accepted. The first oversized
   returned turn remains clipped and marked.
7. Add `TRANSCRIPT_TOOL_NAME_MAX_CHARS = 256`; clip names in
   `boundTranscriptTurn()`, set page truncation when clipping occurs, and reject
   over-limit provider pages at the core boundary.

## Verification

- Architecture allowlist gate fails on an injected extra occurrence.
- Service receipts cover all admission statuses and both association states.
- Codex reaches a null-cursor final page without an extra empty page.
- Utility tests distinguish omitted-candidate truncation from returned clipping.
- Utility and core tests cover the tool-name cap.
- Run affected package typecheck/lint/tests, Rush change verification, task/KB
  checks, `git diff --check`, and publication red-line scans.

## Non-goals

- No provider contract, persisted-state, cursor-envelope, query-surface, or
  lifecycle redesign.
- No new migration or rebuild instruction.
- No broad MCP schema rewrite.
