# Change Log - @excitedjs/dreamux-types

This log was last generated on Fri, 04 Sep 2026 10:24:24 GMT and should not be manually modified.

## 0.9.0
Fri, 04 Sep 2026 10:24:24 GMT

### Minor changes

- BREAKING: Review: Runtime activity producers must provide the required action field on every tool-call activity, using null when no neutral action applies, and Channel consumers may receive the new conversation-display turn event union for dispatcher, team_leader, and team_member roles. No rebuild is needed.
- BREAKING: Review: Agent Runtime providers gain an optional native-turn seam and Channel consumers gain a seventh core event. `AgentRuntimeCreateContext.nativeTurn` is an optional, display-only `AgentRuntimeNativeTurnSink` a provider calls exactly once per runtime-native turn with a `RuntimeNativeTurnEnd`; `ChannelCoreEvent` adds the actor-scoped `TeammateNativeTurnEndedEvent`, which names the owning Dispatcher or TeamLeader and a status, and deliberately carries no logical turn id, submission member set, or presentation identity. A Channel that switches exhaustively over `ChannelCoreEvent['kind']` must handle the new kind; a provider that omits `nativeTurn` keeps working and simply publishes no native-turn end. No rebuild is needed.
- BREAKING: Review: RuntimeActivity and TeammateActivity tool.call now carry three required neutral display facts beside the tool name: summary (the one line the runtime's own UI labels the call with) invocation (the call as a person would write it, such as the shell command line), and items (what the call is about, one entry each, as the runtime's protocol lists them — today the files a read or edit touches; empty otherwise); TeammateInputEvent and TeammateActivity drop their Core-truncation flags (content_truncated, summary_truncated, invocation_truncated, arguments_truncated, result_truncated, reason_truncated), and RuntimeActivity's assistant.message drops its truncated member: Core redacts and never truncates, and a provider is not asked to. RuntimeCompletion's completed branch drops truncated as well: both bundled providers only ever set it to false, and nothing in Core read it. A provider outside this repository must populate the three facts (null when it has no label) and stop setting truncated on assistant messages and completions to compile. No rebuild is needed.
- BREAKING: Review: `TeammateTurnSubmittedEvent` now carries required `source_id: string | null`, returning the submitting caller's own id so that caller can recognize the turn its submission produced. Consumers constructing or exhaustively reading submitted events must handle the field; `null` means the submitter supplied none. It is not a routing key, persistence key, or presentation identity. No rebuild is needed.
- BREAKING: Review: every Agent Runtime and Channel provider must be rewritten against the replaced contracts; there are no compatibility aliases and an old provider fails to load. No rebuild is needed for local state. `AgentRuntimeProvider` now exposes `start`/`submit`/`stop` with provider-owned session identity, mandatory continuous recovery, mandatory session-bound structured output, a leased push state sink, optional live activity, and neutral recent Activity Records; `submit` takes final text only, so no source taxonomy, channel identifier, dedupe policy, or `waitIdle` crosses the seam. `ChannelProvider` replaces `ChannelRoutes` with direct lifecycle plus an `invoke` port and an event source, and adds the caller-scoped Channel MCP composition types. Core binding, `ChannelOrigin`, and every Collaboration Space type are removed, and the canonical Command and Team/TeamMate event envelopes are published here.
- `ChannelCommandError` gains an optional `action` field: when a command fails with a failure whose owning domain knows what the caller should do next, that sentence travels with the code and message. Existing consumers that read only `code` and `message` are unaffected. No config, state, or path shape changed and no rebuild is required.
- BREAKING: Review: every Channel provider must be rewritten against the four-kind Core event catalog, and every Agent Runtime provider against the single activity sink; an old provider fails to compile. No config, state, cache, or path shape changed and no rebuild is needed. Streaming display is keyed on the Agent instead of on a `RuntimeSubmission`. `ChannelCoreEvent` is now `team.state | teammate.state | teammate.input | teammate.activity`: the five turn-scoped kinds (`teammate.turn.submitted`, `teammate.turn.settled`, `teammate.turn.message`, `teammate.turn.tool_call`, `teammate.native_turn.ended`) and `TeammateTurnScope` are deleted, and both new kinds are actor-scoped with no `turn_id`. `teammate.input` is published at the moment of submission and carries the source, caller id, and body; `teammate.activity` nests the runtime's own vocabulary (`assistant.message`, `tool.call`, `turn.ended`). On the runtime seam, `RuntimeActivity` gains `occurredAt` and a `turn.ended` member and no longer names a submission; `RuntimeActivityEvent`, `RuntimeNativeTurnEnd`, `AgentRuntimeNativeTurnSink`, and `AgentRuntimeCreateContext.nativeTurn` are deleted, and `AgentRuntimeActivitySink` takes a `RuntimeActivity` directly. `AgentRuntimeSubmissionInput` stays `{ text }`.

