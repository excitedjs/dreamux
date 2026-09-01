# Domains

The single current-shape tree: how Dreamux is built today, one page per area —
ownership, contracts, invariants, and Regression Traps, with source pointers
`check.sh` keeps alive. These pages describe what is and why; they are
evidence, never preservation orders. A refactor may overturn anything here to
fit the current product scenario, knowingly: name what changes, why the
recorded rationale no longer holds, and update the page in the same change.
User-visible behavior changes are operator decisions — diff against
[the product behavior catalog](../product/README.md).

Load-bearing invariants a coder needs while editing a directory live in that
directory's `CLAUDE.md` (they travel with the code diff); these pages link down
rather than copying. Each page ends with a History pointer into the task tree,
where the full derivation and rulings live.

- [Current architecture](current-architecture.md) — the map: process model,
  package layout, per-area summaries with owner links.
- [Provider runtime](provider-runtime.md) — the Agent Runtime seam, config
  contract, prompts, bundled-skill injection, activity reads.
- [Channel](channel.md) — the Channel seam, sessions, routing, binding,
  targets, Collaboration Spaces, Feishu inbound fidelity, COT display.
- [Feishu pairing access](feishu-pairing-access.md) — V3 access state,
  pairing, `/introduce`, trust policies.
- [Non-blocking dispatcher inbound](non-blocking-dispatcher-inbound.md) — the
  issue #63 gate; read its Regression Trap before touching codex busy/idle.
- [Dispatcher orchestration](dispatcher-orchestration.md) — dispatchers,
  collections and services, Team/TeamMate lifecycle, completion routing,
  workspaces, MCP boundaries.
- [Service topology](service-topology.md) — the source-anchored ownership map
  for service-layer objects; read FIRST before moving any service class.
- [Dispatcher skills](dispatcher-skill.md) — bundled skill injection and the
  role-visible MCP tool surfaces.
- [State, config, and files](state-config-and-files.md) — config, durable
  state, run/cache/log ownership, upgrade policy.
- [Scheduled work](scheduled-work.md) — cron stores, fire semantics, owners.
- [Repository operations and release](repository-operations-and-release.md) —
  install/build/test, change files, guardrails, the release SOP.
- [Model-facing writing](model-facing-writing.md) — the contract for text a
  model can see: skills, prompts, MCP descriptions, results, failures.
