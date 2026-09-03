/**
 * Agent Runtime provider-authoring contracts (declaration-only).
 *
 * The complete, neutral Agent Runtime provider contract a runtime package
 * implements while importing only `@excitedjs/dreamux-types`. The seam is
 * deliberately minimal: a provider facade for selection, creation, and neutral
 * recent Activity reads; a live handle with only `start`, `submit`, and `stop`;
 * and a Core-owned leased state sink runtime facts are pushed into. It never
 * exposes Dreamux host-private types (`DispatcherRow`, `DispatcherStore`,
 * `DispatcherConfig`, config/state stores, or host path-helper
 * implementations); Dreamux core adapts its private objects into these shapes.
 *
 * Recovery, session-bound structured output, and recent Activity Records are
 * mandatory provider behavior rather than negotiated capability bits. Live
 * activity emission stays optional because its absence changes only
 * presentation.
 */
import type { DreamuxLogger } from './logger.js';
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

/** Runtime-specific alias of the shared public logger contract. */
export type AgentRuntimeLogger = DreamuxLogger;

/**
 * One MCP server Core injects into a runtime. Core owns the whole list: a
 * provider launches exactly these entries and never discovers, appends to, or
 * mutates them.
 */
export interface AgentRuntimeMcpServer {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * A skill root core hands to a runtime. Core composes required bundled roots
 * with any authorized custom roots; the runtime package owns the mechanics of
 * applying them to its engine.
 */
export interface AgentRuntimeSkillSource {
  name: string;
  /**
   * Absolute canonical directory whose direct children are skill directories.
   * Dreamux core validates and normalizes custom roots before persistence.
   */
  path: string;
  source: 'dreamux-core' | string;
}

/**
 * Provider-static selection metadata. Zero-argument and config-free: Core has
 * no config-resolved consumer, so parsed config would widen the seam without a
 * use case.
 *
 * `publicConfig` is optional, bounded, explicitly projected metadata. Raw
 * provider config, environment variables, paths, credentials, and secrets are
 * forbidden in it.
 */
export interface AgentRuntimeProviderCapabilities {
  readonly tags: readonly string[];
  readonly publicConfig?: Readonly<Record<string, JsonValue>>;
}

/**
 * The neutral, Core-supplied identity of one runtime instance.
 *
 * `sessionId` is the provider's own prior session id, or `null` for a fresh
 * start. It is an opaque string Core persists atomically and returns only to
 * the same provider; Core never parses it or derives anything from its shape.
 * A session id is all a resumable runtime needs, so the seam carries a string
 * rather than an extensible object: nothing downstream may attach a second
 * durable fact to a session.
 */
export interface AgentRuntimeIdentity {
  readonly runtimeId: string;
  readonly sessionId: string | null;
}

export interface AgentRuntimePathContext {
  /**
   * The global host cache root for provider-owned rebuildable scratch.
   * Neutral: the runtime derives its own subpaths from here. Recovery state and
   * volatile rendezvous sockets do NOT live here.
   */
  cacheDir(): string;
  /**
   * The central logs root. The runtime composes its OWN log subpaths under this
   * directory (e.g. `<logsDir>/<engine>/<id>.log`), so core never has to name a
   * per-runtime log file. Neutral: a runtime that logs differently lays out its
   * own tree here.
   */
  logsDir(): string;
  /**
   * Candidate directories for volatile rendezvous sockets, in host preference
   * order. A runtime that needs a Unix-domain socket allocates a fresh random
   * short name inside the first candidate whose full path fits the platform
   * socket-path budget (see `@excitedjs/dreamux-utils` `unixSocketPathFitsBudget`).
   * Neutral: a runtime that needs no socket (e.g. a stdio engine) ignores it.
   * Sockets are never persisted and never live under {@link cacheDir}.
   */
  runtimeSocketDirs(): readonly string[];
}

/**
 * Neutral runtime status. Mirrors the host's dispatcher lifecycle states without
 * importing the host enum, so a provider can report status without depending on
 * `@excitedjs/dreamux`.
 */
export type AgentRuntimeStatus =
  | 'declared'
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'stopping'
  | 'stopped';

/** One authoritative runtime fact pushed into the Core-owned state sink. */
export type AgentRuntimeStateUpdate =
  | {
      readonly kind: 'status';
      readonly status: AgentRuntimeStatus;
      readonly lastError?: string;
    }
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'session_lost'; readonly reason: string };

