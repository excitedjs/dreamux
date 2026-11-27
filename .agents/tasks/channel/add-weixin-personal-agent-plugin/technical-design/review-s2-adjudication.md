# Slice 2 review adjudication — `team.last`

Status: adjudicated by the TeamLeader on 2026-11-25; corrections are not
applied until the operator rules on them by card. Target reviewed: the
uncommitted slice 2 change (six files under `packages/dreamux/src/service/team/`,
four test files, three knowledge pages) against `requirement.md` behavior 8
and criterion 8 and `final.md` Section 2.

Reviews, as delivered:

- [review-s2-complexity.md](review-s2-complexity.md) — gpt-sol, complexity
  adversary: 25 items (delete 4, fold 11, move 1, keep 9). Source inspection and
  an ESLint line count; tests not run.
- [review-s2-glm.md](review-s2-glm.md) — glm, correctness: 0 blocking, 4
  should-fix, 4 nit. Ran the five related test files (106 passed) and the
  package linters on the changed files. It reports one slip: a first
  `npx vitest` from the worktree root pulled a vitest version into the npx
  cache outside the repository; the working tree was unchanged.
- [review-s2-kimi.md](review-s2-kimi.md) — kimi, correctness: one finding,
  the closed-record selection below.

Coverage limits common to all three: no real runtime was exercised (the
provider boundary is stubbed), the live Codex model cases were not run, and
no review observed that a held leader's read uses the launch's provider and
config rather than the current configuration.

The three reviews agree on every finding they share. No review found a
defect in the tool's normal path: a held leader read mid-turn, paging,
`include_tools`, failure mapping, the output schema, and the fence were each
verified correct.

## Dispositions

"Card" marks a correction that waits for the operator's ruling; "record" is a
task-record correction, which needs no ruling.

