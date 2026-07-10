# Proposal: MiMo Code Agent Runtime Provider

- **Status:** Active proposal (draft for review)
- **Date:** 2026-06-30
- **Affects:** Agent Runtime provider loading, external provider packaging,
  runtime state isolation, runtime diagnostics, runtime permission handling,
  teammate completion delivery
- **PR / Issue:** TBD
- **Reviewed external source:** `XiaomiMiMo/MiMo-Code@1c5217ef342518d6cfcd2d1b5c9a7b21d1c1d96d`

## Intent

Dreamux should be able to run agents on MiMo Code without adding MiMo-specific
branches to Dreamux core. The integration target is an external Agent Runtime
provider package, for example `@excitedjs/agent-runtime-mimo-code`, selected by
an `npm:` provider ref in operator config.

The provider must implement the public `AgentRuntimeProvider` contract from
`@excitedjs/dreamux-types`. Dreamux core continues to own dispatcher, Team,
TeamMate, channel, and MCP assembly semantics; the MiMo provider owns only the
translation between the neutral runtime contract and MiMo Code's process,
session, event, permission, and storage surfaces.

## Source Facts

Dreamux already exposes the required neutral provider seam:

- `/packages/dreamux-types/src/agent-runtime.ts` defines
  `AgentRuntimeProvider`, `AgentRuntime`, `AgentRuntimeCreateContext`, runtime
  handle methods, checkpoint/state callbacks, path context, MCP server
  injection, prompt injection, skill sources, and plain text completion input.
- `/packages/dreamux/src/agent-runtime/external-provider.ts` validates external
  `agentRuntime` provider objects, resume capability declarations, and runtime
  handles returned by `createRuntime`.
- `/packages/dreamux/src/registry/provider-ref.ts` defines public provider refs
  as `builtin:<id>`, `npm:<package>`, or `npm:<package>#<export>`.
- `/packages/dreamux/src/registry/builtins.ts` keeps built-in runtime packages
  behind the same registry/catalog path that external providers use.
- `/packages/agent-runtime/claude-code/src/provider.ts` and
  `/packages/agent-runtime/claude-code/src/runtime.ts` are a useful local shape
  reference for a runtime package that stays behind `@excitedjs/dreamux-types`.

The reviewed MiMo Code source has enough non-interactive surface for a Dreamux
runtime, but the long-lived runtime driver should be the server surface, not the
one-shot CLI command:

- `packages/opencode/package.json` exposes the npm package `@mimo-ai/cli` and
  the `mimo` bin.
- `packages/opencode/bin/mimo` is a Node shim that locates a platform-specific
  binary package, with `MIMOCODE_BIN_PATH` as an override.
- `packages/opencode/src/cli/cmd/run.ts` implements `mimo run [message]` with
  `--format json`, `--continue`, `--session`, `--fork`, `--attach`, `--dir`,
  `--model`, `--agent`, stdin prompt input, and
  `--dangerously-skip-permissions`.
- `packages/opencode/src/cli/cmd/serve.ts` starts a headless MiMo Code server,
  refuses unauthenticated non-loopback binding unless explicitly overridden,
  and logs the selected local URL.
- `packages/opencode/src/server/routes/instance/session.ts` exposes session
  list/status/read endpoints, `POST /session/:sessionID/message` with a 409
  busy precheck and disconnect cancellation, `POST
  /session/:sessionID/prompt_async`, and `POST
  /session/:sessionID/command`.
- `packages/opencode/src/server/routes/instance/event.ts` exposes `/event` as
  server-sent events with heartbeat and bounded drop-oldest buffering.
- `packages/opencode/src/server/routes/instance/permission.ts` exposes the
  current permission surface: `GET /permission` for pending requests and
  `POST /permission/:requestID/reply` for replies. The older
  `POST /session/:sessionID/permissions/:permissionID` route is deprecated.
- `packages/shared/src/global.ts` and
  `packages/opencode/src/global/index.ts` resolve `MIMOCODE_HOME` into isolated
  data, cache, config, and state directories.
- `packages/opencode/src/flag/flag.ts` exposes integration-relevant flags such
  as `MIMOCODE_HOME`, `MIMOCODE_MIMO_ONLY`,
  `MIMOCODE_DISABLE_EXTERNAL_SKILLS`, `MIMOCODE_DISABLE_DEFAULT_PLUGINS`,
  `MIMOCODE_DISABLE_MODELS_FETCH`, `MIMOCODE_ENABLE_ANALYSIS`,
  `MIMOCODE_AUTO_SHARE`, `MIMOCODE_SERVER_PASSWORD`, and `MIMOCODE_DB`.
  `MIMOCODE_PURE` is not a general isolation switch; the reviewed source uses
  it to skip external plugins.
