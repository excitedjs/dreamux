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
 */
export type { DreamuxLogger } from './logger.js';
export type {
  BuiltinProviderRef,
  NpmProviderRef,
  ProviderDescriptor,
  ProviderKind,
  ProviderRef,
  ProviderRefSource,
} from './provider.js';
export type {
  InboundAttachment,
  InboundDeliveryHooks,
  InboundDeliveryResult,
  InboundTurnInput,
  NoticeInjectionResult,
  TurnSettledSignal,
} from './turn.js';
export type {
  AgentRuntimeBinCheck,
  AgentRuntimeCapabilities,
  AgentRuntimeContextSnapshot,
  AgentRuntimeDiagnosticRunner,
  AgentRuntimeDoctorResult,
  AgentRuntimeLastResult,
  AgentRuntimeMcpServer,
  AgentRuntimePathContext,
  AgentRuntimeProviderConfigReadContext,
  AgentRuntimeResumeCapability,
  AgentRuntimeResumeCheckpoint,
  AgentRuntimeResumeInput,
  AgentRuntimeRole,
  AgentRuntimeSkillSource,
  AgentRuntimeSystemInput,
  CompletionDeliveryShape,
  CompletionEnvelope,
  TeamMateCompletionDeliveryResult,
} from './agent-runtime.js';
export type {
  ChannelConfigContext,
  ChannelInboundEnvelope,
  ChannelListPeersInput,
  ChannelMessageTargetCheck,
  ChannelProvider,
  ChannelReactInput,
  ChannelReplyInput,
  ChannelRoutes,
  ChannelSender,
  ChannelSession,
  ChannelSessionCreateContext,
  ChannelTarget,
  ChannelToolCall,
  ChannelToolContext,
  ChannelToolDescriptor,
  ChannelToolListContext,
} from './channel.js';