/**
 * Push-only state sink, leased to exactly one runtime generation.
 *
 * Core creates a distinct sink per generation; the generation is not a public
 * field and the provider supplies no sequence number. Core serializes updates
 * in call-receipt order and resolves `publish` only after the authoritative
 * state write is durable. There is no pull counterpart: awaiting the provider's
 * own initial `publish` calls is the start fence.
 *
 * After Core revokes the lease (runtime replaced or stopped), `publish` rejects
 * with an {@link AgentRuntimeStateLeaseRevokedError} so the provider terminates
 * the stale writer. A persistence failure is a separate, fatal error.
 */
export interface AgentRuntimeStateSink {
  publish(update: AgentRuntimeStateUpdate): Promise<void>;
}

/**
 * Structural shape of the `Error` {@link AgentRuntimeStateSink.publish} rejects
 * with once Core has revoked that runtime generation's lease. Callers branch on
 * `error.name` rather than `instanceof`, keeping this package declaration-only.
 */
export interface AgentRuntimeStateLeaseRevokedError extends Error {
  name: 'AgentRuntimeStateLeaseRevokedError';
}

/**
 * What a tool invocation does, classified by the runtime that owns the tool
 * vocabulary. `null` means the runtime has no such classification for this call.
 */
export type RuntimeToolAction =
  | 'read'
  | 'list_files'
  | 'search'
  | 'edit'
  | 'run';

/** One accepted provider submission. Its identity never implies folding. */
export interface RuntimeSubmission {
  readonly settled: Promise<RuntimeSubmissionSettlement>;
}

/** A provider-observed native result. */
export type RuntimeCompletion =
  | {
      readonly status: 'completed';
      readonly resultText: string | null;
      readonly truncated: boolean;
    }
  | {
      readonly status: 'failed';
      readonly error: Error;
    };

export type RuntimeSubmissionSettlement =
  | { readonly kind: 'completion'; readonly completion: RuntimeCompletion }
  | { readonly kind: 'failed'; readonly error: Error }
  | { readonly kind: 'stopped' };

/**
 * One thing an agent's runtime did, in the runtime's own vocabulary.
 *
 * Keyed on the agent and nothing else. A provider folds any number of Dreamux
 * submissions into one native turn, so an activity cannot honestly name the
 * submission that caused it — and inventing one would make a display pick an
 * arbitrary member. What a live surface needs is this agent's stream in order,
 * which is what this is.
 */
export type RuntimeActivity =
  | {
      readonly kind: 'assistant.message';
      readonly occurredAt: number;
      readonly id: string;
      readonly text: string;
      readonly truncated: boolean;
    }
  | {
      readonly kind: 'tool.call';
      readonly occurredAt: number;
      readonly id: string;
      readonly callId: string;
      readonly toolName: string;
      readonly action: RuntimeToolAction | null;
      /**
       * The call as the runtime's own UI labels it, in one line: a command's
       * stated purpose, the path a file tool touches, the pattern a search
       * runs, the task a sub-agent was given. `null` when the runtime has no
       * label of its own for the tool, so a display falls back to the name.
       */
      readonly summary: string | null;
      /**
       * The call as a person would write it: the shell command line, the
       * task text handed to a sub-agent, the script a runner executes.
       * `arguments` is the tool's full structured input; this is the one
       * member of it that has a notation of its own, so a display can show
       * it in that notation instead of as JSON. `null` when there is none.
       */
      readonly invocation: string | null;
      /**
       * The files the call reads or changes, as the runtime reported them
       * in structured members of the call: a file tool's path argument, the
       * paths of a patch, the files a parsed shell command read. Empty when
       * the call is not about files or the runtime reported none; never
       * recovered from a label or an output by parsing.
       */
      readonly files: readonly string[];
      readonly status: 'started' | 'completed' | 'failed';
      readonly arguments: JsonValue | null;
      readonly result: JsonValue | null;
      readonly error: string | null;
    }
  | {
      /**
       * The runtime stopped producing for the turn it was running, whatever
       * that turn contained. `completed` is the runtime's own successful
       * terminal; `failed` is a proven terminal error; `interrupted` is a
       * native turn that ended without either, such as a stop or a protocol
       * loss. `reason` carries the runtime's own explanation when it holds
       * one, so a display can say why rather than only that.
       *
       * A provider reports this from the native terminal it observed, and
       * again, without asking whether a turn was open, when it tears down a
       * live native session. It keeps no display state to answer that
       * question, so a consumer may receive an end with nothing open and
       * ignores it: a native end closes an open display and never opens one.
       */
      readonly kind: 'turn.ended';
      readonly occurredAt: number;
      readonly status: 'completed' | 'failed' | 'interrupted';
      readonly reason: string | null;
    };