- `packages/opencode/src/metrics/client.ts` and
  `packages/opencode/src/metrics/subscriber.ts` show that MiMo analytics are
  enabled by default and post session-scoped model/tool/agent metrics to an
  external endpoint unless `MIMOCODE_ENABLE_ANALYSIS=false`.
- `packages/opencode/src/cli/network.ts` gives `mimo serve` a default loopback
  hostname and port `0`, while allowing explicit `--hostname` and `--port`.
- `packages/opencode/src/acp/` contains an ACP server surface. It implements
  session, prompt, permission, cwd, and MCP concepts, but its README records
  important current limitations: no streaming responses, no tool progress, and
  `session/load` does not restore actual conversation history. ACP is therefore
  a future candidate to re-evaluate after those gaps close, not the preferred
  first production driver.

## Runtime Shape

The provider should spawn and own a private `mimo serve` process per live
Dreamux runtime instance. It should communicate with that process through the
MiMo SDK or HTTP API and subscribe to `/event` for push telemetry.

```mermaid
flowchart LR
  Core[Dreamux core AgentRuntime] --> Provider[MiMo Code provider]
  Provider --> Serve[mimo serve]
  Provider --> SessionAPI[Session HTTP API]
  Provider --> EventSSE[/event SSE]
  Provider --> PermissionAPI[Permission API]
  Serve --> Store[MIMOCODE_HOME]
```

The provider should not drive normal Dreamux turns by launching `mimo run` for
each prompt. `mimo run` is useful for provider diagnostics and smoke tests
because it has a JSON event mode and can attach to a server, but it is a weaker
runtime substrate: the CLI process ends after the command, per-turn process
startup obscures lifecycle ownership, and long-running event/permission handling
would have to be reconstructed around a transient process.

The provider may use `mimo run --attach` in a diagnostic path, but the production
runtime handle should own the server child process, server URL, password, event
stream, session id, idle state, and shutdown.

Normal Dreamux turns should use `POST /session/:sessionID/message`, or an SDK
call with the same settlement semantics. `POST /session/:sessionID/prompt_async`
returns before the turn settles and has no 409 busy precheck; it is acceptable
only when the provider can reconstruct terminal state from source-backed status
and event signals. The streaming `/message` response may include leading
heartbeat whitespace before the final JSON body, so a direct HTTP client must
tolerate JSON whitespace and must not assume the first response byte is `{`.

The `/event` stream is push telemetry, not the sole source of truth for turn
settlement. Its queue is bounded and drops oldest events under sustained
backpressure. The provider may use SSE for progress, but final success/failure
must be confirmed from `/message` completion, session status, or another durable
source-backed signal.

## Provider Configuration

The provider config should be provider-owned and parsed in `readConfig`. It must
not require Dreamux core to understand MiMo-specific keys.

The minimum config surface should cover:

- the `mimo` executable path or default PATH lookup;
- optional model and agent selection;
- optional extra environment variables;
- optional MiMo config content or config path when the operator wants to supply
  MiMo-native settings;
- permission mode selection for non-interactive execution;
- startup timeout and turn timeout values;
- an option to keep or remove the per-runtime `MIMOCODE_HOME` after stop for
  debugging.

Provider refs should use the existing npm provider grammar, for example:

```json
{
  "agents": [
    {
      "id": "mimo",
      "provider": "npm:@excitedjs/agent-runtime-mimo-code",
      "config": {
        "model": "mimo/default",
        "permissionMode": "deny"
      }
    }
  ]
}
```

The exact config schema belongs to the provider package, not Dreamux core.
When operator-supplied MiMo-native config is allowed, the provider must still
keep Dreamux-owned runtime inputs authoritative. In particular, Dreamux-supplied
`mcpServers` must not be merged with native MiMo `mcp` config or inherited
Claude Code MCP config unless an explicit non-Dreamux diagnostic/manual mode
opts into that behavior. For ordinary Dreamux runtime launches, conflicting
native MCP config should fail loudly or be isolated from the runtime that
Dreamux is driving.

## AgentRuntime Contract Mapping

