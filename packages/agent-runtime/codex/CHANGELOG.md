# Change Log - @excitedjs/agent-runtime-codex

This log was last generated on Sat, 27 Jun 2026 12:09:24 GMT and should not be manually modified.

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

