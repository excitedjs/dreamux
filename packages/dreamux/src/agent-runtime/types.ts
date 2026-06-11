import type {
  InboundDeliveryHooks,
  InboundDeliveryResult,
  InboundTurnInput,
  NoticeInjectionResult,
  TurnSettledSignal,
} from './turn.js';
import type { DispatcherConfig } from '../config/config.js';
import type { DispatcherProviderConfig } from '../config/config.js';
import type {
  DispatcherRow,
  DispatcherStatus,
  DispatcherStore,
} from '../state/dispatcher-store.js';
import type { ProviderDescriptor } from '../registry/index.js';

export interface AgentRuntimeMcpServer {
  name: string;
  command: string;
  args: string[];
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
  /** Whether a follow-up turn can steer/fold into an active turn. */
  steer: { supported: boolean };
  /** How runtime events are surfaced to Dreamux. */
  events: { kind: 'push' | 'synthesized' };
  /** Whether the runtime can report the last assistant/user-visible result. */
  last: { supported: boolean };
  /** Whether the runtime can report context-window usage. */
  context: { supported: boolean };
  /**
   * How the launcher-supplied role/system prompt content
   * (`AgentRuntimeCreateContext.systemPromptContent`) is applied: `replace`
   * swaps the engine's base instructions, `append` adds to them.
   */
  systemPrompt: { mode: 'replace' | 'append' };
  /** Upward delivery shapes this runtime supports for teammate completion. */
  teammateCompletion: readonly CompletionDeliveryShape[];
}

/**
 * A source-agnostic completion delivered upward to a runtime. `teammate` is one
 * source; `id` identifies the completing entity within that source (e.g. the
 * teammate name).
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

export type AgentRuntimeTurnResult = InboundDeliveryResult | NoticeInjectionResult;

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

export interface AgentRuntimeStateStore {
  setStatus(
    id: string,
    status: DispatcherStatus,
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

export interface AgentRuntimePathContext {
  /**
   * The per-dispatcher root the runtime drops its own state files into
   * (generated MCP config, …). Neutral: the runtime derives its own subpaths
   * from here, so the shared layer never enumerates per-runtime artifact
   * paths. Volatile rendezvous sockets do NOT live here (issue #182): they
   * are allocated per start under the private runtime-socket root.
   */
  dispatcherDir(id: string): string;
  /**
   * The runtime's primary-process stdout log file in the central logs tree.
   * Runtimes without a separate stdout stream may ignore it.
   */
  stdoutLogPath(id: string): string;
  /** The runtime's primary-process stderr/diagnostic log file in the central logs tree. */
  stderrLogPath(id: string): string;
  /**
   * The owning dispatcher's completion-spill directory in the cache tree
   * (issue #182 PR-2). Supplied by the launcher so a teammate runtime spills
   * under its operator dispatcher, not its composite runtime id — the same
   * launcher-resolves-the-real-dir pattern as the log paths above.
   */
  completionSpillDir(id: string): string;
}

export interface AgentRuntime {
  readonly providerRef: string;
  start(): Promise<void>;
  resume(input?: AgentRuntimeResumeInput): Promise<void>;
  stop(): Promise<void>;
  /** Deliver a channel-inbound turn (today's `submitTurn` channel case). */
  channelInput(
    input: InboundTurnInput,
    hooks?: InboundDeliveryHooks,
  ): Promise<AgentRuntimeTurnResult>;
  /**
   * Inject a system-originated notice (today's `submitTurn` `{kind:'system'}`
   * case; e.g. a restart notice). Keeps the "skip if a live inbound already
   * arrived" semantics.
   */
  systemInput(notice: AgentRuntimeSystemInput): Promise<AgentRuntimeTurnResult>;
  getStatus(): DispatcherStatus;
  getThreadId(): string | null;
  wasThreadResumed(): boolean;
  getLast(): Promise<AgentRuntimeLastResult | null>;
  getContext(): Promise<AgentRuntimeContextSnapshot | null>;
  getCapabilities(): AgentRuntimeCapabilities;
  /**
   * Deliver a teammate-completion envelope upward (rename of
   * `deliverTeamMateCompletion`). Optional: a runtime whose capabilities declare
   * no `teammateCompletion` shapes may not support it.
   */
  completionInput?(
    completion: CompletionEnvelope,
  ): Promise<TeamMateCompletionDeliveryResult>;
}

