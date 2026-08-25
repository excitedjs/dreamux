/**
 * Channel provider-authoring contracts (declaration-only).
 *
 * The neutral Channel provider seam external channel packages author against.
 * Dreamux core owns binding state, routing, and authorization (binding a channel
 * to a Team is a core Team-MCP capability, not a generic Channel MCP); a channel
 * provider owns platform I/O, provider-specific tools, inbound normalization,
 * target resolution, and message ownership facts.
 *
 * These contracts are forward-looking for the channel-provider slices. They live
 * here because external channel packages must compile against
 * `@excitedjs/dreamux-types` only and must not import `@excitedjs/dreamux`.
 */
import type { DreamuxLogger } from './logger.js';
import type {
  ChannelProviderDescriptor,
  DreamuxEnvironment,
  ProviderBinCheck,
  ProviderDiagnosticRunner,
  ProviderDiagnosticScope,
  ProviderDiagnosticResult,
  ProviderFactory,
  ProviderOnboard,
} from './provider.js';
import type {
  ChannelBindingCollaborationSpaceEvent,
  ChannelBindingEndpointSnapshot,
  ChannelBindingRouteEvent,
} from './channel-binding.js';
import type { InboundDeliveryResult, InboundTurnInput } from './turn.js';
import type { RuntimeToolAction } from './agent-runtime.js';

export interface ChannelTarget {
  target_type: string;
  /** Provider-owned opaque key that is stable and unique within one Channel. */
  target_key: string;
  bindable: boolean;
  display?: string;
  canonical_url?: string;
  meta?: Record<string, unknown>;
  /**
   * Provider-ordered, less-specific targets that may reuse existing channel
   * bindings when this exact target has no accepted route. Core never derives
   * these from `meta` or a container, and never provisions collaboration
   * targets from them.
   *
   * Providers should keep this list shallow: fallbacks declared by an entry in
   * this list are not traversed recursively.
   */
  binding_fallbacks?: ChannelTarget[];
}

export interface ChannelContainer {
  container_type: string;
  container_key: string;
  display?: string;
  canonical_url?: string;
  meta?: Record<string, unknown>;
}

export type ChannelTargetLifecycleKind =
  | 'target_created'
  | 'target_closed';

export interface ChannelTargetLifecycleEvent {
  kind: ChannelTargetLifecycleKind;
  event_id?: string;
  container: ChannelContainer;
  target: ChannelTarget;
  title?: string;
  timestamp?: number;
  meta?: Record<string, unknown>;
}

/**
 * Standard MCP tool annotations, expressed as a runtime-neutral,
 * JSON-compatible structure. This mirrors the official MCP `ToolAnnotations`
 * shape without importing any `@modelcontextprotocol/*` package, so external
 * channel packages compile against `@excitedjs/dreamux-types` only. Dreamux
 * core forwards these hints verbatim to the shared MCP server.
 */
export interface ChannelToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** Standard MCP icon metadata without an SDK dependency at the provider seam. */
export interface ChannelToolIcon {
  src: string;
  mimeType?: string;
  sizes?: string[];
  theme?: 'light' | 'dark';
}

export interface ChannelToolDescriptor {
  name: string;
  /** Human-facing tool title surfaced to MCP clients. */
  title?: string;
  /** Optional standard presentation metadata surfaced to MCP clients. */
  icons?: ChannelToolIcon[];
  description?: string;
  /**
   * Closed JSON Schema object describing the tool's model-facing input. The
   * shared channel MCP server advertises it and uses it as the single runtime
   * validator for field shape.
   *
   * Intentionally typed as `unknown`: Dreamux types must not constrain the tool
   * schemas a provider package exposes beyond "it is a JSON Schema object".
   */
  inputSchema: unknown;
  /**
   * JSON Schema object describing the tool's canonical successful public
   * result. Optional at this neutral seam because MCP itself permits its
   * omission and existing external providers must remain loadable; when present
   * the shared server advertises it and validates the returned value. Built-in
   * Channel providers supply one for every tool.
   */
  outputSchema?: unknown;
  /** Standard, conservative read-only/destructive behavior hints. */
  annotations?: ChannelToolAnnotations;
}

