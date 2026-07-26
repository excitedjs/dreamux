# Change Log - @excitedjs/agent-runtime-claude-code

This log was last generated on Sun, 26 Jul 2026 02:44:44 GMT and should not be manually modified.

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

