/**
 * Agent Runtime provider-authoring contracts (declaration-only).
 *
 * The complete, neutral Agent Runtime provider contract an external runtime
 * package (or a future built-in runtime package such as
 * `@excitedjs/agent-runtime-codex`) implements while importing only
 * `@excitedjs/dreamux-types`. The public create context, runtime handle, state
 * callbacks, and status are deliberately neutral: they never expose Dreamux
 * host-private types (`DispatcherRow`, `DispatcherStore`, `DispatcherStatus`,
 * `DispatcherConfig`, config/state stores, or host path-helper implementations).
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

/** The role Dreamux core assigns to a runtime instance. */
export type AgentRuntimeRole =
  | 'dispatcher'
  | 'team_leader'
  | 'teammate'
  | 'team_member';

/**
 * A bundled skill source core hands to a runtime. Core selects sources by role;
 * the runtime package owns the mechanics of applying them to its engine.
 */
export interface AgentRuntimeSkillSource {
  name: string;
  path: string;
  /**
   * How the runtime should mount `path` into its engine. An open string, not a
   * closed union: a new runtime may define its own layout without a types bump.
   * Standard layouts core emits today are `skill-dir` (a single skill directory,
   * e.g. a Codex `skills/extraRoots` entry) and `claude-skills-parent` (the
   * parent of a `.claude/skills` tree, e.g. a Claude `--add-dir` root). A runtime
   * that does not recognize a layout should ignore that source, not fail.
   */
  layout: string;
  source: 'dreamux-core' | string;
}

/**
 * An open, source-agnostic completion delivery shape. Each runtime self-declares
 * its own `kind` string inside its own capabilities; the shared contract never
 * enumerates them.
 */
export interface CompletionDeliveryShape {
  kind: string;
  description: string;
}

export interface AgentRuntimeResumeCheckpoint {
  /** Runtime-owned checkpoint kind; each runtime self-declares its own. */
  kind: string;
  id: string;
}

export type AgentRuntimeResumeCapability =
  | { supported: true; checkpoint: AgentRuntimeResumeCheckpoint['kind'] }
  | { supported: false };

export interface AgentRuntimeCapabilities {
  /** Whether this runtime can resume a prior checkpoint, and which checkpoint id it expects. */
  resume: AgentRuntimeResumeCapability;
  /**
   * Whether a follow-up turn delivered while a turn is active folds into that
   * turn rather than queueing behind it. Purely behavioral: there is no separate
   * "steer" method — core still delivers through `channelInput`,
   * and this flag only tells core whether mid-turn delivery is absorbed.
   */
  steer: { supported: boolean };
  /** How runtime events are surfaced to Dreamux. */
  events: { kind: 'push' | 'synthesized' };
  /** Whether {@link AgentRuntime.getLast} can report the last result. */
  last: { supported: boolean };
  /** Whether {@link AgentRuntime.getContext} can report context-window usage. */
  context: { supported: boolean };
  /** Upward delivery shapes this runtime supports for teammate completion. */
  teammateCompletion: readonly CompletionDeliveryShape[];
}

export interface AgentRuntimeSystemPrompt {
  /** Full role instructions for runtimes that replace their base prompt. */
  replace: string;
  /** Focused role delta for runtimes that append to an existing native prompt. */
  append: string;
}

/**
 * A source-agnostic completion delivered upward to a runtime. `teammate` is one
 * source; `id` identifies the completing entity within that source.
 */
export interface CompletionEnvelope {
  source: string;
  id: string;
  status: 'completed' | 'failed' | 'stopped';
  result: string | null;
}

export type CompletionDeliveryResult =
  | { status: 'accepted' }
  | { status: 'unsupported'; reason: string }
  | { status: 'failed'; error: Error };

export interface AgentRuntimeSystemInput {
  text: string;
  /**
   * Dreamux-owned system-message purpose. Known reasons emitted by core today
   * are `restart-notice`, `runtime-control`, and `scheduled`; the string remains
   * open so a new core workflow does not require unrelated runtimes to update
   * their type dependency before they can ignore or map it.
   */
  reason: 'restart-notice' | 'runtime-control' | 'scheduled' | (string & {});
}

export interface AgentRuntimeResumeInput {
  checkpoint?: AgentRuntimeResumeCheckpoint | null;
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
   * The per-dispatcher root the runtime drops its own state files into.
   * Neutral: the runtime derives its own subpaths from here. Volatile
   * rendezvous sockets do NOT live here.
   */
  dispatcherDir(id: string): string;
  /**
   * The central logs root. The runtime composes its OWN log subpaths under this
   * directory (e.g. `<logsDir>/<engine>/<id>.log`), so core never has to name a
   * per-runtime log file. Neutral: a runtime that logs differently lays out its
   * own tree here.
   */
  logsDir(): string;
  /** The owning dispatcher's completion-spill directory in the cache tree. */
  completionSpillDir(id: string): string;
  /**
   * Candidate directories for volatile rendezvous sockets, in host preference
   * order. A runtime that needs a Unix-domain socket allocates a fresh random
   * short name inside the first candidate whose full path fits the platform
   * socket-path budget (see `@excitedjs/dreamux-utils` `unixSocketPathFitsBudget`).
   * Neutral: a runtime that needs no socket (e.g. a stdio engine) ignores it.
   * Sockets are never persisted and never live under {@link dispatcherDir}.
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
   * start. The runtime interprets it per its own `resume` capability.
   */
  checkpoint_id?: string | null;
}

/**
 * The neutral create context a provider's `createRuntime` receives. Carries the
 * runtime identity, role, parsed provider config, cwd, optional system-prompt
 * content, MCP servers, bundled skill sources, and neutral logger/path/state
 * sinks. It never exposes host dispatcher rows, stores, or config models.
 */
export interface AgentRuntimeCreateContext<TConfig = unknown> {
  identity: AgentRuntimeIdentity;
  role: AgentRuntimeRole;
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
  resume(input?: AgentRuntimeResumeInput): Promise<void>;
  stop(): Promise<void>;
  /**
   * Deliver a channel/user turn. The runtime owns rendering the neutral channel
   * shape into its native input format.
   */
  channelInput(
    input: InboundTurnInput,
    hooks?: InboundDeliveryHooks,
  ): Promise<AgentRuntimeTurnResult>;
  /** Deliver a Dreamux-owned system message such as restart or scheduled work. */
  systemInput(input: AgentRuntimeSystemInput): Promise<AgentRuntimeTurnResult>;
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
   * A runtime whose `capabilities.last.supported` is false returns `null`
   * rather than throwing or blocking — core treats `null` as "not reported".
   */
  getLast(): Promise<AgentRuntimeLastResult | null>;
  /**
   * Context-window usage, or `null` when unavailable. A runtime whose
   * `capabilities.context.supported` is false returns `null` rather than
   * throwing or blocking.
   */
  getContext(): Promise<AgentRuntimeContextSnapshot | null>;
  getCapabilities(): AgentRuntimeCapabilities;
  /**
   * Deliver a teammate-completion envelope upward. Optional, and feature-detected
   * by presence: a runtime that declares no `capabilities.teammateCompletion`
   * shapes should omit this method entirely rather than ship a throwing/no-op
   * stub, since callers test for the method, not the capability array.
   */
  completionInput?(
    completion: CompletionEnvelope,
  ): Promise<CompletionDeliveryResult>;
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