export interface ChannelSender {
  id?: string;
  display?: string;
  meta?: Record<string, unknown>;
}

export interface ChannelInboundEnvelope {
  provider: string;
  channel_id: string;
  target: ChannelTarget;
  container?: ChannelContainer;
  event_id?: string;
  message_id?: string;
  sender?: ChannelSender;
  metadata?: Record<string, unknown>;
}

export interface ChannelConfigContext {
  dispatcher_id: string;
  channel_id: string;
  provider: string;
}

export interface ChannelSessionCreateContext<TConfig = unknown> {
  dispatcher_id: string;
  channel_id: string;
  provider: string;
  config: TConfig;
  logger?: DreamuxLogger;
  state_root?: string;
  cache_root?: string;
}

export interface ChannelReplyInput {
  target: ChannelTarget;
  text: string;
  meta?: Record<string, unknown>;
}

export interface ChannelReactInput {
  target: ChannelTarget;
  message_id: string;
  reaction: string;
}

export interface ChannelToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Who asked core to invoke a provider-owned channel tool, resolved before
 * authorization and passed through verbatim. `team_name` is the Team store key
 * — the same value core publishes on every {@link ChannelCoreEvent} — so a
 * provider may join tool calls and core events on it without core learning any
 * provider concept.
 */
export type ChannelToolCallerContext =
  | { readonly kind: 'dispatcher' }
  | {
      readonly kind: 'team_leader';
      readonly team_name: string;
      readonly leader_name: string;
    };

export interface ChannelToolContext {
  readonly dispatcher_id: string;
  readonly channel_id: string;
  /**
   * Required here, but a provider running against an older core may still see
   * it missing at runtime; degrade safely rather than assume a TeamLeader.
   */
  readonly caller: ChannelToolCallerContext;
  readonly logger?: DreamuxLogger;
}

export interface ChannelMessageTargetCheck {
  target: ChannelTarget;
  message_id: string;
  meta?: Record<string, unknown>;
}

/**
 * An optional per-target repository a channel provider may supply on
 * {@link ChannelCollaborationTargetEnsureInput.repo}. It selects the source
 * repository and the ref the target's Team worktree is created from.
 */
export interface DreamuxManagedRepoRequest {
  /** Source repository working directory the worktree branches from. */
  readonly path: string;
  /** Git ref the worktree is created from. */
  readonly base_ref: string;
}

/**
 * Request that core synchronously make an existing collaboration target ready.
 *
 * A provider may supply an optional {@link DreamuxManagedRepoRequest} `repo` to
 * select the source repository and ref for this provision call. When `repo` is
 * omitted, the existing space binding is used.
 */
export interface ChannelCollaborationTargetEnsureInput {
  readonly container: ChannelContainer;
  readonly target: ChannelTarget;
  readonly title?: string;
  readonly repo?: DreamuxManagedRepoRequest;
}

export type ChannelScopedOperationFailureCode =
  | 'invalid_input'
  | 'collaboration_space_unavailable'
  | 'target_conflict'
  | 'target_closed'
  | 'target_closing'
  | 'route_unavailable'
  | 'dispatcher_unavailable'
  | 'operation_failed';

export interface ChannelScopedOperationRejection {
  readonly code: ChannelScopedOperationFailureCode;
  readonly retryable: boolean;
}

export type ChannelCollaborationTargetEnsureResult =
  | {
      readonly status: 'ready';
      /** Projection of the existing Team name; this creates no new identity. */
      readonly team_name: string;
    }
  | {
      readonly status: 'rejected';
      readonly rejection: ChannelScopedOperationRejection;
    };

export interface ChannelExactDeliveryInput {
  readonly target: ChannelTarget;
  /** Rejects a stale command after the authoritative route changes owner. */
  readonly expected_team_name: string;
  readonly turn: InboundTurnInput;
}

