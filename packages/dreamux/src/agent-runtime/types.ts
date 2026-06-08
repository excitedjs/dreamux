import type {
  InboundDeliveryHooks,
  InboundDeliveryResult,
  InboundTurnInput,
  NoticeInjectionResult,
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

export type TeamMateCompletionDeliveryShape =
  | {
      kind: 'codexInboxTurn';
      description: 'write completion to a runtime inbox, then trigger a dispatcher turn';
    }
  | {
      kind: 'claudeCodeTaskNotification';
      description: 'notify the runtime through a Claude Code task notification path';
    };

export interface AgentRuntimeResumeCheckpoint {
  /** Runtime-owned checkpoint kind; builtins use `codexThread` and `claudeCodeSession`. */
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
  /** Upward delivery shapes this runtime supports for teammate completion. */
  teammateCompletion: readonly TeamMateCompletionDeliveryShape[];
}

export interface TeamMateCompletionEnvelope {
  teammateName: string;
  sessionId: string | null;
  status: 'completed' | 'failed';
  finalText: string;
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
   * The per-dispatcher root the runtime drops its own state files into (control
   * socket, generated MCP config, …). Neutral: the runtime derives its own
   * subpaths from here, so the shared layer never enumerates per-runtime
   * artifact paths.
   */
  dispatcherDir(id: string): string;
  /**
   * The runtime's primary-process stdout log file in the central logs tree.
   * Runtimes without a separate stdout stream may ignore it.
   */
  stdoutLogPath(id: string): string;
  /** The runtime's primary-process stderr/diagnostic log file in the central logs tree. */
  stderrLogPath(id: string): string;
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
    completion: TeamMateCompletionEnvelope,
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
  state?: AgentRuntimeStateStore;
  paths?: AgentRuntimePathContext;
  mcpServers: readonly AgentRuntimeMcpServer[];
  log: (level: 'info' | 'warn' | 'error', msg: string, err?: unknown) => void;
}

export interface AgentRuntimeProviderConfigReadContext {
  providerRef: string;
  dispatcherId: string;
  file: string;
  prefix: string;
}

export interface AgentRuntimeProvider {
  readonly ref: string;
  readonly descriptor: ProviderDescriptor;
  getCapabilities(): AgentRuntimeCapabilities;
  readConfig?(
    rawConfig: Record<string, unknown>,
    context: AgentRuntimeProviderConfigReadContext,
  ): DispatcherProviderConfig;
  createRuntime(context: AgentRuntimeCreateContext): AgentRuntime;
}
