# Independent Review — Red-Line Requirement Fidelity (scope-contracted revision)

- **Reviewer seat:** Independent red-line/requirement-fidelity reviewer
  (non-Codex).
- **Role:** Verify the revised requirement and final solution against current
  source and the whole working tree after the scope contraction: built-in cold
  transcript reads and path receipts, fail-open archive/identity removal,
  unnamed external providers on the neutral contract only, and no removed
  provider-specific assumptions hidden in cursor, transcript, or test design.
  Challenge acceptance coverage, compatibility, and contradictions introduced
  by the red line. Findings only; no rewrite of the draft.
- **Inputs verified (SHA-256):**
  - `requirement.md` = `fa63050ce335e36edef3ab2258c93ea439aa401e37f70982cd9e8c4492f47c92` ✅ matches assignment.
  - `technical-design/final.md` = `7b6c5f20652436601372f5e75d1c6dafdbb22ad8927b2dc5f621bfa85b5f35f2` ✅ matches assignment.
- **Evidence surface:** working-tree sources and diffs (99 changed files + new
  untracked transcript modules), change notes, MCP schemas, and both provider
  test suites.

## Relation to the sibling review

[`redline-ownership.md`](redline-ownership.md) already owns the repository-wide
provider-fingerprint scan and its blocker F1
(`.agents/archive/proposals/dynamic-workflow.md:12`). This seat does not
duplicate that finding; it cross-references it and reviews the *requirement
fidelity* consequences of the contraction: whether the frozen requirement and
final solution, as written, can be met by the existing public built-ins and the
unnamed neutral contract, and whether acceptance coverage proves it.

## Verdict

**NOT CLEAN — remediation required before renewed development approval.**

The four contracted focus areas are architecturally coherent in the frozen
artifacts and largely realized in the working tree (see "Confirmed fidelity").
However:

1. the sibling review's **F1** remains an open red-line blocker
   (`redline-ownership.md:24-78`);
2. **R1** (this seat): the cursor envelope spec in `final.md` contradicts the
   cursor the only implementation that satisfies it actually builds — the
   design must authorize or delete the `anchor` field and reconcile the
   requirement's "no transcript content" wording;
3. **R2–R5**: acceptance criteria 25–42 are only partially evidenced by the
   current tree's test design; the review gate must itemize the fixture matrix,
   not accept a green run.

No other blocker-level contradiction was found.

---

## Confirmed fidelity (evidence-backed, no action needed)

### A. Built-in cold transcript reads and path receipts hold

- Both built-ins implement the mandatory `readTranscript`
  (`packages/agent-runtime/codex/src/provider.ts:141`,
  `packages/agent-runtime/claude-code/src/provider.ts:125`), matching
  `requirement.md:403-406` ("not an optional-capability rollout").
- Codex captures `thread.path` from `thread/start` and `thread/resume`
  (`types.ts:57-70`), canonicalizes, root-confines, and session-validates it
  (`transcript/path.ts:53-123`), persists it atomically with the checkpoint
  (`runtime.ts` diff: `validateThreadPath` + `setCheckpoint` before admission),
  and rejects admission when the path is absent
  (`runtime.ts: validateThreadPath` throws `'Codex thread response omitted the
  native transcript path'` on `null | undefined`) — satisfying AC 40.
- Claude Code pins a provider-generated UUID through native `--session-id`
  (`args.ts:152-157`; `runtime.ts:560` `generateSessionId?.() ?? randomUUID`),
  derives the canonical path before admission
  (`transcript/path.ts:25-40`, `runtime-session.ts:29-42`), persists it via
  `setCheckpoint`, and adds no Hook/IPC bridge — satisfying
  `requirement.md:533-540` and AC 40.
