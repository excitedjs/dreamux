# Change Log - @excitedjs/agent-runtime-codex

This log was last generated on Tue, 25 Aug 2026 11:45:34 GMT and should not be manually modified.

## 0.4.0
Tue, 25 Aug 2026 11:45:34 GMT

### Minor changes

- BREAKING: Review: the turn manager now settles submissions with provider-owned completion tokens at thread result boundaries: folded submissions share one completion, queued submissions settle as distinct completions in native order, stop without an observed final result settles as stopped without fabricating a completion, and live activity flows through the submission activity sink. Test typecheck now actually covers tests/. No rebuild is required because these are runtime contract changes, not persisted state migrations.
- BREAKING: Review: external consumers must implement the required cold readTranscript provider method, persist thread.path with the native session checkpoint, and handle RuntimeAdmission plus stable RuntimeTurn objects instead of public app-server Turn IDs. Codex now reads bounded provider-neutral pages from active, archived, compressed, and history-base native rollouts; request uncertainty is ambiguous, folded aliases converge before settlement, and stop tears down transport before draining every started admission. No rebuild is required: existing Codex rollouts and Dreamux checkpoints remain readable, with provider-native rediscovery when a stored locator is absent or stale.

### Patches

- Compile the supported provider-neutral outputSchema subset into Codex strict schemas, restore optional-field semantics on completed JSON, and reject incompatible schemas or active-turn folding before submission.
- Forward structured output schemas to Codex turn/start.
- Unsubscribe Codex turn collectors after completion, failure, rejected turn/start, direct-run cleanup, and runtime stop so stale collectors cannot observe later turns.
- Stop native transcript pagination at the oldest completed Codex turn while preserving continuations when bounded scanning has not reached the transcript origin. No rebuild is required because native rollout and cursor formats are unchanged.

## 0.3.4
Mon, 27 Jul 2026 08:35:50 GMT

_Version update only_

## 0.3.3
Sun, 26 Jul 2026 02:44:44 GMT

_Version update only_

## 0.3.2
Sun, 19 Jul 2026 03:45:02 GMT

_Version update only_

## 0.3.1
Wed, 15 Jul 2026 02:54:37 GMT

### Patches

- Reject relative skill source root paths before applying Codex extra roots.
- Update Codex runtime path tests to use the AgentRuntimePathContext cacheDir() contract.
- Update Codex skill extra-root handling and tests to consume role-specific skill roots directly.

## 0.3.0
Fri, 03 Jul 2026 04:51:35 GMT

### Minor changes

- BREAKING: Refine AgentRuntime lifecycle contracts around turn-owned settlement results, kindless opaque checkpoint ids, instance-scoped state sinks, resume-only capabilities, removal of public submitTurn/injectControlNotice/systemInput projections, required channelInput and plain completionInput text delivery, provider-owned prompt injection, and runtime-owned skill source materialization.

### Patches

- Apply append-only systemPrompt guidance through Codex developerInstructions on thread start and resume.
- Support ordered append system prompt fragments, wrapping each fragment independently for Codex thread injection.
- Apply append-only systemPrompt guidance through Codex thread injection while keeping replacement prompts as baseInstructions.

## 0.2.0
Sat, 27 Jun 2026 12:09:24 GMT

### Minor changes

- Introduce the built-in Codex Agent Runtime package @excitedjs/agent-runtime-codex (alias builtin:codex, issue #209 slice 3). Implements the neutral @excitedjs/dreamux-types AgentRuntimeProvider (Codex app-server supervisor, WS RPC, initialize handshake, thread start/resume, turn manager, teammate completion delivery, config/args/version gate) and depends on @excitedjs/dreamux-types only — never on @excitedjs/dreamux core. Everything host-specific (per-dispatcher paths, the volatile rendezvous-socket root, the durable state sink, bundled-skill install, the Codex home/auth doctor) is injected by the host through the neutral create context and provider options.
- #209 core-neutrality cleanup for the built-in Codex Agent Runtime: the package owns its own Codex-specific concerns end-to-end (codex-home resolution + doctor, the neutral diagnostic, bin resolution, socket allocation from the host's neutral runtime-socket dirs) and ships a default provider-factory export so `builtin:codex` loads through the host's single dynamic provider loader exactly like an npm: provider. Env injection flows through the neutral AgentRuntimeCreateContext. No config/state/path change for operators.
- The built-in Codex Agent Runtime provider now owns its onboarding prompt for the Codex CLI binary and returns provider-owned raw config to Dreamux core. Its diagnostic result type is renamed to the shared `AgentRuntimeDiagnosticResult` provider contract.
- Apply role-gated bundled skill sources via the app-server `skills/extraRoots/set` RPC (issue #209 slice 6): after `initialize` and before `thread/start`/`thread/resume`, the runtime sets the deduped parent roots of the `skill-dir` `skillSources` on the create context, reapplying them on every app-server restart; empty sources skip the RPC and an RPC error fails the start loud. Support is covered by the existing codex >= 0.137 version floor. Removes the `prepareWorkspaceSkills` host hook and the `CodexWorkspaceSkillPrepResult` type that drove the retired workspace-symlink model.
- Implement the optional waitIdle activity hook for the Codex runtime and route scheduled/runtime-control system input through normal turn/start while preserving restart-notice skip behavior.

### Patches

- Fix: a codex app-server that predates the `skills/extraRoots/set` RPC no longer hard-bricks dispatcher startup (issue #209 slice 6 repair). `CodexRuntime.applySkillExtraRoots()` now distinguishes a capability/version gap — the backend does not implement the method at all, answering with an `unknown variant`/method-not-found error — from a genuine failure of the existing RPC. On a capability gap it fails OPEN: logs a warning and continues skill-blind instead of failing the start, so an older backend comes up rather than landing permanently `stopped`. Every other error (the RPC exists but applying the given roots failed) still fails LOUD, exactly as before. Classification is message-based (the RPC layer drops the JSON-RPC error code) and deliberately narrow.
- Type the package's default factory export against the published `AgentRuntimeProviderFactory` contract and validate+narrow the seed descriptor to the `agentRuntime` kind (issue #209 types-API audit). `CodexProviderFactoryContext` is now a back-compat alias of `ProviderFactoryContext<AgentRuntimeProviderDescriptor>`. No runtime behavior change.

