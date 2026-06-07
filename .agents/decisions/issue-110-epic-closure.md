# Issue 110 Epic closure check

- **Status:** Accepted
- **Date:** 2026-06-07
- **Affects:** plugin/provider architecture, Capability Registry,
  providerized config, doctor/onboard docs, Channel providers, Agent Runtime
  providers, server-hosted TeamMate
- **PR / Issue:** [issue #110](https://github.com/excitedjs/dreamux/issues/110),
  [issue #71](https://github.com/excitedjs/dreamux/issues/71),
  [issue #98](https://github.com/excitedjs/dreamux/issues/98)

## Context

Issue #110 expanded issue #71's registry-first cleanup into a full Phase 1
plugin/provider Epic. It also inherited issue #98's compatibility posture:
operator-owned config and sensitive state must fail loudly when incompatible;
Dreamux must not silently rewrite or infer the operator's intent.

PR1 through PR8 landed the architectural slices on the `next` integration
branch. PR9 is the closure and stabilization pass: make the completed behavior
usable and diagnosable, then close the Epic only after PR9 merges and validation
passes.

## Decision

Treat issue #110 as complete for Phase 1 when these checks hold:

- Provider refs support `builtin:<id>`, npm package refs, and npm package export
  refs. Npm refs are reserved only: parsed/validated, but never installed,
  imported, loaded, or executed.
- The in-process Capability Registry contains descriptors for the wired builtin
  providers and rejects duplicates, unknown builtins, wrong provider kinds, and
  reserved external refs clearly.
- Config v2 is providerized: `dispatchers[].channels[]` with `builtin:feishu`
  and `dispatchers[].runtime` with `builtin:codex` or `builtin:claude-code`.
  Old `dispatchers[].feishu` / `dispatchers[].codex` shapes fail loudly with
  rebuild guidance instead of being silently migrated.
- The Channel provider boundary owns channel lifecycle, channel MCP descriptors,
  Feishu access semantics, reply, and reaction capability. Dreamux core consumes
  provider capabilities and does not classify channels as one-way or two-way.
- The Agent Runtime provider boundary owns runtime launch/resume/stop, Dreamux
  MCP injection, inbound turn submission, and TeamMate completion delivery.
  `builtin:codex` and `builtin:claude-code` are both wired.
- Dreamux injects only Dreamux-owned MCP descriptors: Channel provider MCP and
  Dispatcher Service TeamMate MCP. User MCP servers remain configured directly
  in the selected Agent Runtime.
- Server-hosted TeamMate owns task scheduling, task state, a file-backed
  per-dispatcher ledger, completion delivery, bounded retry, `delivery_failed`
  retention, and read-only result retrieval. TeamMates cannot nested-dispatch
  TeamMates.
- Doctor, onboard docs, README/config examples, and tests describe the wired
  builtin providers, reserved npm refs, TeamMate state/retrieval, and #98
  fail-loud posture.

## Consequences

- The historical dispatcher/tm boundary is superseded for server-owned TeamMate
  state, scheduling, delivery, and retrieval. The `tm` wrapper can still exist
  as a packaged helper, but it no longer defines the long-term state boundary.
- The old target assumption "top-level one dispatcher equals one hard-coded
  Feishu channel plus one hard-coded Codex runtime" is superseded. Phase 1 still
  wires exactly one channel per dispatcher, but the config envelope and runtime
  boundary are providerized.
- `builtin:codex` remains the onboarding default. `builtin:claude-code` is a
  wired Agent Runtime provider, but operators must choose it explicitly in
  config v2.
- Closing issue #110 does not imply external provider execution, a marketplace,
  package trust policy, multi-channel routing, durable inbound buffers,
  autonomous worker execution, or cross-process automatic re-push of TeamMate
  results. Those need separate issues and decisions.

## Validation guardrails

- `.agents/scripts/check.sh` must pass for this closure record and linked
  documents.
- Config tests must cover valid v2 shapes, old-shape rejection, reserved npm
  refs, wrong provider kinds, and both builtin Agent Runtime config shapes.
- Doctor tests must cover provider-owned runtime binaries: Codex diagnostics for
  `builtin:codex` and non-Codex diagnostics for `builtin:claude-code`.
- TeamMate tests must cover scheduling, nested-dispatch rejection, ledger
  compatibility, completion delivery, bounded retry to `delivery_failed`, and
  result retrieval.
- Lint/typecheck must continue to enforce the no-sync-IO and typed provider
  boundaries.
