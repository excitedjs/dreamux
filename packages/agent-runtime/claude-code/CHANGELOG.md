# Change Log - @excitedjs/agent-runtime-claude-code

This log was last generated on Fri, 04 Sep 2026 10:24:24 GMT and should not be manually modified.

## 0.6.0
Fri, 04 Sep 2026 10:24:24 GMT

### Minor changes

- BREAKING: Review: Claude Code tool-call activity now reports required neutral display fields: action is required but nullable when no classified action applies, and failed tool results populate error from provider result detail when available, using null only when the detail is unavailable. No rebuild is needed.
- BREAKING: Review: The Claude Code runtime now reports the end of each runtime-native turn through the optional neutral `nativeTurn` sink. One native turn is one terminal `result`: several Dreamux submissions folded into a single `result` share its one end, while a submission that Claude Code runs on its own after answering an earlier one is answered by a further `result` and reports a further end, so one resident execution window can legally report several. Every terminal result reports exactly once by construction. A failure, protocol loss, cancellation, or stop that produces no result synthesizes `failed` or `interrupted` only when that call actually settles a still-open submission, so an ordinary successful result has no trailing synthesized interruption and requires no provider-side deduplication state. The report is display-only and fail-open: a throwing sink logs a warning and never affects submission settlement. No rebuild is needed.
- Tool calls now carry display facts derived from the built-in tool's input: a Bash call is labelled by its description (or the first line of its command) with the command line as the invocation; Read/Write/Edit/NotebookEdit by their path, which is also the call's one item; Grep/Glob/WebSearch/ToolSearch by their pattern or query; Agent by its description with the task text as the invocation; Skill by the skill name; WebFetch by its URL. MCP and other unknown tools report no label. The tool vocabulary now lives in one module (tool-display.ts). A context compaction (the CLI's system/compact_boundary envelope) is published as an assistant message reading "Compacted session". Assistant messages and completions no longer carry a truncated flag: the provider never truncated, and the seam no longer asks; the summary the CLI wrote stays hidden with every other user-role text.
- BREAKING: Review: confirm no external automation depends on the removed transcript reader, `waitIdle`, live `getContext`, or handle-level `getCapabilities`; there are no compatibility aliases. No rebuild is needed. Migrated to the replaced `AgentRuntimeProvider` contract: continuous recovery, session-bound structured output, leased state updates, and recent Activity Records over the active session replace the removed transcript reader, `waitIdle`, live `getContext`, and handle-level `getCapabilities`. Dreamux-owned system-prompt replace/append fragments are re-supplied on every runtime-context rebuild and mapped to `--append-system-prompt`; the runtime no longer renders a channel envelope or branches on an input source.
- BREAKING: Review: confirm live steering still behaves as expected — Dreamux no longer sends any `priority` on the claude stream-json user envelope, where it previously always sent `priority: 'next'` for a live steer. This is a deliberate feature removal, not a regression. No config, state, cache, or path shape changed and no rebuild is needed. Live activity is reported through one sink keyed on the agent: the native-turn sink is gone and a turn end is emitted as a `turn.ended` activity carrying claude's own error text. Streamed output that no started command could be attributed to is now reported instead of dropped. The end now comes from claude's own terminal — its `result`, the failure that killed the run, or the stop that tore it down — instead of from the completion the submission line builds: a native turn with no submission left to settle is ended rather than skipped, a result whose text cannot be extracted is shown as the completed turn claude reported, and a result no started command can be attributed to is shown with claude's own status (those submissions still fail). The runtime keeps no display state: a stop or a fence teardown of a live child, or a run that died, reports one end without asking whether a turn was open, and a consumer with nothing open ignores it.

### Patches

- Claude Code `user` envelopes on stdout are no longer shown on the conversation display. The stream-json mapping read block types alone, so the text the CLI injects into its own conversation — the whole SKILL.md after a `Skill` call, hook output, reminders — was published as the agent's own `assistant.message` and rendered as long markdown on Feishu COT cards. Only `assistant` envelopes now yield text and tool-call activity; a `user` envelope yields tool results only. The display seam is typed to those two envelopes (`ClaudeActivityLine`), and the RPC no longer forwards other stream lines to it.

## 0.5.0
Tue, 25 Aug 2026 11:45:34 GMT

### Minor changes

- BREAKING: Review: turn settlement now creates provider-owned completion tokens at real native result boundaries on top of lifecycle-terminality gating: folded live-steer sends resolve to one shared completion, queued sends resolve to distinct completions in native order, stop without an observed final result settles as stopped without fabricating a completion, and live assistant/tool activity is reported through the submission activity sink. The Last completion boundary now recognizes terminal results correctly. Test typecheck now actually covers tests/. No rebuild is required because these are runtime contract changes, not persisted state migrations.
- Support structured output via the create-context outputSchema, mapped to the native --json-schema flag on the resident stream-json session. A per-turn schema matching the spawn-time one is a no-op; a differing one still fails loud.
- Pass --json-schema at resident session creation so structured_output is enforced for the session lifetime. Prefer structured_output over free-form result text, fail loud when a schema session returns none, and cache lastResult only after all validation passes so failed turns never leak unvalidated text.
- BREAKING: Review: external consumers must implement the required cold readTranscript provider method, persist the native transcript locator with the session checkpoint, and handle RuntimeAdmission plus stable RuntimeTurn objects instead of public command identifiers. Fresh Claude Code sessions are now pinned with --session-id, native transcript pagination owns opaque cursors and bounded provider-neutral projection, live steer fails loudly without msg_lifecycle_v1, post-write uncertainty is ambiguous, and stop drains every started admission. No rebuild is required: existing native Claude sessions and Dreamux checkpoints remain readable, with provider-native rediscovery when a stored locator is absent or stale.

### Patches

- Settle resident turns when every submitted command has reached a terminal `command_lifecycle` state and at least one `result` has been seen, and parse `command_lifecycle` as a top-level `type` (the resident CLI's actual wire shape, keeping the `system`-subtype shape for backward compatibility). The previous gate never opened for top-level envelopes, so turns hung until the 600s idle reap even though `result` had arrived. Counting results per command cannot replace it: the CLI folds messages that arrive during a tool call into the running turn and answers several commands with a single `result`, and a folded command's uuid never appears on any result. Lifecycle terminality is the only signal that stays 1:1 with submitted commands, and its ordering against `result` is not stable, so the turn now waits for eventual arrival of both and settles with the last result seen. A `result` naming a command the pending turn never submitted is warned about and dropped instead of settling it with another turn's answer; the uuid-less envelope a `priority: 'now'` interrupt produces no longer settles a turn on its own. A command reported `cancelled`/`discarded` stops being waited on with a warning and does not fail a turn its other commands can still answer, but a turn whose commands all ended without ever running now fails immediately with the cause instead of waiting for the idle deadline, which would have reaped a healthy resident child. A build without `msg_lifecycle_v1` settles on its first result. A `result` arriving with no pending turn logs a warning instead of being dropped silently.

## 0.4.3
Mon, 27 Jul 2026 08:35:50 GMT

_Version update only_

## 0.4.2
Sun, 26 Jul 2026 02:44:44 GMT

_Version update only_

## 0.4.1
Sun, 19 Jul 2026 03:45:02 GMT

_Version update only_

## 0.4.0
Wed, 15 Jul 2026 02:54:37 GMT

### Minor changes

- Pass Claude Code MCP config as inline --mcp-config JSON instead of writing mcp.json under runtime state. Move skill adapters to the AgentRuntimePathContext cacheDir() root; adapters are keyed by canonical skill source set and published atomically without deleting a live adapter directory.

### Patches

- Reject relative skill source root paths before materializing Claude add-dir links.
- Fold Dreamux-owned completionInput sends into the active Claude Code logical turn so in-flight TeamMate follow-ups steer the current turn instead of creating separate completions.
- Update Claude Code skill materialization to consume role-specific skill roots and expose only the skills under the selected root.

## 0.3.0
Fri, 03 Jul 2026 04:51:35 GMT

### Minor changes

- BREAKING: Refine AgentRuntime lifecycle contracts around turn-owned settlement results, kindless opaque checkpoint ids, instance-scoped state sinks, resume-only capabilities, removal of public submitTurn/injectControlNotice/systemInput projections, required channelInput and plain completionInput text delivery, provider-owned prompt injection, and runtime-owned Claude add-dir skill materialization.

### Patches

- Support ordered append system prompt fragments, wrapping each fragment independently for Claude Code native append prompts.
- Apply append-only systemPrompt guidance through Claude Code native append prompts.

## 0.2.0
Sat, 27 Jun 2026 12:09:24 GMT

### Minor changes

- Consume the neutral disableFeatures runtime context in the Claude Code provider. The cron feature maps to Claude Code's native CronCreate,CronDelete,CronList disallowed tools and userInterrupt maps to AskUserQuestion; all requested features are merged into a single --disallowedTools flag and unknown feature names are ignored.
- Introduce the built-in Claude Code Agent Runtime package @excitedjs/agent-runtime-claude-code (alias builtin:claude-code, issue #209 slice 4). Implements the neutral @excitedjs/dreamux-types AgentRuntimeProvider (resident stream-json supervisor, the stream-json wire protocol, turn RPC, per-turn idle deadline, MCP config translation, plain-turn teammate completion delivery, config/args) and depends on @excitedjs/dreamux-types only — never on @excitedjs/dreamux core. Everything host-specific (per-dispatcher paths, the durable state sink) is injected by the host through the neutral create context and provider options.
- #209 core-neutrality cleanup for the built-in Claude Code Agent Runtime: the package owns its own engine-specific concerns (the neutral diagnostic, stderr log composition, resident session) and ships a default provider-factory export so `builtin:claude-code` loads through the host's single dynamic provider loader like an npm: provider. Env injection flows through the neutral AgentRuntimeCreateContext. No config/state/path change for operators.
- The built-in Claude Code Agent Runtime provider now owns its onboarding prompt for the Claude Code CLI binary and returns provider-owned raw config to Dreamux core. Its diagnostic result type is renamed to the shared `AgentRuntimeDiagnosticResult` provider contract.
- Translate add-dir-compatible role-gated skill sources into startup `--add-dir <dir>` flags (issue #209 slice 6): sources whose layout marks a `.claude/skills` container are added (deduped, on both start and re-spawn) so claude discovers their skills; incompatible layouts (e.g. the bundled Dreamux `skill-dir` sources) emit nothing, preserving claude-code's prior behavior of injecting no bundled skills. Adds `skillSources` to the resident args input and threads it through the provider/runtime.
- Implement the optional waitIdle activity hook for the Claude Code runtime with queued-turn accounting that excludes steer-folded channel input.

### Patches

- Type the package's default factory export against the published `AgentRuntimeProviderFactory` contract and validate+narrow the seed descriptor to the `agentRuntime` kind (issue #209 types-API audit). `ClaudeCodeProviderFactoryContext` is now a back-compat alias of `ProviderFactoryContext<AgentRuntimeProviderDescriptor>`. No runtime behavior change.