The current shared contract is intentionally small. MiMo-specific transport,
event, permission, auth, and session semantics stay inside the provider; Dreamux
core sees only the required `AgentRuntime` handle.

- `getCapabilities()` should report only `resume: { supported: true }`.
- `start()`, `resume()`, and `stop()` own the `mimo serve` child process and
  provider-side session binding. `resume()` reopens from
  `context.identity.checkpoint_id`.
- `getCheckpoint()` returns the current MiMo session id encoded as `{ id }`, or
  `null` before a session exists.
- `wasCheckpointResumed()` reports whether the live runtime actually continued
  a supplied checkpoint.
- `channelInput()` is only for `ChannelProvider`-originated `InboundTurnInput`.
  The provider owns rendering channel metadata into MiMo-native prompt text.
- `completionInput()` is the required plain text input for Dreamux-owned turns:
  teammate spawn/send prompts, scheduler prompts, restart notices, and rendered
  reverse completion notifications. It must not render channel XML or a
  Dreamux completion envelope.
- `completionInput({ sourceId })` should use `sourceId` as provider-side
  dedupe/correlation metadata. If MiMo cannot accept the turn exactly once, the
  provider should return `duplicate`, `failed`, or `stopped` rather than
  silently creating repeated model-visible notifications.
- `onTurnSettled` must fire exactly once for each submitted Dreamux logical
  turn, with the terminal `turnId`, status, and that turn's result text when
  available. Dreamux core no longer uses `getLast()` to complete the settlement
  path.
- `getLast()` remains a read/recovery surface and may return `null` when no
  result is available.
- `getContext()` may return `null` until MiMo exposes a stable context-window
  snapshot.

MiMo does not currently expose a Codex-style mid-turn injection primitive. That
does not make `completionInput` optional; it means the provider should treat
Dreamux-owned completion input as a normal queued plain text turn, not as an
in-flight native injection. It may return `submitted` only after it owns a
deterministic settlement path for that logical turn.

## Session And State Ownership

Dreamux core supplies `identity.runtime_id`, optional
`identity.checkpoint_id`, `cwd`, `mcpServers`, `systemPrompt`,
`disableFeatures`, `paths`, and state callbacks. The MiMo provider maps those
inputs into MiMo runtime state:

- Allocate `MIMOCODE_HOME` under `paths.dispatcherDir(runtime_id)` or another
  provider-owned subdirectory under the Dreamux runtime path context.
- Keep MiMo data, cache, config, and state under that root so a Dreamux runtime
  instance does not read or mutate the operator's global MiMo state by default.
- Record the MiMo session id through `state.setCheckpoint({ id: sessionID })`.
- Treat a recovered `identity.checkpoint_id` as the MiMo session to resume.
- Keep the server URL, password, child process pid, and transient event stream
  connection as runtime-owned volatile state, not Dreamux durable state.
- Use Dreamux `cwd` as the MiMo project directory; do not rediscover or rewrite
  the working directory inside core.
- Treat host field names such as dispatcher `thread_id` and TeamMate
  `session_id` as Dreamux compatibility projections. The provider-facing term is
  checkpoint.

`MIMOCODE_HOME` must be an absolute path. The provider diagnostic should fail
loudly when the configured path cannot be made absolute, cannot be created, or
would collide across runtime instances.

## Prompt Injection

Dreamux now supplies prompt guidance as
`AgentRuntimeCreateContext.systemPrompt?: { replace?: string; append?: string[] }`.
There is no `systemPrompt.mode` capability and no structural `role` in the
provider-facing create context.

The MiMo provider should preserve MiMo's native base behavior while applying
Dreamux guidance through a provider-owned prompt mechanism. Acceptable shapes
include a MiMo-native agent/config entry or per-turn `PromptInput.system`, but
the provider must document which it uses and must keep that choice inside the
provider. When both `replace` and `append` are present, the provider should
treat the choice explicitly rather than relying on Dreamux core to choose a
provider-specific mode.

## MCP And Skills

Dreamux core already resolves MCP server descriptors before it calls
`createRuntime`. The MiMo provider must launch exactly the supplied
`mcpServers`, subject only to MiMo's own config syntax and process mechanics.
It must not infer additional Dreamux MCP servers, drop supplied servers
silently, or mutate provider refs.

