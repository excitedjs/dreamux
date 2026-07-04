/**
 * Agent Runtime provider-authoring contracts (declaration-only).
 *
 * The complete, neutral Agent Runtime provider contract an external runtime
 * package (or a future built-in runtime package such as
 * `@excitedjs/agent-runtime-codex`) implements while importing only
 * `@excitedjs/dreamux-types`. The public create context, runtime handle, state
 * callbacks, and status are deliberately neutral: they never expose Dreamux
 * host-private types (`DispatcherRow`, `DispatcherStore`, `DispatcherConfig`,
 * config/state stores, or host path-helper implementations).
 * Dreamux core adapts its private objects into these public shapes.
 *
 * Note on sequencing: Dreamux core's own launcher still threads a host-coupled
 * create context internally; converging that launcher onto this neutral context
 * is the runtime-split slice's job (issue #209 slice 3). This package already
 * publishes the stable public target so external and built-in runtime packages
 * can be authored against it today.
 */
import type { DreamuxLogger } from './logger.js';
import type {
  AgentRuntimeProviderDescriptor,
  DreamuxEnvironment,
  ProviderBinCheck,
  ProviderDiagnosticRunner,
  ProviderDiagnosticScope,
  ProviderDiagnosticResult,
  ProviderFactory,
  ProviderOnboard,
} from './provider.js';
import type {
  InboundDeliveryHooks,
  InboundDeliveryResult,
  InboundTurnInput,
  TurnSettledSignal,
} from './turn.js';

export interface AgentRuntimeMcpServer {
  name: string;
  command: string;
  args: string[];
}

/**
 * A bundled skill root core hands to a runtime. Core selects roots by role; the
 * runtime package owns the mechanics of applying them to its engine.
 */
export interface AgentRuntimeSkillSource {
  name: string;
  /** Directory whose direct children are skill directories. */
  path: string;
  source: 'dreamux-core' | string;
}

export interface AgentRuntimeResumeCheckpoint {
  /** Runtime-owned checkpoint id persisted by Dreamux and interpreted by the runtime. */
  id: string;
}

export interface AgentRuntimeResumeCapability {
  supported: boolean;
}

export interface AgentRuntimeCapabilities {
  /** Whether this runtime can resume a prior checkpoint id from its create context. */
  resume: AgentRuntimeResumeCapability;
}

export interface AgentRuntimeSystemPrompt {
  /** Full role instructions for runtimes that replace their base prompt. */
  replace?: string;
  /**
   * Ordered role deltas for runtimes that append to an existing native prompt.
   * Runtime adapters preserve order and choose their native isolation mechanic.
   */
  append?: readonly string[];
}

export interface AgentRuntimeTextInput {
  text: string;
  /** Correlation/dedupe metadata; not part of the model-visible text. */
  sourceId?: string;
}

export interface AgentRuntimeLastResult {
  text: string | null;
}

