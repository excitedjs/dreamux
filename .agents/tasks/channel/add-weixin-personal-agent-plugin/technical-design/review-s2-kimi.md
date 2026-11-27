# Slice 2 independent review — `team.last`

## Findings

### 1. Blocking — a closed Team can still be read through its cached live leader

**Location:** `packages/dreamux/src/service/team/index.ts:320`

`lastResult` chooses `this.live` whenever an entry exists, without checking
`record.status` (`index.ts:319-324`). That is not equivalent to "an open Team
this process holds." Dissolve commits the closed Team record before it destroys
the children (`service.ts:640-667`), and the collection evicts the cached
service only after `service.closed` resolves (`index.ts:839-846`). Leader close
in turn converges/stops the runtime before writing the leader identity closed
(`agent/service.ts:871-891`). There is therefore a real window in which the
Team record is closed, the cached `TeamService` is still present, and the leader
still has a running launch.

Concrete scenario: start a leader turn, publish a non-null runtime status such
as `ready`, submit `team.dissolve`, and hold the provider's stop at a barrier.
After the closed record commits but before leader stop is released, call
`team.last`. The current code takes `held.leaderActivityTarget()`, passes that
live launch to `readAgentActivity` (`index.ts:321-332`; source selection at
`agent/activity.ts:83`), and can return `team_status: 'closed'` beside the old
non-null `runtime_status` and live leader state. The read also uses the running
generation's provider/config instead of the stopped/cold source.

This contradicts the approved closed-state answer (`technical-design/final.md:67-73`),
the standing rule that closed-entity read models answer from records
(`packages/dreamux/src/service/CLAUDE.md:455-459`), and the new knowledge claims
at `.agents/domains/dispatcher-orchestration.md:174-179` and
`.agents/product/README.md:387-393`. `TeamCollection.summaryFromRecord` already
handles this exact distinction correctly by checking `record.status === 'closed'`
before consulting `this.live` (`index.ts:413-424`).

**Change I would make:** in `lastResult`, always use `coldLeader(record)` when
`record.status === 'closed'`; consult `leaderActivityTarget()` only for an open
record. Add a dissolve-in-progress regression test with leader stop blocked and
a published non-null runtime status. Assert that the answer has
`runtime_status: null` and that the read uses no running launch. The persisted
leader lifecycle status during that window may still be `running` until its own
close write lands; the defect is consulting the live service/launch after the
Team's closed commit, not a requirement to fabricate a closed leader identity.

### 2. Should-fix — the “open Team this process does not hold” test actually rebuilds and holds the Team

**Location:** `packages/dreamux/tests/team-last.test.ts:114`

The test closes the first host, builds another, and then awaits
`next.host.start()` before calling `next.teams.last` (`team-last.test.ts:114-120`).
Dispatcher startup calls `teams.recover()`
(`dispatcher-service/lifecycle.ts:165-181`), and `TeamCollection.recover()`
calls `get` for every non-closed Team (`team/index.ts:549-558`). Consequently,
the open Team has already been rebuilt and inserted into `this.live` before the
read. The test exercises `held.leaderActivityTarget()` with no running launch,
not `coldLeader(record)`.

The unchanged runtime count does not detect this: rebuilding a `TeamService`
does not itself create a leader runtime. Thus the test also cannot prove its
title's “building nothing” claim. This makes the test plan in
`technical-design/final.md:108-112` and the evidence statement in
`verification.md:31-32` overclaims, even though the test passes.

**Change I would make:** call `next.teams.last` on the newly built collection
without starting `next.host`, so recovery cannot populate the live cache. Spy
on `TeamService.rebuild` without replacing its implementation and assert that
the read does not call it; retain the provider/session and no-new-runtime
assertions. This follows the existing unstarted-cold-owner fixture pattern in
`tests/team-create-recovery.test.ts:276-288` and observes construction through
the real owner rather than inferring it from runtime count.

## What I verified as correct

- **Held reads and generation pairing:** `teamLeaderActivityTarget` reads the
  leader identity, status, and running launch synchronously, with no `await`
  (`team/leader.ts:282-289`). No runtime event can interleave between those
  reads in JavaScript. `readAgentActivity` then uses that captured running
  provider/config, or resolves the current configured provider only when the
  captured launch is null (`agent/activity.ts:79-98`). I found no
  cross-generation identity/launch pairing on this path.
- **No action hidden behind the read:** the new path calls identity/activity
  readers only. It does not call `open`, `get`, `submitInput`, runtime start,
  resume, or interrupt. A leader with no session fails before the provider read
  (`agent/activity.ts:79-82`), and a missing persisted leader is mapped to the
  same `session_unavailable` outcome (`team/index.ts:352-359`).
- **Input, paging, and tool defaults:** the tool reuses `agentEntityLastQuery`;
  its 1..200/default-20 limit, cursor, and `include_tools` reach the shared
  reader. MCP defaults `include_tools` to false while the direct port retains
  the sibling port's default of true (`team/mcp.ts:283-292`;
  `agent/activity.ts:196-201`). The focused test verifies cursor forwarding and
  both tool-record choices through the real `TeamCollection` and MCP delegate.
