/**
 * @excitedjs/dreamux-types
 *
 * Declaration-only provider-authoring contracts for Dreamux. External Agent
 * Runtime and Channel providers import Dreamux contracts from this package and
 * must not import `@excitedjs/dreamux`.
 *
 * This package emits declarations only: there is no runtime JS contract surface
 * and no runtime dependencies. See
 * `.agents/decisions/npm-package-split-and-channel-targets.md`.
 *
 * Scope: neutral contracts and catalog types only. No provider-specific paths,
 * selectors, or runtime-native record formats cross this boundary, and no
 * module here encodes a provider id or an exposure policy.
 *
 * Module layout follows domain ownership: `agent-runtime.ts` is the Provider /
 * native execution seam, `channel.ts` is the bridge lifecycle plus the two
 * generic Core ports, `command.ts` is the generic Command port, and `team.ts` /
 * `teammate.ts` hold the Core domain facts each of those entities owns.
 *
 * Root-export policy (issue #209): the root aggregates every public contract
 * type so an external provider author can name any of them directly. A type
 * being reached only *contextually* today — through a property of one of these
 * interfaces or an implemented method's parameter — is not a reason to hide it:
 * the package is type-only, so re-exporting a public type costs nothing at
 * runtime and keeps the surface honest (a provider author can name a shape they
 * legitimately depend on). The `exports` map publishes only this root, so this
 * list IS the public API.
 */
export type { DreamuxLogger } from './logger.js';
export type { JsonSchema, JsonValue } from './json.js';
export type { JsonInvokeResult, JsonInvoker } from './invoke.js';
export type {
  AgentRuntimeProviderDescriptor,
  BuiltinProviderRef,
  ChannelProviderDescriptor,
  DreamuxEnvironment,
  ProviderBinCheck,
  NpmProviderRef,
  ProviderDiagnosticRunner,
  ProviderDiagnosticScope,
  ProviderDescriptor,
  ProviderDiagnosticResult,
  ProviderFactory,
  ProviderFactoryContext,
  ProviderKind,
  ProviderOnboard,
  ProviderOnboardConfirmPrompt,
  ProviderOnboardContext,
  ProviderOnboardPromptHost,
  ProviderOnboardSecretPrompt,
  ProviderOnboardTextPrompt,
  ProviderRef,
  ProviderRefSource,
  RegisteredProvider,
} from './provider.js';
export type {
  AgentActivityError,
  AgentActivityPage,
  AgentActivityQuery,
  AgentActivityReadContext,
  AgentActivityRecord,
  AgentRuntime,
  AgentRuntimeActivitySink,
  AgentRuntimeBinCheck,
  AgentRuntimeConfigCapability,
  AgentRuntimeCreateContext,
  AgentRuntimeDiagnosticCapability,
  AgentRuntimeDiagnosticContext,
  AgentRuntimeDiagnosticRunner,
  AgentRuntimeDiagnosticResult,
  AgentRuntimeIdentity,
  AgentRuntimeLogger,
  AgentRuntimeMcpServer,
  AgentRuntimeOnboardCapability,
  AgentRuntimePathContext,
  AgentRuntimeProvider,
  AgentRuntimeProviderCapabilities,
  AgentRuntimeProviderConfigReadContext,
  AgentRuntimeProviderFactory,
  AgentRuntimeSessionRef,
  AgentRuntimeSkillSource,
  AgentRuntimeStartOutcome,
  AgentRuntimeStateLeaseRevokedError,
  AgentRuntimeStateSink,
  AgentRuntimeStateUpdate,
  AgentRuntimeStatus,
  AgentRuntimeSubmissionInput,
  AgentRuntimeSystemPrompt,
  RuntimeActivity,
  RuntimeActivityEvent,
  RuntimeAdmission,
  RuntimeCompletion,
  RuntimeSubmission,
  RuntimeSubmissionSettlement,
  RuntimeToolAction,
} from './agent-runtime.js';
export type {
  ChannelCommandError,
  ChannelCommandRetryableErrorCode,
  CoreCommandContext,
  CoreCommandDefinition,
  CoreCommandRegistry,
  CoreCommandSource,
} from './command.js';
export type {
  TeamCreateCommand,
  TeamCreateRepoRequest,
  TeamCreateResult,
  TeamStateEvent,
  TeamStateTeammateSummary,
  TeamSubmitCommand,
  TeamSubmitResult,
} from './team.js';
export type {
  TeamContainedRole,
  TeammateRole,
  TeammateStateEvent,
  TeammateStatus,
  TeammateTurnMessageEvent,
  TeammateTurnScope,
  TeammateTurnSettledEvent,
  TeammateTurnSubmittedEvent,
  TeammateTurnToolCallEvent,
} from './teammate.js';
export type {
  ChannelBinCheck,
  ChannelConfigCapability,
  ChannelConfigContext,
  ChannelCorePort,
  ChannelCoreEvent,
  ChannelDiagnosticCapability,
  ChannelDiagnosticContext,
  ChannelDiagnosticRunner,
  ChannelDiagnosticResult,
  ChannelEventSource,
  ChannelEventSubscription,
  ChannelIdentityCapability,
  ChannelInstance,
  ChannelMcpCall,
  ChannelMcpCallContext,
  ChannelMcpCaller,
  ChannelMcpCapability,
  ChannelMcpToolAnnotations,
  ChannelMcpToolDescriptor,
  ChannelMcpToolIcon,
  ChannelMcpToolOutcome,
  ChannelMcpToolRegistration,
  ChannelOnboardCapability,
  ChannelProvider,
  ChannelProviderFactory,
  ChannelSession,
  ChannelSessionCreateContext,
  ChannelSessionMcpCapability,
} from './channel.js';