export interface AgentRuntimeContextSnapshot {
  usedTokens: number | null;
  windowTokens: number | null;
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

/** Runtime-specific alias of the shared provider binary check. */
export type AgentRuntimeBinCheck = ProviderBinCheck;

/** Runtime-specific alias of the shared provider diagnostic result. */
export type AgentRuntimeDiagnosticResult = ProviderDiagnosticResult;

/** Runtime-specific alias of the shared provider diagnostic runner. */
export type AgentRuntimeDiagnosticRunner = ProviderDiagnosticRunner;

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

/**
 * Neutral state sink the runtime writes status/thread transitions to. Dreamux
 * core adapts its own dispatcher store to this shape; the runtime never sees the
 * host store type.
 */
export interface AgentRuntimeStateCallbacks {
  setStatus(
    status: AgentRuntimeStatus,
    extras?: {
      last_error?: string | null;
      last_started_at?: number;
      last_ready_at?: number;
    },
  ): Promise<void>;
  setCheckpoint(checkpoint: AgentRuntimeResumeCheckpoint): Promise<void>;
  recordLostCheckpoint?(
    lost: AgentRuntimeResumeCheckpoint,
    replacement: AgentRuntimeResumeCheckpoint,
    error: string,
  ): Promise<void>;
}

export type AgentRuntimeTurnResult =
  | InboundDeliveryResult
  | { status: 'skipped' };

/**
 * The neutral, launcher-supplied identity of the runtime instance. Replaces the
 * host's `DispatcherRow` in the public create context: a provider reads only the
 * fields it needs (its own id, an optional resumable checkpoint id) and never
 * the host row.
 */
export interface AgentRuntimeIdentity {
  /** The runtime instance id (the dispatcher/teammate id the launcher assigns). */
  runtime_id: string;
  /**
   * A prior resumable checkpoint id the launcher recovered, or null for a fresh
   * start. The runtime interprets the id in its own native format.
   */
  checkpoint_id?: string | null;
}

/**
 * The neutral create context a provider's `createRuntime` receives. Carries the
 * runtime identity, parsed provider config, cwd, optional system-prompt
 * content, MCP servers, bundled skill sources, and neutral logger/path/state
 * sinks. It never exposes host dispatcher rows, stores, or config models.
 */
export interface AgentRuntimeCreateContext<TConfig = unknown> {
  identity: AgentRuntimeIdentity;
  /** Provider-parsed config (the output of the provider's own `readConfig`). */
  config: TConfig;
  /**
   * The directory the runtime runs in. Always supplied by the launcher; never
   * derived inside the runtime.
   */
  cwd: string;
  /**
   * Launcher-supplied role/system-prompt content. Core supplies both canonical
   * forms; runtime adapters decide which native prompt mechanic to use.
   */
  systemPrompt?: AgentRuntimeSystemPrompt;
  /**
   * MCP servers the launcher injects for this runtime instance. Already fully
   * resolved by core: an empty array means "no MCP servers", and the provider
   * must launch exactly these — it must not infer, append, or mutate the list.
   */
  mcpServers: readonly AgentRuntimeMcpServer[];
  /**
   * Bundled skill sources core selected for this role. Empty for roles that
   * receive no bundled Dreamux skills (ordinary teammate/team-member).
   */
  skillSources?: readonly AgentRuntimeSkillSource[];
  /**
   * Neutral feature names the host asks this runtime to disable. Core emits
   * only neutral names; each runtime maps the names it understands to its own
   * mechanism and ignores the rest.
   */
  disableFeatures?: readonly string[];
  logger?: DreamuxLogger;
  paths?: AgentRuntimePathContext;
  state?: AgentRuntimeStateCallbacks;
  /**
   * Neutral process-env injection seam. Core merges these entries into the
   * runtime's spawn environment AFTER `process.env` and BEFORE the provider's
   * own `config.extra_env`, i.e. spawn env =
   * `{ ...process.env, ...injectEnv, ...config.extra_env }`. Core owns what (if
   * anything) it injects; `config.extra_env` is the provider's own config and is
   * NOT routed through here. Empty/omitted means "inject nothing" — the common
   * case today.
   */
  injectEnv?: Record<string, string>;
  /**
   * Fired each time a delivered turn reaches a terminal state. Capability-
   * neutral; the launcher opts in.
   */
  onTurnSettled?: (settled: TurnSettledSignal) => void;
}

/**
 * The live runtime handle a provider's `createRuntime` returns. Neutral: its
 * status type is {@link AgentRuntimeStatus}, not a host enum.
 */
export interface AgentRuntime {
  readonly providerRef: string;
  start(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Deliver a channel/user turn. The runtime owns rendering the neutral channel
   * shape into its native input format.
   */
  channelInput(
    input: InboundTurnInput,
    hooks?: InboundDeliveryHooks,
  ): Promise<AgentRuntimeTurnResult>;
  /**
   * Deliver a Dreamux-owned plain text turn. This is not channel input and must
   * not receive channel/XML rendering.
   */
  completionInput(input: AgentRuntimeTextInput): Promise<AgentRuntimeTurnResult>;
  /**
   * Resolve when no turn is in progress. Optional: runtimes that omit it are
   * treated by core as always idle.
   */
  waitIdle?(): Promise<void>;
  getStatus(): AgentRuntimeStatus;
  getCheckpoint(): AgentRuntimeResumeCheckpoint | null;
  wasCheckpointResumed(): boolean;
  /**
   * The last assistant/user-visible result, or `null` when unavailable.
   * Core treats `null` as "not reported".
   */
  getLast(): Promise<AgentRuntimeLastResult | null>;
  /**
   * Context-window usage, or `null` when unavailable.
   */
  getContext(): Promise<AgentRuntimeContextSnapshot | null>;
  getCapabilities(): AgentRuntimeCapabilities;
}

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
 * A provider's self-reported diagnostics: it DECLARES the bin checks Dreamux
 * core should dedup + execute, and RUNS its own non-bin internal checks. The
 * core doctor command iterates providers and calls these instead of branching
 * on a builtin ref.
 *
 * Optional on {@link AgentRuntimeProvider}: a provider with no diagnostic surface
 * omits it. The host supplies the {@link AgentRuntimeDiagnosticRunner} to
 * `runDiagnostic`; the provider only implements the checks, never the runner.
 */
export interface AgentRuntimeDiagnostic<TConfig = unknown> {
  binChecks(context: AgentRuntimeDiagnosticContext<TConfig>): AgentRuntimeBinCheck[];
  runDiagnostic(
    context: AgentRuntimeDiagnosticContext<TConfig>,
    runner: AgentRuntimeDiagnosticRunner,
  ): Promise<AgentRuntimeDiagnosticResult>;
}

/**
 * The Agent Runtime provider contract. An external or built-in runtime package
 * implements this against `@excitedjs/dreamux-types` only.
 */
export interface AgentRuntimeProvider<TConfig = unknown> {
  readonly ref: string;
  readonly descriptor: AgentRuntimeProviderDescriptor;
  getCapabilities(): AgentRuntimeCapabilities;
  /**
   * Parse + validate this provider's own config block. May return synchronously
   * or as a promise; Dreamux core awaits the result, mirroring
   * `ChannelProvider.readConfig`. A parse/validation failure must throw (the host
   * fails loud), never return a partially-valid config.
   */
  readConfig?(
    rawConfig: Record<string, unknown>,
    context: AgentRuntimeProviderConfigReadContext,
  ): TConfig | Promise<TConfig>;
  /**
   * Self-reported diagnostics. Optional: a provider with no diagnostic
   * surface may omit it.
   */
  diagnostic?: AgentRuntimeDiagnostic<TConfig>;
  /**
   * Provider-owned onboarding. Core asks only for host envelope fields and
   * delegates provider-specific raw config collection to this capability.
   */
  onboard?: ProviderOnboard<Record<string, unknown>>;
  createRuntime(context: AgentRuntimeCreateContext<TConfig>): AgentRuntime;
}

/**
 * The default (or `npm:pkg#export`-selected) factory export an Agent Runtime
 * package ships. Its {@link ProviderFactoryContext} carries the already-narrowed
 * {@link AgentRuntimeProviderDescriptor}, so the package assigns
 * `provider.descriptor` from the seed without a cast.
 */
export type AgentRuntimeProviderFactory<TConfig = unknown> = ProviderFactory<
  AgentRuntimeProvider<TConfig>,
  AgentRuntimeProviderDescriptor
>;

/** Re-export so provider packages can take a logger in their own contexts. */
export type { DreamuxLogger };