- **Output contract:** every field returned in `structured` is present, with the
  corresponding nullability, in `TEAM_LAST_SCHEMA`
  (`team/mcp.ts:79-102,293-304`). The tool is marked read-only
  (`team/mcp.ts:513-518`). I found no missing or extra published result field.
- **Failure behavior:** recognized activity failures pass through
  `mapAgentActivityCommandError`; `TeamNotFoundError`, caller mistakes, and
  unrecognized exceptions retain their existing types because the mapper
  rethrows anything other than `AgentActivityReadError`
  (`agent/activity.ts:339-348`). The new tests cover no-session, missing Team,
  bad limit, and Dispatcher-fence refusal. `last` is admitted through the same
  Dispatcher work fence as the other `TeamsPort` reads (`team/index.ts:298-304`).
- **Closed Team after eviction:** the existing closed-Team test awaits
  `service.closed` before reading (`team-last.test.ts:141-151`), so it does
  exercise the persisted-identity path and verifies `team.history` remains
  intact. Finding 1 concerns the earlier, still-cached window that this test
  does not cover.
- **Replaced accessor regression:** the only former caller of
  `leaderIdentityStatus()` was `TeamCollection.leaderState`; its replacement
  still returns `mustLeader().current().status` through
  `leaderActivityTarget().identity.status` (`team/index.ts:974-989`). The extra
  status/launch reads are synchronous and side-effect-free. No other caller
  remains.
- **Layering:** the new imports follow the declared store → service →
  collection direction. In particular, the `AgentService` import in
  `team/leader.ts` is type-only and points to an earlier layer; the shared
  activity reader remains in the neutral agent store tier. Dependency-cruiser
  reported no violations (134 modules, 624 dependencies).
- **Existing tests were not weakened:** adding `last` to the output-schema list
  strengthens `team-mcp-results.test.ts`. The shared `last` arguments in
  `mcp-public-failures.test.ts` now carry both tools' required names, but no
  assertion was relaxed; the native-failure case still proves the poisoned
  owning method is reached by returning its exact `TypeError` message. The new
  `readTeamLeaderActivity` harness override stubs the real `dispatcher.teams.last`
  method (`tests/helpers/command-harness.ts:232-246`).
- **Implementation deviations and scope:** the held-leader projection is the
  only production behavior added to `team/leader.ts`; it is a same-tier helper,
  not a new indirection used by both old and new accessors. The original
  approved file list omitted `leader.ts`, and the task record now discloses
  that deviation at task `README.md:41,48-52`. I judge it a routine in-scope
  file-placement choice under `.agents/skills/dev-workflow/SKILL.md:30-39`, not
  new product scope. The other two stated deviations are present in source:
  `lastResult` does not consult `starting`, so a mid-create record takes the
  cold path, and `TeamService.leaderActivityTarget()` returns the helper's
  inferred projection type. No `service/agent/` source, Weixin code,
  `team.history`, Command registry, or TeamLeader-owned `team` server changed.
- **Records other than the two findings:** `dispatcher-skill.md` accurately
  names the Dispatcher tool and its inputs. The orchestration/product pages
  accurately state the intended held/cold model, but currently overclaim closed
  behavior because of finding 1. Section 2's implementation-deviation account
  matches the source; its cold-test claim is inaccurate for the reason in
  finding 2.

## Checks run

From `packages/dreamux`:

- `npx vitest run tests/team-last.test.ts` — **6 tests passed**.
- `npx vitest run tests/mcp-public-failures.test.ts tests/team-mcp-results.test.ts`
  — **76 tests passed**.
- `npm run typecheck:tests` — **passed**.
- ESLint over the six changed Team source files — **passed**. The HEAD version
  of `team/service.ts`, supplied over stdin, also passed the current lint rules.
- `npx dependency-cruiser --config .dependency-cruiser.cjs src/service/team src/service/agent/activity.ts src/service/agent/requests.ts`
  — **no violations**.
- `git diff --check` — **passed**.

An initial accidental Vitest invocation from the repository root failed before
collecting tests because it did not load the package configuration. The valid
package-directory runs above supersede that invocation; there was no test
failure in those runs.

## What I did not check

- I did not run the monorepo-wide Rush build, lint, test, or test-typecheck
  gates, and I did not independently confirm the full-gate results recorded in
  `verification.md`.
- I did not run a real Codex/Claude provider or an operator Dispatcher
  end-to-end call. Actual native transcript ordering, completed-turn contents,
  and provider-side paging are covered only indirectly by the shared reader
  and its existing tests, not by this review's mocked provider runs.
- I did not execute a new dissolve-race reproduction; finding 1 is established
  from the current close/eviction control flow cited above. No files other than
  this report were changed.
- I did not review slices 1 or 3, or working-tree changes outside the named
  Slice 2 files.

Counts: 1 blocking, 1 should-fix, 0 nit.
Most important: a closed Team must bypass its still-cached leader and use the persisted cold read (`packages/dreamux/src/service/team/index.ts:320`).