export type ChannelExactDeliveryResult =
  | { readonly status: 'submitted' }
  /** Runtime-local facts only; neither status confirms cross-restart acceptance. */
  | { readonly status: 'duplicate' }
  | { readonly status: 'stopped' }
  | { readonly status: 'ambiguous' }
  | { readonly status: 'failed' };

export type ChannelTeamAgentRole = 'team_leader' | 'team_member';

export interface ChannelTeamStateEvent {
  readonly schema_version: 1;
  readonly kind: 'team.state';
  readonly occurred_at: number;
  readonly team_name: string;
  readonly leader_name: string;
  readonly status: 'starting' | 'running' | 'closed';
}

export interface ChannelAgentStateEvent {
  readonly schema_version: 1;
  readonly kind: 'agent.state';
  readonly occurred_at: number;
  readonly team_name: string;
  readonly agent_name: string;
  readonly role: ChannelTeamAgentRole;
  readonly status:
    | 'starting'
    | 'running'
    | 'degraded'
    | 'stopped'
    | 'closed';
}

/**
 * The provider-neutral inbound location a Channel turn was routed from, frozen
 * at routing time and broadcast once with that turn's submitted fact.
 *
 * `target` is the original inbound target; `binding` is the endpoint whose Team
 * binding accepted the route, or `null` when the dispatcher accepted the
 * target directly. Target and binding differ whenever a more specific target
 * (a thread) is delivered through a less-specific binding fallback (its
 * group), so both facts are kept. `message_id` may be absent, per
 * {@link ChannelInboundEnvelope}.
 */
export interface ChannelOrigin {
  readonly provider: string;
  readonly channel_id: string;
  readonly message_id: string | null;
  readonly target: ChannelTarget;
  readonly binding: ChannelBindingEndpointSnapshot | null;
}

/** Provider-neutral fact describing which Core input path submitted a turn. */
export type ChannelTurnSource =
  | 'channel'
  | 'dispatcher'
  | 'team_leader'
  | 'scheduled'
  | 'completion'
  | 'control';

/** The provider-neutral entity scope that can publish Channel conversation facts. */
export type ChannelConversationScope =
  | {
      readonly team_name: null;
      readonly role: 'dispatcher';
    }
  | {
      readonly team_name: string;
      readonly role: 'team_leader' | 'team_member';
    };

interface ChannelTurnEventScope {
  readonly schema_version: 1;
  readonly occurred_at: number;
  readonly agent_name: string;
  readonly turn_id: string;
}

export type ChannelTurnSubmittedEvent = ChannelConversationScope &
  ChannelTurnEventScope & {
  readonly kind: 'turn.submitted';
  /**
   * Proves that Core captured a presentable Channel inbound location. A real
   * Channel input can still omit this field when its route snapshot fails, so
   * absence must not be interpreted as a non-Channel source.
   */
  readonly channel_origin?: ChannelOrigin;
  /** Optional for compatibility with older Core publishers and fixtures. */
  readonly turn_source?: ChannelTurnSource;
};

export type ChannelTurnSettledEvent = ChannelConversationScope &
  ChannelTurnEventScope & {
  readonly kind: 'turn.settled';
  readonly status: 'completed' | 'failed' | 'stopped';
  readonly assistant: string | null;
  readonly assistant_truncated: boolean;
  readonly redacted: boolean;
};

export type ChannelTurnMessageEvent = ChannelConversationScope &
  ChannelTurnEventScope & {
  readonly kind: 'turn.message';
  readonly event_id: string;
  readonly message_role: 'user' | 'assistant';
  readonly content: string;
  readonly content_truncated: boolean;
  readonly redacted: boolean;
};

