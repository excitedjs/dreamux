# Requirement

## Operator instructions

Original wording, 2026-09-11:

> 有一个小点，就是workspace 的默认值，从true 改成false了。把那个同步到上游

> team.create 的变更也同步过来。

English rendering: change the workspace default from true to false, and also
port the Team creation change identified by the source comparison. The TeamLeader
replayed the concrete creation chain: optional context, result metadata, a fresh
creation event, and provider-owned binding of an existing Feishu group.

## Current alignment

- Baseline: `af96c9f4` on `next`.
- Configuration currently defaults `dispatchers[].workspace.enabled` to true,
  including omitted workspace, an empty workspace object, and new onboarding.
- Creating a Team without a repository already works. Default workspace policy
  selects an isolated plain directory or the dispatcher's cwd; neither requires Git.
- Canonical `team.create` currently has no provider context. Core already owns
  request idempotency and a dispatcher-scoped event stream; Feishu owns bindings.
- Desired outcome: repository-free agents use the dispatcher cwd unless isolation
  is explicitly enabled. An external caller can supply provider-owned creation
  context so the relevant channel can bind an already-existing conversation.
- Scope: the selected default change and creation-context chain, preserving
  existing ownership and request semantics.
- Non-goals: platform task protocols, new runtime providers, workflow-stage cards,
  old-state migration, creating external groups, and unrelated timer-test changes.

## Acceptance criteria

1. Omitted workspace configuration, `workspace: {}`, and newly onboarded
   dispatchers use `enabled: false`. Explicit true/false configuration survives
   load/save and re-onboarding. Dispatcher enabled status is unaffected.
2. Repository-free Team and dispatcher-owned TeamMate creation reuse dispatcher
   cwd by default. Explicit isolation and explicit repository policies still work.
3. Canonical `team.create` accepts optional `{ provider, payload }` context,
   projects it in the create result's `metadata`, and publishes one `team.created`
   event after a fresh successful creation. Identical retries emit no new event;
   changed request content retains existing idempotency-conflict behavior.
4. Context remains provider-opaque to Core and is not persisted as Team state.
   Ordinary status reads do not gain creation-only metadata; events are not replayed.
5. Feishu consumes only its own context with payload `{ chat_id, title }`, binds
   the existing group, updates COT ownership, and sends the existing binding card.
   Provider binding/notification failures do not reverse Team creation or fail its
   command. Session shutdown drains registered event handling.
6. Update public contract documentation, current maintenance instructions, and
   ordinary release notes. No schema migration or upgrade-blocking marker is needed.

## Decisions and unknowns

- The operator selected the new default after being told that it shares the
  dispatcher cwd. This supersedes the earlier default, not explicit isolation.
- The exact creation implementation selected in the comparison uses the canonical
  command seam; this task does not add context to agent-facing creation MCP tools.
- Blocking unknowns: none identified in the compared source.
