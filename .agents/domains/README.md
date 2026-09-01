# Domain Knowledge

Domain pages are stable, module-oriented reading paths for current Dreamux
contracts. They summarize settled design that used to be scattered across ADRs.
For why a design was chosen, follow each page's decision trail.

Before changing code, verify the linked source files. These pages are navigation
and invariants, not a substitute for reading the implementation.

These pages describe what is and why — they are evidence, not preservation
orders. A refactor may overturn anything here to fit the current product
scenario, knowingly: name what changes, why the recorded rationale no longer
holds, and update the page in the same change. User-visible behavior changes
are operator decisions
(see [the product behavior catalog](../product/README.md)).

## Core Domains

- [Provider runtime](provider-runtime.md) — provider refs, package boundaries,
  named `agents[]`, runtime create context, skills, prompts, diagnostics, and
  provider-neutral core.
- [Channel routing and binding](channel-routing-and-binding.md) — Channel
  providers, provider tools, target normalization, Team MCP binding, routing,
  and TeamLeader egress authorization.
- [Dispatcher orchestration](dispatcher-orchestration.md) — Dispatchers,
  DispatcherService, Team/TeamMate collections, `TeammateService`,
  object-owned completion delivery, MCP projections, and workspaces.
- [State, config, and files](state-config-and-files.md) — local config,
  state/run/cache/log layout, upgrade policy, JSON stores, workspaces, and logs.
- [Scheduled work](scheduled-work.md) — per-conversational-agent cron,
  immediate fire semantics, scheduler ownership, and current prompt-agent scope.
- [Repository operations and release](repository-operations-and-release.md) —
  Rush/pnpm install path, package/bin surface, public-repo safeguards, lint
  gates, changelog responsibility, and npm release workflow.

## Feishu Domains

- [Feishu introduce](feishu-introduce.md)
- [Feishu pairing access](feishu-pairing-access.md)
- [Non-blocking dispatcher inbound](non-blocking-dispatcher-inbound.md)
