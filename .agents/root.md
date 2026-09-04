# dreamux knowledge base

This is the on-demand knowledge base for the `excitedjs/dreamux` repo.
Always-loaded operating rules live in [`/CLAUDE.md`](../CLAUDE.md).

The knowledge layers, in trust order:

1. [`/CLAUDE.md`](../CLAUDE.md) — big principles and pointers, always loaded.
2. [`product/`](product/README.md) — what the system promises its users,
   stated independently of implementation.
3. [`domains/`](domains/README.md) — how it is currently built: ownership,
   contracts, invariants, traps. One tree; there is no separate reference/.
4. [`tasks/`](tasks/README.md) — the full derivation record per requirement:
   rulings, design churn, evidence. Dense and messy by design; go here to know
   *why*, via each domain page's History pointer.

Nothing here is absolutely authoritative: every page is description plus
rationale, and anything may be changed to fit the current product scenario —
knowingly. A change to user-visible behavior is a requirement decision for the
operator. Routes fire more than once: re-run the table below at every stage
boundary of a long task and after every context compaction, not just at kickoff.

## Start Here

- [Product behavior catalog](product/README.md) — the baseline refactors diff
  against; also owns the [Dynamic Workflow usage guide](product/dynamic-workflow-usage.md).
- [Engineering whitepaper](skills/engineering-whitepaper/SKILL.md) — the
  operator's standing taste: entropy reduction, anti-defensive engineering,
  minimal mechanism, collaboration rhythm.
- [Current architecture](domains/current-architecture.md) — the map: package
  layout and per-area summaries with owner links.
- [Domain pages](domains/README.md) — the current-shape tree.
- [Development tasks](tasks/README.md) — README-indexed requirement lineage
  and task state.
- [Glossary](glossary.md) — overloaded Dreamux terms, each linking its owner.
- [KB contributing guide](CONTRIBUTING.md) — document kinds, conventions,
  validation.

## Task Routes

| You're about to ... | Read first |
|---|---|
| answer "how is Dreamux shaped now?" | [Current architecture](domains/current-architecture.md), then source |
| start any refactor, or judge whether something can be removed | [Product behavior catalog](product/README.md), [Engineering whitepaper](skills/engineering-whitepaper/SKILL.md) |
| run a multi-stage architecture refactor | [Large-refactor mode](skills/dev-workflow/references/large-refactor-mode.md), [Product behavior catalog](product/README.md) |
| change the repository through a feature, refactor, or bug fix | [Development workflow skill](skills/dev-workflow/SKILL.md), [Development tasks](tasks/README.md) |
| add/change a package or move source between packages | [Current architecture](domains/current-architecture.md) (package map), [Repository operations](domains/repository-operations-and-release.md) |
| install/build/test, add Rush change files, or release | [Repository operations and release](domains/repository-operations-and-release.md) |
| modify config loading, `agents[]`, `dispatchers[]`, or provider refs | [Provider runtime](domains/provider-runtime.md), [State, config, and files](domains/state-config-and-files.md) |
| modify any config/persisted-state shape, validation, default, ownership, or meaning | [State, config, and files](domains/state-config-and-files.md), [Model-facing writing](domains/model-facing-writing.md), and update the single owning reference under `packages/dreamux/skills/dispatcher/dreamux-maintenance/` plus its root route when needed |
| modify bundled maintenance routing or the managed-daemon self-upgrade SOP | [Dispatcher skills](domains/dispatcher-skill.md), [Model-facing writing](domains/model-facing-writing.md), and the archived [maintenance progressive-disclosure specification](archive/proposals/dreamux-maintenance-progressive-disclosure.md) |
| modify provider loading, Agent Runtime providers, or Channel providers | [Provider runtime](domains/provider-runtime.md), [Channel](domains/channel.md), [Current architecture](domains/current-architecture.md) |
| modify dispatcher runtime lifecycle, MCP injection, or Team/TeamMate lifecycle | [Dispatcher orchestration](domains/dispatcher-orchestration.md), [Service topology](domains/service-topology.md), source |
| refactor/move a service class or change who-owns-what | [Service topology](domains/service-topology.md) FIRST, then source |
| modify agent-entity identity/turn/runtime-state stores or name validation | [Dispatcher orchestration](domains/dispatcher-orchestration.md), [State, config, and files](domains/state-config-and-files.md), source `packages/dreamux/src/service/agent-entity/` |
| modify scheduled tasks / cron | [Scheduled work](domains/scheduled-work.md), source |
| modify bundled skills, system prompts, MCP descriptions, or tests locking model-visible text | [Model-facing writing](domains/model-facing-writing.md), [Dispatcher skills](domains/dispatcher-skill.md), then source |
| modify Channel routing, binding, targets, or Collaboration Space policy | [Channel](domains/channel.md), source |
| modify Feishu inbound, `/introduce`, pairing/access, or reaction timing | [Feishu pairing access](domains/feishu-pairing-access.md), [Non-blocking dispatcher inbound](domains/non-blocking-dispatcher-inbound.md), [Channel](domains/channel.md), source |
| touch codex busy/idle, `turn-manager.ts`, or inbound submission gating | [Non-blocking dispatcher inbound](domains/non-blocking-dispatcher-inbound.md) — read its Regression Trap before anything else |
| modify Dynamic Workflow behavior or its usage guide | [Current architecture](domains/current-architecture.md#dynamic-workflows), [Dynamic Workflow usage](product/dynamic-workflow-usage.md) |
| modify the anti-leak guardrail, `.gitleaks.toml`, `.npmrc`, CI, or hooks | [Repository operations and release](domains/repository-operations-and-release.md) |
| ask why an area is shaped this way | that domain page's History pointer, then the owning task record under [tasks/](tasks/README.md) |
| write or move KB content | [KB contributing guide](CONTRIBUTING.md) |

## Domains

- [Current architecture](domains/current-architecture.md) — the map.
- [Provider runtime](domains/provider-runtime.md)
- [Channel](domains/channel.md)
- [Feishu pairing access](domains/feishu-pairing-access.md)
- [Non-blocking dispatcher inbound](domains/non-blocking-dispatcher-inbound.md)
- [Dispatcher orchestration](domains/dispatcher-orchestration.md)
- [Service topology](domains/service-topology.md)
- [Dispatcher skills](domains/dispatcher-skill.md)
- [State, config, and files](domains/state-config-and-files.md)
- [Scheduled work](domains/scheduled-work.md)
- [Repository operations and release](domains/repository-operations-and-release.md)
- [Model-facing writing](domains/model-facing-writing.md)

## Research

- [Post-#110 architecture sustainability](research/post-110-architecture-sustainability.md)
  — frozen diagnosis of why agent-written code drifted after the pluginization
  inflection; its live backlog is tracked in
  [harness-gaps](tasks/architecture/harness-gaps/README.md).
- [Claude Code stream-json protocol](research/claude-code-stream-json-protocol.md)
  — frozen 2026-09-03 snapshot of what the CLI emits on stdout (live probe and
  SDK 0.3.259 types) against what the runtime reads; evidence for hiding
  `user` envelopes, with the deferred divergences.

## Active Proposals

- [Admin control plane surface](proposals/admin-control-plane-surface.md)
  — issue #295: the remaining control-plane slices (events, protocol baseline,
  introspection, inventory, authentication). The only active proposal; every
  implemented or superseded one lives in
  [archive/proposals](archive/proposals/README.md).

## Archive

- [Archive index](archive/README.md) — archived proposals, dissolved decision
  records, and extracted historical notes. Reachable, not a default path.

## Validation

Run before any KB-touching commit:

```bash
.agents/scripts/check.sh
```
