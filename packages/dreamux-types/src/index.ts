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
 * Root-export policy (issue #209): the root aggregates every public contract
 * type so an external provider author can name any of them directly. A type
 * being reached only *contextually* today — through a property of one of these
 * interfaces or an implemented method's parameter — is not a reason to hide it:
 * the package is type-only, so re-exporting a public type costs nothing at
 * runtime and keeps the surface honest (a provider author can name a shape they
 * legitimately depend on). The `exports` map publishes only this root, so this
 * list IS the public API. `tests/root-exports.test.ts` locks the surface to the
 * full set of public types in the source modules so future slices grow it
 * deliberately, not by accident.
 */
export type { DreamuxLogger } from './logger.js';
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
  SubscribeChannelProviderDescriptor,
} from './provider.js';
export type {
  InboundAttachment,
  InboundDeliveryHooks,
  InboundDeliveryResult,
  InboundTurnInput,
  TurnSettledSignal,
} from './turn.js';
export type {
  AgentRuntime,
  AgentRuntimeBinCheck,
  AgentRuntimeCapabilities,
  AgentRuntimeContextSnapshot,
  AgentRuntimeCreateContext,
  AgentRuntimeDiagnostic,
  AgentRuntimeDiagnosticContext,
  AgentRuntimeDiagnosticRunner,
  AgentRuntimeDiagnosticResult,
  AgentRuntimeIdentity,
  AgentRuntimeLastResult,
  AgentRuntimeMcpServer,
  AgentRuntimePathContext,
  AgentRuntimeProvider,
  AgentRuntimeProviderConfigReadContext,
  AgentRuntimeProviderFactory,
  AgentRuntimeResumeCapability,
  AgentRuntimeResumeCheckpoint,
  AgentRuntimeSkillSource,
  AgentRuntimeStateCallbacks,
  AgentRuntimeStatus,
  AgentRuntimeSystemPrompt,
  AgentRuntimeTextInput,
  AgentRuntimeTurnResult,
} from './agent-runtime.js';
export type {
  ChannelBinCheck,
  ChannelConfigContext,
  ChannelDiagnostic,
  ChannelDiagnosticContext,
  ChannelDiagnosticRunner,
  ChannelDiagnosticResult,
  ChannelInboundEnvelope,
  ChannelMcpDescriptorContext,
  ChannelMessageTargetCheck,
  ChannelProvider,
  ChannelProviderFactory,
  ChannelReactInput,
  ChannelReplyInput,
  ChannelRoutes,
  ChannelSender,
  ChannelSession,
  ChannelSessionCreateContext,
  ChannelSessionlessToolContext,
  ChannelTarget,
  ChannelToolCall,
  ChannelToolContext,
  ChannelToolDescriptor,
  ChannelToolListContext,
} from './channel.js';
export type {
  SubscribeChannelConfigContext,
  SubscribeChannelEvent,
  SubscribeChannelMcpDescriptorContext,
  SubscribeChannelProvider,
  SubscribeChannelProviderFactory,
  SubscribeChannelRoutes,
  SubscribeChannelSession,
  SubscribeChannelSessionCreateContext,
} from './subscribe-channel.js';
