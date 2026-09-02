/**
 * Channel provider-authoring contracts (declaration-only).
 *
 * The neutral Channel seam external channel packages author against. A Channel
 * session is controlled directly in-process through a small lifecycle, and it
 * reaches Core through exactly two generic ports: the Command invoker and the
 * live event source. Everything else — external transport, message
 * interpretation, Command selection, external-route bindings, target hierarchy,
 * automatic provisioning, Channel-owned configuration/state, and rendering
 * — is owned by the Channel and never mirrored into Core.
 *
 * Channel names here are reserved for bridge lifecycle, external transport, and
 * the generic Command/event ports. A Channel call site never determines the name
 * or owner of a Core capability, so no Team or TeamMate policy appears in this
 * module.
 *
 * External channel packages must compile against `@excitedjs/dreamux-types`
 * only and must not import `@excitedjs/dreamux`.
 */
import type { DreamuxLogger } from './logger.js';
import type { CoreCommandContext } from './command.js';
import type { JsonInvokeResult, JsonInvoker } from './invoke.js';
import type { JsonSchema, JsonValue } from './json.js';
import type {
  DreamuxEnvironment,
  ProviderBinCheck,
  ProviderDiagnosticRunner,
  ProviderDiagnosticScope,
  ProviderDiagnosticResult,
  ProviderFactory,
  ProviderOnboard,
} from './provider.js';
import type { TeamStateEvent } from './team.js';
import type {
  TeammateNativeTurnEndedEvent,
  TeammateStateEvent,
  TeammateTurnMessageEvent,
  TeammateTurnSettledEvent,
  TeammateTurnSubmittedEvent,
  TeammateTurnToolCallEvent,
} from './teammate.js';

/**
 * The complete Core event union delivered to a Channel. One subscription
 * receives it whole and demultiplexes inside the Channel, so adding an event
 * changes only this catalog and its consumers, never the base lifecycle.
 *
 * Workflow, scheduler, routing, and host-maintenance events are deliberately
 * absent.
 */
export type ChannelCoreEvent =
  | TeamStateEvent
  | TeammateStateEvent
  | TeammateTurnSubmittedEvent
  | TeammateTurnSettledEvent
  | TeammateTurnMessageEvent
  | TeammateTurnToolCallEvent
  | TeammateNativeTurnEndedEvent;

export interface ChannelEventSubscription {
  /** Idempotent; Core may already have revoked the enclosing session source. */
  unsubscribe(): void;
}

/**
 * Read-only, dispatcher-scoped, live-session event source. Delivery is live and
 * best-effort: Core invokes listeners in publication order and does not await
 * them, and a listener's exception or rejection never escapes into admission or
 * settlement. There is no FIFO, backpressure, timeout, acknowledgement, retry,
 * replay, snapshot, or final-delivery guarantee.
 *
 * A listener must keep its synchronous projection bounded. A Channel reaction
 * that needs asynchronous persistence synchronously updates or fences its
 * in-memory authority and serializes the durable write on a Channel-owned
 * mutation tail that {@link ChannelSession.close} awaits.
 */
export interface ChannelEventSource {
  subscribe(
    listener: (event: ChannelCoreEvent) => void | Promise<void>,
  ): ChannelEventSubscription;
}

/**
 * Everything a Channel session may reach Core through.
 *
 * The Command port is the shared one-request/one-result JSON invoker: a
 * Channel names a Command, hands it a payload, and gets one answer. Both public
 * adapters bind the same registry behind it, so a Channel gets no smaller
 * catalog and no private door.
 */
export interface ChannelCorePort {
  readonly invoke: JsonInvoker;
  readonly events: ChannelEventSource;
}

/**
 * The direct, same-process Channel lifecycle. These are ordinary method calls,
 * not Commands or events.
 */
export interface ChannelSession {
  /**
   * Load and validate Channel-owned state, store the Core port, and attach any
   * event consumer. It MUST NOT open external input, which is what makes
   * subscribe-before-admission provable.
   */
  initialize(port: ChannelCorePort): Promise<void>;
  /** Open external I/O. Everything durable was already loaded. */
  start(): Promise<void>;
  /**
   * Stop external I/O, await the Channel-owned mutation tail, and release
   * provider resources.
   */
  close(): Promise<void>;
}

/**
 * Standard MCP tool annotations, expressed as a runtime-neutral,
 * JSON-compatible structure. This mirrors the official MCP `ToolAnnotations`
 * shape without importing any `@modelcontextprotocol/*` package, so external
 * channel packages compile against `@excitedjs/dreamux-types` only.
 */