### Patches

- Remove the dead `turn.ts` module (`InboundTurnInput` / `InboundAttachment`). These shapes stopped crossing the Agent Runtime seam when Channel rendering moved into each runtime, and they were deliberately withheld from the package root export, so they had no consumer in any package and no external provider author could name them. Deleting them changes no published type: the root export surface is unchanged, and the root-export guard now asserts the carve-out is gone rather than locking it in place.

## 0.8.0
Tue, 25 Aug 2026 11:45:34 GMT

### Minor changes

- BREAKING: Review: the Agent Runtime contract now settles submissions with provider-owned completion tokens: submit returns a RuntimeSubmission whose settlement resolves to an immutable RuntimeCompletion created at each real native result boundary, folded sends share one completion object, queued sends settle as distinct completions in provider order, stop without an observed final result settles as stopped without a completion, and providers report live assistant/tool activity through the submission's synchronous activity sink. Update every provider to create completion tokens at result boundaries and stop deriving settlement from per-send slots. No rebuild is required because these are provider and public TypeScript contract changes, not persisted Dreamux state migrations.
- Add outputSchema to AgentRuntimeCreateContext for spawn-time structured output, alongside the existing per-turn outputSchema on text turn inputs and the structural unsupported-feature error contract.
- BREAKING: Expand ChannelToolDescriptor with standard MCP title, icon, annotation, and output-schema metadata, and require every provider tool to declare an inputSchema. Existing external Channel providers must add an input schema to each published tool descriptor.
- BREAKING: Review: update every Agent Runtime provider to replace AgentRuntimeIdentity.checkpoint_id with typed checkpoint: AgentRuntimeResumeCheckpoint | null, remove AgentRuntime.getLast(), implement required cold readTranscript queries/pages/typed-reason errors, persist the native transcript_locator with its session checkpoint, and return RuntimeAdmission with stable RuntimeTurn objects. Provider-private Turn IDs, transcript locators, cursor positions, and arbitrary transcript error messages no longer belong in shared results; failed proves pre-admission rejection, ambiguous forbids automatic retry, and stop drains all started admissions. Channel delivery results remain status-only with no Turn lifecycle events. No rebuild is required because these are provider and public TypeScript contract changes, not persisted Dreamux state migrations.

## 0.7.0
Mon, 27 Jul 2026 08:35:50 GMT

### Minor changes

- Add an optional per-target repository to the public Channel ABI: DreamuxManagedRepoRequest (a source path and base_ref) and an optional repo field on ChannelCollaborationTargetEnsureInput. Existing providers stay source- and behavior-compatible.

## 0.6.0
Sun, 26 Jul 2026 02:44:44 GMT

### Minor changes

- Add public Channel core-event DTOs for route and collaboration-space binding transitions.

## 0.5.0
Sun, 19 Jul 2026 03:45:02 GMT

### Minor changes

- Add provider-declared binding fallbacks to ChannelTarget for less-specific route reuse.
- Add provider-neutral strict collaboration routing and live core event capabilities.

## 0.4.0
Wed, 15 Jul 2026 02:54:37 GMT

### Minor changes

- Add collaboration-space provisioning, channel lifecycle contracts, and default workspace/binding controls.
- BREAKING: Remove provider-authored channel MCP descriptor contracts. ChannelProvider.mcpServerDescriptor, ChannelMcpDescriptorContext, ChannelSession.tools, ChannelToolListContext, and InboundDeliveryHooks are removed; channel providers now expose only static tool catalogs plus handlers while Dreamux core owns MCP descriptor rendering and inbound ack/cancellation boundaries. The deferred SubscribeChannelProvider reservation is also removed from the public type package.
- BREAKING: Replace AgentRuntimePathContext.dispatcherDir(id) with cacheDir(), a global rebuildable cache-root seam for provider scratch. Runtime recovery remains in host-owned identity state, while providers keep logsDir() and runtimeSocketDirs() for logs and volatile sockets.
- BREAKING: Change the AgentRuntimeSkillSource.path contract from a single skill directory to a skill root whose direct children are skill directories. Runtime providers must apply or materialize skills from the direct child directories of each source root.

## 0.3.0
Fri, 03 Jul 2026 04:51:35 GMT

### Minor changes

- BREAKING: Refine AgentRuntime lifecycle contracts around turn-owned settlement results, kindless opaque checkpoint ids, instance-scoped state sinks, resume-only capabilities, removal of public submitTurn/injectControlNotice/systemInput projections, required channelInput and plain completionInput text delivery, provider-owned prompt injection, neutral skill sources, and removal of core-only completion envelope/spill-path types from the provider API.
- Allow AgentRuntimeSystemPrompt.append to carry ordered prompt fragments instead of a single append string.
- Allow AgentRuntimeSystemPrompt to carry append-only or replace-only prompt content so TeamMate identity guidance can reuse the neutral runtime prompt surface.

