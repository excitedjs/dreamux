# Change Log - @excitedjs/agent-runtime-codex

This log was last generated on Fri, 09 Oct 2026 03:05:18 GMT and should not be manually modified.

## 0.7.0
Fri, 09 Oct 2026 03:05:18 GMT

### Minor changes

- Support ultrathink through native Codex effort parameters, restore ordinary effort on the next ordinary submission, and pass submission text through unchanged. Busy input follows native Codex timing.
- Align the Codex ultrathink keyword with Claude Code: a matching submission now also carries the sentence Claude Code injects, as a separate input item beside the unchanged submission text, and the keyword must appear as a whole word. A submission where it is only part of a word, such as 'ultrathinking', no longer raises effort.
- Fixed the codex doctor to validate the Codex home actually in effect for an agent, instead of always ~/.codex: it now resolves CODEX_HOME (and the OPENAI_API_KEY/CODEX_API_KEY/CODEX_ACCESS_TOKEN auth check) from the same effective env the runtime spawns its Codex child with (ambient env plus the agent's own extra_env), via one CODEX_HOME resolver paths.ts now shares between the runtime spawn path, the activity reader, and the doctor. Previously doctor ignored extra_env entirely and always checked the operator's global ~/.codex, so an operator-configured per-agent CODEX_HOME or auth override produced false doctor failures or false passes. Also removed the dead codexHomeDoctor hook end to end: CodexAgentRuntimeProviderOptions no longer has a codexHomeDoctor field (nothing in this repo ever supplied it), and codex-home.ts's assertDispatcherCodexHomeReady, formatDispatcherCodexHomeErrors, and DispatcherCodexHomeDoctor type, which only existed to serve that hook, are gone from the package's exports along with paths.ts's operatorCodexHome/dispatcherCodexHome/dispatcherCodexConfigPath (replaced by the internal codexSpawnEnv/resolveCodexHomeDir). dispatcherCodexHomeDoctorContext now takes a required env argument, and validateDispatcherCodexHome no longer accepts a bare dispatcher-id string (its only caller already passed a full context). Nothing persisted changes.
- The package keeps its default neutral provider factory for configured npm provider refs and exports createCodexPlugin for builtin plugin loading. createCodexAgentRuntimeProvider remains the named bare-provider constructor. Internal process, RPC, and diagnostic helpers are no longer public barrel exports; callers inside the package use their owning modules. Existing configured official npm provider refs continue to load.
- Implemented the new AgentRuntimeProvider.operatorStateRoot capability, returning the operator's default Codex home (resolveCodexHomeDir(process.env), with no per-agent extra_env override applied). Dreamux core's uninstall guard now sources its protected Codex path from this instead of a hard-coded ~/.codex literal: for a default install the protected path is still ~/.codex, but if CODEX_HOME is set in the environment dreamux uninstall runs in, the guard now protects that directory instead.
- PR #455 review round: `codexSpawnEnv` now takes the base env as an explicit parameter instead of reading `process.env` internally. The managed-service `dreamux doctor` check builds its Codex spawn env from the diagnostic context's own target env (the installed service's persisted env) merged with `extra_env`, instead of the ambient env of the process running `doctor`; a per-agent `CODEX_HOME` or auth override that only differs between the terminal and the installed systemd unit is now validated against the environment the managed service actually runs with. The runtime spawn and the activity reader are unaffected: both still merge `extra_env` onto the live process's own `process.env`, passed explicitly at the call site now instead of implicitly inside the helper.
- An `agents[].config` block for a `builtin:codex`/`npm:`-codex-runtime provider now follows the same persisted-shape policy (R21) as the rest of config.json: an unrecognized key is tolerated and ignored instead of refusing `dreamux serve`. This drops the allow-list added by stage 2a for `turn_timeout_ms`/`approval_policy` (which is superseded, not narrowed) along with `bin`/`sandbox_mode`/`extra_args`/`extra_env`/`initialize_timeout_ms`; wrong types and missing required fields still fail loading.
- Code organization refactor stage 2a, item 8 (R24/R25): agents[].config.turn_timeout_ms and .approval_policy are no longer read - Codex approval policy is always 'never' (issue #2 trust model), and turn_timeout_ms was accepted-and-ignored with no runtime effect. Both keys are still tolerated (and ignored) in an existing config.json - a file that sets either does not need editing.
- Code organization refactor stage 2b, item 3: enable exactOptionalPropertyTypes. CodexProcessOptions.binPath and HandshakeOptions.timeoutMs (both published: binPath from index.ts's CodexProcessOptions, timeoutMs from performInitializeHandshake's exported HandshakeOptions parameter type) now type as string | undefined and number | undefined so a caller can construct the field with an explicit undefined value, not only omit it. Non-breaking widening; no runtime change.
- Construct Codex processes and clients directly, removing codexProcessFactory and codexClientFactory provider options. Retain numeric restart backoff settings and per-start socket allocation; internal turn and skill-root diagnostics use DreamuxLogger objects.
- Report text-free compaction and interruption activities. Use native item ids for assistant, tool and compaction activities, and turn ids for usage and interruption; remove callId.
- Emit one cumulative token.usage snapshot per native turn from the app-server thread/tokenUsage/updated totals, keeping no baseline or history; the formatted usage summary is no longer emitted as an assistant message.

### Patches

- Keep the package default compatible with configured npm provider references and expose createCodexPlugin separately. Clarify provider-owned activity bounds and restore runtime, activity and lifecycle coverage. Verify the actual neutral provider instance, including operatorStateRoot, separately from its runtime handle and package exports.
- The config reader throws `RuleViolation` from `@excitedjs/dreamux-utils` for a refused `bin` or `sandbox_mode` value instead of a plain `Error`; messages are unchanged.
- Bind fixed runtime context once and return persistence and cleanup operations to their owning services.
- The Codex home auth check in `dreamux doctor` also accepts a home whose selected `model_provider` authenticates through its own `[model_providers.<id>]` table (a non-empty `experimental_bearer_token`, or an `env_key` whose variable is set). Such a home has no `auth.json` and was reported as missing auth even though the runtime started normally.

## 0.6.0
Thu, 10 Sep 2026 04:59:50 GMT

### Minor changes

- Codex agents can now interrupt the active app-server turn through turn/interrupt; an idle runtime reports that no turn is running, and an interrupted turn is marked on its card with the same [Request interrupted by user] line Claude Code writes.
- Project a web search's query and action as the call's arguments, so a search row can show what was asked; codex states them outside the argument members every other item uses.

### Patches

- Show native context and cumulative token usage before the turn display ends, without extra queries or transcript scans.
- Display the inner script of recognized Codex shell commands in tool summaries and invocations without changing execution arguments.
- Display context compaction as COMPACTED SESSION without changing activity timing or summary suppression.

## 0.5.0
Fri, 04 Sep 2026 10:24:24 GMT

### Minor changes

- BREAKING: Review: Codex tool-call activity now reports a required neutral display action, using null when no classified action applies. No rebuild is needed.
- BREAKING: Review: The Codex runtime now reports the end of each runtime-native turn through the optional neutral `nativeTurn` sink, exactly once per turn, driven by Codex's one `turn/completed` regardless of how many Dreamux submissions that turn folded. A failed finalize or a codec restore reports `failed`, and a stopped turn reports `interrupted`. The report is display-only and fail-open: a throwing sink never affects submission settlement. No rebuild is needed.
- Tool calls now carry display facts in the codex TUI's own wording: a command is labelled by the files it read, the paths it listed, or the query it searched when codex's command parse is uniform, otherwise by its first line, always with the command line as the invocation; a patch by the files it touches with the diffs codex prepared as the invocation. Read commands and patches also report their files as the call's items (from the parsed command's path and the patch's paths). Web search items, previously dropped because they carry no tool name, now appear as web_search rows labelled by the query or page. A context compaction (the contextCompaction item's completion) is published as an assistant message reading "Compacted session". Assistant messages and completions no longer carry a truncated flag: the provider never truncated, and the seam no longer asks.
- BREAKING: Review: confirm no external automation depends on the removed transcript reader, `waitIdle`, live `getContext`, or handle-level `getCapabilities`; there are no compatibility aliases. No rebuild is needed. Migrated to the replaced `AgentRuntimeProvider` contract: continuous recovery, session-bound structured output, leased state updates, and recent Activity Records over the active session replace the removed transcript reader, `waitIdle`, live `getContext`, and handle-level `getCapabilities`. Dreamux-owned system-prompt fragments are re-supplied on every runtime-context rebuild: a `replace` fragment is mapped to `baseInstructions`, and `append` fragments are mapped to `developerInstructions` only when no `replace` is present. The runtime no longer renders a channel envelope or branches on an input source.
- Report live activity through one agent-keyed sink: the native-turn sink is gone and a turn end is emitted as a `turn.ended` activity carrying codex's own error text. The per-turn pending-activity buffer is deleted, so thread items observed before a submission binds are reported instead of buffered and possibly dropped, and such a turn's end is reported too rather than dropped, so the card its items opened can close; orphan turns are still released from the collector. No config, state, or path shape changed and no rebuild is required. The end is now reported the moment codex reports the native turn's terminal, independent of the submission line: a turn codex only ever streamed items for is ended by a stop or a protocol failure instead of disappearing, and a turn whose encoded result cannot be restored is shown as the completed turn codex reported (the submission still settles as failed). The provider keeps no display state: a stop or a protocol failure reports one end without asking whether a turn was open, and a consumer with nothing open ignores it.

### Patches

- Say what the Codex runtime actually knows when it rejects an approval request. The warn log and the approval handler's module doc both explained the rejection in terms of Feishu outbound being MCP reply-only — a Channel fact a runtime package cannot see and does not depend on. Both now state the runtime-owned truth: approvals are unsupported in Dreamux-managed runtimes. Wording only; no behavior, config, state, or path shape changed and no rebuild is required.
- Translate the remaining Chinese text in the Codex runtime source to English. The two approval-handler errors a user can actually see — approvals unsupported in this version, and an unsupported codex server-request — now read in English with their meaning unchanged, including the same remedy (configure codex approval-policy=never, or deploy the dispatcher in a trusted-local environment). Chinese issue-section citations in module docs and one startup-refusal message are rendered in English too, so the repository's English-only source rule holds across the package. Text only; no behavior, config, state, or path shape changed and no rebuild is required.

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