export interface ChannelMcpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * Who is calling a Channel-MCP-scoped operation. Core injects Channel MCP only
 * into Dispatcher and TeamLeader runtimes, so those are the only two callers.
 * `team_name` is the Team store key — the same value Core publishes on every
 * Team/TeamMate event — so a Channel may join tool calls and events on it
 * without Core learning any Channel concept.
 *
 * It lives with the Channel seam rather than with the Command port: the caller
 * is bound into the MCP lease Core mints, and no Command ever reads it.
 */
export type ChannelMcpCaller =
  | { readonly kind: 'dispatcher' }
  | {
      readonly kind: 'team_leader';
      readonly team_name: string;
      readonly leader_name: string;
    };

/** Standard MCP icon metadata without an SDK dependency at the provider seam. */
export interface ChannelMcpToolIcon {
  src: string;
  mimeType?: string;
  sizes?: string[];
  theme?: 'light' | 'dark';
}

export interface ChannelMcpToolDescriptor {
  name: string;
  /** Human-facing tool title surfaced to MCP clients. */
  title?: string;
  /** Optional standard presentation metadata surfaced to MCP clients. */
  icons?: ChannelMcpToolIcon[];
  description?: string;
  /**
   * Closed JSON Schema object describing the tool's model-facing input. The
   * official MCP SDK owns validation of it.
   *
   * Intentionally typed as `unknown`: Dreamux types must not constrain the tool
   * schemas a provider package exposes beyond "it is a JSON Schema object".
   */
  inputSchema: unknown;
  /**
   * JSON Schema object describing the tool's canonical successful public
   * result. Optional because MCP itself permits its omission; when present the
   * SDK advertises it and validates the returned value.
   */
  outputSchema?: unknown;
  /** Standard, conservative read-only/destructive behavior hints. */
  annotations?: ChannelMcpToolAnnotations;
}

/**
 * One advertised tool plus the handler that serves it. Core validates the pair
 * before injection, so an unavailable tool is never advertised: `session`
 * requires the created instance's {@link ChannelSessionMcpCapability}, and
 * `provider` requires {@link ChannelMcpCapability.invoke} and works without a
 * live session.
 */
export interface ChannelMcpToolRegistration {
  readonly tool: ChannelMcpToolDescriptor;
  readonly target: 'session' | 'provider';
}

export interface ChannelMcpCall {
  readonly name: string;
  readonly arguments: Readonly<Record<string, JsonValue>>;
}

/**
 * The scope Core baked into the lease that admitted this call. Routing identity
 * is never part of the model-facing tool schema.
 */
export interface ChannelMcpCallContext {
  readonly dispatcher_id: string;
  readonly channel_id: string;
  readonly caller: ChannelMcpCaller;
}

/**
 * Optional Channel MCP composition. Core asks `describe` only when constructing
 * a Dispatcher or TeamLeader runtime, never for an ordinary Team member or a
 * standalone TeamMate, and the returned catalog is caller-specific. Core does
 * not know the returned tool names and encodes none of their product policy.
 *
 * Catalogs are immutable for one runtime generation: a configuration or catalog
 * change takes effect on the next runtime construction.
 */
export interface ChannelMcpCapability<TConfig> {
  describe(
    config: TConfig,
    context: { readonly caller: ChannelMcpCaller },
  ): readonly ChannelMcpToolRegistration[];

  /** Serves `target: 'provider'` registrations, with no live session. */
  invoke?(
    call: ChannelMcpCall,
    context: ChannelMcpCallContext,
  ): Promise<ChannelMcpToolOutcome>;
}

/** Serves `target: 'session'` registrations for one live Channel instance. */
export interface ChannelSessionMcpCapability {
  invoke(
    call: ChannelMcpCall,
    context: ChannelMcpCallContext,
  ): Promise<ChannelMcpToolOutcome>;
}

/**
 * What a Channel tool answers: the result object, or a refusal the Channel
 * decided the model may read.
 *
 * A refusal is a value, not an exception, because the two sides are different
 * packages and often different processes. A Channel that says "that chat is not
 * bound to your Team" is stating a product fact the model can act on; making it
 * travel would otherwise require Core and the Channel to share an error class
 * or an error-code vocabulary, and then Core would be curating which Channel
 * failures a model may read — a policy it has no standing to hold.
 *
 * A failure the Channel did not decide to publish is still thrown. Core logs it
 * and answers with its own sanitized wording, so an unhandled bug can never
 * become model-facing text by accident.
 */
export type ChannelMcpToolOutcome = JsonInvokeResult<
  Readonly<Record<string, JsonValue>>
>;

