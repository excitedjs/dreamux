# dispatcher-service/

The Dispatcher Service: the real entity (issue #135) that the server launches per
dispatcher. It holds the dispatcher agent and orchestrates teammates. `server.ts`
is wiring only — all per-dispatcher orchestration lives here.

## What goes where

- **`service.ts`** — the facade that assembles the dispatcher-agent service and
  the teammate service.
- **`dispatcher/`** — `DispatcherAgentService`: owns live dispatcher slots,
  start / resume / stop, restart-notice injection, the Feishu channel session,
  and the **role-based MCP descriptor builder**. The dispatcher agent's lifecycle
  is tied to the server (started at boot, resumed on restart). Also holds the
  dispatcher base prompt.
- **`teammate/`** — `TeamMateAgentService` + identity-store + runtime-state +
  types + the teammate MCP descriptor. Agent-centric teammates: **no `task`** —
  a teammate is a named, resumable agent.

## Invariants (why it's shaped this way)

- **Drive every runtime through the neutral AgentRuntime interface.** The service
  resolves a provider from the registry-backed catalog and calls the same
  contract for codex/claude/external; it knows no runtime specifics.
- **Same creation path for dispatcher and teammate agents.** Both go through
  `AgentRuntimeProviderCatalog.resolve(ref).createRuntime(...)`. No parallel
  worker/runtime tree.
- **cwd is supplied by the launcher.** The dispatcher agent's cwd is its
  validated workspace (`ensureDispatcherWorkspace(config, id)` in
  `dispatcher-workspace.ts`): every dispatcher MUST declare an explicit `cwd`,
  there is no state-dir fallback (issue #182 PR-4). A teammate's cwd is its
  resolved target (`identity.cwd`). Passed as the required `cwd` create-context
  field — never derived inside the runtime. Managed TeamMate/Team git worktrees
  live under that workspace at `<cwd>/.workspace/worktree/<repo-slug>/<slug>/`,
  never under `~/.dreamux`. When a `spawn`/`create` omits `repo` (issue #199),
  the work directory is instead a plain `<cwd>/.workspace/work/<name>/` dir
  (`WorktreeManager.prepareDefaultWorkspace`) — `mkdir -p`, no git worktree, so
  the dispatcher cwd need not be a git repo; it is persisted as a `reuse-cwd`
  worktree with `source_repo: null`. `WorktreeManager` resolves all three modes
  (default work dir, reuse-cwd, managed); the admin layer signals "default" by
  forwarding no cwd/worktree.
- **Nested dispatch is prevented by MCP injection, not a runtime check.** A
  teammate/team-leader agent is simply not injected the "spawn teammate" tool;
  role differentiation is done by the MCP tool set + system prompt this service
  injects at launch.
- **`teammate.*` visibility is one predicate at two chokepoints (issue #199
  Slice 4).** `principalCanAccess` is the sole rule and is applied ONLY in
  `scopedList` (list reads) and `mustIdentity` (single reads), so no read site
  can widen visibility. A dispatcher principal sees only the ordinary TeamMates
  it spawned (`role: 'teammate'`) — never a TeamLeader (dispatcher-owned but
  `role: 'team_leader'`) or a Team member; a `team_leader` principal sees only
  its own members; a `teammate` principal sees nothing. The Team service reaches
  its own leader + members through the INTERNAL `team_service` principal (built
  only by the Team service, never from a public caller); a dispatcher inspects
  Teams via `team.*` compact summaries, never `teammate.*`.
- **Teammate storage is the per-name record + the per-name turns archive
  (issue #199 Slice 3).** `teammate/records/<name>.json` is the primary record —
  identity plus a rolling recovery summary (turn_count / last_seen_at / last
  prompt+assistant previews) — and is the single source for `history` / `list` /
  `status` (no event fold). `teammate/turns/<name>.jsonl` is the ONLY JSONL store:
  one compact `submit`/`settled` row per turn event, holding turn-only facts (no
  record fields repeated), folded by `last`. `last` reads the record first
  (existence/scope), then the turns archive — it never starts or resumes a
  runtime, so a closed/stopped teammate stays recoverable. Both writes are
  best-effort and never fail a lifecycle verb. The former `teammate/sessions.jsonl`
  session ledger, the Dreamux-minted `session_id` key, and the persisted
  `checkpoint` object are gone: `session_id` is now the runtime-native thread id,
  persisted directly, and the resume checkpoint kind is rebuilt from the runtime.
- **Pre-#199 state fails loud, it is never migrated (issue #199 Slice 5).** 0.x
  has no schema migration (issue #98). `legacy-state.ts` is the one place that
  knows the removed layout: `detectLegacyDispatcherState` probes the removed
  whole-file/dir paths (`teammate/identities/`, `teammate/sessions.jsonl`,
  `teammate/history/`, `team/ledger/`) and `dreamux serve` aborts startup —
  `dreamux doctor` diagnoses — naming the path to delete. Removed *fields* left in
  a present record (`checkpoint` / `checkpoint_kind` / `session_ref` /
  `display_name` / `close_status`, or a channel binding keyed by `team_id`) are
  rejected by that record's reader via `assertNoRemovedRecordFields`. Detection
  only: the legacy paths/files are never read for migration, rewritten, or
  removed.
