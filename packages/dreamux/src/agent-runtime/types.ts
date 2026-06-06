import type {
  InboundDeliveryHooks,
  InboundDeliveryResult,
  InboundTurnInput,
} from '../dispatcher/turn-manager.js';
import type { DispatcherConfig } from '../runtime/config.js';
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

export interface AgentRuntimeDeliveryCapabilities {
  teammateCompletion: readonly TeamMateCompletionDeliveryShape[];
}

export interface TeamMateCompletionEnvelope {
  taskId: string;
  teammateId: string;
  status: 'completed' | 'failed';
  finalText: string;
}

export type TeamMateCompletionDeliveryResult =
  | { status: 'accepted' }
  | { status: 'unsupported'; reason: string }
  | { status: 'failed'; error: Error };

export interface AgentRuntime {
  readonly providerRef: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  enqueueInbound(
    input: InboundTurnInput,
    hooks?: InboundDeliveryHooks,
  ): Promise<InboundDeliveryResult>;
  injectRestartNotice(text: string): Promise<void>;
  getStatus(): DispatcherStatus;
  getThreadId(): string | null;
  wasThreadResumed(): boolean;
  deliverTeamMateCompletion?(
    completion: TeamMateCompletionEnvelope,
  ): Promise<TeamMateCompletionDeliveryResult>;
}

export interface AgentRuntimeCreateContext {
  row: DispatcherRow;
  dispatcher: DispatcherConfig | null;
  dispatchers: DispatcherStore;
  mcpServers: readonly AgentRuntimeMcpServer[];
  log: (level: 'info' | 'warn' | 'error', msg: string, err?: unknown) => void;
}

export interface AgentRuntimeProvider {
  readonly ref: string;
  readonly descriptor: ProviderDescriptor;
  readonly delivery: AgentRuntimeDeliveryCapabilities;
  createRuntime(context: AgentRuntimeCreateContext): AgentRuntime;
}
