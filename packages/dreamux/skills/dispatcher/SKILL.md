---
name: dispatcher
description: Use from a Dreamux dispatcher thread when bounded repository work should be delegated to a TeamMate. The server-hosted TeamMate MCP is the default interface; spawn creates a semi-resident TeamMate and RETURNS its concrete name (use that name for every later call), send submits follow-up turns and reopens a closed TeamMate from its checkpoint, close stops one, history searches the durable session ledger, and list/status/last/get_capabilities inspect state. The tm CLI is the explicit fallback for legacy diagnostics. Applies to spawning, tracking, retrieving, sending, closing, inspecting, reopening, recovering, or summarizing teammate work.
---

# Dispatcher

Use this skill only from a Dreamux dispatcher session. The dispatcher delegates
bounded repository work to TeamMates and reports verified results back to the
source chat.

## TeamMate Interface

Reach a TeamMate through the server-hosted TeamMate MCP by default. Drop to the
`tm` CLI only for what the MCP does not yet cover. Pick by what you need, not by
habit.

### Server-hosted TeamMate MCP — the primary interface

Dreamux injects a dispatcher-scoped `teammate` MCP server. It creates named
semi-resident TeamMate agents through the same AgentRuntime contract as
dispatchers, then lets you submit follow-up turns, reopen closed agents from
their checkpoint, inspect state, and close agents without holding a shell
session or polling a process.

**Lifecycle.**

- `spawn` — create a TeamMate and submit the first turn. The `name` you pass is
  a requested label / base slug, **not** the final address: the service
  allocates a concrete, never-reused name and returns it as `teammate.name`.
  **Use that returned concrete name for every later `send`/`status`/`last`/
  `close`.** Your requested label is preserved as `display_name` for display.
  `intent` is **required**: a short recovery subject for the session ledger
  (what this TeamMate is for). When selecting a runtime, pass one of
  `get_capabilities.agent_runtimes[].id` as `agent_runtime`; do not pass provider
  refs such as `builtin:*`.
- `send` — submit a turn to a TeamMate by its concrete name. If it is not live —
  including one previously `close`d — send first reopens it from its persisted
  checkpoint, then submits. There is no separate `resume` verb; send covers
  reattach. Pass `intent` (optional) to update the recorded recovery subject
  when the work shifts.
- `close` — stop the TeamMate (by concrete name) and mark it closed. `note` is
  **required**: why you are stopping a recoverable session. It stays reopenable:
  a later `send` revives it from its checkpoint.

**Watch and collect — no polling.**

- `list` — this dispatcher's TeamMates: concrete name, display name, status, and
  repo/cwd/session essentials.
- `status` — one TeamMate's current state by concrete name: display name, agent
  runtime id, session, cwd/repo, checkpoint, and close metadata.
- `history` — the durable session-ledger search surface for this dispatcher,
  with recovery filters across TeamMates (name/state/repo/grep/cursor).
- `last` — a TeamMate's most recent settled turn(s), read from the durable
  session ledger by concrete name. It accepts `turns` (1..5, default 1; newest
  last) and returns the final assistant output as completely as it was durably
  captured (with a truncation flag). It does **not** start or resume a runtime,
  so it works for a closed or stopped TeamMate — this is your fallback when a
  completion was never delivered.

These serve status / history / last directly, so you do not need `tm` to check
on a running TeamMate. Do not wait or poll for completion: submit the turn, let
the dispatcher turn end, then recover through `history` and `last`. (The former
`ctx` and `history_events` verbs were removed; use `last` and `history`.)

**Team lifecycle.**

Dreamux also injects a dispatcher-scoped `team` MCP server for Team Mode
lifecycle. It is addressed by **Team name** (the same value you create with),
mirroring the TeamMate read-surface model. Team work still runs through agents;
do not inspect the target repo directly from the dispatcher.