/**
 * Optional, synchronous, non-backpressuring sink for live native activity. It
 * is transient input to the Core conversation projection, not a progress view:
 * Core drops writes from a revoked generation, and its absence changes only
 * presentation. The stable progress view is
 * {@link AgentRuntimeProvider.readRecentActivity}, which never replays this
 * sink and is never replayed by it.
 *
 * The sink never throws. A projection failure is caught and logged inside
 * Core, so a provider calls it bare and holds no guard of its own.
 */
export interface AgentRuntimeActivitySink {
  (activity: RuntimeActivity): void;
}

/**
 * The single input shape a live runtime accepts.
 *
 * Deliberately nothing but text: it is already the complete model-facing
 * message, so the seam carries no discriminator, no source enum, no source
 * identity, and no rendering instruction. Every caller prepares its final text
 * before submitting, so a runtime never renders an envelope and never branches
 * on where a turn came from. Stable source identity, origin, intent, and
 * display correlation stay on Core's own turn/admission state, and Core — not a
 * Provider — deduplicates with them.
 */
export interface AgentRuntimeSubmissionInput {
  readonly text: string;
}

/**
 * Admission is separate from the eventual outcome of an accepted turn.
 *
 * `failed` is narrowly reserved for a provider-proven pre-admission failure:
 * the provider knows that no native command was accepted or may later become
 * accepted. `ambiguous` means submission may have crossed the provider/native
 * boundary. Callers MUST NOT retry an ambiguous admission automatically.
 * A rejected/thrown input promise is likewise admission-ambiguous unless the
 * provider documents and returns the explicit `failed` result instead.
 *
 * `skipped` remains a provider-seam state; the Command boundary — not this
 * seam — normalizes it to the public `stopped`.
 *
 * There is no `duplicate` admission: a Provider has no source identity to
 * deduplicate with. Core's own admission ledger returns the public `duplicate`
 * before it ever calls {@link AgentRuntime.submit}.
 */
export type RuntimeAdmission =
  | { status: 'submitted'; submission: RuntimeSubmission }
  | { status: 'stopped' }
  | { status: 'skipped' }
  | { status: 'failed'; error: Error }
  | { status: 'ambiguous'; error: Error };

/**
 * Neutral system-prompt input. When both forms are present they are alternate
 * representations of the same instructions, and a Provider applies at most one
 * of them — whichever its runtime supports. `append` fragment order is
 * significant. Dreamux re-supplies the reconstructed bundle on every
 * runtime-context creation; a Provider must never become the authority for
 * prompt state.
 */
export interface AgentRuntimeSystemPrompt {
  readonly replace?: string;
  readonly append?: readonly string[];
}

/**
 * The neutral facts required to launch one Dreamux role. Immutable: prior
 * session identity reaches `start` only through this object.
 */
export interface AgentRuntimeCreateContext<TConfig> {
  readonly identity: AgentRuntimeIdentity;
  /** Provider-parsed config (the output of the provider's own config capability). */
  readonly config: TConfig;
  /**
   * The directory the runtime runs in. Always supplied by the launcher; never
   * derived inside the runtime.
   */
  readonly cwd: string;
  /** Core-supplied role instructions; see {@link AgentRuntimeSystemPrompt}. */
  readonly systemPrompt?: AgentRuntimeSystemPrompt;
  /**
   * MCP servers Core injects for this runtime instance. Already fully resolved:
   * an empty array means "no MCP servers", and the provider must launch exactly
   * these — it must not infer, append, or mutate the list.
   */
  readonly mcpServers: readonly AgentRuntimeMcpServer[];
  /**
   * Effective skill sources core selected for this runtime, including required
   * bundled role roots and authorized custom roots.
   */
  readonly skillSources: readonly AgentRuntimeSkillSource[];
  /**
   * Neutral feature names the host asks this runtime to disable. Core emits
   * only neutral names; each runtime maps the names it understands to its own
   * mechanism and ignores the rest.
   */
  readonly disabledFeatures: readonly string[];
  /**
   * Optional JSON Schema constraining the model's final assistant message, bound
   * once to this runtime session. A provider that applies the schema natively
   * per turn stores this fixed value and reapplies it; a later submit can never
   * change it. When set, every settled turn's result text is expected to be
   * valid JSON conforming to the schema; the caller parses it.
   */
  readonly outputSchema?: JsonSchema;
  /**
   * Neutral process-env injection seam. Core merges these entries into the
   * runtime's spawn environment AFTER `process.env` and BEFORE the provider's
   * own `config.extra_env`, i.e. spawn env =
   * `{ ...process.env, ...injectEnv, ...config.extra_env }`. Core owns what (if
   * anything) it injects; `config.extra_env` is the provider's own config and is
   * NOT routed through here.
   */
  readonly injectEnv?: Readonly<Record<string, string>>;
  readonly paths: AgentRuntimePathContext;
  /** Leased, push-only state sink for this runtime generation. */
  readonly state: AgentRuntimeStateSink;
  /** Leased, push-only sink for this runtime generation's live activity. */
  readonly activity?: AgentRuntimeActivitySink;
  readonly logger?: AgentRuntimeLogger;
}