export type ChannelTurnToolCallEvent = ChannelConversationScope &
  ChannelTurnEventScope & {
  readonly kind: 'turn.tool_call';
  readonly event_id: string;
  readonly call_id: string;
  readonly tool_name: string;
  readonly tool_action: RuntimeToolAction | null;
  readonly status: 'started' | 'completed' | 'failed';
  readonly arguments_json: string | null;
  readonly result_json: string | null;
  readonly arguments_truncated: boolean;
  readonly result_truncated: boolean;
  readonly redacted: boolean;
};

export type ChannelCoreEvent =
  | ChannelTeamStateEvent
  | ChannelAgentStateEvent
  | ChannelTurnSubmittedEvent
  | ChannelTurnSettledEvent
  | ChannelTurnMessageEvent
  | ChannelTurnToolCallEvent
  | ChannelBindingRouteEvent
  | ChannelBindingCollaborationSpaceEvent;

export type ChannelCoreEventKind = ChannelCoreEvent['kind'];

export type ChannelCoreEventOfKind<K extends ChannelCoreEventKind> = Extract<
  ChannelCoreEvent,
  { readonly kind: K }
>;

export type ChannelCoreEventListener<K extends ChannelCoreEventKind> = (
  event: ChannelCoreEventOfKind<K>,
) => void | Promise<void>;

export interface ChannelCoreEventSubscription {
  /** Idempotent; core may already have revoked the enclosing session source. */
  unsubscribe(): void;
}

/**
 * Read-only, dispatcher-scoped, live-session event source. It intentionally
 * exposes no emitter, listener enumeration, or arbitrary listener removal.
 */
export interface ChannelCoreEventSource {
  on<K extends ChannelCoreEventKind>(
    kind: K,
    listener: ChannelCoreEventListener<K>,
  ): ChannelCoreEventSubscription;
}

export interface ChannelRoutes {
  /**
   * Deliver a normalized inbound to Dreamux core. The channel session supplies
   * the neutral turn {@link InboundTurnInput} (text/body/attrs/attachments it
   * normalized) plus the routing/identity {@link ChannelInboundEnvelope}; core
   * passes `input.sourceId` through as a runtime-local dedupe/correlation hint,
   * submits the turn, and returns the neutral {@link InboundDeliveryResult}.
   * The channel session owns any platform ack or reaction lifecycle around this
   * call. A channel inbound never yields
   * `'skipped'` (that is a notice-only state), so the union is exactly the
   * inbound-delivery one.
   */
  deliver(
    input: InboundTurnInput,
    envelope: ChannelInboundEnvelope,
  ): Promise<InboundDeliveryResult>;
  targetLifecycle?(event: ChannelTargetLifecycleEvent): Promise<void>;
  /** Optional presence is capability negotiation with an older core. */
  readonly coreEvents?: ChannelCoreEventSource;
  /** Synchronously ensure the existing collaboration target is fully ready. */
  ensureCollaborationTarget?(
    input: ChannelCollaborationTargetEnsureInput,
  ): Promise<ChannelCollaborationTargetEnsureResult>;
  /** Exact authoritative route only: no fallback and no Dispatcher Agent. */
  deliverExact?(
    input: ChannelExactDeliveryInput,
  ): Promise<ChannelExactDeliveryResult>;
}

/**
 * The context core passes to {@link ChannelProvider.handleSessionlessTool}. A
 * sessionless tool runs without a live {@link ChannelSession} (e.g. listing the
 * bots in a chat before any binding exists), so it gets only neutral host
 * locators, never a session handle.
 */
export interface ChannelSessionlessToolContext {
  dispatcher_id: string;
  /** Dispatcher-local channel id whose provider owns the sessionless call. */
  channel_id: string;
  /** The per-dispatcher state root the provider may read credentials/state from. */
  state_root?: string;
  logger?: DreamuxLogger;
}

