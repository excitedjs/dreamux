# dispatcher-service/

The Dispatcher Service: the real entity (issue #135) that the server launches per
dispatcher. It holds the dispatcher agent and orchestrates teammates. `server.ts`
is wiring only — all per-dispatcher orchestration lives here.

## What goes where

- **`service.ts`** — the `Dispatchers` collection. It owns configured
  dispatcher aggregates and process-wide shutdown/restart hooks only; it must
  not grow teammate/team/channel forwarding methods. It owns the process-wide
  `TeammateCollection` + `TeamCollection` (Phase 1 keeps them singletons keyed by
  dispatcher id) and one per-dispatcher `CompletionRouter`, injected into the
  collection via `routerFor(id)` / `initiatorFor(id, producer)`.
- **`dispatcher-instance.ts`** — one dispatcher-local aggregate
  (`DispatcherService`). It owns that dispatcher's runtime/channel operations and
  delegates teammate/team work to the collections. It resolves a settled turn's
  delivery target via `initiatorFor` (a team member → its leader's
  `TeammateService`; a dispatcher-owned teammate / leader → a thin adapter over
  the dispatcher runtime's `completionInput`) and implements `TeamChannelContext`
  for the team layer's channel ops.
- **`team/service.ts`** — `TeamCollection` (split out of the old `TeamManager`):
  owns the team store, channel bindings, and worktrees; does `create` / `list` /
  `history` / `resolveChannel`, and `get(id) → TeamService`. `TeamService` is the
  single per-team entity (holds its own `TeamRecord`): `status` / `dissolve` /
  `bindChannel` / `deliverToLeader` / `sharedWorkspace` plus the teammate forwards
  the admin `team_leader` target calls. The entity is loaded fresh per `get` (no
  caching) so a held record never goes stale after a dissolve.
- **`dispatcher/`** — `DispatcherRuntimeService`: owns one live dispatcher runtime,
  start / resume / stop, restart-notice injection, the channel session(s)
  (`Map<channel_id, ChannelSession>`, driven through the
  `@excitedjs/dreamux-types` `ChannelProvider` seam — `builtin:feishu` today),
  and the **role-based MCP descriptor builder**. A `DispatcherService` composes
  exactly one `DispatcherRuntimeService`; there is no process-wide runtime slots
  manager. `deliverCompletion` is a thin forward into the runtime's
  `completionInput`; the at-most-once policy lives in the `CompletionRouter`, not
  here. Also holds the dispatcher base prompt.
- **`teammate/`** — `TeammateCollection` (the collection: stores, worktrees,
  `spawn` / `list` / `history` / `close`, factory paths, per-turn router
  registration) + `TeammateService` (the single-entity: holds its identity,
  lazily started runtime, `send` / `status` / `last` / `channelInput`, and
  `completionInput` as a delivery target) + `CompletionRouter` (per-dispatcher
  delivery service, keyed by `producerName:turnId`, terminal-cache at-most-once) +
  identity-store + runtime-state + types + the teammate MCP descriptor.
  Agent-centric teammates: **no `task`** — a teammate is a named, resumable agent.

## Invariants (why it's shaped this way)

- **Drive every runtime through the published AgentRuntime interface.** The service
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
- **State is a symmetric directory per agent entity (issue #233).** Every agent
  is a directory holding `identity.json` (identity + rolling recovery summary:
  turn_count / last_seen_at / last prompt+assistant previews — the single source
  for `history` / `list` / `status`, no event fold) and `turn.jsonl` (the ONLY
  JSONL store: one compact `submit`/`settled` row per turn, turn-only facts, no
  record fields repeated, folded by `last`). Placement is by role:
  `teammate/<name>/` for dispatcher-owned teammates, `team/<team>/` for the team
  *leader* (its pair sits at the team root, beside `record.json`), and
  `team/<team>/teammate/<name>/` for team members. The `teammate/` and `team/`
  dirs are blind-scan collections of entity dirs only — `channel-bindings.json`
  sits at the dispatcher root and provider runtime scratch under `runtime/<name>/`,
  never inside a collection. Writing is a blind `mkdir -p` + write; the store
  derives every path from the identity's `role` + `team_id` (`paths.ts`
  `dispatcherAgentEntityDir`). Reads/lists scan `<scope>/teammate/<name>/`; a
  team-scoped read-by-name two-probes (member dir, then team root for the
  leader). `last` reads the identity first (existence/scope), then the turn
  archive — it never starts a runtime, so a closed teammate stays recoverable.
  Both writes are best-effort. Teammate **names stay dispatcher-global**:
  `allocateName` dedups against `IdentityStore.listAllNames` (all three scopes,
  leaders included), so `producerName:turnId` is collision-free for the router.
  The reserved-name guard (`assertNotReservedAgentName`) blocks names that would
  recreate a legacy leaf (`records` / `turns` / …). `session_id` is the
  runtime-native thread id, persisted directly.
- **Old state fails loud, it is never migrated (issue #199 Slice 5, #233).** 0.x
  has no schema migration (issue #98). `legacy-state.ts` is the one place that
  knows the removed layout: `detectLegacyDispatcherState` probes the removed
  leaves (`teammate/identities/`, `teammate/records/`, `teammate/turns/`,
  `teammate/sessions.jsonl`, `teammate/history/`, `team/records/`,
  `team/channel-bindings.json`, `team/ledger/`) — the `teammate/`/`team/` parents
  stay valid as the new collection roots — and `dreamux serve` aborts startup
  while `dreamux doctor` diagnoses, naming the path to delete. Removed *fields*
  left in a present record (`checkpoint` / `checkpoint_kind` / `session_ref` /
  `display_name` / `close_status`, or a channel binding keyed by `team_id`) are
  rejected by that record's reader via `assertNoRemovedRecordFields`. Detection
  only: the legacy paths/files are never read for migration, rewritten, or
  removed.
