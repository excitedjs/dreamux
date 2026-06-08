# Named agents[] config normalization

- **Status:** Accepted, refines
  [providerized-config-state-compatibility](providerized-config-state-compatibility.md)
- **Date:** 2026-06-08
- **Affects:** `~/.dreamux/config.json` schema, `config/config.ts` parse/validate,
  `onboard/config-files.ts`, the agent-runtime catalog registration, the two
  builtin runtime config readers, dispatcher/teammate runtime resolution
- **PR / Issue:** [issue #148](https://github.com/excitedjs/dreamux/issues/148),
  absorbing [issue #146](https://github.com/excitedjs/dreamux/issues/146),
  following [issue #98](https://github.com/excitedjs/dreamux/issues/98)

## Context

The providerized config v2 envelope inlined runtime config inside each dispatcher
(`dispatchers[].runtime = { provider, config }`). That had two costs: runtime
config could not be reused or named ("one provider, multiple named configs"), and
a teammate launching its runtime unconditionally inherited the dispatcher's
config as its source — so a cross-provider teammate (a claude teammate under a
codex dispatcher) read the wrong config type and threw
`runtime provider "builtin:codex" is not wired to Claude Code`.

## Decision

Runtime config is hoisted to a top-level, named `agents[]` array. Dispatchers and
teammates reference an agent by id and carry no config block of their own.

```jsonc
{
  "agents": [
    { "id": "codex",  "provider": "builtin:codex",       "config": { "approval_policy": "never" } },
    { "id": "claude", "provider": "builtin:claude-code", "config": { "permission_mode": "default" } }
  ],
  "dispatchers": [
    { "id": "d1", "agentRuntime": "codex", "channels": [ { "provider": "builtin:feishu", "config": {} } ] }
  ]
}
```

Two id semantics, both spelled `id`:

| Field | Meaning | Constraint |
|---|---|---|
| `agents[].id` | config-internal reference alias, resolved at load | globally unique; not persisted, not an IPC/path key, no `validateDispatcherId` |
| `dispatchers[].id` | durable runtime identity (state/log/IPC key) | `validateDispatcherId` path-safety (unchanged) |

Channels stay inline under `dispatchers[].channels[]` (channel plugins are
deferred and carry per-dispatcher credentials).

### Load and resolution

- At load, `readAgents` parses each `agents[]` entry, validating its `config`
  block through that provider's `readConfig` (the core no longer branches on
  runtime identity — this is where issue #146 merges in). It builds an
  `id -> resolved { provider, config }` map kept on the in-memory
  `DreamuxConfig.agents`.
- Each dispatcher resolves its `agentRuntime` id against that map and populates
  the existing in-memory `DispatcherConfig.runtime = { provider, config }`. The
  in-memory shape is unchanged, so downstream readers (services, doctor,
  npm-detection) keep working; only the file schema and the parse layer change.
- The intended end state is that a teammate resolves its own `agentRuntime` id
  against `config.agents` into its own `{ provider, config }`, which structurally
  removes the cross-provider bug (no dispatcher-config inheritance to mismatch).
  The schema and `config.agents` map land here; rewiring the teammate service off
  its same-provider inheritance hack onto agent-id resolution is a follow-up
  phase.
- `DispatcherConfig` also keeps the referenced `agentRuntime` id in memory so the
  config round-trips back to the file shape (`stringifyConfig` is the in-memory →
  file translator; `DEFAULT_CONFIG_JSON` is routed through it).
- The builtin runtime providers are registered into the registry idempotently
  (guarded by `getImplementation(id) === undefined`) so config can register them
  for parsing while the server's factory-bearing registration still wins.

### #98 fail-loud (no migration shim)

The old shape and broken references each fail loudly at load with rebuild
guidance naming the file and the required new shape:

- a dispatcher carrying an inline `runtime` block;
- a dispatcher missing `agentRuntime`;
- an `agentRuntime` id with no matching `agents[].id` (dangling);
- a duplicate `agents[].id`;
- a top-level `agents` that is not an array.

`onboard` writes the new shape (one agent per dispatcher, agent id == dispatcher
id). The breaking change ships a rush change file with `BREAKING:` + `Rebuild:`.

## Consequences

- Config landing place is `agents[]` only; `dispatchers[].runtime` no longer
  exists on disk.
- Runtime config is reusable: multiple dispatchers can share one agent, and a
  teammate can select a different agent than its dispatcher.
- The teammate "inherit dispatcher config only when the provider matches" hack is
  slated for replacement by agent-id resolution against `config.agents` (a
  follow-up phase; this record lands the schema and the resolved map it needs).

## Alternatives considered

- **Keep inline `dispatchers[].runtime` and special-case teammates:** rejected;
  it preserves the inheritance bug and blocks named/shared runtime config.
- **Silently migrate the old shape:** rejected by issue #98.
