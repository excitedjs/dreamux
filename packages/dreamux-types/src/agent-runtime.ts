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
  InboundTurnInput,
} from './turn.js';

export interface AgentRuntimeMcpServer {
  name: string;
  command: string;
  args: string[];
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

export interface AgentRuntimeResumeCheckpoint {
  /** Runtime-owned checkpoint id persisted by Dreamux and interpreted by the runtime. */
  id: string;
  /**
   * Provider-produced canonical native transcript locator. Dreamux persists
   * this value atomically with {@link id} and never interprets it.
   */
  transcript_locator?: string | null;
}

export interface AgentRuntimeResumeCapability {
  supported: boolean;
}

export interface AgentRuntimeStructuredOutputCapability {
  supported: boolean;
  /**
   * How the schema is applied:
   * - `'create-context'`: set once at spawn time (e.g. claude-code `--json-schema`).
   * - `'per-turn'`: set on each turn (e.g. codex `turn/start.outputSchema`).
   * When `supported` is false, `scope` is omitted.
   */
  scope?: 'create-context' | 'per-turn';
}

export interface AgentRuntimeCapabilities {
  /** Whether this runtime can resume a prior checkpoint id from its create context. */
  resume: AgentRuntimeResumeCapability;
  /**
   * Whether this runtime supports structured output (JSON Schema on the final
   * assistant message). Optional: a provider that omits it is treated as
   * unsupported so core can fail-loud before submitting a schema-constrained
   * turn, instead of relying on the runtime to return a specific error.
   */
  structuredOutput?: AgentRuntimeStructuredOutputCapability;
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
  /**
   * Optional JSON Schema constraining the model's final assistant message for
   * this turn. Provider-neutral: each runtime maps it to its native structured
   * output mechanism (e.g. codex `turn/start.outputSchema`, claude-code
   * `--json-schema`). Runtimes that do not support structured output MUST
   * return `{ status: 'failed', error }` where `error` is an
   * {@link UnsupportedAgentRuntimeFeatureError} with `feature: 'outputSchema'`
   * when this is set — never silently ignore it, so callers never get
   * unconstrained text when they asked for a schema. When set, the settled
   * result text is expected to be valid JSON conforming to the schema; the
   * caller parses it.
   */
  outputSchema?: Record<string, unknown>;
}

/**
 * Structural shape of an `Error` a runtime returns (as a `failed` turn
 * `error`) when the caller requested a neutral feature the runtime does not
 * support. Callers branch on `error.name === 'UnsupportedAgentRuntimeFeatureError'`
 * and `error.feature` rather than `instanceof`, keeping `@excitedjs/dreamux-types`
 * declaration-only (no runtime values). The `feature` field names the requested
 * capability (e.g. `'outputSchema'`).
 */
export interface UnsupportedAgentRuntimeFeatureError extends Error {
  name: 'UnsupportedAgentRuntimeFeatureError';
  feature: string;
}

export interface AgentRuntimeContextSnapshot {
  usedTokens: number | null;
  windowTokens: number | null;
}

export interface AgentRuntimeTranscriptQuery {
  turns: number;
  cursor?: string;
  includeTools?: boolean;
}

export type AgentRuntimeTranscriptBlock =
  | {
      kind: 'message';
      role: 'user' | 'assistant';
      text: string;
      truncated: boolean;
    }
  | {
      kind: 'tool';
      name: string;
      input: string | null;
      output: string | null;
      status: 'ok' | 'error';
      inputTruncated: boolean;
      outputTruncated: boolean;
    };

export interface AgentRuntimeTranscriptTurn {
  startedAt: number | null;
  endedAt: number | null;
  blocks: readonly AgentRuntimeTranscriptBlock[];
}

export interface AgentRuntimeTranscriptPage {
  turns: readonly AgentRuntimeTranscriptTurn[];
  nextCursor: string | null;
  truncated: boolean;
}

export interface AgentRuntimeTranscriptContext<TConfig = unknown> {
  checkpoint: AgentRuntimeResumeCheckpoint | null;
  config: TConfig;
  cwd: string;
  injectEnv?: Readonly<Record<string, string>>;
  outputBudgetBytes: 262144;
  logger?: DreamuxLogger;
}

export interface AgentRuntimeTranscriptError extends Error {
  name: 'AgentRuntimeTranscriptError';
  reason:
    | 'checkpoint_missing'
    | 'not_found'
    | 'unreadable'
    | 'invalid'
    | 'locator_outside_root'
    | 'session_mismatch'
    | 'cursor_invalid'
    | 'cursor_query_mismatch'
    | 'cursor_stale'
    | 'scan_unsupported';
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

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** One accepted provider submission. Its identity never implies folding. */
export interface RuntimeSubmission {
  readonly settled: Promise<RuntimeSubmissionSettlement>;
}

/** A provider-observed native result and the opaque completion identity. */
export type RuntimeCompletion =
  | {
      readonly status: 'completed';
      readonly displaySubmission: RuntimeSubmission;
      readonly resultText: string | null;
      readonly truncated: boolean;
    }
  | {
      readonly status: 'failed';
      readonly displaySubmission: RuntimeSubmission;
      readonly error: Error;
    };

export type RuntimeSubmissionSettlement =
  | { readonly kind: 'completion'; readonly completion: RuntimeCompletion }
  | { readonly kind: 'failed'; readonly error: Error }
  | { readonly kind: 'stopped' };

export type RuntimeActivity =
  | {
      readonly kind: 'assistant.message';
      readonly id: string;
      readonly text: string;
      readonly truncated: boolean;
    }
  | {
      readonly kind: 'tool.call';
      readonly id: string;
      readonly callId: string;
      readonly toolName: string;
      readonly status: 'started' | 'completed' | 'failed';
      readonly arguments: JsonValue | null;
      readonly result: JsonValue | null;
      readonly error: string | null;
    };

export interface RuntimeActivityEvent {
  readonly submission: RuntimeSubmission;
  readonly activity: RuntimeActivity;
  readonly occurredAt: number;
}

/** Synchronous, non-backpressuring sink invoked for native activity facts. */
export interface RuntimeActivitySink {
  (event: RuntimeActivityEvent): void;
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
 */
export type RuntimeAdmission =
  | { status: 'submitted'; submission: RuntimeSubmission }
  | { status: 'duplicate' }
  | { status: 'stopped' }
  | { status: 'skipped' }
  | { status: 'failed'; error: Error }
  | { status: 'ambiguous'; error: Error };

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
   * A prior resumable checkpoint the launcher recovered, or null for a fresh
   * start. The runtime interprets both the id and transcript locator.
   */
  checkpoint: AgentRuntimeResumeCheckpoint | null;
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
   * Effective skill sources core selected for this runtime. This can include
   * required bundled role roots and authorized custom roots.
   */
  skillSources?: readonly AgentRuntimeSkillSource[];
  /**
   * Neutral feature names the host asks this runtime to disable. Core emits
   * only neutral names; each runtime maps the names it understands to its own
   * mechanism and ignores the rest.
   */
  disableFeatures?: readonly string[];
  /**
   * Optional JSON Schema constraining the model's final assistant message for
   * the *entire resident session*. Provider-neutral: each runtime maps it to
   * its native structured-output mechanism at spawn time (e.g. claude-code
   * `--json-schema`, which is a CLI flag fixed for the process lifetime).
   * Runtimes that support per-turn schema natively (e.g. codex
   * `turn/start.outputSchema`) may ignore this create-context field and rely
   * on the per-turn {@link AgentRuntimeTextInput.outputSchema} instead. When
   * set, every settled turn's result text is expected to be valid JSON
   * conforming to the schema; the caller parses it. Omitted/undefined means
   * "no schema constraint" — the common case.
   */
  outputSchema?: Record<string, unknown>;
  /** Required live activity sink, installed before the runtime starts. */
  activitySink: RuntimeActivitySink;
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
}

/**
 * The live runtime handle a provider's `createRuntime` returns. Neutral: its
 * status type is {@link AgentRuntimeStatus}, not a host enum.
 */
export interface AgentRuntime {
  readonly providerRef: string;
  start(): Promise<void>;
  resume(): Promise<void>;
  /**
   * Fence new input synchronously, terminate the owned runtime, and converge
   * every `channelInput`/`completionInput` call that started before the fence.
   * This promise MUST NOT resolve while an already-started admission can still
   * resolve to a newly accepted {@link RuntimeSubmission}.
   */
  stop(): Promise<void>;
  /**
   * Deliver a channel/user turn. The runtime owns rendering the neutral channel
   * shape into its native input format.
   */
  channelInput(input: InboundTurnInput): Promise<RuntimeAdmission>;
  /**
   * Deliver a Dreamux-owned plain text turn. This is not channel input and must
   * not receive channel/XML rendering.
   */
  completionInput(input: AgentRuntimeTextInput): Promise<RuntimeAdmission>;
  /**
   * Resolve when no turn is in progress. Optional: runtimes that omit it are
   * treated by core as always idle.
   */
  waitIdle?(): Promise<void>;
  getStatus(): AgentRuntimeStatus;
  getCheckpoint(): AgentRuntimeResumeCheckpoint | null;
  wasCheckpointResumed(): boolean;
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
  readTranscript(
    query: AgentRuntimeTranscriptQuery,
    context: AgentRuntimeTranscriptContext<TConfig>,
  ): Promise<AgentRuntimeTranscriptPage>;
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