Because MiMo can read native `mcp` config and can inherit Claude Code MCP
config, the provider must make the Dreamux MCP source exclusive for normal
Dreamux launches. It should generate or supply the MiMo MCP configuration from
`context.mcpServers`, disable or reject inherited MCP sources that would add
servers, and fail loudly when an operator-provided MiMo config tries to add a
second MCP graph to the same Dreamux runtime.

Dreamux bundled skill sources are neutral skill directories: each
`skillSources[].path` points directly at a directory containing `SKILL.md`.
Core no longer supplies runtime-specific layout markers. The first MiMo provider
version may ignore `skillSources` if MiMo has no stable skill mount format. If
MiMo Code gains one, the provider maps those direct skill directories into a
runtime-owned native layout without changing Dreamux core.

## Permission And Safety Model

Permission handling is a provider boundary. Dreamux core should not parse MiMo
permission request payloads.

The initial provider should default to `deny` or fail-loud permission behavior.
Current Dreamux `AgentRuntime` contracts do not expose a neutral provider-to-core
permission request and reply channel, so an `ask` mode cannot be presented as a
fully supported channel-driven behavior yet.

The provider may expose permission modes only with explicit semantics:

- `deny` or fail-loud mode: reject permission requests that cannot be handled
  safely without a human.
- `ask`: allowed only when the provider owns a complete response loop or a
  future Dreamux-neutral permission contract exists. Without that loop, MiMo
  permission or question waits can hang until the turn timeout and disconnect
  cancellation path runs.
- `auto-approve`: allowed only as an explicit unsafe operator opt-in mapped to
  MiMo's own unsafe permission controls.

Every non-interactive mode must have a configured turn timeout. The timeout is
the last-resort guard that prevents an unanswered permission or question wait
from pinning the runtime forever.

The provider should set isolation-oriented defaults unless the operator opts
out:

- use `MIMOCODE_HOME` for per-runtime state;
- use `MIMOCODE_MIMO_ONLY` and targeted MiMo flags such as
  `MIMOCODE_DISABLE_EXTERNAL_SKILLS`, `MIMOCODE_DISABLE_DEFAULT_PLUGINS`,
  `MIMOCODE_DISABLE_MODELS_FETCH`, and `MIMOCODE_DISABLE_CLAUDE_CODE_MCP` to
  avoid accidental inheritance of unrelated Claude, Codex, external skill,
  default plugin, model-fetching, MCP, or ambient provider-environment behavior
  when that inheritance is not wanted;
- set `MIMOCODE_ENABLE_ANALYSIS=false`;
- keep auto-share disabled, including not setting `MIMOCODE_AUTO_SHARE` and
  using MiMo config `share: "disabled"` when the provider writes config;
- bind `mimo serve` to loopback only;
- pass an explicit loopback host and port, preferring port `0` or another
  provider-owned free-port strategy over parsing an accidental global config;
- set a generated server password unless the selected transport makes that
  unnecessary;
- keep MiMo logs under the provider-owned runtime/log path.

## Diagnostics

The provider should expose `diagnostic.binChecks` and `diagnostic.runDiagnostic`
instead of adding MiMo-specific checks to Dreamux core.

Diagnostics should verify:

- the `mimo` executable resolves, or `MIMOCODE_BIN_PATH` points to an executable;
- the platform binary shim can find a compatible binary package;
- `mimo serve` can start on loopback with an isolated `MIMOCODE_HOME`;
- the server URL can be discovered and authenticated;
- analytics and auto-share are disabled for normal Dreamux launches;
- native or inherited MCP config cannot add servers beyond
  `context.mcpServers`;
- `/event` can be subscribed;
- a session can be created or resumed;
- a no-op or cheap prompt smoke can run only when the diagnostic scope allows
  live model calls;
- unsupported live scopes fail loudly when credentials or model config are
  missing.

## Testing Requirements

Provider tests should use a fake MiMo server first. The fake must exercise the
provider through the same HTTP/SSE/client interface the real provider uses, not
through private provider internals.

Focused tests should cover:

- provider config parsing and fail-loud validation;
- the minimal `resume` capability matching runtime behavior;
- required runtime-handle methods, including `completionInput`,
  `getCheckpoint`, and `wasCheckpointResumed`;
- isolated `MIMOCODE_HOME` path derivation;
- `start`, `resume`, `stop`, and child-process cleanup;
- session id persistence through `state.setCheckpoint`;
- one successful `channelInput` turn;
- one successful plain text `completionInput` turn with `sourceId` dedupe;
- busy 409 handling and idle waiting;
- `prompt_async` is not treated as settled unless the provider has a tested
  settlement tracker;
