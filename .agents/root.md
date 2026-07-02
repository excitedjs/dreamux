# dreamux knowledge base

This is the on-demand knowledge base for the `excitedjs/dreamux` repo.
Always-loaded operating rules live in [`/CLAUDE.md`](../CLAUDE.md).

Use this KB for current reference, architecture intent, and decision history.
For current behavior, read the linked source code too.

## Start Here

- [Current architecture](reference/current-architecture.md) — compact current
  system map with source-code pointers.
- [Repository structure](reference/repo-structure.md) — package layout,
  install/build/test path, Rush change files, and public package/bin surface.
- [State and paths](reference/state-and-paths.md) — current config, workspace,
  state, run, cache, log, and external-home ownership.
- [Channel runtime](reference/channel-runtime.md) — Channel provider sessions,
  Feishu tools, target routing, and binding.
- [Service topology](reference/service-topology.md) — source-anchored
  service-layer ownership and construction map.
- [Glossary](glossary.md) — short definitions for overloaded Dreamux terms.
- [Decision index](decisions/README.md) — ADRs, with current-trail and
  historical-background sections.
- [KB contributing guide](CONTRIBUTING.md) — document kinds, link rules, and
  validation.

## Task Routes

| You're about to ... | Read first |
|---|---|
| answer "how is Dreamux shaped now?" | [Current architecture](reference/current-architecture.md), then source |
| add/change a package or move source between packages | [Repository structure](reference/repo-structure.md) |
| install/build/test the repo or debug workspace install issues | [Repository structure](reference/repo-structure.md), [install model](decisions/install-model.md) |
| add or verify Rush change files | [Repository structure: Rush change files](reference/repo-structure.md#rush-change-files) |
| modify config loading, `agents[]`, `dispatchers[]`, provider refs, or config compatibility | [Current architecture](reference/current-architecture.md), [agents config normalization](decisions/agents-config-normalization.md), [providerized config compatibility](decisions/providerized-config-state-compatibility.md) |
| modify state/cache/run/log paths | [State and paths](reference/state-and-paths.md), [runtime run root](decisions/runtime-run-root.md), [top-level design](decisions/top-level-design.md) |
| modify provider loading, Agent Runtime providers, Channel providers, or capabilities | [Current architecture](reference/current-architecture.md), [Channel runtime](reference/channel-runtime.md), [Provider architecture realignment](decisions/provider-architecture-realignment.md), [provider refs and registry](decisions/provider-references-and-capability-registry.md), [NPM package split and channel targets](decisions/npm-package-split-and-channel-targets.md) |
| modify dispatcher runtime lifecycle or MCP injection | [Current architecture](reference/current-architecture.md), [dispatcher local aggregate](decisions/dispatcher-local-aggregate.md), [service architecture refactor](decisions/service-architecture-refactor.md), source |
| modify scheduled tasks / cron jobs | [Scheduled tasks](reference/scheduled-tasks.md), [Agent activity capability](decisions/agent-activity-capability.md), [Json document store](decisions/json-document-store.md), source |
| refactor/move a service class or change who-owns-what | [Service topology](reference/service-topology.md) FIRST, then source |
| modify TeamMate / Team lifecycle, read surfaces, or bundled dispatcher skills | [Dispatcher skill reference](reference/dispatcher-skill.md), [provider architecture realignment](decisions/provider-architecture-realignment.md), [top-level design](decisions/top-level-design.md), [service architecture refactor](decisions/service-architecture-refactor.md) |
| modify channel binding or channel target routing | [Channel runtime](reference/channel-runtime.md), [NPM package split and channel targets](decisions/npm-package-split-and-channel-targets.md), source |
| modify Feishu inbound, `/introduce`, trusted bot context, or reaction timing | [Channel runtime](reference/channel-runtime.md), [Feishu introduce](domains/feishu-introduce.md), [Feishu pairing access](domains/feishu-pairing-access.md), [non-blocking dispatcher inbound](domains/non-blocking-dispatcher-inbound.md), source |
| modify Feishu attachment download/cache behavior | [Feishu inbound attachments](decisions/feishu-inbound-attachments.md) |
| modify onboard, daemon, uninstall, or public CLI names | [Global bin/onboard/serve](decisions/global-bin-onboard-serve.md), [CLI and package naming](decisions/cli-and-package-naming.md) |
| modify the anti-leak guardrail, `.gitleaks.toml`, `.npmrc`, CI, or hooks | [Anti-leak guardrail](decisions/anti-leak-guardrail.md) |
| modify npm publishing or release workflows | [NPM release OIDC](decisions/npm-release-oidc.md) |
| inspect historical hardening backlog | [Archived Post-MVP hardening](archive/proposals/post-mvp-hardening.md) |
| write or move KB content | [KB contributing guide](CONTRIBUTING.md) |

## Document Kinds

- `reference/` — current behavior and operational mental models. Prefer this
  for "what exists now".
- `decisions/` — accepted, superseded, or historical ADRs. Prefer this for
  "why was this chosen".
- `domains/` — current cross-cutting runtime contracts that span multiple
  reference pages, such as Feishu gate, trust, and inbound timing contracts.
- `proposals/` — active design proposals only.
- `archive/` — preserved historical material. It is intentionally reachable but
  not part of the default task path.

## Current Reference

- [Current architecture](reference/current-architecture.md)
- [Repository structure](reference/repo-structure.md)
- [State and paths](reference/state-and-paths.md)
- [Channel runtime](reference/channel-runtime.md)
- [Service topology](reference/service-topology.md)
- [Dispatcher skill and TeamMate workflow](reference/dispatcher-skill.md)
- [Scheduled tasks](reference/scheduled-tasks.md)
- [Release process](reference/release-process.md)
  — operator-facing 4-stage SOP (PR → next → alpha → beta → promote-next →
  main → stable publish), the strict main-is-ancestor-of-next topology
  invariant, the GITHUB_TOKEN anti-loop workaround + sync-next repair
  commitment built into the release workflow, and a failure-mode recovery
  table for each release gate.
- [Glossary](glossary.md)

## Decisions

Start with [decisions/README.md](decisions/README.md). Decision files preserve
history and rationale; when you need current behavior, pair them with
[Current architecture](reference/current-architecture.md) and source.

## Domains

- [Feishu introduce](domains/feishu-introduce.md)
- [Feishu pairing access](domains/feishu-pairing-access.md)
- [Non-blocking dispatcher inbound](domains/non-blocking-dispatcher-inbound.md)

## Active Proposals

- [AgentRuntime input surface cleanup](proposals/agent-runtime-input-surface-cleanup.md)
  — draft technical design for narrowing the provider-facing runtime input
  surface: plain text `completionInput` for non-channel turns, `channelInput`
  only for channel-originated XML rendering, provider-owned skill layout
  materialization, and removal of Dreamux structural `role` from
  `AgentRuntimeCreateContext`.
- [AgentRuntime lifecycle contracts](proposals/agent-runtime-lifecycle-contracts.md)
  — draft technical design for the minimum neutral Agent Runtime contract:
  Dreamux logical turns, turn-owned settlement results, opaque checkpoints,
  terminal completion-delivery semantics, instance-scoped runtime state facts,
  provider-owned role prompt injection, and external runtime handle validation
  while keeping native CLI/daemon details provider-owned.
- [Kimi Code ACP Agent Runtime provider](proposals/kimi-code-acp-agent-runtime-provider.md)
  — draft technical design for integrating Kimi Code through its public ACP
  server as an external Agent Runtime provider, including prompt append and
  skill materialization through `KIMI_CODE_HOME`, MCP descriptor mapping,
  logical turn semantics, and checkpoint replacement on lost ACP sessions.
- [TeamMate identity system prompt](proposals/teammate-identity-system-prompt.md)
  — draft requirement/spec for adding a minimal `identity` input to
  `teammate.spawn` and `team.create`, persisting it on TeamMate identity records,
  and rendering it as provider-neutral system-prompt append guidance rather than
  first-turn prompt text.
- [Dispatcher Team MCP send to TeamLeader](proposals/team-mcp-dispatcher-send.md)
  — draft requirement/spec for adding a dispatcher-only Team MCP `send` tool
  that submits turns to an existing Team's TeamLeader, registers completion
  delivery back to the dispatcher at send time, and leaves Team peer messaging
  out of this slice.
- [TeamLeader-scoped Team MCP transfer back](proposals/team-mcp-teamleader-transfer-back.md)
  — draft requirement/spec for exposing only `transfer_back` from Team MCP to
  TeamLeaders, keeping dispatcher Team lifecycle tools private, keeping explicit
  provider target `meta`, moving channel binding ownership to a core
  `ChannelService` over live sessions plus `ChannelBindingStore`, and recording
  the future `team.send` parity requirement without implementing it in this
  slice.
- [Post-#110 architecture sustainability](proposals/post-110-architecture-sustainability.md)
  — diagnostic of why agent-written code drifted from the intended architecture
  after the #110 pluginization inflection (load-bearing invariants are prose with
  no executable backstop; the ownership map lives outside the queryable KB; review
  bypassed at land-first merges) plus a prioritized, mostly-executable improvement
  backlog (topology map + ownership/boundary fitness functions + process gates).

Move an active proposal out of `proposals/` once it is implemented,
superseded, or abandoned; preserve the old text under `archive/` when the
history still matters.

## Archive

- [Archive index](archive/README.md)
- [Archived proposals](archive/proposals/README.md)

## Validation

Run before any KB-touching commit:

```bash
.agents/scripts/check.sh
```
