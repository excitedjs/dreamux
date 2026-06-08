import type {
  InboundDeliveryHooks,
  InboundDeliveryResult,
  InboundTurnInput,
  NoticeInjectionResult,
} from './turn.js';
import type { DispatcherConfig } from '../runtime/config.js';
import type { DispatcherProviderConfig } from '../runtime/config.js';
import type {
  DispatcherRow,
  DispatcherStatus,
  DispatcherStore,
} from '../runtime/dispatcher-store.js';
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

export type AgentRuntimeTurnInput =
  | InboundTurnInput
  | {
      kind: 'system';
      text: string;
      reason: 'restart-notice' | 'teammate-completion' | 'runtime-control';
    };

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
  dispatcherCodexCwd(id: string): string;
  dispatcherSocketPath(id: string): string;
  dispatcherStdoutLog(id: string): string;
  dispatcherStderrLog(id: string): string;
  dispatcherClaudeCodeMcpConfigPath(id: string): string;
  dispatcherClaudeCodeStreamLogPath(id: string): string;
}

export interface AgentRuntime {
  readonly providerRef: string;
  start(): Promise<void>;
  resume(input?: AgentRuntimeResumeInput): Promise<void>;
  stop(): Promise<void>;
  submitTurn(
    input: AgentRuntimeTurnInput,
    hooks?: InboundDeliveryHooks,
  ): Promise<AgentRuntimeTurnResult>;
  getStatus(): DispatcherStatus;
  getThreadId(): string | null;
  wasThreadResumed(): boolean;
  getLast(): Promise<AgentRuntimeLastResult | null>;
  getContext(): Promise<AgentRuntimeContextSnapshot | null>;
  getCapabilities(): AgentRuntimeCapabilities;
  deliverTeamMateCompletion?(
    completion: TeamMateCompletionEnvelope,
  ): Promise<TeamMateCompletionDeliveryResult>;
}

export interface AgentRuntimeCreateContext {
  row: DispatcherRow;
  dispatcher: DispatcherConfig | null;
  dispatchers: DispatcherStore;
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
