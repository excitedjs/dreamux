/**
 * Agent Runtime contract for Dreamux core.
 *
 * The neutral, provider-authoring contract is published by
 * `@excitedjs/dreamux-types` — including the complete public
 * `AgentRuntimeProvider`, `AgentRuntime`, and `AgentRuntimeCreateContext`
 * (issue #209). This module re-exports the neutral sub-shapes so the many
 * existing in-repo imports from `../agent-runtime/types.js` stay stable.
 *
 * The `AgentRuntimeStateStore`, `AgentRuntime`, `AgentRuntimeCreateContext`,
 * `AgentRuntimeProvider`, `AgentRuntimeDiagnostic`, and
 * `AgentRuntimeDiagnosticContext` interfaces below are the host-coupled variants
 * core's own launcher still threads (they reference `DispatcherStatus`,
 * `DispatcherRow`, `DispatcherStore`, `DispatcherConfig`,
 * `DispatcherProviderConfig`, and `ProviderDescriptor`). Converging core's
 * launcher onto the neutral public context — and deleting these host-coupled
 * variants — is the runtime-split slice's job (issue #209 slice 3). External and
 * built-in runtime packages should implement
 * `import type { AgentRuntimeProvider } from '@excitedjs/dreamux-types'` instead.
 */
import type { DispatcherConfig } from '../config/config.js';
import type { DispatcherProviderConfig } from '../config/config.js';
import type {
  DispatcherRow,
  DispatcherStatus,
  DispatcherStore,
} from '../state/dispatcher-store.js';
import type { ProviderDescriptor } from '../registry/index.js';
import type {
  AgentRuntimeBinCheck,
  AgentRuntimeCapabilities,
  AgentRuntimeContextSnapshot,
  AgentRuntimeDiagnosticRunner,
  AgentRuntimeDoctorResult,
  AgentRuntimeLastResult,
  AgentRuntimeMcpServer,
  AgentRuntimePathContext,
  AgentRuntimeProviderConfigReadContext,
  AgentRuntimeResumeInput,
  AgentRuntimeRole,
  AgentRuntimeSkillSource,
  AgentRuntimeSystemInput,
  CompletionEnvelope,
  TeamMateCompletionDeliveryResult,
} from '@excitedjs/dreamux-types';
import type {
  InboundDeliveryHooks,
  InboundDeliveryResult,
  InboundTurnInput,
  NoticeInjectionResult,
  TurnSettledSignal,
} from './turn.js';

export type {
  AgentRuntimeMcpServer,
  AgentRuntimeRole,
  AgentRuntimeSkillSource,
  CompletionDeliveryShape,
  AgentRuntimeResumeCheckpoint,
  AgentRuntimeResumeCapability,
  AgentRuntimeCapabilities,
  CompletionEnvelope,
  TeamMateCompletionDeliveryResult,
  AgentRuntimeSystemInput,
  AgentRuntimeResumeInput,
  AgentRuntimeLastResult,
  AgentRuntimeContextSnapshot,
  AgentRuntimePathContext,
  AgentRuntimeProviderConfigReadContext,
  AgentRuntimeBinCheck,
  AgentRuntimeDoctorResult,
  AgentRuntimeDiagnosticRunner,
  AgentRuntimeIdentity,
  AgentRuntimeStateCallbacks,
  AgentRuntimeStatus,
} from '@excitedjs/dreamux-types';

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

export type AgentRuntimeTurnResult = InboundDeliveryResult | NoticeInjectionResult;

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
   * The role Dreamux core assigns to this runtime launch. The launcher sets it
   * explicitly (`dispatcher` for the dispatcher agent; the teammate identity's
   * role for teammate/team-leader/team-member launches) — runtimes must never
   * infer it from incidental signals such as the presence of `onTurnSettled`.
   * Core selects role-gated bundled `skillSources` from it (issue #209 slice 6).
   */
  role: AgentRuntimeRole;
  /**
   * Bundled Dreamux skill sources core selected for this role. Populated only for
   * Dispatcher and TeamLeader launches; empty for ordinary teammate/team-member
   * launches. The runtime package owns the mechanics of applying them to its
   * engine (codex `skills/extraRoots/set`, claude-code `--add-dir`).
   */
  skillSources?: readonly AgentRuntimeSkillSource[];
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