- Receipt path is the persisted association, not the current turn:
  `TeammateService.transcriptPath()` returns `this.current().transcript_locator`
  (`teammate-service/index.ts:369-371`), so duplicate/failed/ambiguous/stopped
  turns on an established session keep the path — AC 39. `transcript_path` is
  populated only on spawn/send receipts
  (`teammate-collection/index.ts:127`, `teammate-service/index.ts:189`,
  `teammate-mcp.ts:201-207, 397-404`) — AC 41 boundary confirmed
  (also sibling C3).
- `last` is a cold query: `TeammateCollection.last()` reads identity, resolves
  the provider, and never materializes an entity
  (`teammate-collection/index.ts:222-241`; `liveEntity()` is lookup-only,
  `index.ts:344-351`) or starts a runtime; `readAgentTranscript` performs no
  identity writes (`transcript-reader.ts:39-94`) — AC 28/30.

### B. Archive and rolling-identity removal is complete and fail-open

- `turns-store.ts` deleted (git status `D`); `AgentEntityTurnRecord`,
  `foldLastTurns`, `turnsScopeOf`, `dispatcherAgentTurnsPath`, `AgentTurnsStore`
  references, `AgentRuntime.getLast()`/`AgentRuntimeLastResult`, and the Channel
  `turn.submitted`/`turn.settled` pair have zero hits across
  `packages/**/src` — AC 25, AC 19, deletion list items 18-31.
- Rolling identity fields are gone from create, update, parse, in-memory types,
  history rows, sorting, `since`/`until` (now `updated_at`), and grep
  (`identity-store.ts` diff; `read-helpers.ts:92-93, 138-147`) — AC 26/27.
- The four removed keys are **not** in the fail-loud removed-field gate:
  zero hits in `assertNoRemovedRecordFields`
  (`identity-store.ts`, `legacy-state.ts`) — they are ignored as unknown
  legacy extras, per `requirement.md:562-565`.
- Fail-open residue is exercised in the tree:
  `teammate-service.test.ts:865-876` boots with a *directory* in place of
  `turn.jsonl`; `dispatcher-workspace.test.ts:282-299` boots with a v1 file;
  `architecture-ownership-gate.test.ts:830-861` loads an identity carrying the
  four legacy keys and proves a later rewrite drops them.

### C. Unnamed external providers see only the neutral contract

- The neutral contract (`packages/dreamux-types/src/agent-runtime.ts`) contains
  no provider names, no built-in-specific fields, and makes `readTranscript`
  required; the external loader enforces it
  (`packages/dreamux/src/agent-runtime/external-provider.ts:106-107`). External
  fixtures are unnamed neutral fakes (sibling C2). Six change notes are
  fingerprint-free and declare the contract break as `BREAKING:` + `Review:`
  with no rebuild (sibling C1).

### D. Cursor/transcript/test design contains no removed-provider assumptions