/** What `start` restored. Core consumes it before admitting the first submission. */
export interface AgentRuntimeStartOutcome {
  readonly continuity: 'fresh' | 'resumed';
}

/**
 * The live runtime handle. Nothing is pulled from it: every runtime fact flows
 * out through the leased state and activity sinks.
 */
export interface AgentRuntime {
  /**
   * Launch or restore the native session. A non-null create-context session MUST
   * restore continuous model context; failure rejects and never silently becomes
   * fresh. The provider durably publishes its session and ready state before
   * this resolves.
   */
  start(): Promise<AgentRuntimeStartOutcome>;
  submit(input: AgentRuntimeSubmissionInput): Promise<RuntimeAdmission>;
  /**
   * Fence new input synchronously, terminate the owned runtime, and converge
   * every `submit` call that started before the fence. This promise MUST NOT
   * resolve while an already-started admission can still resolve to a newly
   * accepted {@link RuntimeSubmission}. A stop racing a still-pending start
   * stops the runtime that appears later; a failed start rolls back all partial
   * ownership.
   */
  stop(): Promise<void>;
}

/**
 * A bounded request for the recent tail of one session's activity. Cursors are
 * opaque and provider-owned; pagination walks a stable recent tail without
 * skipping or duplicating records as native history grows.
 */
export interface AgentActivityQuery {
  readonly sessionId: string;
  readonly cursor?: string;
  readonly limit?: number;
  /** Tools are included by default and can only be hidden as a group. */
  readonly includeTools?: boolean;
}

export interface AgentActivityReadContext<TConfig> {
  readonly config: TConfig;
  readonly cwd: string;
  readonly injectEnv?: Readonly<Record<string, string>>;
  readonly logger?: AgentRuntimeLogger;
}

/**
 * One neutral activity fact. Tool arguments, tool results, provider-native
 * lines, Core status, admission, and settlement never appear here.
 */
export type AgentActivityRecord =
  | {
      readonly kind: 'assistant_message';
      readonly text: string;
      readonly occurredAt?: string;
    }
  | {
      readonly kind: 'tool';
      readonly name: string;
      readonly status: 'started' | 'completed' | 'failed';
      readonly occurredAt?: string;
    };

/** One chronological page of recent Activity Records. */
export interface AgentActivityPage {
  readonly records: readonly AgentActivityRecord[];
  readonly nextCursor?: string;
  /** Set by the provider when its own native read bounds truncated the page. */
  readonly truncated: boolean;
}

/**
 * Structural shape of the `Error` a provider rejects an Activity read with.
 * Reasons describe neutral states only: never a filesystem path, native history
 * layout, or scan mode. Callers branch on `error.name` rather than
 * `instanceof`, keeping this package declaration-only.
 */
export interface AgentActivityError extends Error {
  name: 'AgentActivityError';
  reason:
    | 'session_unavailable'
    | 'cursor_invalid'
    | 'activity_corrupt'
    | 'provider_failure';
}

export interface AgentRuntimeProviderConfigReadContext {
  providerRef: string;
  /**
   * The `agents[].id` whose config block is being parsed — a config-internal
   * alias, not a dispatcher identity.
   */
  agentId: string;
  file: string;
  prefix: string;
}