| # | Finding (source) | Disposition | Evidence and reason | Ruling |
| --- | --- | --- | --- | --- |
| 1 | The Team-specific activity target, its projection in `leader.ts`, and the forwarding accessor are a rearrangement to satisfy the 700-code-line cap, and make `list` and `history` compute a status and a launch to read one field (complexity 1, 10, 14) | Accept | `service/CLAUDE.md` and the cap rule's own text (`packages/eslint-config/index.js`, `max-lines`) forbid exiling a small helper to pass the gate; `leaderState` now calls `leaderActivityTarget().status.status`, which runs `status()` and `runningLaunch()` per row. Replacement: `TeamService` exposes a read-only view of the leader it holds (`Pick<AgentService, 'current' \| 'runningLaunch' \| 'status'>`), which fits under the cap; the target type, the projection, and the repeated comments go. | Card A |
| 2 | `status`, `runtime_status`, `last_error` duplicate `team.status` (complexity 2) | Accept, operator's decision | They are in the confirmed solution, so removing them changes an approved contract. Nothing in behavior 8 or criterion 8 names them. | Card B |
| 2b | The same three fields on the `teammate` `last` tool (operator's addition to item 2) | Accept, ruled | The operator's words: “TeamMate 工具面上也做同样的删除，如果那边也有同样问题的话”. Checked: `agent/mcp.ts`'s `last` returns `status`, `runtime_status`, and `last_error`, which the `status` tool on the same server already returns; the removal applies to the MCP tool only, and `teammate.last` as a Command keeps its full value. | Ruled 2026-11-25 |
| 3 | A closed record that is still held during teardown is read through the live leader (complexity 3, glm 6, kimi) | Accept | `lastResult` selects by `live` alone; `evict` runs only after `service.closed` settles, and the `closed` write precedes child destruction. The confirmed solution says a closed Team answers from its record. Fix: consult the held leader only for a record that is not closed. | Card A |
| 4 | `coldLeader` is a trampoline that exists only to build the target (complexity 4) | Accept | Folded into item 1: one read picks the held leader's view or `leaderIdentity(record)`. | Card A |
| 5 | The absent-session classification belongs in the Activity reader (complexity 5) | Accept | Team code constructs `agent/activity.ts`'s internal error with its private reason string. Letting `readAgentActivity` take a nullable identity removes that; the reader's one early check then covers both cases. The state is reachable: a record is published before its leader identity exists, and an abandoned creation can leave a closed record with none. This touches `agent/activity.ts`, outside the approved file list. | Card A |
| 6 | The tool copies the port result field by field (complexity 6) | Accept | `TeamLastResult` already has exactly the published fields and `McpToolSuccess.structured` is `unknown`. Return the port's result. | Card C |
| 7 | Share the three activity input properties with `teammate` `last` (complexity 7) | Reject | It edits `agent/mcp.ts` and `agent/requests.ts`, outside this slice's boundary, to remove a duplication of three literals; duplication is not entropy. Revisit with a third consumer. | None |
| 8 | The cursor `maxLength: 4096` has no producer or failure behind it (complexity 8) | Accept | Copied from the `teammate` descriptor; the shared reader publishes and accepts tokens without that bound, so a longer provider token would be refused only here. Remove it from the new tool. | Card C |
| 9 | A Team still being created is read from its record (complexity 9, glm 4) | Keep; record corrected | No review found a caller that reaches the window through the create receipt. `team.list` can expose the name earlier, and in that window the read also loses the launch context, not only status fields; the record now says so. | Record |
| 10 | Inferred return type of the accessor (complexity 10) | Moot | The accessor is replaced by item 1's read view, which states its type. | — |
| 11 | One fenced `TeamsPort.last` (complexity 11) | Keep | Criterion 8 requires an addressed read; the fence has a named scenario. | None |
| 12 | The port's optional query defaults to tool records, the tool's to none (complexity 12, glm 5) | Accept | `validateIncludeTools(undefined)` is `true`; the tool passes `false`. Make the query required on the port. | Card C |
| 13 | Result fields and output schema (complexity 13) | Keep, except item 2 | `records`, `next_cursor`, `truncated`, `transcript_path`, `team_status`, `leader_name` each carry something the others do not. | Card B |
| 14 | Repeated JSDoc (complexity 14) | Accept | One note stays, beside the two reads it explains. | Card A |
| 15 | Tool description repetition (complexity 15) | Accept, in part | Trimmed with item 6's edit. | Card C |
| 16 | The live test's second call changes the filter while paging, the page is static, and nothing asserts the active turn is untouched (complexity 16) | Accept, in part | Two pages keyed by cursor with one filter, a completed and a current message, and the active submission still pending are added. Running the case through the Dispatcher runtime's MCP lease is rejected: the sibling tests call the delegate directly, and the lease path has its own coverage. | Card D |
| 17 | The "builds nothing" test is not cold and proves less than it says (complexity 17, glm 1) | Accept | `host.start()` calls `teams.recover()`, which rebuilds every non-closed Team; the test then asserts only a runtime count, which a rebuilt `TeamService` does not change. Read before `start()`, assert `TeamService.rebuild` is not called, and answer with a non-empty page. | Card D |
| 18 | The closed case carries an unrelated `history` assertion and waits past the interval of item 3 (complexity 18) | Accept, in part | The `history` assertion goes; the closed-but-held interval gets its own case. | Card D |
| 19 | The no-session case (complexity 19) | Keep, extended | A held leader with no session stays; a record with no leader identity is added (glm 3). | Card D |
| 20 | Duplicate missing-Team assertions and `ghost` with a bad limit (complexity 20) | Accept | One outcome each. | Card D |
| 21 | The fence test creates a Team it does not need (complexity 21) | Accept, in part | The Team goes; the host's own `close()` stays, since it is the real owner of the fence. | Card D |
| 22 | The harness override and the poisoned sweep (complexity 22, 24) | Keep | They route the new tool through the same failure sweep as every tool. | None |
| 23 | The sweep's shared `last` arguments carry both servers' keys (complexity 23) | Accept | Give each server its own `last` arguments. | Card D |
| 24 | The harness key `readTeamLeaderActivity` names no Command (glm 7) | Accept | Renamed `lastTeamLeader`, after the port method. | Card C |
| 25 | Shared parser, tool default, reader, and error mapping (complexity 25) | Keep | These are the mechanisms behavior 8 is paid by. | None |
| 26 | `check.mjs` exits 1 while the record says it passed (glm 2) | Accept; fixed | The cause was the task README's state line, corrected; `verification.md` records the real output. | Record |
| 27 | The record overstates the deviation for a Team being created (glm 4) | Accept | Same as item 9. | Record |
| 28 | The final solution's file table omits a type (glm 8) | Accept | Rewritten with item 1. | Record |

Rejected without a ruling: items 7 and the lease part of 16. Nothing was
started before ratification; the working tree still holds the implementation
as reviewed.

## Rulings so far

- Card B (result fields), 2026-11-25: remove the three fields; the operator added the
  `teammate` `last` tool (item 2b).
- Card A (code shape), 2026-11-25: approved as proposed. Items 1, 3, 4, 5, and 14 are
  applied: `TeamService.leaderForRead()` is the read-only view of the held
  leader; a closed record is read from its identity; `readAgentActivity` takes
  a nullable identity.
- Cards A and B applied on 2026-11-25. The package's lint and test type-check
  pass, and the eight related test files pass (145 tests); the four repository
  gates are re-run after the remaining cards.
- Card C (port and tool contract), 2026-11-25: approved as proposed; items 6, 8, 12, 15, and 24 are applied.
- Card D (tests), 2026-11-25: approved as proposed; items 16 to 21 and 23 are applied: `team-last.test.ts` has seven cases, and the failure sweep gives each server its own `last` arguments.
- No accepted finding is left unapplied.

## Cards

- **Card A — code shape** (items 1, 3, 4, 5, 14): a read-only view of the held
  leader; consult it only for a record that is not closed; one read; the
  Activity reader takes a nullable identity, which edits
  `packages/dreamux/src/service/agent/activity.ts` and one test there.
- **Card B — result fields** (items 2, 13): keep or remove the leader status
  trio.
- **Card C — port and tool contract** (items 6, 8, 12, 15, 24).
- **Card D — tests** (items 16 to 21, 23).
