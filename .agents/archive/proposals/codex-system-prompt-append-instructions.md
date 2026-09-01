# Codex system prompt append instructions

> **Archived 2026-09-01.** Fully implemented: Codex append prompts ride thread-level `developerInstructions`; `thread/inject_items` is gone repo-wide. Current owner: [/.agents/domains/provider-runtime.md](/.agents/domains/provider-runtime.md).

- **Status:** Draft for review
- **Date:** 2026-07-02
- **Related PR:** [#271](https://github.com/excitedjs/dreamux/pull/271)
- **Depends on:** [TeamMate identity system prompt](teammate-identity-system-prompt.md)
- **Affects:** `@excitedjs/agent-runtime-codex`, Codex runtime protocol mapping, system-prompt tests
- **Source snapshot:** Dreamux branch `team/agentruntime-opt-0630-1901` after [#274](https://github.com/excitedjs/dreamux/pull/274); Codex source `main@129ea2aaf5fb426d8ba683ee53f290742f41dd31`; refreshed Codex tags show `developerInstructions` present in `rust-v0.135.0` and `rust-v0.137.0`

## Context

Dreamux now exposes system prompt customization to runtime providers as a
neutral representation:

```ts
interface AgentRuntimeSystemPrompt {
  replace?: string;
  append?: readonly string[];
}
```

`replace` and `append` are not the same operation. Dispatcher launch may supply
both as alternate representations of the same dispatcher guidance. TeamLeader
and TeamMate identity guidance supplies append-only fragments that must survive
runtime recreation and resume because they describe the agent's durable working
identity, not a single turn.

Before this proposal, the Codex runtime mapped `replace` to Codex
`baseInstructions`, rendered append fragments as `<developer-reminder>` blocks,
then injected one developer message into the thread with `thread/inject_items`
after `thread/start` or `thread/resume`.

That is the wrong layer for append-only system guidance:

- `thread/inject_items` mutates model-visible thread history. It is suitable for
  historical item delivery, not for the runtime creation contract.
- Codex app-server already accepts `developerInstructions` on both
  `thread/start` and `thread/resume`; this was verified in Codex `rust-v0.135.0`
  and `rust-v0.137.0`.
- Codex persists `base_instructions` in thread metadata, but the current Codex
  source does not persist `developer_instructions` in `SessionMeta` or
  `CreateThreadParams`.
- Codex `developerInstructions` becomes developer-role input text, but Codex
  does not wrap the text in XML or preserve Dreamux append-array boundaries by
  itself.

Therefore Dreamux must keep the durable source of append guidance in Dreamux
state, and the Codex adapter must re-supply the rendered developer instructions
whenever it creates or resumes the Codex thread.

## Intent

Move Codex append-only system prompt delivery from history injection to Codex's
native thread configuration surface.

The runtime should treat `AgentRuntimeCreateContext.systemPrompt` as the only
provider-facing prompt source:

- `replace` maps to Codex `baseInstructions`;
- append-only fragments map to Codex `developerInstructions`;
- append fragments are rendered before the first model turn and supplied on
  both fresh start and resume.

Dreamux core remains responsible for persisting the source data that produces
append fragments. The Codex adapter remains stateless with respect to that
source and only renders the create-context value it receives.

## Contract

Dreamux persists structured prompt sources, not provider-rendered prompt blobs.
For the current Team and TeamMate identity feature, the sources are:

- the deterministic one-line TeamLeader default derived from the Team name;
- the optional TeamLeader identity prompt persisted on the TeamLeader identity
  record;
- the optional TeamMate or team-member identity prompt persisted on that
  agent's identity record;
- dispatcher prompt constants supplied by dispatcher launch.

If a future feature introduces another append prompt source that cannot be
reconstructed from existing durable Dreamux state, that source must be persisted
in Dreamux-owned state before it is handed to a runtime adapter. Runtime
adapters must not become hidden prompt-state stores.

The Codex adapter selection rules are:

- when `replace` is present, pass it as `baseInstructions` and do not also apply
  `append`;
- when `replace` is absent and non-empty `append` fragments exist, render the
  ordered fragments and pass the result as `developerInstructions`;
- when neither selected prompt form is present, omit both Codex instruction
  fields.

The same selected instructions are supplied to:

- `thread/start` for a fresh Codex thread;
- `thread/resume` for an existing Codex thread;
- fallback `thread/start` when `thread/resume` fails and the runtime starts a
  replacement thread.

Because current Codex does not persist `developer_instructions`, Dreamux cannot
assume a cold resume will keep append-only guidance from the original start
request. Re-supplying `developerInstructions` on resume is load-bearing.

Codex `developerInstructions` does not add XML wrappers. It only provides
developer-role separation. To keep Dreamux's append array boundary stable, the
Codex adapter renders every append element as its own XML block:

```xml
<developer-reminder>
...
</developer-reminder>
```

The adapter escapes XML text content inside each block. It should reuse the
existing Codex append renderer rather than introducing a second renderer for the
same XML boundary contract. After empty fragments are filtered, an empty result
omits `developerInstructions`; it must not send an empty string. For non-empty
append input, the adapter joins the rendered blocks with blank lines and sends
the joined string as `developerInstructions`.

The adapter must not send append guidance through `thread/inject_items`,
first-turn input, `channelInput`, `completionInput`, or `baseInstructions`.

Dreamux must continue to fail loudly when the installed Codex version cannot
support the selected runtime prompt protocol. The existing Dreamux minimum
Codex version (`0.137.0`) is already high enough for `developerInstructions`,
because that field is present in Codex `rust-v0.137.0`. This change should keep
or raise the version gate only if later code facts require it, but the gate and
diagnostic text must no longer claim that teammate completion delivery depends
on `thread/inject_items`.

Reverse completion delivery is separate from append prompt delivery. Current
Codex completion delivery uses `completionInput` -> `turn/start`, not
`thread/inject_items`. This change must not remove or weaken that `turn/start`
completion path, but it should remove the stale prompt-append item-injection
helpers when no callers remain.

If Codex later persists `developer_instructions` natively, Dreamux may still
re-supply the same developer instructions on resume unless a future verified
Codex contract proves duplicate application would occur. That future change
requires a new proposal or decision update with source evidence.

## Acceptance

- `ThreadStartParams` and `ThreadResumeParams` in
  `/packages/agent-runtime/codex/src/types.ts` include `developerInstructions`.
- The Codex runtime passes rendered append-only guidance as
  `developerInstructions` on fresh `thread/start`, `thread/resume`, and fallback
  fresh `thread/start` after resume failure.
- The Codex runtime no longer calls `thread/inject_items` for
  `systemPrompt.append`.
- Existing completion delivery behavior remains unchanged. This change must not
  remove or weaken the reverse-completion delivery path
  (`completionInput` -> `turn/start`).
- Stale `thread/inject_items` append-prompt plumbing is cleaned up when no
  callers remain: the `buildCodexSystemPromptAppendItem` helper is removed, and
  the internal `injectThreadItems` helper is either removed or retained only with
  a real remaining caller or a clearly documented near-term use.
- Codex version gate comments and diagnostics are updated so they describe the
  current runtime requirements and fail-loud behavior instead of the stale
  "teammate completion delivery via `thread/inject_items`" rationale.
- `replace` continues to map to `baseInstructions`, and Codex still suppresses
  `append` when `replace` is present so dispatcher guidance is not duplicated.
- Append-only prompts never become `baseInstructions` and never appear in the
  first user/channel/completion turn text.
- Tests cover fresh start, resume, resume-fallback start, replace precedence,
  XML escaping, omission of empty `developerInstructions`, completion delivery
  through `turn/start`, and the absence of append prompt delivery through
  `thread/inject_items`.
- Focused verification runs for the Codex runtime package tests touched by this
  change, plus repository KB validation when proposal links change.

## Out of scope

- Persisting provider-rendered system prompt blobs in Dreamux state.
- Changing TeamLeader or TeamMate identity storage beyond the existing durable
  identity prompt source.
- Changing Claude Code append behavior; it already maps append fragments to
  native `--append-system-prompt` arguments.
- Adding channel-level system prompt injection.
- Adding a runtime capability flag for replace or append support.