export interface AgentRuntimeCreateContext {
  row: DispatcherRow;
  dispatcher: DispatcherConfig | null;
  dispatchers: DispatcherStore;
  /**
   * The directory the runtime runs in. Always supplied by whoever launches the
   * runtime (the Dispatcher Service for dispatcher agents, the dispatcher for
   * teammate agents); never derived inside the runtime.
   */
  cwd: string;
  /**
   * Launcher-supplied dispatcher/role system-prompt content, applied per the
   * runtime's `systemPrompt.mode` capability (replace or append). Optional:
   * teammate launches may omit it.
   */
  systemPromptContent?: string;
  state?: AgentRuntimeStateStore;
  paths?: AgentRuntimePathContext;
  mcpServers: readonly AgentRuntimeMcpServer[];
  /**
   * Fired by the runtime each time a delivered turn reaches a terminal state
   * (success, failure, or stop). Capability-neutral; the launcher opts in. The
   * teammate service passes it to bridge a finished teammate turn back to its
   * dispatcher; the dispatcher launcher does NOT pass it, so a dispatcher never
   * self-delivers its own turn settlements.
   */
  onTurnSettled?: (settled: TurnSettledSignal) => void;
  log: (level: 'info' | 'warn' | 'error', msg: string, err?: unknown) => void;
}

export interface AgentRuntimeProviderConfigReadContext {
  providerRef: string;
  /**
   * The `agents[].id` whose config block is being parsed — a config-internal
   * alias, not a dispatcher identity. Provider `readConfig` implementations may
   * use it for diagnostics; both builtins ignore it.
   */
  agentId: string;
  file: string;
  prefix: string;
}

/**
 * A neutral runtime-binary launch descriptor a provider DECLARES for doctor.
 * Doctor dedups these across dispatchers via its own Map and executes them
 * (foreground: a plain `check`; managed service: a launch under the unit env).
 * Pure data — the provider never runs it itself, so codex/claude bin execution
 * never leaks into the provider's own diagnostic pass.
 */
export interface AgentRuntimeBinCheck {
  name: string;
  bin: string;
  args: string[];
}

/**
 * The neutral result of a provider's own (non-bin) diagnostic pass — e.g. codex
 * home validation and the codex version gate. Replaces doctor's old
 * codex-specific result union so `cli/doctor.ts` never branches on runtime
 * identity. `detail` is a one-line summary; `errors` are per-problem lines.
 */
export interface AgentRuntimeDoctorResult {
  ok: boolean;
  detail: string;
  errors: string[];
}

/**
 * The minimal command runner a provider's diagnostic needs. A structural subset
 * of the CLI's `CommandRunner` so the provider never imports `cli/doctor` or
 * `onboard/types` (that would invert layering and re-leak runtime specifics into
 * the doctor surface).
 */
export interface AgentRuntimeDiagnosticRunner {
  check(command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }): Promise<boolean>;
  capture(command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }): Promise<string>;
}

/**
 * Per-dispatcher diagnostic context. The provider resolves its own bin/home/
 * version checks off the dispatcher's resolved runtime config (M2). `scope`
 * distinguishes the two passes doctor runs per dispatcher (foreground vs the
 * installed managed-service env) so the provider can self-name its bin checks
 * for each scope ('codex binary' vs 'managed service Codex binary').
 */
export interface AgentRuntimeDiagnosticContext {
  dispatcher: DispatcherConfig;
  env: NodeJS.ProcessEnv;
  scope: 'foreground' | 'managedService';
}

/**
 * A provider's self-reported diagnostics (issue #146 fold): it DECLARES the bin
 * checks doctor should dedup + execute, and RUNS its own non-bin internal checks
 * (codex: home validation + version >= 0.137 for thread/inject_items, #147;
 * claude: none). Doctor iterates providers and calls these instead of branching
 * on `BUILTIN_CODEX_PROVIDER_REF`.
 */
export interface AgentRuntimeDiagnostic {
  binChecks(context: AgentRuntimeDiagnosticContext): AgentRuntimeBinCheck[];
  runDiagnostic(
    context: AgentRuntimeDiagnosticContext,
    runner: AgentRuntimeDiagnosticRunner,
  ): Promise<AgentRuntimeDoctorResult>;
}

export interface AgentRuntimeProvider {
  readonly ref: string;
  readonly descriptor: ProviderDescriptor;
  getCapabilities(): AgentRuntimeCapabilities;
  readConfig?(
    rawConfig: Record<string, unknown>,
    context: AgentRuntimeProviderConfigReadContext,
  ): DispatcherProviderConfig;
  /**
   * Self-reported doctor diagnostics. Optional: a provider with no diagnostic
   * surface (no bin, no internal state) may omit it; doctor then reports a
   * neutral "no diagnostics" result for that dispatcher.
   */
  diagnostic?: AgentRuntimeDiagnostic;
  createRuntime(context: AgentRuntimeCreateContext): AgentRuntime;
}