export interface ChannelSession {
  readonly provider: string;
  readonly channel_id: string;
  start(routes: ChannelRoutes): Promise<void>;
  close(): Promise<void>;
  resolveTarget(meta: unknown): Promise<ChannelTarget>;
  /** Send a reply. Omit entirely if the platform has no outbound reply path. */
  reply?(input: ChannelReplyInput): Promise<unknown>;
  /** Add a reaction. Omit entirely if the platform has no reaction surface. */
  react?(input: ChannelReactInput): Promise<unknown>;
  /**
   * Handle a provider-specific tool call. Omit when `tools` is omitted; the two
   * go together. These optional members are absent, not no-op stubs, when the
   * platform does not support them — core feature-detects by presence.
   */
  handleTool?(
    call: ChannelToolCall,
    context: ChannelToolContext,
  ): Promise<unknown>;
  /** Decide message ownership for routing. Omit if the platform cannot. */
  messageBelongsToTarget?(
    input: ChannelMessageTargetCheck,
  ): boolean | Promise<boolean>;
}

/** Channel-specific alias of the shared provider binary check. */
export type ChannelBinCheck = ProviderBinCheck;

/** Channel-specific alias of the shared provider diagnostic result. */
export type ChannelDiagnosticResult = ProviderDiagnosticResult;

/** Channel-specific alias of the shared provider diagnostic runner. */
export type ChannelDiagnosticRunner = ProviderDiagnosticRunner;

export interface ChannelDiagnosticContext<TConfig = unknown> {
  dispatcher_id: string;
  channel_id: string;
  provider: string;
  config: TConfig;
  env: DreamuxEnvironment;
  scope: ProviderDiagnosticScope;
  state_root?: string;
  cache_root?: string;
}

/**
 * Optional channel diagnostics. A provider that needs no host-visible checks may
 * omit it; core treats absence as a passing provider report.
 */
export interface ChannelDiagnostic<TConfig = unknown> {
  binChecks(context: ChannelDiagnosticContext<TConfig>): ChannelBinCheck[];
  runDiagnostic(
    context: ChannelDiagnosticContext<TConfig>,
    runner: ChannelDiagnosticRunner,
  ): Promise<ChannelDiagnosticResult>;
}

export interface ChannelProvider<TConfig = unknown> {
  readonly ref: string;
  readonly descriptor: ChannelProviderDescriptor;
  readConfig?(
    raw: unknown,
    context: ChannelConfigContext,
  ): TConfig | Promise<TConfig>;
  createSession(context: ChannelSessionCreateContext<TConfig>): ChannelSession;
  /**
   * Self-report a neutral, opaque channel identity for this config (e.g. the
   * bot app id). Core stores and displays the string but never interprets it,
   * so it never has to name a provider config field. Omit if the channel has no
   * stable identity to report.
   */
  getIdentity?(config: TConfig): string;
  /**
   * Static provider/config tool catalog. Core owns every MCP descriptor and uses
   * this catalog as launch metadata; live sessions are never a metadata source.
   * Omit when the channel exposes no provider-specific MCP tools.
   */
  tools?(config: TConfig): readonly ChannelToolDescriptor[];
  /**
   * Provider-owned onboarding. Core asks only for host envelope fields and
   * delegates provider-specific raw config collection to this capability.
   */
  onboard?: ProviderOnboard<Record<string, unknown>>;
  /** Self-reported provider diagnostics. */
  diagnostic?: ChannelDiagnostic<TConfig>;
  /**
   * Handle a tool call that has no live {@link ChannelSession} (e.g. a discovery
   * tool used before any binding exists). Omit when the channel exposes no
   * sessionless tools. Feature-detected by presence.
   */
  handleSessionlessTool?(
    name: string,
    args: Record<string, unknown>,
    context: ChannelSessionlessToolContext,
  ): Promise<unknown>;
}

/**
 * The default (or `npm:pkg#export`-selected) factory export a Channel package
 * ships. Its {@link ProviderFactoryContext} carries the already-narrowed
 * {@link ChannelProviderDescriptor}, so the package assigns `provider.descriptor`
 * from the seed without a cast.
 */
export type ChannelProviderFactory<TConfig = unknown> = ProviderFactory<
  ChannelProvider<TConfig>,
  ChannelProviderDescriptor
>;