- Cursor envelopes mark only the public built-ins (`p: 'codex'`,
  `p: 'claude'`), the fingerprint covers `include_tools` only (so `turns`
  changes do not invalidate — AC 32's query-mismatch half), positions are
  numeric (segment+offset / byte offset), and generations digest lineage or
  rewrite facts — matching `final.md:708-731` except for R1 below.
- No named out-of-repository provider appears in any new test; the only
  external model-name strings are pre-existing
  `--model [redacted external provider fingerprint]` `extra_args` fixtures for
  the public built-in Codex provider (`global-config.test.ts`; not added by
  this diff) — sibling C1 already adjudicates these as legitimate.

---

## Findings (severity-ordered)

### R1 — BLOCKER (this seat): `final.md`'s cursor spec contradicts the cursor the implementation builds; requirement wording forbids a field the implementation embeds

- **Evidence (design):** `final.md:708-731` states a provider cursor
  "is versioned base64url data containing: a fingerprint …, a
  logical-history generation digest, a representation-independent storage
  position …" and that it "contains no path, content, secret, or native
  turn/message/call ID, including hashed native IDs used as positions."
  `requirement.md:452-455` bans "transcript content" in cursors outright.
- **Evidence (implementation):** both built-in cursors carry a fourth,
  unspecified field `anchor` — a one-way digest of the raw boundary record:
  - Codex: `codex/src/transcript/cursor.ts:10-17, 23-37` (`anchor` in the
    envelope) and `reader.ts:125` (`nextAnchor = digest(cursorTarget.native
    .startLine)`); the boundary record is a `task_started`/`turn_started`
    event, i.e. native metadata.
  - Claude: `claude-code/src/transcript/cursor.ts:5-13, 21-38` (`anchor`) and
    `reader.ts:105` (`boundaryAnchor: digest(boundary.startLine)`); the
    boundary record is the first entry of the consumed turn — the `user`
    prompt record, whose raw JSON contains the user's message text.
- **Why this is a fidelity contradiction, not an implementation nit:** the
  anchor implements a *required* behavior — `requirement.md:455-459` ("Native
  rewrite, revert, logical compaction/snip, or lineage replacement may
  invalidate it … rather than silently duplicating or skipping results") — but
  the authoritative design (`final.md`) neither documents nor authorizes it,
  the requirement's literal ban ("no transcript content") can be read to
  forbid it, and the verification plan has no test for it (`final.md`
  verification item 13 lists append stability, query mismatch, staleness,
  malformed cursor — never the anchor).
- **Failure scenario:** the implementation reviewer measures the code against
  `final.md:708-731` and rejects the envelope as off-spec; or an operator reads
  `requirement.md:452-455` literally and rejects a cursor whose `anchor` is a
  digest of a record containing user text (one-way, but content-derived). Both
  halt the gate on wording, not on a real leak.
- **Remediation (either is acceptable, pick one explicitly):**
  1. Amend `final.md`'s cursor section to document the `anchor`: purpose
     (boundary-stability check for same-generation in-place rewrites),
     derivation (SHA-256 of the boundary record's raw bytes), and why a
     one-way digest is not "content" — and reconcile
     `requirement.md:452-455` to ban *recoverable* content/paths/IDs; add
     anchor-mismatch staleness fixtures to verification item 13.
  2. Delete the `anchor` from both providers and rely on the generation digest
     alone — then explicitly accept that same-size in-place content edits
     (which change no rewrite fact) may silently shift page boundaries, or
     extend the generation digest to cover the scanned suffix. This is a
     deliberate AC 32 tradeoff that must be recorded, not left implicit.

### R2 — MEDIUM: built-in transcript test coverage is far below the frozen acceptance matrix; the gate must itemize it

- AC 29 and `final.md` verification items 14-15 require, per built-in,
  deterministic tests covering fresh start, resume/reopen, process restart,
  multiple turns, provider-private field stripping, missing/corrupt errors, and
  (Codex) active/archived, revert selection, `history_base` lineage, `.jsonl`,
  `.jsonl.zst`, both `task_`/`turn_` wire aliases; (Claude) path resolution,
  parent chain, parallel tool branches, compact/snip, sidechain/meta
  exclusion, tool-result pairing, open tails, cursor staleness.
- **Evidence:** the working tree contains 3 Codex tests
  (`codex/tests/transcript.test.ts`: pagination+tool pairing+
  `cursor_query_mismatch`; locator escape + `session_mismatch`; pre-append
  thread-path acceptance) and 2 Claude tests
  (`claude-code/tests/transcript.test.ts`: main chain + tool pairing + open
  tail; fresh pinned path). Untested today: `.zst` reads and `scan_unsupported`,
  `history_base` lineage, revert selection, wire aliases, corrupt/missing
  transcript errors, `cursor_stale`, append-stability proofs (AC 32),
  scan-bound continuation (AC 38), compact/snip and sidechain/meta fixtures,
  parallel tool branches, cross-project rediscovery.
- **Failure scenario:** implementation review runs the suite green and signs
  off AC 29/32/36/38 on three+two tests; the first archive-moved or
  compressed-rollout customer hits an untested branch. Per the repo's own
  rule (root `CLAUDE.md`), the review gate must check the fixture matrix
  against the source contract, not trust a green run.

### R3 — MEDIUM: `AgentRuntimeTranscriptError.publicMessage` is contract dead weight; the "clear provider-owned error" acceptance is unproven end-to-end

- The neutral type declares `publicMessage: string`
  (`packages/dreamux-types/src/agent-runtime.ts`, transcript error block), but
  no consumer exists anywhere in core (`grep` across `dreamux/src` and
  `dreamux-utils/src` returns zero). MCP `last` propagates errors generically.
- AC 30/36 and `requirement.md:470-471` ("fail with a clear provider-owned
  error") therefore have no demonstrated public surface. Either project
  `publicMessage` at the MCP boundary (path-free, per AC 41) or delete the
  field from the contract; as written, the acceptance claim cannot be
  verified.

### R4 — LOW: AC 38 continuation has a zero-progress edge in the Codex reader

- `codex/src/transcript/reader.ts:258-264`: when a scanned window contains
  zero complete turns with an incomplete boundary, the resume position is the
  window's own `startOffset`, so reusing `next_cursor` re-reads the identical
  window and returns the same empty page and cursor. This is bounded per call
  (8 MiB / 2 s — no service monopoly) and is the correct "retry after the open
  tail completes" behavior for in-progress tails, but for a *completed* turn
  larger than one scan window it never progresses.
- **Remediation:** state the contract explicitly (repeat-cursor means
  "tail not yet complete; retry later"), or advance the resume position for
  the completed-giant-turn case; add a fixture for both.

### R5 — LOW: requirement-internal wording drift on Claude session pinning

- `requirement.md:893-896` ("Confirmed operator decisions") says Claude
  "persists the path it resolves from its native session storage after
  receiving stream-json `session_id`", while `requirement.md:533-540` and
  `final.md:102-103, 762-767` (and the working tree) pin a pre-generated UUID
  through `--session-id` before admission. The decisions section is the
  normative one; it should be aligned to the pinned-UUID wording to avoid
  re-litigating the Hook/IPC question at review time.

### R6 — LOW: bookkeeping and compatibility declarations

- `README.md:8` still reads "Current solution input revision: Pending a new
  hash after the repository publication boundary is reconciled" while the
  frozen requirement hash `fa63050…` is now pinned by `final.md:8`. The README
  blocker list and review trail need updating when this gate concludes (this
  seat may not edit it).
- `AgentRuntimeIdentity.checkpoint_id` is renamed to
  `checkpoint: AgentRuntimeResumeCheckpoint | null`
  (`packages/dreamux-types/src/agent-runtime.ts` diff) — a breaking TypeScript
  rename for external providers. The `dreamux-types` change note declares the
  contract break broadly but does not name the rename; add it to the
  `Review:` text.

---

## Acceptance-coverage map (this seat's four focus areas)

| AC | Focus | Status in frozen artifacts | Status in working tree |
| --- | --- | --- | --- |
| 25 | no `turn.jsonl` create/read/validate/preflight; inert residue | stated (`final.md:527-556`) | ✅ complete; 2 residue tests |
| 26 | four rolling keys removed; legacy tolerated | stated (`final.md:552-556`) | ✅ complete; ownership-gate test |
| 27 | history = identity/`updated_at` query | stated (`final.md:558-563`) | ✅ complete (`read-helpers.ts`) |
| 28, 30 | cold `last`; error isolation | stated (`final.md:668-681`) | ✅ complete (R3: error surface unproven) |
| 29 | per-built-in deterministic matrix | planned (`final.md` verif. 14-15) | ⚠️ partial — see R2 |
| 31, 33 | `last(name, turns?)`, 1..50, no grep/since/until | stated | ✅ complete (`teammate-mcp.ts:146-155`) |
| 32 | append-stable pagination, no duplicates | stated (`final.md:723-726`) | ⚠️ untested; R1 anchor unspecced |
| 35 | fixed 262144 budget | stated (`final.md:696-701`) | ✅ complete (`transcript-reader.ts:21, 118-131`; util enforces) |
| 36 | cursor errors, no state write | stated | ⚠️ decode paths tested once; `cursor_stale` untested; R3 |
| 37 | locator confinement + session match | stated (`final.md:590-600`) | ✅ complete + 2 tests |
| 38 | bounded scan + continuation | stated (`final.md:728-737`) | ⚠️ untested; R4 edge |
| 39, 40 | receipt path always present; pre-admission pinning | stated | ✅ complete (A above) |
| 41 | path confined to spawn/send receipts | stated | ✅ complete (sibling C3) |
| 42 | repository-wide/full-diff red-line scan | stated | ❌ blocked — sibling F1 |

## Scope compliance

Only this file was written. No product code, requirement, final solution,
GitHub state, or other file was modified.

---

# Post-Adjudication Review (appended after TeamLeader adjudication)

- **Redaction applied:** the only exact external model-name fingerprint quoted
  in this file was replaced with `[redacted external provider fingerprint]`;
  the evidence location (`global-config.test.ts`) and the reasoning are
  preserved. The file now passes the same fingerprint scan used by the red-line
  gate.
- **Revised inputs re-read and verified (SHA-256):**
  - `requirement.md` = `9c42231fba5323c8f8bfb845927961e8cbe660f2676ce58cbbcbba6d642c0a2d`
  - `technical-design/final.md` = `d0d98b487d4035496d41e2332b6969efd28054576190efec6bc9bbd37e011d3e`

## Adjudication verification (spec-blocker disposition per finding)

| Finding | Disposition | Evidence in revised artifacts |
| --- | --- | --- |
| R1 — cursor boundary digest unauthorized | **RESOLVED** | `requirement.md:451-457` authorizes "one-way boundary-integrity digests", defines them as "SHA-256 over the exact native boundary record bytes", "exists only to detect in-place rewrites", "cannot be used as a storage position or recover the record", and bans only *recoverable* content. `final.md:730-747` mirrors this ("never a storage position and cannot recover the record"). AC 32 (`requirement.md:817-821`) adds "A boundary-record digest mismatch returns `cursor_stale`"; `final.md` verification item 13 adds "boundary-digest mismatch". The implementation's `anchor` is now in-spec. |
| R2 — fixture matrix under-evidenced | **ACCEPTED AS GATE** | Adjudicated as a mandatory implementation acceptance matrix; no spec edit required. `final.md` verification items 13-15 and AC 29 remain the frozen matrix; the implementation review must itemize every fixture (including the newly added digest-mismatch, strictly-advancing continuation, and oversized-turn cases) rather than accept a green run. |
| R3 — `publicMessage` dead weight / error surface | **RESOLVED** | `final.md:646-659` drops `publicMessage` and keeps typed `reason` only; `final.md:683-688` and `final.md:997-998` require core to map each recognized `name + reason` to one fixed, bounded, path-free admin/MCP message, with unknown/malformed provider exceptions using the generic internal error. `requirement.md:471-477` and AC 36 (`requirement.md:831-834`) state the same contract ("provider-supplied arbitrary public text is not part of the contract"). Verification item 19 (`final.md:1275-1277`) pins it. |
| R4 — zero-progress continuation edge | **RESOLVED** | AC 38 (`requirement.md:838-844`): "A non-null continuation must strictly advance to an older numeric position; if the native representation cannot make safe progress within the bound, the provider returns `scan_unsupported` rather than repeating the same empty page and cursor." AC 32 repeats the strictly-advancing rule. `final.md:754-760` adds the same requirement plus the open-tail allowance (see residual note 2 below). |
| R5 — decisions-section wording drift | **RESOLVED** | `requirement.md:907-910` now reads "Claude pre-generates a UUID, passes it through native `--session-id`, derives and persists the corresponding native path before admission, and later confirms the same session through stream-json init; no Hook IPC bridge is added" — consistent with `requirement.md:541-546` and `final.md:791-796`. |
| R6 — change-note/README bookkeeping | **RESOLVED (spec part)** | `final.md:1090-1091` now requires the `dreamux-types` `Review:` note to name the `checkpoint_id` → typed `checkpoint` contract change explicitly. README/hash updates are deferred post-review per the adjudication (see residual note 1). |

## New-blocker assessment

**No new blocker is introduced by the revisions.** The R1/R3/R4/R5/R6 edits are
internally consistent: requirement and final solution now agree on the cursor
envelope, the error surface, the continuation contract, and the Claude session
pinning. The five specification blockers raised by this seat are resolved.

Residual non-blocking items to record before implementation approval:

1. **Hash/README re-pin (bookkeeping):** `final.md:8` still pins the superseded
   requirement hash `fa63050…` while `requirement.md` now hashes to
   `9c42231f…`; `README.md:8` still says "Pending a new hash". Both must be
   updated when this revision is re-frozen — expected per the R6 adjudication,
   not a spec defect.
2. **Open-tail wording tension (LOW):** `final.md:756-757` permits a
   continuation that "explicitly represent[s] an open tail that may become
   complete later", while AC 32/38 mandate that *every* non-null continuation
   strictly advance. The stricter requirement reading is trivially satisfiable
   (return `next_cursor: null` when zero complete turns fall in the window; a
   fresh uncursored query later returns the completed turn), so this cannot
   block, but the two texts should be reconciled to avoid implementation-review
   friction — either name the open-tail exception in AC 38 or drop the
   allowance from `final.md`.
3. **Implementation deltas now pinned by the spec (expected; no product edits
   are authorized yet):** the working tree predates this adjudication, so the
   neutral type still carries `publicMessage` with no core reason-to-message
   projection, and the Codex reader's zero-progress resume path
   (`codex/src/transcript/reader.ts:258-264`) must now distinguish open-tail
   (null continuation or explicit marker) from completed-oversize
   (`scan_unsupported`). Verification items 13 and 19 make both cases
   testable gates, so the implementation cannot ship without them.
4. **Sibling blocker unchanged:** the repository-wide fingerprint finding
   (sibling `redline-ownership.md` F1) is outside this seat and is not affected
   by these adjudications; it remains the standing red-line blocker for
   renewed development approval.

## Post-adjudication verdict

This seat's specification blockers (R1, R3, R4, R5, R6) are **resolved** by the
revised artifacts, and the R2 matrix is now a mandatory implementation gate.
No new blocker arises from the revisions. The overall gate is still not CLEAN
pending (a) the sibling review's repository-wide fingerprint blocker and
(b) itemized evidence for the R2/verification-13/19 matrix at implementation
review.

---

# Final Gate Update

- **Current revisions re-read:** `requirement.md` = `7aa44f42f42cf8f6e99788df662097e1824b0c1119875d49357a336388028906123`,
  `final.md` = `0e272407c6414db08bc52eddeb4365b4366c2530eac1c20910481ea78f6882de`,
  sibling review = `217479df3804228d87ed1446439042a45f705a3a865cd51d991d5f4f0a580b6b`.

## Open-tail tension — RESOLVED

- AC 32 (`requirement.md:822-825`): when the newest bounded window contains
  only an open native tail and no complete turn, the response returns
  `next_cursor: null`; a later fresh uncursored query observes the turn after
  the provider finishes appending it.
- AC 38 (`requirement.md:847-849`): an open tail with no complete turn returns
  a null cursor and is retried only through a later fresh query.
- `final.md:756-761` matches: "Every continuation cursor must advance to an
  older numeric position. If a bounded newest window contains only an open tail
  and no complete turn, the provider returns `nextCursor: null`… A completed
  turn larger than one scan window … returns `scan_unsupported` when safe
  progress is impossible."
- The earlier non-advancing open-tail marker allowance is gone from both
  artifacts; requirement and final now agree word-for-word in substance. My
  residual note 2 is closed.

## Sibling repository-wide fingerprint blocker — CLEARED

- The source archive line was neutralized (working tree shows the file
  modified), and the sibling review artifact was sanitized and carries a
  post-fix verification with the blocker marked CLEARED. An independent scan of
  the adjudicated token family over the working tree returns no provider-name
  hit.

## Independent re-scan caveat (same class as the cleared finding)

One other tracked, unmodified archive document still contains pre-existing
named out-of-repository provider references:
`.agents/archive/proposals/agent-runtime-lifecycle-contracts.md:12,28,77,124,380,463`
— it names three external runtime CLIs, including version-snapshot identifiers,
in consultation-history prose. Per AC 42 as reworded (`requirement.md:861-867`,
"every tracked or untracked repository artifact"), the repository-wide
predicate remains unmet until that file receives the same neutralization as the
cleared one, or the operator records a scoping decision for pre-existing
archive consultation history. This is the identical one-line-class fix already
applied for the cleared finding, not a specification defect. (Provider names
are deliberately not reproduced here.)

## Verdict — overall solution-spec gate

**CLEAN (spec content).** All of this seat's findings are resolved: R1, R3,
R4, R5, R6 are incorporated in the current requirement/final; the open-tail
tension is closed; the adjudicated repository-wide fingerprint blocker is
cleared. Two non-blocking bookkeeping items remain: (1) re-pin
`final.md:8`/`README.md` to the current requirement revision `7aa44f42…` when
it is re-frozen (both currently pin the prior revision), and (2) apply the same
archive neutralization to the one remaining file noted above or record the
scope decision. R2 plus verification items 13-19 remain a **mandatory
implementation gate** at implementation review — required evidence, not a
solution blocker.

---

# Scope Correction (operator red-line clarification)

- **Current revisions re-read:** `requirement.md` = `e44f6411914cd1ff5ea49c55f09bbae17ad162f62335123f43d89ea0405208d0`,
  `final.md` = `17a8a54af9b13eb99c5db2bb2cbf310f3ab48cc2e98773ecd5d3b84b41527cd4`.
- The operator's actual red line prohibits exposure of **one specified
  external provider family**; it does not ban unrelated external provider
  names or historical generic provider examples. The current artifacts record
  this precisely:
  - `requirement.md:118-122` — only the operator-prohibited family must not be
    named/registered/packaged/documented/tested; "Other external providers
    remain governed by the neutral plugin contract; this task neither adds nor
    removes their unrelated historical documentation."
  - `requirement.md:680-681`, `requirement.md:925-926` — same family scope.
  - AC 42 (`requirement.md:860-871`) — scans target the prohibited family
    only; "The scan token set is supplied outside repository artifacts so the
    red line does not reproduce the prohibited name"; immutable
    already-public pre-task history is outside the gate.
  - `final.md:110, 148, 1074, 1157, 1185, 1275-1278` — matching family-scoped
    gates and verification item 17.
- **Retraction:** my earlier "Independent re-scan caveat" is superseded.
  `.agents/archive/proposals/agent-runtime-lifecycle-contracts.md` names three
  unrelated external runtime CLIs in historical consultation prose; under the
  clarified red line this is **not a violation and requires no scrub**. The
  caveat's evidence locations remain as recorded, but its
  scrub-recommendation is withdrawn.
- **Verdict: the solution-spec gate remains CLEAN.** All of this seat's
  findings are resolved (R1, R3, R4, R5, R6; open-tail null-cursor rule; the
  prohibited-family blocker cleared), and no new spec issue arises from the
  scope clarification. R2 plus verification items 13-19 stay deferred as a
  **mandatory implementation gate** at implementation review — required
  evidence, not a solution blocker.
- Non-blocking bookkeeping: `final.md:8` and `README.md` still pin the earlier
  requirement revision `9c42231f…`; re-pin to `e44f6411…` when the requirement
  is re-frozen. No prohibited family token or branch/worktree label is
  reproduced in this file (scan-verified).
