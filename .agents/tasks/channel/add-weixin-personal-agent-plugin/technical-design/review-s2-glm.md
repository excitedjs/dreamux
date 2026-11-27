# Slice 2 review — `team.last` (correctness)

Reviewed on 2026-11-25 against the uncommitted working tree: the six files
under `packages/dreamux/src/service/team/`, the four test files, the three
knowledge pages, `requirement.md` (behavior 8, criterion 8) and
`technical-design/final.md` Section 2. Read-only; nothing was modified.

## Findings, most important first

### 1. should-fix — the "builds nothing" test passes for a non-compliant implementation too

`packages/dreamux/tests/team-last.test.ts:107-133` (title: "…building nothing"),
cited by `final.md:110-111` as proving "answering without constructing a
`TeamService`".

- The only assertion about materialization is
  `expect(fixture.provider.runtimes).toHaveLength(runtimes)` (`:132`).
- `createRuntime` has one call site, `agent/runtime-generation.ts:242`, on the
  launch path; `TeamService.rebuild` (`team/service.ts:448`) submits and starts
  nothing. So a `TeamService` built by the read creates no runtime.
- Scenario: replace the cold branch of `TeamCollection.lastResult`
  (`team/index.ts:321-324`) with `await this.open(record.team_id)` for an open
  record. Test 2 still passes: `open` rebuilds, no runtime appears, the read is
  made with the same `sessionId`, and every asserted field is equal. The open
  cold state is exactly the state this test exists for; only the closed state
  (test 3) would fail, and only because `open` throws `TeamClosedError`.
- The same test asserts `records: []` (`:130`), which is the fixture's constant
  answer (`tests/helpers/controlled-runtime-provider.ts:89-91`), so it does not
  show that a cold leader's last completed turn comes back. Criterion 8 names
  that output.

Change I would make: observe the construction itself — for example
`vi.spyOn(TeamService, 'rebuild')` around the read and assert it was not
called, in line with the guide's "spies sit on actual owners" — and answer the
read with `answerActivity(fixture.provider)` so the page is asserted to travel
from the persisted session id to the caller.

### 2. should-fix — `node .agents/scripts/check.mjs` fails, and the record says it passed

`README.md:6` reads `- State: \`review\` (slice 2); slices 1 and 3 are not in
development`. Running `node .agents/scripts/check.mjs` from the worktree root
exits 1: "task README has no supported workflow state. The line must read
exactly '- State: `<state>`' with nothing after it". It is the only problem
reported across 67 task records.

`verification.md:22` records this command as "one notice: this task record is
in an in-flight state, as expected until it becomes `done`", and
`final.md:514` lists `check.mjs` as a gate for criterion 7.

Change I would make: make the State line exactly `- State: \`review\`` and move
the slice remark to `Next action`; re-run the check and record its real output.
This file belongs to the task record rather than to slice 2's code, but it
will be committed with it.

### 3. should-fix — the new no-identity branch has no test

`team/index.ts:356-358`: `coldLeader` throws `AgentActivityReadError('session_unavailable')`
when `leaderIdentity()` answers `null`.

The only session-unavailable test (`team-last.test.ts:178-194`) goes through a
Team this process holds, where the throw comes from the shared reader
(`agent/activity.ts:80-82`) before that branch is reached. Scenario: delete
lines 356-358. `readAgentActivity` receives `identity: null`, the read fails
with a `TypeError` and the tool answers `INTERNAL` instead of
`ACTIVITY_SESSION_UNAVAILABLE`. No test changes.

The state is real and already has a fixture: `team-collection-read-path.test.ts:257-285`
writes a closed record with no leader identity.

Change I would make: add one case to `team-last.test.ts` that writes such a
record with `writeRawRecord`, calls the tool, and expects
`{ code: 'ACTIVITY_SESSION_UNAVAILABLE' }` with no provider call.

### 4. should-fix — the record overstates what differs for a Team being created

`final.md:86-89`: "The difference was the leader's status fields only".

It is not only the status fields. In that window the Team is in `starting`
(`team/index.ts:682-690`) and its leader's first turn is already admitted, so
the leader may have a running launch and a published session. The cold branch
reads the persisted identity with `running: null`, so the provider and config
come from the current config (`agent/activity.ts:113-123`), not from the launch.
That is the pairing the same section's Behavior bullet (`final.md:59-63`) says
the one-step rule prevents. `team-collection-read-path.test.ts:337-366` shows
the window with a live runtime.

I found no caller that reaches it: the name comes back from `team.create`,
which returns after `track()`. So this is a wording defect, not a reachable
failure. Change I would make: state the whole difference (`status`,
`runtime_status`, and `running`) and that the window is reachable only by a
caller that guesses the name; or join the `starting` entry as the first
solution text did.

### 5. nit — the port and the tool disagree on the `include_tools` default

`team/teams-port.ts:52` declares `last(teamId, query?: AgentEntityLastQuery)`.
With the query omitted, `validateIncludeTools(undefined)` answers `true`
(`agent/activity.ts:196-201`), so the port includes tool records; the tool
documents and applies `false` (`team/mcp.ts:291`). `team-last.test.ts:99-104`
pins the port's answer as `[MESSAGE_RECORD, TOOL_RECORD]`. The same wart exists
on `TeammateCollection.last`; nothing calls this port without the query today.

Change I would make: apply `includeTools ?? false` once in `lastResult` and
drop it from the tool, or make `query` required.

### 6. nit — a closed record that is still held is answered through the held leader