/**
 * Optional provider-owned config parsing. A parse/validation failure must throw
 * (the host fails loud), never return a partially-valid config.
 */
export interface AgentRuntimeConfigCapability<TConfig> {
  read(
    rawConfig: Record<string, unknown>,
    context: AgentRuntimeProviderConfigReadContext,
  ): TConfig | Promise<TConfig>;
}

/**
 * Optional provider-owned onboarding. Core asks only for host envelope fields
 * and delegates provider-specific raw config collection to this capability.
 */
export type AgentRuntimeOnboardCapability = ProviderOnboard<
  Record<string, unknown>
>;

/** Runtime-specific alias of the shared provider binary check. */
export type AgentRuntimeBinCheck = ProviderBinCheck;

/** Runtime-specific alias of the shared provider diagnostic result. */
export type AgentRuntimeDiagnosticResult = ProviderDiagnosticResult;

/** Runtime-specific alias of the shared provider diagnostic runner. */
export type AgentRuntimeDiagnosticRunner = ProviderDiagnosticRunner;

/**
 * Per-runtime diagnostic context. Neutral: it carries the runtime instance id,
 * the provider-parsed config, the resolved env, and the diagnostic `scope`,
 * rather than a host `DispatcherConfig`.
 */
export interface AgentRuntimeDiagnosticContext<TConfig = unknown> {
  runtime_id: string;
  config: TConfig;
  env: DreamuxEnvironment;
  scope: ProviderDiagnosticScope;
  /**
   * The same neutral path context the create context carries, supplied by
   * doctor so a provider diagnostic can pre-check placement-sensitive paths
   * (e.g. validate that a runtime socket would fit the platform budget via
   * {@link AgentRuntimePathContext.runtimeSocketDirs}). Optional: a provider
   * with no path-dependent checks ignores it.
   */
  paths?: AgentRuntimePathContext;
}

/**
 * Optional provider-owned diagnostics: the provider DECLARES the bin checks
 * Dreamux core should dedup + execute, and RUNS its own non-bin internal
 * checks. The host supplies the {@link AgentRuntimeDiagnosticRunner}; the
 * provider only implements the checks, never the runner.
 */
export interface AgentRuntimeDiagnosticCapability<TConfig> {
  binChecks(
    context: AgentRuntimeDiagnosticContext<TConfig>,
  ): AgentRuntimeBinCheck[];
  runDiagnostic(
    context: AgentRuntimeDiagnosticContext<TConfig>,
    runner: AgentRuntimeDiagnosticRunner,
  ): Promise<AgentRuntimeDiagnosticResult>;
}

/**
 * The Agent Runtime provider facade: selection, neutral recent Activity reads,
 * and runtime creation, plus operational capabilities composed as optional
 * objects rather than fake methods.
 *
 * Registration identity is absent by construction — Core owns the descriptor in
 * its {@link RegisteredProvider} wrapper, so this interface has no `ref` or
 * `descriptor` member and a live {@link AgentRuntime} echoes neither.
 *
 * A provider resumes from its own opaque session id and nothing else; see
 * {@link AgentRuntimeIdentity}.
 */
export interface AgentRuntimeProvider<TConfig> {
  getCapabilities(): AgentRuntimeProviderCapabilities;
  /**
   * Read the recent tail of one session's activity. Mandatory: it must work
   * against an actively growing session — producing useful records before any
   * completion marker — and against the same session after the live runtime has
   * closed. The provider enforces its own native read bounds and sets
   * {@link AgentActivityPage.truncated}; Core independently validates record
   * count, text size, page size, cursor size, and public errors.
   */
  readRecentActivity(
    query: AgentActivityQuery,
    context: AgentActivityReadContext<TConfig>,
  ): Promise<AgentActivityPage>;
  createRuntime(
    context: AgentRuntimeCreateContext<TConfig>,
  ): Promise<AgentRuntime>;

  readonly config?: AgentRuntimeConfigCapability<TConfig>;
  readonly onboard?: AgentRuntimeOnboardCapability;
  readonly diagnostic?: AgentRuntimeDiagnosticCapability<TConfig>;
}

/**
 * The default (or `npm:pkg#export`-selected) factory export an Agent Runtime
 * package ships.
 */
export type AgentRuntimeProviderFactory<TConfig> = ProviderFactory<
  AgentRuntimeProvider<TConfig>
>;

/** Re-export so provider packages can take a logger in their own contexts. */
export type { DreamuxLogger };
