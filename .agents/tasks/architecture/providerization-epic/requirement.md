# Backfilled decision records: providerization epic records

> Backfilled 2026-09-01 from the dissolved `.agents/decisions/` tree on
> operator instruction: task records are the single derivation layer. Each
> section preserves one record verbatim (original heading, status, and date;
> headings demoted one level for nesting). Later reality is recorded only in
> dated "Since this was recorded" subsections; historical text is never edited.

## provider-architecture-realignment

## Provider architecture realignment

- **Status:** Accepted (remediation tracked in issue #135; implemented through
  the PR F external Agent Runtime loading cut)
- **Date:** 2026-06-08
- **Affects:** Agent Runtime providers, TeamMate agent state, Dispatcher
  Service, Capability Registry, Channel providers, MCP injection, `server.ts`
- **PR / Issue:** [issue #135](https://github.com/excitedjs/dreamux/issues/135);
  refines/supersedes the architectural claims in
  [provider-references-and-capability-registry](/.agents/tasks/architecture/providerization-epic/requirement.md#provider-references-and-capability-registry),
  [agent-runtime-provider](/.agents/archive/decisions/agent-runtime-provider.md),
  [channel-provider](/.agents/archive/decisions/channel-provider.md), and
  [server-hosted-teammate](/.agents/archive/decisions/server-hosted-teammate.md)

### Context

`#110` introduced the plugin / provider / capability abstraction and `#126`
extended it to TeamMate worker execution. A review against the original design
intent found both Epics drifted from the same root: things that should not be
plugin seams were modeled as providers, the one runtime abstraction was forked
into two, and the load-bearing Dispatcher Service was never given an entity.
This record fixes the target so future work stops reverse-engineering intent
from code.

### Decision

The target architecture is:

- **One `AgentRuntime` abstraction** serves every agent role — dispatcher,
  teammate, team-leader, and (future) team member. Roles are NOT distinct
  runtime types; a role is the same runtime launched by the Dispatcher Service
  with a **role-specific injected MCP tool set** plus a **role-specific system
  prompt**. The `TeamMateWorkerProvider` parallel tree
  (`/packages/dreamux/src/teammate/worker/`) is removed. The runtime interface
  covers single-instance operations only: start/resume/stop, inbound/turn
  submission, steering capability, context reads, and upward result delivery.
  Cold history is a provider-level `readTranscript()` query so it also works
  after the live runtime object is gone. Dispatcher orchestration verbs such as
  `spawn`, `close`, and `list` stay on the Dispatcher Service and must not be
  instance methods on `AgentRuntime`. The "one task = one turn, reap" worker
  model is replaced by a semi-resident, resumable session that the dispatcher
  controls.
- **Dispatcher Service is a real module**, not a role smeared across
  `/packages/dreamux/src/server.ts` and `/packages/dreamux/src/teammate/`. It is
  launched by the server, holds the dispatcher agent (lifecycle tied to the
  server: started at boot, resumed on restart), and owns TeamMate spawn, send,
  close, read/recovery verbs, and teammate runtime instances (issue #155 removed
  the standalone `resume` verb; `send` now reopens a closed teammate). The
  dispatcher agent commands it over MCP.
- **Nested dispatch is prevented by MCP injection, not a runtime check.** A
  teammate / team-leader agent is simply not injected the "spawn TeamMate" tool;
  it is injected inter-agent communication tools instead (agent↔dispatcher,
  agent↔team-leader, agent↔agent).
- **Exactly two plugin seams: `agentRuntime` and `channel`.** The `'service'`
  provider kind is removed — Dispatcher Service is a dreamux core capability and
  must not be modifiable by external plugins.
- **External provider loading is made real for the `agentRuntime` seam.** The
  `npm:` ref grammar must actually load external/closed-source or third-party
  runtimes that cannot be vendored into this open repo, not just reserve
  syntax.
- **The `channel` plugin seam is interface-only this cycle.** Define the TS
  interface with proper reservations for subscription-style channels (github /
  jira) that inject arbitrary channel MCP and push subscribed events to agents;
  do not implement external channel loading yet.
- **Feishu is pulled out of the plugin seam.** It is a built-in *bidirectional
  conversational* channel, a different category from subscription-style channel
  plugins; its chat→agent binding model is expected to change with the Team
  work (different group chats binding to different team-leaders rather than all
  to the dispatcher). The current `ChannelConnection = FeishuBot` and 1:1
  dispatcher binding are temporary.
- **The Capability Registry is demoted to a provider registry / loader.** It
  resolves `builtin:` and `npm:` refs to provider implementations. The config
  loader creates or receives one registry instance, loads external runtime
  providers into that instance, validates config through it, and passes the same
  instance into server startup. No default builtin singleton may become a
  separate fallback that rejects already-loaded `npm:` refs. The capability
  *mirror* (registry-declared capabilities duplicated by provider methods, kept
  in sync by a drift test) is removed; capability is a single provider-owned
  declaration that core actually reads — to compose the channel tool surface,
  and to know per-runtime support (resume / steer / completion-delivery shape).
  Runtime catalogs are registry views: they resolve descriptors from the
  registry and read the implementation already registered there, rather than
  maintaining a second provider map.
- **Channel tool handlers move out of core.** A channel plugin owns its MCP
  end-to-end (tool definitions + handlers); core injects the descriptor and
  provides the connection, and no longer carries `*FromMcp` handlers in
  `server.ts`.

#### TeamMate layer (agent-centric)

The teammate layer follows the agent-centric dispatcher model proven in the
sibling open-source repo claudemux
(https://github.com/excitedjs/claudemux/tree/main/plugins/claudemux/src) —
see its `verbs/` (spawn/resume/history), `persistence/history-index.ts` and
`identity-store.ts`, `engines/types.ts`, and `engines/teammate-record.ts`.

- **No `task` abstraction.** A teammate is a persistent, resumable agent
  identified by a stable name — not a one-shot task runner. The current
  `/packages/dreamux/src/teammate/ledger.ts` task state machine (`task_id`,
  `schedule`, `run_task`, `execute_task`) is removed. Task decomposition and
  assignment stay in the dispatcher agent (its own todolist-style tools); the
  teammate layer only knows teammate identities.
- **Dispatcher-facing verbs, no unified suffix:** `spawn`, `send`, `close` for
  lifecycle; `history`, `list`, `status`, `last`, `get_capabilities` for
  read/recovery. `history` is the identity/lifecycle recovery search surface,
  served from per-entity `identity.json`; `last` cold-reads completed turns from
  the selected Agent Runtime provider's native transcript. Issue #188 reworked
  both and removed the obsolete `ctx` and raw `history_events` verbs; the
  current native-transcript contract supersedes the later Dreamux per-name Turn
  archive. See
  [Dispatcher orchestration](/.agents/domains/dispatcher-orchestration.md).
  `spawn`/`send` return after submitting
  the runtime turn; the dispatcher recovers through history/last instead of a
  task result ledger. (Issue #155 dropped the original standalone `resume`
  verb — see below.)
- **send subsumes resume (issue #155).** The original design carried a separate
  `resume` verb to bring back a prior teammate session with its history; that is
  gone. `send` now reopens a teammate that is not live — including a `close`d one
  — by rebuilding the resume checkpoint from the record's runtime-native
  `session_id` plus the runtime's own declared checkpoint kind (issue #199 Slice
  3; the kind is never persisted), then submits, so `close` is a reversible
  soft-stop. Read-only verbs never reopen a closed teammate.
- **History reads the record, not an event stream (issue #199 Slice 3).**
  `history` / `list` / `status` project per-entity `identity.json`: identity,
  lifecycle, worktree, intent, and runtime-session facts only. There is no
  rolling turn count, last-seen timestamp, prompt preview, or assistant preview.
  `last` delegates to the runtime provider's native transcript and persists no
  Dreamux copy, cursor, or index. Per-runtime checkpoint mechanics and native
  transcript discovery stay behind the provider's neutral contract.
- **Identity and state location.** A teammate is a flat name plus a base record
  (agent runtime id, dispatcher owner, source/runtime cwd, optional managed
  worktree metadata, runtime-native `session_id`, nullable opaque
  `transcript_locator`, status, close metadata). State is server-owned under
  `~/.dreamux/state/<dispatcher>/teammate/`; paths go through
  `/packages/dreamux/src/platform/paths.ts`. Current entities use one
  `teammate/<name>/identity.json`; a per-entity `turn.jsonl` left by an older
  release is inert residue that Dreamux never reads, validates, or requires the
  operator to remove. See
  [State, config, and files](/.agents/domains/state-config-and-files.md).
- **Ownership.** The Dispatcher Service owns TeamMate identity and history
  through focused modules under
  `/packages/dreamux/src/service/teammate-collection/`.

### Consequences

- Several `#110` / `#126` decisions are refined: the registry stops being a
  "capability registry", `agentRuntime` and `channel` are the only provider
  kinds, and TeamMate execution is no longer a separate provider tree.
- `server.ts` loses the ~12 `*TeamMate*FromMcp` methods, channel `*FromMcp`
  handlers, and hard-spliced MCP injection — they move into the Dispatcher
  Service and the channel/runtime plugins.
- PR C extracted a thin `DispatcherService`; PR D replaces the old task/worker
  implementation with agent-centric TeamMate verbs. `server.ts` wires the
  service, admin/MCP handlers validate params and delegate to it, and the
  service owns TeamMate identity, history, lifecycle, and live runtime map.
- PR D deletes `/packages/dreamux/src/teammate/ledger.ts`,
  `/packages/dreamux/src/teammate/delivery.ts`,
  `/packages/dreamux/src/teammate/wait-broker.ts`,
  `/packages/dreamux/src/teammate/worker-execution.ts`,
  `/packages/dreamux/src/teammate/worker-logs.ts`, and
  `/packages/dreamux/src/teammate/worker/`. There is no parallel
  `TeamMateWorkerProvider` tree or `task_id` API after this cut.
- PR E's original "Feishu wired in core" direction is **superseded by issue
  #209**. The current implementation loads `builtin:feishu` through the Channel
  provider loader/catalog from `@excitedjs/feishu-channel`; the removed
  `/packages/dreamux/src/channel/feishu-channel.ts`,
  `/packages/dreamux/src/channel/feishu-mcp-surface.ts`, and
  `/packages/dreamux/src/channel/feishu-provider.ts` paths must not be
  reintroduced. Core owns Team routing/binding and the generic provider-tool MCP
  conduit only.
- PR E also closes the dispatcher-agent ownership debt: `DispatcherService`
  delegates dispatcher runtime/channel lifecycle to
  `/packages/dreamux/src/service/dispatcher-service/index.ts`, which owns
  live dispatcher slots, start coalescing, stop, runtime lookup, restart-notice
  injection, and Feishu channel MCP dispatch. `/packages/dreamux/src/server.ts`
  is wiring only.
- PR F implements `npm:` Agent Runtime loading: dynamic import, provider factory
  validation, same-registry registration, provider-owned capability
  declarations, and fail-loud startup errors.
- Hard-coded `BUILTIN_*_REF` branching across core (`server.ts`,
  `/packages/dreamux/src/runtime/config.ts`,
  `/packages/dreamux/src/cli/doctor.ts`) is expected to shrink as core consumes
  provider implementations instead of provider-specific names.
- This is an upgrade blocker by the root `CLAUDE.md` changelog rule once
  implemented: it touches provider config semantics, state/runtime layout, and
  bundled MCP/skill surfaces. The implementing PRs must ship `rush change`
  notes.

### Future extension points (not in scope, but the design must not preclude them)

- A **Team Service** under the Dispatcher Service: the dispatcher creates a team
  of a team-leader plus 3–4 member agents that communicate, debate, and
  challenge each other; the dispatcher connects only to the team-leader.
- Feishu's many-to-many group-chat → team-leader binding rework.

### Since this was recorded (2026-09-01)

The architectural direction stands. The provider contract shape half is superseded by #350: `readTranscript` became the neutral `readRecentActivity` (`/packages/dreamux-types/src/agent-runtime.ts`), per-runtime capability declarations reduced to `getCapabilities(): { tags, publicConfig? }`, and the once interface-only channel seam is implemented.


---

## provider-references-and-capability-registry

## Provider references and Capability Registry

- **Status:** Accepted, refined by
  [npm-package-split-and-channel-targets](/.agents/tasks/architecture/npm-package-split/requirement.md#npm-package-split-and-channel-targets)
- **Date:** 2026-06-06
- **Affects:** provider references, plugin manifests, Capability Registry,
  dispatcher startup validation, MCP descriptor discovery
- **PR / Issue:** [issue #110](https://github.com/excitedjs/dreamux/issues/110)

### Context

Issue #71 proposed a registry-first internal cleanup. Issue #110 expands that
into a provider architecture for Channel providers, Agent Runtime providers, and
Dispatcher Service capabilities.

The architecture needs a public ref syntax that can describe builtin providers
and externally installed package/export providers. It also needs a registry that
lets Dreamux core discover runtime implementations without hard-coding every
runtime or MCP surface in the server.

### Decision

Use explicit provider refs and an in-process Capability Registry.

Provider refs have string shorthand and a normalized internal object form:

```text
builtin:<id>
npm:<package-spec>
npm:<package-spec>#<export-name>
```

Examples:

```text
builtin:codex
builtin:claude-code
npm:@example/dreamux-provider
npm:@example/dreamux-provider#thirdPartyRuntime
```

The normalized form separates source, package, export, and builtin id so config
validation and future manifests do not depend on ad hoc string parsing after
startup.

Builtin provider descriptors are registered eagerly for both `agentRuntime`
(`builtin:codex`, `builtin:claude-code`) and `channel` (`builtin:feishu`).
External refs in `dispatchers[].runtime.provider` and
`dispatchers[].channels[].provider` are loaded before config validation by
dynamic-importing the installed package, selecting its default export or
`#named` export, calling the provider factory with the seed descriptor, and
registering the returned provider implementation into the same registry instance
used by config validation and server startup. Dreamux does not install provider
packages; a missing package, missing export, invalid provider contract, incomplete
capability declaration, or descriptor mismatch fails startup loudly with the
selected provider ref.

Issue #209 demotes the old "Capability Registry" idea into a process-local
provider registry / loader. Wired runtime providers attach their implemented
capabilities to the provider implementation. Codex and Claude Code both own the
same `AgentRuntimeProvider` interface with their own delivery shapes. Feishu owns
the `ChannelProvider` implementation behind `builtin:feishu`; core consumes it
through the channel catalog, the same shape future `npm:` channel providers use.
The registry records descriptors and implementation handles only; it does not
mirror or synthesize provider capabilities.

The provider registry is process-local and server-owned. It records:

- provider descriptors;
- provider kind (`agentRuntime` or `channel`);
- provider-local implementation handles;
- validation status.

Core consumers must consume runtime and channel providers from the registry view
instead of maintaining parallel provider maps. Provider-specific channel MCP
surfaces are contributed by the selected Channel provider and injected by the
Dispatcher Service; Team binding remains a Dreamux Team MCP capability.

### Consequences

- Builtin Agent Runtime and Channel providers become explicit extension points
  rather than special server branches.
- External provider packages use the same registry, lifecycle, and Dispatcher
  Service creation path as builtin providers of the same kind.
- Startup validation must distinguish "unknown builtin", "external package or
  export failed to load", "invalid provider contract", and "registered
  descriptor without runnable implementation".
- Feishu channel behavior is reviewed at the `@excitedjs/feishu-channel`
  provider boundary, not as core-owned special-case wiring.

### Alternatives considered

- **Hard-code builtin providers until external plugins exist:** rejected because
  Channel and Agent Runtime abstractions would still be shaped by Feishu and
  Codex implementation details.
- **Load only external runtimes, not channels:** superseded by issue #209.
  Bidirectional Channel providers now use the same provider loader/catalog shape.
  One-way subscription channels remain a separate reserved contract.
- **Use only object refs in config:** rejected for operator ergonomics. String
  refs are concise, while the normalized object form keeps implementation
  unambiguous.

### Since this was recorded (2026-09-01)

The ref syntax (`builtin:<id>` / `npm:<spec>` / `npm:<spec>#<export>`) remains the live contract and is cited as authority by `/packages/dreamux/src/registry/provider-ref.ts`. The config attachment point moved: `dispatchers[].runtime.provider` is now `agents[].provider` plus `dispatchers[].agentRuntime`.


---

## providerized-config-state-compatibility

## Providerized config and state compatibility

- **Status:** Accepted, refined by
  [provider-architecture-realignment](/.agents/tasks/architecture/providerization-epic/requirement.md#provider-architecture-realignment);
  the inline `dispatchers[].runtime` envelope is superseded by named top-level
  `agents[]` in [agents-config-normalization](/.agents/tasks/architecture/providerization-epic/requirement.md#agents-config-normalization)
- **Date:** 2026-06-06
- **Affects:** `~/.dreamux/config.json`, dispatcher state files, provider config,
  TeamMate ledger, compatibility errors
- **PR / Issue:** [issue #110](https://github.com/excitedjs/dreamux/issues/110),
  following [issue #98](https://github.com/excitedjs/dreamux/issues/98)

### Context

The current config shape is Feishu and Codex specific. It has dispatcher-local
Feishu credentials and dispatcher-local Codex settings. Issue #110 replaces
those special cases with providerized channels and runtime declarations.

Issue #98 settled the 0.x compatibility stance: Dreamux does not silently infer
or rewrite incompatible config/state. Sensitive state fails loudly; rebuildable
server state may warn and rebuild/drop only when that loss is explicit and safe.

### Decision

Introduce a providerized config v2 shape. The durable envelope is:

```json
{
  "dispatchers": [
    {
      "id": "dispatcher-a",
      "cwd": "/path/to/workspace",
      "enabled": true,
      "channels": [
        {
          "id": "primary",
          "provider": "builtin:feishu",
          "config": {}
        }
      ],
      "runtime": {
        "provider": "builtin:codex",
        "config": {}
      }
    }
  ]
}
```

Common fields are owned by Dreamux core. Agent-runtime provider `config`
objects are owned and validated by provider descriptors. The Feishu
`channels[]` entry keeps the `builtin:feishu` ref string for config stability,
but it is validated as a built-in bidirectional channel, not through the
provider registry.

Confirmed Phase 1 loading rules after issue #135:

- `builtin:codex` and `builtin:claude-code` are known builtin Agent Runtime
  provider refs.
- `builtin:feishu` is a known built-in channel ref, not a provider-registry
  implementation.
- Npm package and package export refs are reserved schema/manifest syntax.
- Npm runtime refs are not loaded, imported, installed, or executed in Phase 1.
- Subscription channel plugin refs are interface-only reservations in this
  phase.
- A config value only becomes runnable after the matching provider runtime is
  wired. Until then, validation must fail loudly for a known but non-wired
  builtin instead of silently falling back to another provider.

Incompatible old config shapes must fail loudly with rebuild guidance. Dreamux
must not silently rewrite an operator's config into v2.

State compatibility follows issue #98:

- authorization or access-control state fails loudly when incompatible;
- rebuildable runtime state may warn and rebuild/drop;
- TeamMate ledger state is server-owned, versioned, and must not silently lose
  completed final outputs. The persisted identity record references its runtime
  by `agent_runtime` (an `agents[].id`), aligned with the named-agents schema; a
  legacy `provider_ref` identity (pre-#148) fails loud on the next lifecycle verb
  with rebuild guidance rather than silently defaulting a runtime;
- failed push delivery does not delete a result that can be retrieved later.

### Consequences

- `dispatchers[].feishu` and `dispatchers[].codex` stop being the target
  architecture, even if transitional implementation code reads them before the
  config v2 PR lands.
- Provider config validation needs two layers: core envelope validation and
  provider-local validation.
- Error messages must be explicit about rebuild/migration expectations.
- Config display, status, doctor, and logs must continue to redact provider
  secrets.

### Alternatives considered

- **Silently migrate the current config shape:** rejected by issue #98.
- **Keep Feishu/Codex config keys and add providers beside them:** rejected
  because it preserves the special-case architecture.
- **Allow npm provider execution as soon as refs parse:** rejected for Phase 1.
  External provider loading requires a separate package trust and dependency
  resolution decision.

---

## agents-config-normalization

## Named agents[] config normalization

- **Status:** Accepted, refines
  [providerized-config-state-compatibility](/.agents/tasks/architecture/providerization-epic/requirement.md#providerized-config-state-compatibility)
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

### Context

The providerized config v2 envelope inlined runtime config inside each dispatcher
(`dispatchers[].runtime = { provider, config }`). That had two costs: runtime
config could not be reused or named ("one provider, multiple named configs"), and
a teammate launching its runtime unconditionally inherited the dispatcher's
config as its source — so a cross-provider teammate (a claude teammate under a
codex dispatcher) read the wrong config type and threw
`runtime provider "builtin:codex" is not wired to Claude Code`.

### Decision

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

#### Load and resolution

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

##### De-cycle (post-#148 hotfix)

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

#### Provider-self-reported doctor diagnostics (issue #146 doctor half)

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

##### Codex version floor (issue #147 fold)

The codex diagnostic enforces `MIN_CODEX_VERSION = '0.137.0'`: it runs
`codex --version`, parses the `major.minor.patch` triple, and compares
component-wise (numeric, not string). Below 0.137 it fails loud. The floor now
guards the app-server protocol surface used by the built-in runtime, including
thread start/resume, turn start, and thread-level instruction overrides such as
`baseInstructions` and `developerInstructions`. Doctor surfaces the requirement
up front rather than letting prompt customization or turn delivery degrade
silently at runtime.

#### #98 fail-loud (no migration shim)

The old shape and broken references each fail loudly at load with rebuild
guidance naming the file and the required new shape:

- a dispatcher carrying an inline `runtime` block;
- a dispatcher missing `agentRuntime`;
- an `agentRuntime` id with no matching `agents[].id` (dangling);
- a duplicate `agents[].id`;
- a top-level `agents` that is not an array.

`onboard` writes the new shape (one agent per dispatcher, agent id == dispatcher
id). The breaking change ships a rush change file with `BREAKING:` + `Rebuild:`.

### Consequences

- Config landing place is `agents[]` only; `dispatchers[].runtime` no longer
  exists on disk.
- Runtime config is reusable: multiple dispatchers can share one agent, and a
  teammate can select a different agent than its dispatcher.
- The teammate "inherit dispatcher config only when the provider matches" hack is
  gone, replaced by agent-id resolution against `config.agents`. A teammate runs
  with its own named agent's config, so a claude teammate under a codex dispatcher
  starts cleanly instead of throwing "is not wired to Claude Code".

### Alternatives considered

- **Keep inline `dispatchers[].runtime` and special-case teammates:** rejected;
  it preserves the inheritance bug and blocks named/shared runtime config.
- **Silently migrate the old shape:** rejected by issue #98.