`team/index.ts:320-324` chooses by `live` only; `summaryFromRecord` returns a
closed record before it consults `live` (`team/index.ts:422`). Between the
`closed` write and `service.closed` settling, `team.status` answers from the
record and `team.last` from the held leader, whose runtime may still be up. I
found no failure in that window — `mustLeader()` cannot be `null` there — and
`dispatcher-orchestration.md`'s "a closed one included… is never built for the
read" stays true. Add the `record.status === 'closed'` check for symmetry, or
one sentence saying the window is read live on purpose.

### 7. nit — the harness key names a Command that does not exist

`tests/helpers/command-harness.ts:95,242` and
`tests/mcp-public-failures.test.ts:361` call the override
`readTeamLeaderActivity`. `final.md:100-104` states that `team.last` has no
Command, and the port method is `last`. Name the key after the port method.

### 8. nit — the file table omits the second new type

`final.md:37` lists `TeamLastResult` for `types.ts`. The diff also adds the
exported `TeamLeaderActivityTarget` (`team/types.ts:276-280`). Add it to the
table so the "what changed" list is complete.

## Verified as correct

- **Held Team mid-turn.** `lastResult` takes identity, status and launch in
  one synchronous step (`team/leader.ts:282-290`, called at
  `team/index.ts:324`); the first `await` after it is the provider call, whose
  `config` and provider are read from `running` without an intervening await
  (`agent/activity.ts:83-98`). No await sits between the `live` lookup and the
  projection. This mirrors `TeammateCollection.lastAdmitted`
  (`agent/index.ts:448-452`).
- **Cold, closed, missing, no session.** Cold and closed Teams never reach
  `open`/`get`/`rebuild`; a missing record throws `TeamNotFoundError`
  (`team/index.ts:485-493`); a held leader with `session_id: null` is refused
  by the reader before the provider is called.
- **Fence.** `last` crosses `this.opts.fence.admit` like `list`, `history` and
  `summary` (`team/index.ts:298-304`), before the record read.
- **Paging and `include_tools`.** Both are read by the shared
  `agentEntityLastQuery`; `limit: 0` is `BAD_REQUEST` before the port is
  reached.
- **Failures.** Through the tool, a recognized read failure becomes its
  `ACTIVITY_*` code with its own next step (`team/mcp.ts:306-310`); anything
  else keeps its type (`TeamNotFoundError`, `ServerShuttingDownError`,
  unstated errors). Through the port the raw `AgentActivityReadError` leaves,
  exactly as on `TeammateOps.last`.
- **Output schema.** All nine required properties of `TEAM_LAST_SCHEMA`
  (`team/mcp.ts:79-102`) are returned by the tool with matching types, and
  nothing else is.
- **`leaderIdentityStatus()` callers.** At HEAD it had one caller,
  `leaderState` (`team/index.ts:917`). `leaderActivityTarget().identity.status`
  is `current().status`, the same value; `status()` and `runningLaunch()` are
  pure reads. No behavior change for `list` and `history`.
- **Layering.** `depcruise` reports no violation over 236 modules. The new
  imports from `team/` reach only `agent/` store-tier files (`activity`,
  `records`, `requests`, `identity`) and a type-only import of
  `agent/service.ts` in `leader.ts`, which is in the service tier.
- **The 700-line cap claim.** `service.ts` counts 700 code lines at HEAD and
  700 now by `eslint`'s counting, so any method body past a one-line delegate
  would break `max-lines`. Deviation 1 holds, and deviation 3 holds: the free
  function is annotated `TeamLeaderActivityTarget`.
- **Existing tests not weakened.** `mcp-public-failures.test.ts:393` adds
  `team_name` to the shared `last` arguments, the same shape `status` already
  uses; the `teammate` tool ignores it and both `last` tools still meet both
  failure kinds. `team-mcp-results.test.ts:353` adds `last` to the tools that
  must publish an output schema, which strengthens the test.
- **Runs I made.** `npx vitest run` on `team-last`, `team-mcp-results`,
  `mcp-public-failures`, `team-leader-status`, `core-command-registry`: 106
  passed. `eslint` on the ten changed files, `prettier --check` on them,
  `tsc -p tsconfig.tests.json`, `depcruise`, and `knip`: clean, with nothing
  from this change in knip's unused-export list.
- **Scope.** Every source and test file in the diff is inside the boundary the
  README names. `team/leader.ts` is outside the card's list and is disclosed in
  both the README and `final.md`. No Dispatcher base prompt or skill enumerates
  the `team` tools, so no text is stale.

## Not checked

- `rush build`, `rush lint`, `rush test` as whole-repository runs; I ran the
  package-level equivalents on the changed files only.
- The live Codex activity cases and any real runtime; the provider boundary is
  stubbed in every test I ran.
- Whether a real provider returns a previous process's last completed turn for
  a persisted session id (finding 1 says no test shows it).
- That the launch's provider and config, rather than the current config, are
  used for a held leader: no test observes the second `readRecentActivity`
  argument, and I did not construct the case.
- `dispatcher-skill.md`, `dispatcher-orchestration.md` and the product README
  against every caller's experience; I read them against the source only.
  `packages/dreamux/src/service/CLAUDE.md` is unchanged and I am not asking
  for an edit.
- Slice 1 and slice 3 material, and the other reviewers' reports.

---

Report: 0 blocking, 4 should-fix, 4 nit. Most important: the only test of the
open cold state passes unchanged if the read materializes a `TeamService`
(`team-last.test.ts:107-133`), so the slice's central "read, never build"
property is asserted by nothing.