- `create` — create a Team and TeamLeader. Requires `repo_cwd`,
  `leader_agent_runtime`, and `intent` (the Team's recovery subject); no default
  leader runtime is inferred. Optionally pass `bind_group: { chat_id }` to bind
  an EXISTING Feishu group chat to the new Team at create time. (The former
  `create_group` tool — create a brand-new Feishu group and invite users — was
  retired; bind an existing group instead.)
- `list` — compact scan rows for current Teams (name, status, intent, repo
  signal, leader name/state, member count, bound group marker, timestamps). Keep
  it cheap and scannable; reach for `status` for detail.
- `status` — one Team's detailed current state by name: the Team record, the
  TeamLeader status/session, member count, and the active bound group.
- `history` — the durable Team recovery search (closed Teams included): filter by
  `name`, `status`, `close_status`, `repo`, `intent` text (`grep`), and time
  range (`since`/`until`), with `limit`/`cursor`. This is the recovery interface;
  the raw per-Team lifecycle event timeline stays internal.
- `bind_group` — bind an existing Feishu group chat to a Team by name and
  `chat_id` (group chats only; no `chat_type`).
- `transfer_channel_back` — return a bound Feishu group chat (`chat_id`) to the
  dispatcher.
- `dissolve` — close the TeamLeader and team-owned members by Team name, then
  conservatively clean up the shared managed worktree. `note` is **required**:
  why the Team is being dissolved. Active channel bindings are transferred back
  first.

**Control and inspect.**

- `get_capabilities` — spawnable `agents[].id` values under `agent_runtimes[]`,
  each with runtime capabilities: resume, steer, events, last, and context. Use
  `spawn({ agent_runtime: id, ... })` with one of those ids. Claude Code Remote
  Control is an external Claude UI surface, distinct from Dreamux `send` steer;
  keep trusting `steer.supported` from the returned capabilities.

The persistent identity and history files are the source of truth. A TeamMate
reopened by send continues from its saved runtime checkpoint; do not create a
new name unless you want a separate session.

### tm CLI — the explicit fallback

Dreamux hosts the dispatcher Codex app-server and exposes `tm` on the dispatcher
`PATH`. `tm` owns live tm **session** state: teammate liveness, repository
worktrees, and resumable session history. Reach for it only for what the MCP
does not yet cover — resuming or recovering a dead session, multi-turn
isolated managed worktrees — and for legacy diagnostics. It is
not the default orchestration path. The rest of this skill and its references
are the operational manual for that fallback.

## Router Posture

The dispatcher routes repository work to a teammate that lives in the target
repo. It does not investigate that repo itself.

- Hand the teammate the symptom and any concrete evidence, not your diagnosis.
  Skip `grep`, file reads, and `git -C <repo>` probes done "to understand the
  bug first". The teammate has the repo's own context and conventions;
  pre-investigation burns dispatcher context and anchors the teammate to a
  conclusion you drew before delegating.
- Treat the user's framing adversarially. A request like "find which commit
  broke X" embeds claims ("X is broken", "it is a regression") that may be
  false. Pass such claims into the teammate brief as things to verify, not as
  settled premises.
- Keep repo-local instructions, git state, and tool output inside the teammate
  context instead of mixing them into the dispatcher thread.

## Boundaries

These govern the tm fallback path. For the primary MCP path, call the injected
`teammate` MCP tools directly.

- Invoke bare `tm` from the dispatcher environment `PATH`. Dreamux injects its
  package `bin/` directory into the dispatcher app-server PATH.
- Do not use `npx`, `npm exec --package @excitedjs/tm`, or a version-qualified
  `@excitedjs/tm`; the Dreamux package owns the compatible tm version.
- Choose the teammate engine deliberately. `tm spawn` takes `--engine`; the
  engines it supports are listed in `tm spawn --help`. Pick by task shape and
  by what the dispatcher environment actually provides -- a persistent,
  resumable Codex daemon suits ongoing repo work; an engine whose CLI is not
  installed or authenticated in this environment is not a usable choice. State
  `--engine` explicitly so the selection is intentional rather than inherited
  from a tm version default.
- Do not call dreamux admin APIs directly to create or recover teammate state.
  Reach server-owned TeamMate agent state only through the `teammate` MCP tools;
  reach live tm sessions only through `tm`.
- Do not infer the target repository from the dispatcher cwd unless the user or
  operator explicitly made that cwd the requested repo.
- Do not ask a TeamMate to spawn or close another TeamMate.

## When To Delegate

Delegate when the request is bounded and can be completed by one teammate:
running tests, inspecting a code path, drafting a narrow patch, or collecting a
specific result. Handle the work directly when the request is tiny, ambiguous,
security-sensitive, or missing a repository path.

Resolve the repo path in this order:

1. An absolute path in the user request.
2. An explicit dispatcher environment variable set by the operator.
3. Ask the user for the repo path.

Use an absolute repo path for `tm spawn`. If the user gives a relative path,
make it absolute only when its base is explicit.

## Command Contract

`tm --help` is the top-level synopsis. `tm <verb> --help` owns each verb's
flags, accepted arguments, exit codes, and exact stdout/stderr contract. This
skill and its references own operational semantics and scenario selection; the
live help owns the executable contract. Read the verb's own help before relying
on a flag -- do not infer one verb's flags from another.

## Scenario Routing

These references cover the `tm` fallback path. For ordinary delegation —
spawning a TeamMate, sending follow-up turns (which also reopens a closed one
from its checkpoint), checking status, or reading history/last — use the
`teammate` MCP tools above and you do not need a reference.
Read the matching reference when you have dropped to `tm`:

| Intent | Reference |
|---|---|
| Use the tm fallback to spawn a managed-worktree teammate or send a legacy tm turn | `references/dispatch-task.md` |
| Look up, re-read, or resume a prior or dead teammate session | `references/inspect-and-resume.md` |

For multi-teammate review, design negotiation, merge, or unblock coordination,
use the `team-dev-workflow` skill, which layers methodology on top of this one.

## Verified Reports

A reply to the source chat that asserts an outcome must be verifiable from this
turn's tool calls.

- Report only what the TeamMate interface returned, whether a `teammate` MCP
  tool result or a `tm` verb. Do not invent a teammate result that was not
  produced by one of them.
- Verify any command, flag, or path before naming it; if you cannot verify it
  this turn, say so rather than guessing a name.
- Translate dispatcher-internal identifiers into plain language before the
  message goes out. Issue and PR numbers the user can look up are shared
  vocabulary; ad-hoc internal labels are not.
- For public target repos, forbid internal domains, tokens, private
  identifiers, and machine-local paths in commits, PRs/MRs, and comments in the
  teammate brief.

## State Boundary

Two state owners, kept distinct:

- The Dreamux server owns the TeamMate **agent state** behind the `teammate`
  MCP — concrete identities (with their display labels), runtime checkpoints,
  status, and the durable session ledger (prompts and captured assistant
  output). Read and control it with `list`, `status`, `history`, `last`,
  `send`, and `close`.
- `tm` owns live tm **session** state — teammate liveness, worktrees, and
  resumable session history (see `references/inspect-and-resume.md`).

Do not conflate the two. Recovering a tm session is not the same as resuming a
server-owned TeamMate identity, and the server does not own tm session liveness.