- SSE event parsing, reconnect, heartbeat, and bounded/no-event behavior;
- turn settlement remains correct when SSE drops progress events;
- permission request and reply paths;
- unanswered permission/question behavior is bounded by turn timeout and cleanup;
- `getLast` from session messages;
- unsupported `getContext` returning `null`;
- no telemetry or auto-share side effects in the fake-server launch envelope;
- Dreamux-owned completion text is delivered through `completionInput` without
  channel/XML rendering or a provider-facing completion envelope;
- diagnostics for missing binary, failed server startup, and live-scope skips.

Live MiMo Code tests should be opt-in and fail loudly when enabled but the
binary or required credentials are missing. They must not depend on a developer
global MiMo home.

## Acceptance

- A MiMo Code runtime can be selected through an `npm:` Agent Runtime provider
  ref without editing Dreamux built-in provider registries or core branching on
  MiMo-specific strings.
- The provider imports only `@excitedjs/dreamux-types` from Dreamux packages.
- Dreamux core continues to supply `cwd`, MCP servers, bundled skill sources,
  disabled features, path context, and state callbacks through the neutral
  `AgentRuntimeCreateContext`.
- The provider starts and stops a loopback `mimo serve` process owned by the
  runtime instance.
- The provider uses an isolated absolute `MIMOCODE_HOME` by default.
- The provider disables MiMo analytics and auto-share by default.
- The provider prevents native or inherited MiMo MCP config from adding servers
  beyond Dreamux `context.mcpServers` in normal Dreamux launches.
- Runtime resume maps Dreamux checkpoint ids to MiMo session ids.
- `channelInput` is reserved for ChannelProvider-originated input.
- Dreamux-owned non-channel turns use plain text `completionInput`, preserve
  `sourceId` dedupe, and never receive channel/XML rendering.
- Every submitted Dreamux logical turn emits exactly one `onTurnSettled` signal
  with that turn's result text when available.
- `/event` may be used for progress, but durable settlement is confirmed outside
  the best-effort SSE queue.
- Permission behavior is explicit, safe by default, and bounded by a turn
  timeout.
- `mimo run` is limited to diagnostics/smoke use unless a later source-backed
  decision records why the one-shot CLI should become the production driver.
- Fake-server tests cover the provider contract before any live MiMo test is
  required.
- No MiMo-specific code is added to Dreamux core beyond generic external
  provider loading and existing neutral provider contracts.

## Out Of Scope

- Adding MiMo Code as a Dreamux built-in provider.
- Changing the public `AgentRuntimeProvider` contract.
- Teaching Dreamux core to parse MiMo session, permission, model, skill, or MCP
  config shapes.
- Changing channel provider contracts.
- Adding a neutral Dreamux permission request/reply contract.
- Adding a Dreamux core capability for mid-turn steering. The provider may own
  MiMo-specific queuing or steering behavior behind `channelInput` and
  `completionInput`, but core should not learn MiMo-native semantics.
- Claiming native mid-turn completion injection. `completionInput` is a normal
  Dreamux logical turn unless a later source-backed decision records a stronger
  MiMo injection primitive.
- Allowing native MiMo MCP config to widen Dreamux's runtime MCP surface by
  default.
- Replacing MiMo's base prompt or agent model rather than applying Dreamux
  `systemPrompt` content through a provider-owned append-like mechanism.
- Depending on the operator's global MiMo state as the default runtime state.

## Review Questions

- Is `mimo serve` the correct first production driver, or is there a stronger
  source-backed reason to choose ACP or `mimo run --attach`?
- Is `resume: { supported: true }` honest against both Dreamux checkpoint
  semantics and MiMo Code's current session source?
- Should MiMo map `systemPrompt.replace`, `systemPrompt.append`, or both into a
  native append-like mechanism?
- Does the `MIMOCODE_HOME` ownership model fit Dreamux's state/cache/run/log
  path contracts without leaking runtime-owned details into core?
- Should a future Dreamux-neutral permission request/reply contract exist, or
  should MiMo remain deny/fail-loud for channel-driven agents?
- Which MiMo-native prompt/config mechanism is the least invasive way to apply
  Dreamux system prompt content?
- Does strict per-runtime `MIMOCODE_HOME` isolation need a shared read-only cache
  escape hatch to avoid repeated downloads, or should repeat cache cost remain
  the price of isolation?
