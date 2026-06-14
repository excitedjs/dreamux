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
 * Root-export policy (issue #209 overexposure audit): the names below are the
 * intentional public surface an external provider author names directly. Helper
 * shapes that a provider only reaches *contextually* — through a property of one
 * of these interfaces or an implemented method's parameter — are intentionally
 * NOT re-exported here even though they remain `export`ed from their source
 * module (so the emitted `.d.ts` still resolves them transitively). The
 * `exports` map publishes only this root, so an un-re-exported name is genuinely
 * unnameable by consumers. `tests/root-exports.test.ts` locks this allowlist so
 * future slices grow the surface deliberately, not by accident.
 */
export type { DreamuxLogger } from './logger.js';
export type {
  AgentRuntimeProviderDescriptor,
  BuiltinProviderRef,
  ChannelProviderDescriptor,
  DreamuxEnvironment,
  NpmProviderRef,
  ProviderDescriptor,
  ProviderFactory,
  ProviderFactoryContext,
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
  AgentRuntime,
  AgentRuntimeBinCheck,
  AgentRuntimeCapabilities,
  AgentRuntimeContextSnapshot,
  AgentRuntimeCreateContext,
  AgentRuntimeDiagnostic,
  AgentRuntimeDiagnosticRunner,
  AgentRuntimeDoctorResult,
  AgentRuntimeIdentity,
  AgentRuntimeLastResult,
  AgentRuntimeMcpServer,
  AgentRuntimePathContext,
  AgentRuntimeProvider,
  AgentRuntimeProviderConfigReadContext,
  AgentRuntimeProviderFactory,
  AgentRuntimeResumeInput,
  AgentRuntimeRole,
  AgentRuntimeSkillSource,
  AgentRuntimeStateCallbacks,
  AgentRuntimeStatus,
  AgentRuntimeSystemInput,
  AgentRuntimeTurnResult,
  CompletionDeliveryShape,
  CompletionEnvelope,
  TeamMateCompletionDeliveryResult,
} from './agent-runtime.js';
export type {
  ChannelConfigContext,
  ChannelInboundEnvelope,
  ChannelMessageTargetCheck,
  ChannelProvider,
  ChannelProviderFactory,
  ChannelReactInput,
  ChannelReplyInput,
  ChannelRoutes,
  ChannelSession,
  ChannelSessionCreateContext,
  ChannelTarget,
  ChannelToolCall,
  ChannelToolContext,
  ChannelToolDescriptor,
  ChannelToolListContext,
} from './channel.js';
