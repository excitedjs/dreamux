# Named agents[] config normalization

- **Status:** Accepted, refines
  [providerized-config-state-compatibility](providerized-config-state-compatibility.md)
- **Date:** 2026-06-08
- **Affects:** `~/.dreamux/config.json` schema, `config/config.ts` parse/validate,
  `onboard/config-files.ts`, the agent-runtime catalog registration, the two
  builtin runtime config readers, dispatcher/teammate runtime resolution,
  `cli/doctor.ts` + the provider `diagnostic` capability (codex version floor)
- **PR / Issue:** [issue #148](https://github.com/excitedjs/dreamux/issues/148),
  absorbing [issue #146](https://github.com/excitedjs/dreamux/issues/146) and the
  doctor half of [issue #147](https://github.com/excitedjs/dreamux/issues/147)'s
  codex 0.137 requirement, following
  [issue #98](https://github.com/excitedjs/dreamux/issues/98)

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
- A teammate resolves its own `agentRuntime` id against `config.agents` into its
  own `{ provider, config }` and hands the provider a create-context dispatcher
  whose `runtime` is that resolved runtime (other dispatcher fields copied from
  the real dispatcher config). This structurally removes the cross-provider bug —
  there is no dispatcher-config inheritance left to mismatch. `spawn` takes
  `agentRuntime` (an `agents[].id`, was `provider_ref`); omitting it falls back to
  the dispatcher's own `agentRuntime` id (no provider-ref fallback). The teammate
  identity record persists `agent_runtime` (was `provider_ref`) so resume
  re-resolves the config; a pre-#148 identity or an `agent_runtime` that no longer
  matches any agent fails loud rather than silently defaulting a runtime.
- `DispatcherConfig` also keeps the referenced `agentRuntime` id in memory so the
  config round-trips back to the file shape (`stringifyConfig` is the in-memory →
  file translator; `DEFAULT_CONFIG_JSON` is routed through it).
- The builtin runtime providers must already be registered in the registry
  `readAgents` validates against (each agent's `config` is parsed through its
  provider's `readConfig`). Registration is **caller-composed, not done by
  `config/config.ts`**: the config module is a schema/parse leaf and never
  imports the runtime catalog. `cli/server.ts` hands `loadConfig` a
  factory-bearing registry it built; the leaf entry points
  (doctor / daemon / onboard) call `loadConfigWithBuiltins`
  (`agent-runtime/load-config.ts`), which builds a registry, registers the
  builtins idempotently (guarded by `getImplementation(id) === undefined`), then
  delegates to `loadConfig`. A bare `loadConfig` against a registry with a
  registered-but-unimplemented builtin fails loud in `readAgents` ("registered
  but not runnable"). External `npm:` providers still load inside
  `readConfigFile` via the dynamic-import loader.

#### De-cycle (post-#148 hotfix)

The first #148 cut had `config/config.ts` import
`registerBuiltinAgentRuntimeProviders` from `agent-runtime/catalog.ts` directly.
That formed a static ESM import cycle —
`config/config.ts → catalog → builtin/* → platform/paths.ts → config/config.ts`
(`platform/paths.ts` reads `BUILT_IN_DEFAULTS` at module top level) — which
crashed the built CLI on cold start with
`Cannot access 'BUILT_IN_DEFAULTS' before initialization` (a temporal-dead-zone
read). `tsc` and `vitest` (transpiled, hoisted) did not surface it; only the
built artifact did. The fix moves registration out of the leaf to the
caller-composed `loadConfigWithBuiltins`, severing the upward edge at its root
(rather than deferring the TDZ read).

**Invariant (precise — the hazard is reaching `platform/paths.ts`, not the
`builtin/` directory name):**

- `config/config.ts` and `platform/paths.ts` must never statically import
  `agent-runtime/catalog.ts` or any builtin **runtime / provider / transport /
  paths** module — i.e. anything that transitively imports `platform/paths.ts`.
  Those are the edges that close the cycle.
- `config/config.ts` **may** re-export from the builtin **config** modules
  (`builtin/codex/config.ts`, `builtin/claude-code/config.ts`). This is the
  intentional M2 back-compat surface so non-builtin callers keep their
  `config/config.js` import paths. It is cycle-free *because* those two modules
  are deliberately kept as leaves: they import only `registry/` and
  `config/validate.ts`, never `platform/paths.ts` and never `config/config.ts`.
  That leaf property is load-bearing and is guarded by a comment in each of the
  two files — do not add a `platform/paths` or `config/config` import there.
- `agent-runtime/load-config.ts` must never be imported by `platform/paths.ts`
  or by any `builtin/*` module.

Guarded by the `smoke-built-cli` gate (a fresh-Node `bin/dreamux --version` run
in CI and before release publish), which exercises the compiled cold-start path
that the unit tests cannot. `madge --circular dist/` (types erased = runtime
truth) is the check: after this fix it shows no `config`/`paths` cycle, only two
pre-existing intra-`builtin/codex/` cycles.

### Provider-self-reported doctor diagnostics (issue #146 doctor half)

`AgentRuntimeProvider` gains an optional `diagnostic` capability so `cli/doctor.ts`
stops branching on `BUILTIN_CODEX_PROVIDER_REF`:

- The provider **declares** `binChecks(context)` — pure `{ name, bin, args }`
  descriptors. Doctor dedups them across dispatchers via its existing Map and
  executes them (foreground via `runner.check`; managed-service via a launch
  under the unit env). The descriptor name is scope-aware
  (`'codex binary'` vs `'managed service Codex binary'`), so the provider owns
  its own labels.
- The provider **runs** `runDiagnostic(context, runner)` for its own non-bin
  internal checks, returning a neutral `AgentRuntimeDoctorResult { ok, detail,
  errors }`. codex validates its codex-home (the prior
  `validateDispatcherCodexHome`) and gates the codex version; claude has no
  host-managed state and returns a neutral pass.
- Doctor keeps the per-dispatcher `DispatcherDoctorReport[]` shape and runs the
  diagnostic twice per dispatcher (foreground env + installed managed-service
  env). The old codex-specific `DispatcherRuntimeDoctorResult` union is gone;
  `foreground`/`managedService` are the neutral result. The diagnostic runner is
  a minimal `{ check, capture }` interface declared in `agent-runtime/types.ts`,
  so the provider never imports `cli/doctor`.
- Residual (acceptance is near-zero, not zero): `rejectTopLevelCodex` at the
  config parse layer, and the empty-dispatchers default-codex bin check in doctor
  (no dispatcher means no agents[] entry to drive a provider).

#### Codex version floor (issue #147 fold)

The codex diagnostic enforces `MIN_CODEX_VERSION = '0.137.0'`: it runs
`codex --version`, parses the `major.minor.patch` triple, and compares
component-wise (numeric, not string). Below 0.137 it fails loud. Reason: the
teammate-completion reverse leg appends the completion to the dispatcher thread
via `thread/inject_items`, an RPC that exists only on codex >= 0.137 — doctor
surfaces the requirement up front rather than letting a teammate completion
silently RPC-fail at runtime.

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
  gone, replaced by agent-id resolution against `config.agents`. A teammate runs
  with its own named agent's config, so a claude teammate under a codex dispatcher
  starts cleanly instead of throwing "is not wired to Claude Code".

## Alternatives considered

- **Keep inline `dispatchers[].runtime` and special-case teammates:** rejected;
  it preserves the inheritance bug and blocks named/shared runtime config.
- **Silently migrate the old shape:** rejected by issue #98.