/**
 * One Channel-owned Command, authored exactly like a Core one.
 *
 * The only difference from {@link CoreCommandDefinition} is the name: a Channel
 * declares a `local_name` — a single stable segment — and Core derives the full
 * registered name from it. A Channel therefore cannot occupy a Core name or
 * another Channel's namespace, and no caller has to assemble an unverified
 * string.
 *
 * Everything else is deliberately identical, because the invocation is
 * identical: the same registry resolves it, the same bounds and input schema
 * validate the payload, and the same canonicalization and output schema check
 * the result. There is no second call result and no Channel-specific adapter.
 *
 * A refusal the caller is meant to read belongs in `output`, not in a throw.
 * This package is declaration-only, so a Channel authored against it alone has
 * no Core error base to construct; Core classifies an unrecognized throw as
 * `INTERNAL` with no stated next step, which is right for an implementation
 * fault and wrong for a business answer. So a Channel that must say "this chat
 * is not bindable" declares that outcome in its own output schema and returns
 * it.
 */
export interface ChannelCommandDefinition<Input = unknown, Output = unknown> {
  /**
   * A single stable segment, unique within the Channel that declares it. Core
   * rejects a name it cannot register unambiguously rather than encoding it.
   */
  readonly local_name: string;
  readonly version: 1;
  readonly input: JsonSchema;
  readonly output: JsonSchema;
  parse(payload: JsonValue): Input;
  execute(context: CoreCommandContext, input: Input): Promise<Output>;
}

/**
 * Optional Channel Command composition, declared beside the session because the
 * handlers need the live session and the Channel-owned state it loaded.
 *
 * Core composes the returned definitions and owns none of them: not their
 * schemas, not their business meaning, and not the outcomes they report. It is
 * read once per instance, so a catalog is immutable for the life of that
 * instance — the same rule {@link ChannelMcpCapability} follows.
 */
export interface ChannelCommandCapability {
  definitions(): readonly ChannelCommandDefinition[];
}

/**
 * What `createSession` produced. MCP and Commands are composed outside the base
 * session, so a Channel with neither simply omits them rather than implementing
 * fake members.
 */
export interface ChannelInstance {
  readonly session: ChannelSession;
  readonly mcp?: ChannelSessionMcpCapability;
  readonly commands?: ChannelCommandCapability;
}

export interface ChannelConfigContext {
  dispatcher_id: string;
  channel_id: string;
  provider: string;
}

export interface ChannelSessionCreateContext<TConfig> {
  dispatcher_id: string;
  channel_id: string;
  provider: string;
  config: TConfig;
  logger?: DreamuxLogger;
  /** The per-dispatcher root the Channel owns its durable state under. */
  state_root?: string;
  cache_root?: string;
}

/**
 * Optional Channel-owned config parsing. A parse/validation failure must throw
 * (the host fails loud), never return a partially-valid config.
 */
export interface ChannelConfigCapability<TConfig> {
  read(raw: unknown, context: ChannelConfigContext): TConfig | Promise<TConfig>;
}

/**
 * Optional neutral, opaque channel identity for a config (e.g. the bot app id).
 * Core stores and displays the string but never interprets it, so it never has
 * to name a provider config field.
 */
export interface ChannelIdentityCapability<TConfig> {
  get(config: TConfig): string;
}

/**
 * Optional Channel-owned onboarding. Core asks only for host envelope fields
 * and delegates provider-specific raw config collection to this capability.
 */
export type ChannelOnboardCapability = ProviderOnboard<Record<string, unknown>>;

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
 * Optional Channel diagnostics. A provider that needs no host-visible checks may
 * omit it; core treats absence as a passing provider report.
 */
export interface ChannelDiagnosticCapability<TConfig> {
  binChecks(context: ChannelDiagnosticContext<TConfig>): ChannelBinCheck[];
  runDiagnostic(
    context: ChannelDiagnosticContext<TConfig>,
    runner: ChannelDiagnosticRunner,
  ): Promise<ChannelDiagnosticResult>;
}

/**
 * The Channel provider facade: one creation method plus operational
 * capabilities composed as optional objects rather than fake methods.
 *
 * Registration identity is absent by construction — Core owns the descriptor in
 * its `RegisteredProvider` wrapper, so this interface has no `ref` or
 * `descriptor` member.
 */
export interface ChannelProvider<TConfig> {
  createSession(
    context: ChannelSessionCreateContext<TConfig>,
  ): Promise<ChannelInstance>;

  readonly config?: ChannelConfigCapability<TConfig>;
  readonly identity?: ChannelIdentityCapability<TConfig>;
  readonly onboard?: ChannelOnboardCapability;
  readonly diagnostic?: ChannelDiagnosticCapability<TConfig>;
  readonly mcp?: ChannelMcpCapability<TConfig>;
}

/**
 * The default (or `npm:pkg#export`-selected) factory export a Channel package
 * ships.
 */
export type ChannelProviderFactory<TConfig> = ProviderFactory<
  ChannelProvider<TConfig>
>;
