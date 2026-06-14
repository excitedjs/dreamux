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
  ProviderFactory,
} from './provider.js';
import type {
  InboundDeliveryHooks,
  InboundDeliveryResult,
  InboundTurnInput,
  NoticeInjectionResult,
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
   * "steer" method — core still delivers through `channelInput`/`systemInput`,
   * and this flag only tells core whether mid-turn delivery is absorbed.
   */
  steer: { supported: boolean };
  /** How runtime events are surfaced to Dreamux. */
  events: { kind: 'push' | 'synthesized' };
  /** Whether {@link AgentRuntime.getLast} can report the last result. */
  last: { supported: boolean };
  /** Whether {@link AgentRuntime.getContext} can report context-window usage. */
  context: { supported: boolean };
  /**
   * How the launcher-supplied role/system prompt content is applied: `replace`
   * swaps the engine's base instructions, `append` adds to them.
   */
  systemPrompt: { mode: 'replace' | 'append' };
  /** Upward delivery shapes this runtime supports for teammate completion. */
  teammateCompletion: readonly CompletionDeliveryShape[];
}

/**
 * A source-agnostic completion delivered upward to a runtime. `teammate` is one
 * source; `id` identifies the completing entity within that source.
 */
export interface CompletionEnvelope {
  source: string;
  id: string;
  status: 'completed' | 'failed' | 'stopped';
  result: string;
}

export type TeamMateCompletionDeliveryResult =
  | { status: 'accepted' }
  | { status: 'unsupported'; reason: string }
  | { status: 'failed'; error: Error };

export interface AgentRuntimeSystemInput {
  kind: 'system';
  text: string;
  reason: 'restart-notice' | 'teammate-completion' | 'runtime-control';
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
  /** The runtime's primary-process stdout log file in the central logs tree. */
  stdoutLogPath(id: string): string;
  /** The runtime's primary-process stderr/diagnostic log file in the central logs tree. */
  stderrLogPath(id: string): string;
  /** The owning dispatcher's completion-spill directory in the cache tree. */
  completionSpillDir(id: string): string;
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
 * A neutral runtime-binary launch descriptor a provider declares for doctor.
 * Pure data — the provider never runs it itself.
 */
export interface AgentRuntimeBinCheck {
  name: string;
  bin: string;
  args: string[];
}

/**
 * The neutral result of a provider's own (non-bin) diagnostic pass. `detail` is
 * a one-line summary; `errors` are per-problem lines.
 */
export interface AgentRuntimeDoctorResult {
  ok: boolean;
  detail: string;
  errors: string[];
}

/**
 * The minimal command runner a provider's diagnostic needs. A structural subset
 * of the CLI's command runner so the provider never imports host CLI modules.
 */
export interface AgentRuntimeDiagnosticRunner {
  check(
    command: string,
    args: string[],
    options?: { env?: DreamuxEnvironment },
  ): Promise<boolean>;
  capture(
    command: string,
    args: string[],
    options?: { env?: DreamuxEnvironment },
  ): Promise<string>;
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

/**
 * Neutral state sink the runtime writes status/thread transitions to. Dreamux
 * core adapts its own dispatcher store to this shape; the runtime never sees the
 * host store type.
 */
export interface AgentRuntimeStateCallbacks {
  setStatus(
    id: string,
    status: AgentRuntimeStatus,
    extras?: {
      last_error?: string | null;
      last_started_at?: number;
      last_ready_at?: number;
    },
  ): Promise<void>;
  setThreadId(id: string, threadId: string): Promise<void>;
  recordLostThread?(
    id: string,
    lostThreadId: string,
    newThreadId: string,
    error: string,
  ): Promise<void>;
}

export type AgentRuntimeTurnResult = InboundDeliveryResult | NoticeInjectionResult;

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
   * Launcher-supplied role/system-prompt content, applied per the runtime's
   * `systemPrompt.mode` capability. Optional: teammate launches may omit it.
   */
  systemPromptContent?: string;
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
  logger?: DreamuxLogger;
  paths?: AgentRuntimePathContext;
  state?: AgentRuntimeStateCallbacks;
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
  /** Deliver a channel-inbound turn. */
  channelInput(
    input: InboundTurnInput,
    hooks?: InboundDeliveryHooks,
  ): Promise<AgentRuntimeTurnResult>;
  /** Inject a system-originated notice (e.g. a restart notice). */
  systemInput(notice: AgentRuntimeSystemInput): Promise<AgentRuntimeTurnResult>;
  getStatus(): AgentRuntimeStatus;
  getThreadId(): string | null;
  wasThreadResumed(): boolean;
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
  ): Promise<TeamMateCompletionDeliveryResult>;
}

/**
 * Per-runtime diagnostic context. Neutral: it carries the runtime instance id,
 * the provider-parsed config, the resolved env, and the doctor pass `scope`,
 * rather than a host `DispatcherConfig`.
 */
export interface AgentRuntimeDiagnosticContext<TConfig = unknown> {
  runtime_id: string;
  config: TConfig;
  env: DreamuxEnvironment;
  scope: 'foreground' | 'managedService';
}

/**
 * A provider's self-reported diagnostics: it DECLARES the bin checks doctor
 * should dedup + execute, and RUNS its own non-bin internal checks. Doctor
 * iterates providers and calls these instead of branching on a builtin ref.
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
  ): Promise<AgentRuntimeDoctorResult>;
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
   * Self-reported doctor diagnostics. Optional: a provider with no diagnostic
   * surface may omit it.
   */
  diagnostic?: AgentRuntimeDiagnostic<TConfig>;
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