## 0.2.0
Sat, 27 Jun 2026 12:09:24 GMT

### Minor changes

- Add an optional neutral AgentRuntimeCreateContext.disableFeatures string list so Dreamux core can ask runtimes to disable host-level feature groups without naming runtime-specific tools or protocol settings. This is additive for provider authors; runtimes should map only the names they understand and ignore the rest.
- Introduce the declaration-only @excitedjs/dreamux-types package as the provider-authoring contract anchor (issue #209). Emits .d.ts only with no runtime dependencies, and publishes the complete neutral AgentRuntimeProvider/AgentRuntime/AgentRuntimeCreateContext and ChannelProvider contracts so external and built-in runtime/channel packages can be authored against types only.
- Additive provider-authoring contract members for the #209 core-neutrality work: the channel MCP surface (ChannelSession.mcpServerDescriptor / tools / handleTool, ChannelProvider.handleSessionlessTool, ChannelMcpDescriptorContext, ChannelSessionlessToolContext), ChannelProvider.getIdentity for a neutral self-reported channel identity, and the AgentRuntime create-context env-injection + path-context additions. Declaration-only and additive; existing provider authors are unaffected.
- BREAKING: provider diagnostics use one public naming scheme. The shared result type is now `ProviderDiagnosticResult`, with `AgentRuntimeDiagnosticResult` and `ChannelDiagnosticResult` aliases; the previous `*DoctorResult` provider-facing aliases are removed. Add shared provider onboarding prompt types plus channel diagnostic contracts so core can call provider-owned onboard and diagnostic capabilities without importing provider implementations.
- Remove the speculative `list_peers` channel capability (issue #209): the optional `ChannelSession.listPeers?` method and the `ChannelListPeersInput` type are removed from the public channel contract. They were never an owner-designed capability and had no implementation; external channel providers do not need to declare or implement peer enumeration. The rest of the `ChannelSession` contract (`reply` / `react` / `resolveTarget` / `tools` / `handleTool` / `messageBelongsToTarget`) is unchanged.
- Public types-API audit (issue #209). Remove `@types/node` host globals from the public contract: `AgentRuntimeDiagnosticRunner` options + `AgentRuntimeDiagnosticContext.env` now use the package-owned `DreamuxEnvironment` (`Record<string, string | undefined>`) instead of `NodeJS.ProcessEnv`; a guard test forbids `NodeJS.*` / `Buffer` from reappearing. Publish the provider factory contract: `ProviderFactoryContext<TDescriptor>` / `ProviderFactory<TProvider, TDescriptor>` plus kind-specific aliases `AgentRuntimeProviderFactory` / `ChannelProviderFactory`. Narrow descriptors by kind: new `AgentRuntimeProviderDescriptor` / `ChannelProviderDescriptor`, and `AgentRuntimeProvider.descriptor` is now `agentRuntime`-narrowed. `AgentRuntimeProvider.readConfig` may now return `TConfig | Promise<TConfig>` (parity with `ChannelProvider.readConfig`). Root-export surface: the package root aggregates every public type from the source modules so an external provider author can name any shape they depend on (the type-only package gains nothing by hiding a public type behind transitive resolution); a root-export allowlist test pins the surface to that full set, in both directions. Update the stale `channel.ts` header that implied a generic Channel MCP.
- Add the optional AgentRuntime.waitIdle activity hook and the scheduled system-input reason for durable scheduled task injection. The hook is additive and feature-detected; runtimes that omit it are treated as always idle.

### Patches

- Restore the public root type-only surface of @excitedjs/dreamux-types (issue #209 final review). The package root again re-exports `AgentRuntimeDiagnosticContext`, `AgentRuntimeResumeCapability`, `AgentRuntimeResumeCheckpoint`, and `ChannelSender`, so a provider author can import these public type names directly from `@excitedjs/dreamux-types`. Each is a parameter or property type of an interface a provider already implements (the `AgentRuntimeDiagnostic` methods, `AgentRuntimeCapabilities.resume` / `AgentRuntimeResumeInput.checkpoint`, and `ChannelInboundEnvelope.sender`); a declaration-only package gains nothing by hiding a public type behind transitive resolution. The root now aggregates every public type declared in the source modules, and a guard test pins the root export set to that full set in both directions (no casual widening, no casual hiding). The package stays strictly type-only: every re-export is `export type`, no runtime values are exported, and the manifest is unchanged.

