# Baseline function-valued construction inventory

This is a read-only source inventory for the [data-flow continuation](data-flow-follow-up.md),
captured after PR #457. It is a search index, not a verdict: real capability
methods, library hooks, test seams, and ownership plumbing are deliberately
listed together so the final design must classify rather than overlook them.

The scan covers 345 tracked package source TypeScript files. It examines
named interfaces/type aliases, including inherited callable members, and
separately locates function-valued object literal properties. Inline anonymous
constructor types and function arguments still require call-chain inspection.
Counts of fields are not counts of defects; one field can appear in several
inherited contracts.

## Named construction contracts

| Source | Callable members to trace |
| --- | --- |
| `packages/agent-runtime/claude-code/src/provider.ts` | `ClaudeCodeAgentRuntimeProviderOptions.resolveBinPath`, `ClaudeCodeAgentRuntimeProviderOptions.sessionFactory`, `ClaudeCodeAgentRuntimeProviderOptions.generateSessionId` |
| `packages/agent-runtime/claude-code/src/rpc.ts` | `ClaudeCodeStreamRpcOptions.log`, `ClaudeCodeStreamRpcOptions.reapOnTimeout`, `ClaudeCodeStreamRpcOptions.onRemoteControlUrl`, `ClaudeCodeStreamRpcOptions.onProtocolEvent` |
| `packages/agent-runtime/claude-code/src/runtime-activity.ts` | `ProtocolEventContext.activitySink` |
| `packages/agent-runtime/claude-code/src/runtime-deps.ts` | `ClaudeCodeRuntimeDeps.sessionFactory`, `ClaudeCodeRuntimeDeps.resolveBinPath`, `ClaudeCodeRuntimeDeps.generateSessionId`, `ClaudeCodeRuntimeDeps.activitySink` |
| `packages/agent-runtime/codex/src/events.ts` | `TurnSubscriptionOptions.onTokenUsage`, `TurnSubscriptionOptions.onItemStarted`, `TurnSubscriptionOptions.onItemCompleted`, `TurnSubscriptionOptions.onTerminal`, `TurnSubscriptionOptions.onUnscopedFailure` |
| `packages/agent-runtime/codex/src/provider.ts` | `CodexAgentRuntimeProviderOptions.codexProcessFactory`, `CodexAgentRuntimeProviderOptions.codexClientFactory` |
| `packages/agent-runtime/codex/src/runtime-deps.ts` | `CodexRuntimeDeps.allocateSocketPath`, `CodexRuntimeDeps.codexProcessFactory`, `CodexRuntimeDeps.codexClientFactory`, `CodexRuntimeDeps.activitySink` |
| `packages/agent-runtime/codex/src/turn-manager.ts` | `TurnManagerOptions.activitySink`, `TurnManagerOptions.log` |
| `packages/channel/feishu-channel/src/ask-user/registry.ts` | `AskUserRegistryOptions.onExpire`, `AskUserRegistryOptions.newRequestId` |
| `packages/channel/feishu-channel/src/bot.ts` | `CreateFeishuBotDeps.createTransport` |
| `packages/channel/feishu-channel/src/cot/adapter.ts` | `FeishuCotAdapterOptions.cotClient` |
| `packages/channel/feishu-channel/src/cot/io.ts` | `FeishuCotIoOptions.cotClient` |
| `packages/channel/feishu-channel/src/feishu-bounded-operation.ts` | `FeishuBoundedOperationOptions.operation`, `FeishuBoundedOperationOptions.beforeStart`, `FeishuBoundedOperationOptions.onLateValue`, `FeishuBoundedOperationOptions.now` |
| `packages/channel/feishu-channel/src/feishu-document-comments.ts` | `FeishuDocumentCommentsOptions.submit` |
| `packages/channel/feishu-channel/src/feishu-provisioning.ts` | `FeishuProvisioningOptions.submit`, `FeishuProvisioningOptions.announce` |
| `packages/channel/feishu-channel/src/feishu-slash-commands.ts` | `CommandContext.bindChannel`, `CommandContext.resolveChatName` |
| `packages/channel/feishu-channel/src/inbound/work.ts` | `FeishuInboundWorkOptions.now`, `FeishuInboundWorkContext.isSessionActive`, `FeishuInboundWorkContext.assertSessionActive`, `FeishuInboundWorkContext.assertEnrichmentActive`, `FeishuInboundWorkContext.remainingTimeMs`, `FeishuInboundWorkContext.dispose` |
| `packages/channel/feishu-channel/src/provider.ts` | `CreateFeishuChannelProviderOptions.botFactory` |
| `packages/channel/feishu-channel/src/routing/operations.ts` | `FeishuBindingOperationsOptions.notify` |
| `packages/channel/feishu-channel/src/session/card-actions.ts` | `FeishuCardActionsOptions.deliver` |
| `packages/channel/feishu-channel/src/session/session.ts` | `FeishuChannelSessionOptions.botFactory` |
| `packages/channel/feishu-transport/src/transport/cot.ts` | `FeishuCotClientOptions.now` |
| `packages/dreamux-types/src/agent-runtime.ts` | `AgentRuntimePathContext.cacheDir`, `AgentRuntimePathContext.logsDir`, `AgentRuntimePathContext.runtimeSocketDirs`, `AgentRuntimeCreateContext.activity` |
| `packages/dreamux-utils/src/os.ts` | `EnsureOwnerOnlyDirOptions.getuid` |
| `packages/dreamux-utils/src/runtime-state-fence.ts` | `RuntimeStateFenceOptions.terminate`, `RuntimeStateFenceOptions.log` |
| `packages/dreamux-utils/src/transactional-store.ts` | `TransactionalStoreOptions.load`, `TransactionalStoreOptions.encode` |
| `packages/dreamux/src/admin/socket.ts` | `AdminSocketOptions.chmodFn`, `AdminSocketOptions.isPidAlive`, `LegacyAdminServerCheckOptions.isPidAlive` |
| `packages/dreamux/src/agent-runtime/external-provider.ts` | `LoadAgentRuntimeProvidersOptions.importModule` |
| `packages/dreamux/src/channel/external-channel-provider.ts` | `LoadChannelProvidersOptions.importModule` |
| `packages/dreamux/src/daemon/install.ts` | `DaemonInstallOptions.execDirProbe` |
| `packages/dreamux/src/mcp/server.ts` | `RunMcpServerOptions.log` |
| `packages/dreamux/src/mcp/shim.ts` | `DreamuxMcpShimOptions.log` |
| `packages/dreamux/src/onboard/run.ts` | `RunOnboardOptions.execDirProbe` |
| `packages/dreamux/src/registry/provider-loader.ts` | `ProviderContractContext.fail`, `LoadProviderPackagesOptions.importModule` |
| `packages/dreamux/src/server.ts` | `ServerOptions.channelLoggerFactory`, `ServerOptions.workflowLoggerFactory`, `ServerOptions.runtimeSocketSweep` |
| `packages/dreamux/src/service/agent/factory.ts` | `AgentEntityCallbacks.onPersisted`, `AgentEntityCallbacks.findManagedWorktreeOwner` |
| `packages/dreamux/src/service/agent/index.ts` | `TeammateCollectionOptions.onPersisted`, `TeammateCollectionOptions.admitOperation`, `TeammateCollectionOptions.isClosing`, `TeammateCollectionOptions.initiatorFor`, `TeammateCollectionOptions.suffixGenerator` |
| `packages/dreamux/src/service/agent/mcp.ts` | `TeamMateMcpDispatcherScope.workspace` |
| `packages/dreamux/src/service/agent/service-types.ts` | `TeammateServiceDeps.onPersisted`, `TeammateServiceDeps.findManagedWorktreeOwner` |
| `packages/dreamux/src/service/channel-service/index.ts` | `ChannelServiceOptions.channelLoggerFactory` |
| `packages/dreamux/src/service/dispatcher-core-events/index.ts` | `ScopedChannelEventSourceLease.revoke` |
| `packages/dreamux/src/service/dispatcher-service/agent.ts` | `DispatcherAgentOptions.mcp`, `DispatcherAgentOptions.onPersisted` |
| `packages/dreamux/src/service/dispatcher-service/index.ts` | `DispatcherServiceOptions.channelLoggerFactory`, `DispatcherServiceOptions.workflowLoggerFactory` |
| `packages/dreamux/src/service/dispatcher-service/restart-intent.ts` | `NotifyResumedRestartOptions.runControl` |
| `packages/dreamux/src/service/dispatchers/index.ts` | `DispatchersOptions.channelLoggerFactory`, `DispatchersOptions.workflowLoggerFactory` |
| `packages/dreamux/src/service/scheduler/index.ts` | `SchedulerServiceOptions.admit`, `SchedulerServiceOptions.submitScheduled`, `SchedulerServiceOptions.now` |
| `packages/dreamux/src/service/team/leader.ts` | `TeamLeaderOpenDeps.leaderMcp`, `TeamLeaderOpenDeps.onPersisted` |
| `packages/dreamux/src/service/team/service.ts` | `TeamServiceDeps.leaderCompletionInitiator`, `TeamServiceDeps.admitOperation`, `TeamServiceDeps.isClosing`, `TeamServiceDeps.leaderMcp`, `TeamServiceDeps.announceTeam`, `TeamServiceDeps.agentNameSuffixGenerator` |
| `packages/dreamux/src/service/team/types.ts` | `TeamCollectionOptions.leaderCompletionInitiator`, `TeamCollectionOptions.admitOperation`, `TeamCollectionOptions.applyCreateTeamHook`, `TeamCollectionOptions.isClosing`, `TeamCollectionOptions.leaderMcp`, `TeamCollectionOptions.announceTeam`, `TeamCollectionOptions.nameSuffixGenerator`, `TeamCollectionOptions.agentNameSuffixGenerator` |
| `packages/dreamux/src/service/workflow-service/index.ts` | `WorkflowServiceOptions.completionInitiator`, `WorkflowServiceOptions.admit`, `WorkflowServiceOptions.createRunner`, `WorkflowServiceOptions.generateRunId`, `WorkflowServiceOptions.now` |
| `packages/dreamux/src/service/workflow-service/run.ts` | `WorkflowRunDeps.createRunner`, `WorkflowRunDeps.deliverTerminal`, `WorkflowRunDeps.now` |

