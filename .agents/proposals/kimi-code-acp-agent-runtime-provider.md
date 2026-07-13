# Kimi Code ACP AgentRuntime provider

- **Status:** Draft for review
- **Date:** 2026-07-02
- **Affects:** Agent Runtime providers, external provider loading,
  `@excitedjs/dreamux-types` consumers
- **Dreamux source snapshot:** `origin/next@5363c8d63506dd0ced833508f9d6c079355b9a5a`
- **Kimi Code source snapshot:** `MoonshotAI/kimi-code@93ec6cb6526021156a951f8c513c45f138bf5dbb`

## Intent

Add a Kimi Code Agent Runtime provider without expanding Dreamux core's neutral
runtime contract.

Kimi Code does not expose a Claude Code-compatible `-p --stream-json` resident
RPC process. Its public resident integration surface is `kimi acp`, an Agent
Client Protocol server over stdio. The provider should therefore be a
provider-owned ACP adapter: Dreamux core calls the existing `AgentRuntime`
methods, and the Kimi package translates those calls into ACP session lifecycle
and prompt calls.

## Source Facts

Dreamux's current runtime contract is small and provider-neutral:

- `AgentRuntimeCapabilities` declares only `resume.supported`.
- `AgentRuntimeCreateContext` passes explicit `systemPrompt`, `mcpServers`,
  `skillSources`, `disableFeatures`, `cwd`, `paths`, `state`, `injectEnv`, and
  `onTurnSettled`. It no longer passes Dreamux role topology.
- `completionInput()` is required and receives plain text only; channel XML
  rendering belongs only in `channelInput()`.
- Runtime checkpoint APIs are `getCheckpoint()` and
  `wasCheckpointResumed()`.

Kimi Code current source has these relevant properties:

- The public CLI package is `@moonshot-ai/kimi-code`, and its `kimi` bin has an
  `acp` subcommand.
- `@moonshot-ai/kimi-code-sdk` is still `private: true` in source and is not
  published on the public npm registry. Dreamux's public package should not
  depend on it directly.
- `kimi acp` constructs a Kimi harness internally and exposes ACP
  `initialize`, `session/new`, `session/load`, `session/resume`,
  `session/prompt`, `session/cancel`, and related session configuration methods.
- Kimi ACP forwards ACP MCP server descriptors into Kimi's kernel-side
  `mcpServers` session field.
- Kimi's public session creation surface accepts MCP injection through ACP, but
  it does not expose a public SDK option to replace the base system prompt.
- Kimi loads user-level brand instructions from `KIMI_CODE_HOME/AGENTS.md`.
- Kimi loads user-level brand skills from `KIMI_CODE_HOME/skills/` when it is
  set, and discovers each child directory containing `SKILL.md` as a skill.

## Provider Shape

The first implementation should be an npm external provider package:

```json
{
  "provider": "npm:@excitedjs/agent-runtime-kimi-code"
}
```

It should not be registered as `builtin:kimi-code` yet. Keeping it external
avoids adding Kimi Code's CLI dependency to Dreamux's default runtime set, and
matches the fact that ACP-specific prompt and skill injection support still has
native limitations.

The provider should depend on public packages only:

- `@excitedjs/dreamux-types`;
- `@excitedjs/dreamux-utils`;
- `@agentclientprotocol/sdk`.

It should not depend directly on the Kimi Code CLI package yet. Like the Claude
Code provider, it should invoke a configurable binary (`kimi` by default) so the
operator controls the native tool installation and version.

The runtime process is a supervised `kimi acp` child over stdio. The provider
owns ACP client connection setup, session creation/resume, prompt submission,
result collection, and child teardown. Dreamux core never imports ACP types.

## Runtime Mapping

Capabilities:

```ts
{ resume: { supported: true } }
```

Checkpoint mapping:

- A Kimi ACP session id is the Dreamux runtime checkpoint id.
- `start()` creates a new ACP session unless `identity.checkpoint_id` exists.
- `resume()` resumes `identity.checkpoint_id`.
- `getCheckpoint()` returns the active ACP session id after session setup.
- `wasCheckpointResumed()` reports whether the active session came from a
  supplied checkpoint id.
- If ACP resume fails for a stored checkpoint, the provider starts a fresh ACP
  session and calls `state.recordLostCheckpoint(lost, replacement, error)` when
  the host supplied that callback. If the callback is absent, it still persists
  the replacement through `state.setCheckpoint()` and marks the runtime degraded
  with the resume error.

Turn mapping:

- `channelInput(input, hooks)` renders `input` through
  `renderChannelInput(input)`, then submits the rendered text as an ACP prompt.
- `completionInput({ text, sourceId })` submits `text` as an ACP prompt without
  channel rendering.
- The provider allocates a Dreamux logical turn id before submitting to ACP.
- `sourceId` is dedupe metadata: non-empty duplicate `sourceId` values return
  `{ status: "duplicate" }` and must not create a second native ACP prompt.
- `channelInput(..., hooks)` calls `hooks.onAccepted` only after dedupe accepts
  the channel turn and before the provider submits it to the serial prompt
  queue. A hook failure is logged but must not drop the turn.
- Accepted turns must settle exactly once through `onTurnSettled`.
- The provider should serialize prompts. Kimi native `steer`/active-turn
  buffering is not part of ACP's Dreamux mapping, and serializing keeps one
  Dreamux logical turn aligned with one ACP `session/prompt` response.
- `agent_message_chunk` text updates are concatenated into the turn result.
  Other ACP updates are provider-internal unless a future Dreamux capability
  explicitly asks for them.
- ACP `stopReason: "cancelled"` maps to Dreamux `stopped`; all other successful
  ACP prompt responses map to `completed` unless the prompt request throws.

MCP mapping:

- `AgentRuntimeMcpServer` maps to ACP stdio MCP descriptors.
- Dreamux's current MCP descriptor has only `name`, `command`, and `args`, so
  the Kimi provider must not invent env/cwd values.

Environment and paths:

- The child command is `<config.bin> acp ...config.extra_args`, with `bin`
  defaulting to `kimi`.
- The child environment is `{ ...process.env, ...context.injectEnv,
  ...config.extra_env }`.
- `KIMI_CODE_HOME` should default to a runtime-owned directory under
  `context.paths.dispatcherDir(runtime_id)`.
- Logs should be written under `context.paths.logsDir()/kimi-code`.
- `systemPrompt.append` is materialized into `KIMI_CODE_HOME/AGENTS.md` as a
  provider-owned generated file. Existing non-generated `AGENTS.md` content must
  not be overwritten.
- `skillSources` are materialized as provider-owned links under
  `KIMI_CODE_HOME/skills/<name>`. Existing non-provider files at those paths
  must fail loud instead of being overwritten.
- `disableFeatures` has no direct ACP session field. The provider must handle
  interactive ACP permission/question requests conservatively by returning
  cancellation/dismissal so disabled user-interrupt flows cannot wedge Dreamux.

## Unsupported Or Deferred

System prompt replacement is unsupported in the first provider. Kimi Code's
public ACP/CLI surface does not expose a base-prompt replacement hook, and
pretending `replace` is an ordinary user turn would violate Dreamux's prompt
contract. When Dreamux supplies both `replace` and `append`, the provider uses
the append-only instructions and does not claim replacement semantics. When
Dreamux supplies only `replace`, the provider must fail loud or require an
explicit operator override before starting.

Interactive approval bridging is deferred. A first provider can fail or cancel
Kimi permission requests conservatively rather than asking Dreamux core to model
Kimi-specific approval details.

## Hard Constraints

- No dependency on `@moonshot-ai/kimi-code-sdk` while it is unpublished/private.
- No Kimi or ACP imports from `@excitedjs/dreamux` core.
- No system-prompt replacement approximation through user-visible turns.
- No overwrite of pre-existing non-provider `KIMI_CODE_HOME/AGENTS.md` or skill
  paths while materializing Dreamux prompts or skills.
- No parallel logical prompt submission until the provider can prove each
  submitted Dreamux turn settles exactly once.
- No Dreamux core special cases for Kimi Code.

## Acceptance

- The package exports a default `AgentRuntimeProviderFactory`.
- The provider loads through the existing `npm:` provider loader.
- `createRuntime()` requires `context.paths` and `context.state` and fails loud
  if they are missing.
- `start()`, `resume()`, `stop()`, `channelInput()`, `completionInput()`,
  `waitIdle()`, `getStatus()`, `getCheckpoint()`, `wasCheckpointResumed()`,
  `getLast()`, `getContext()`, and `getCapabilities()` satisfy the current
  `AgentRuntime` interface.
- Focused tests cover config parsing, descriptor/ref behavior, MCP mapping,
  prompt/skill materialization, source-id dedupe, accepted-hook ordering, turn
  settlement, lost-checkpoint replacement, and ACP process lifecycle through
  injected fakes.
