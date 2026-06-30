# service/

The Dispatcher Service module (issue #135 entity, issue #233 restructure): the
real entity that the server launches per dispatcher. It holds the dispatcher
agent and orchestrates teammates. `server.ts` is wiring only — all per-dispatcher
orchestration lives here. One service class per file/dir; a class with helpers
gets a directory whose `index.ts` is the class and siblings are its helpers.
`service/index.ts` is the only package-internal service facade (`Dispatchers`,
`DispatcherService`, `TeamService`, `ChannelToolAuthorizationError` from
`channel-service/errors.ts`). Sub-service directories must not re-export sibling
modules; callers import the owning module directly unless the symbol belongs on
the explicit `service/index.ts` facade.

## What goes where

- **`dispatchers/index.ts`** — the `Dispatchers` collection: a thin factory + cache over
  per-dispatcher `DispatcherService` aggregates plus process-wide
  shutdown/restart hooks only. It owns **no** teammate/team/channel/router state —
  each `DispatcherService` builds and owns its own object graph (collections,
  stores, worktree manager, `CompletionRouter`, `ChannelService`, and the
  dispatcher agent). This collection only keys them by dispatcher id (Phase 3,
  #233).
- **`dispatcher-service/index.ts`** — one dispatcher-local aggregate
  (`DispatcherService`). It *has an* agent — a contained `TeammateService` built
  by `dispatcher-service/agent.ts` (Phase 5, #233) — that owns the agent runtime
  lifecycle (start/resume/stop). `DispatcherService` keeps the dispatcher-only
  concerns the removed `DispatcherRuntimeService` held: the live `ChannelService`,
  restart-notice injection (post-`agent.start()` hook), role MCP descriptor
  assembly, channel-tool dispatch, channel binding ownership, and completion routing. It launches the agent
  runtime first, then the channel sessions (slot-before-session ordering, #209
  fix #7). It resolves a settled turn's delivery target via `initiatorFor` (a team
  member → its leader's `TeammateService`; a dispatcher-owned teammate / leader →
  the dispatcher's own `agent` `TeammateService`, the unified router path) and
  orchestrates Team route-owner facts with ChannelService binding operations.
- **`team-collection/index.ts`** — `TeamCollection` (split out of the old
  `TeamManager`): owns the team store and worktrees; does `create` / `list` /
  `history`, open-Team route-owner fact lookup, and `get(id) → TeamService`.
  **`team-service/index.ts`** — `TeamService`, the single per-team entity (holds
  its own `TeamRecord`): `status` / `dissolve` / `deliverToLeader` /
  `sharedWorkspace` plus the teammate forwards the admin `team_leader` target
  calls and the shared `teamView` helper. The two classes were split into
  separate files for the one-class-per-file rule (issue #233).
- **`dispatcher-service/` (agent-side parts)** — the dispatcher agent's parts (Phase 5, #233):
  `agent.ts` builds the dispatcher's own agent as a contained `TeammateService`
  (runtime built from the dispatcher config, status/thread persisted to the
  authoritative `status.json` via `DispatcherStore`, a write-only debug
  `identity.json`+`turn.jsonl` at the dispatcher *root* via role `dispatcher` —
  structurally outside the `teammate/` collection, so the read chokepoints never
  enumerate it). `mcp-descriptors.ts` is the role-based MCP descriptor
  builder.
- **`channel-service/`** — the dispatcher-local core Channel service. It wraps the
  private live `ChannelSessions` helper, owns channel-tool dispatch, provider
  target resolution, TeamLeader egress checks, and all `ChannelBindingStore`
  reads/writes/summaries/transfer-back operations. It treats Team route owners as
  flat routing data and does not import Team service types. The dispatcher base prompt and runnable-channel guard stay under `dispatcher-service/`. There
  is **no** `DispatcherRuntimeService`; the at-most-once policy lives in the
  `CompletionRouter`, and `TeammateService.completionInput` is a thin forward.
- **`teammate-collection/` + `teammate-service/` + `completion-router/`** —
  `TeammateCollection` (the collection: stores, worktrees, `spawn` / `list` /
  `history` / `close`, factory paths, per-turn router registration) +
  `TeammateService` (the single-entity: holds its identity, lazily started
  runtime, `send` / `status` / `last` / `channelInput`, and `completionInput` as a
  delivery target) + `CompletionRouter` (per-dispatcher delivery service, keyed by
  `producerName:turnId`, terminal-cache at-most-once) + identity-store +
  runtime-state + types + the teammate MCP descriptor. The cross-cutting helpers
  `worktree/`, `channel-binding/`, `legacy-state.ts`, and `dispatcher-workspace.ts`
  (the issue #182 dispatcher-cwd policy used by `server.ts` startup, the dispatcher
  service, `dreamux doctor`, and the `worktree/` layer) live at the `service/` root
  because no single service owns them.
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
- **`teammate.*` visibility is physical directory scoping plus one roster
  predicate (issue #199 Slice 4, issue #233).** After the symmetric layout, the
  scope IS the directory: `TeammateReadModel.rosterList` lists only
  `teammate/<name>/` for a dispatcher-scope read and only that team's members
  under `team/<team>/teammate/<name>/` for a team-scope read — the leader lives at
  the team root and is never a member row, so no post-filter is needed. The single
  read-by-name chokepoint `mustIdentity` then applies `assertInCollection` so a
  wrong-scope name resolves as "does not exist": a dispatcher-scope read sees
  only `role: 'teammate'` entities with `team_id === null`, a team-scope read
  only that team's `team_member` rows; the TeamLeader lives at the team root and
  is reached through `TeamService`, not the members collection. The
  Team service reaches its own leader + members through the team-scoped reads it
  drives; a dispatcher inspects Teams via `team.*` compact summaries, never
  `teammate.*`.
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