## Review additions to the baseline index

The R71 source review identified two retained contracts beyond the original
named-type scan. Their dispositions belong to the final solution's retained
table; these entries make the call chains discoverable without changing the
historical baseline above.

- `packages/dreamux-utils/src/activity-scan.ts`: the anonymous `createScanBudget`
  input accepts `now`; the utility's existing tests provide fixed and advanced
  clocks. Provider adapters no longer forward an unused clock override.
- `packages/dreamux/src/daemon/environment.ts`: `ServiceNodeProbe` is an
  object with `realpath` and `isExecutable` operations, consumed by service-Node
  selection and doctor. Its recorded onboard-test supplier belongs to the
  parent restoration pass; it is distinct from `ExecDirProbe`.

## Additional call-chain checkpoints

- Inline constructor contracts: completion delivery acceptance, runtime-state
  fencing, provider event sinks, and store loader/commit callbacks.
- Object-returning factories: Team record handles, prepared completion
  submission, workflow-owned teammate handles, channel event-source leases,
  inbound work contexts, and role-scoped MCP delegates.
- Initial creation, failed construction after persistence, record-only close,
  reopen, host stop/restart, owner dissolve, and runtime-generation replacement.
- Preserve legitimate local task callbacks and external protocol registrations;
  do not disguise a parent-private-state closure as a method-only wrapper.

Final solution and implementation review must cover these checkpoints plus
any additional source discovered during independent consultation.
