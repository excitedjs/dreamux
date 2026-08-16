# Requirement

## Initial request

- Turn the merged native-transcript non-leakage and receipt semantics into enforceable tests, repair stale knowledge/change notes, and fix bounded reader edge cases
- After PR #338 merged, create one follow-up PR for the non-blocking review
  findings.
- Operator instruction: skip requirement consultation and solution review, and
  directly orchestrate development plus review in one workflow.

## Current alignment

- Status: Approved for direct implementation.
- Confirmed current behavior and evidence:
  - The merged solution requires `transcript_path` to appear only on direct
    TeamMate `spawn` / `send` receipts, but no static gate enforces the allowed
    source locations and service tests do not pin every admission status.
  - TeamMate MCP read projections still use open nested object schemas, so the
    behavioral safety currently depends on explicit service projection
    literals rather than schema rejection.
  - `.agents/domains/state-config-and-files.md` lists the deleted
    `agent-entity/turns-store.ts` as a current source and lists
    `team-collection/store.ts` twice.
  - The `@excitedjs/dreamux-types` breaking note does not explicitly name the
    removed `AgentRuntime.getLast()` member.
  - Codex can return one unnecessary continuation cursor after the oldest
    completed turn because native metadata before that turn is treated as
    evidence that an older result may exist.
  - `budgetTranscriptTurns()` marks the page truncated from a later candidate
    even when that candidate is omitted and no returned block was clipped.
  - Tool input/output and message text are bounded, but model-visible tool names
    have no source cap. Budget fallback may shorten a name without a dedicated
    bound being enforced by core.
- Desired outcome: Make the merged native-transcript contract mechanically
  enforceable and remove the bounded-reader edge cases without changing
  ownership, persisted state, or the public query surface.
- Desired behavior:
  - Any new `transcript_path` source projection outside the direct receipt
    surface fails a deterministic architecture gate.
  - Direct spawn/send receipts return the known canonical path for every
    admission status once a session association exists; only a never-established
    association returns null.
  - The oldest Codex result page ends with `next_cursor: null` without requiring
    an extra empty page.
  - `truncated` is true only when content present in the returned page was
    clipped.
  - Tool names use one shared finite character cap, deterministic clipping, and
    core verification.
- Scope:
  - Dreamux architecture/service tests, transcript utility/provider tests, and
    the minimum source changes required by those contracts.
  - The stale current KB source list and the existing Dreamux Types Rush change
    note.
- Non-goals:
  - No new `last` query parameters, search/index feature, cursor format,
    transcript locator, provider, migration, or persisted field.
  - No redesign of the merged entity-owned lifecycle or native transcript
    parsers.
  - No generalized closure of every MCP `OPEN_OBJECT` schema.
- Constraints and invariants:
  - Core remains provider-neutral.
  - `transcript_path` remains absent from list, status, history, `last`,
    Workflow, Team, Channel, completion delivery, logs, metrics, and public
    errors.
  - Existing native transcript pagination remains append-stable, strictly
    backward, and free of duplicate turns.
  - Existing Dreamux `turn.jsonl` residue remains completely no-touch and
    requires no rebuild.
  - The repository publication red line remains zero-match.

## Acceptance criteria

1. A static architecture test fails when `transcript_path` is added to any
   product-source location outside the exact direct-receipt allowlist, including
   an additional occurrence in an otherwise allowed file.
2. Service-level tests prove established-session `spawn` and `send` receipts
   retain the same non-null path for submitted, duplicate, failed, ambiguous,
   and stopped outcomes; a never-established association returns null.
3. Current KB source pointers contain no deleted Turn-store path or duplicate
   Team store entry.
4. The Dreamux Types change note explicitly names removal of
   `AgentRuntime.getLast()` while retaining the existing breaking/no-rebuild
   semantics.
5. Codex pagination returns the oldest completed page with a null continuation
   cursor and no caller-visible empty terminal page, without losing bounded-scan
   continuation.
6. A candidate omitted only because it does not fit after already returned
   turns does not set page `truncated`; clipping any returned block still does.
7. Tool names are capped at 256 Unicode code points by the shared transcript
   utility, contribute to page `truncated` when clipped, and are rejected by
   core when a provider exceeds the cap.
8. Focused provider/core/utility tests, affected typechecks and lint, task/KB
   validation, Rush change verification, `git diff --check`, and repository
   red-line scans pass.

## Decisions and unknowns

- Confirmed operator decisions:
  - Merge PR #338 first, then create a follow-up PR.
  - Skip requirement consultation and technical-solution review.
  - Use one workflow to orchestrate development and review stages together.
- Assumptions:
  - A 256-code-point tool-name cap is well above native tool identifiers while
    providing a deterministic public bound.
  - The existing open nested MCP schemas may remain because static source gates
    plus service-level behavior tests enforce the leakage invariant across the
    full service surface.
- Blocking unknowns: None.
