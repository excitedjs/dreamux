import type {
  AgentRuntime,
  AgentRuntimeSkillSource,
  AgentRuntimeTurnResult,
} from '@excitedjs/dreamux-types';

export interface TaskOperationInvocation {
  /** Durable submission whose model turn produced this tool call. */
  parentOperationId: string;
  /** Stable identity of one Core-facing tool invocation. */
  callId: string;
  /** Distinguishes multiple operations produced by one invocation. */
  ordinal: number;
  /** Core-assigned runtime identity asserted by the runtime's MCP metadata. */
  runtimeId: string;
  /** Stable durability domain asserted by the same runtime ledger. */
  durabilityNamespace: string;
}

export type TaskRuntimeRole = 'leader' | 'member';

export type TaskRuntimeEffect =
  | { kind: 'root' }
  | { kind: 'completion'; source_operation_id: string }
  | {
      kind: 'spawn';
      teammate_name: string;
      agent_runtime: string;
      intent: string;
      identity: string | null;
      skill_sources: readonly AgentRuntimeSkillSource[];
    }
  | {
      kind: 'send';
      teammate_name: string | null;
      intent: string | null;
    };

export interface TaskRuntimeHandle {
  runtimeId: string;
  role: TaskRuntimeRole;
  runtime: AgentRuntime;
}

export interface PreparedTaskRuntimeSubmission {
  operationId: string;
}

export class TaskRuntimeCapabilityUnavailableError extends Error {
  constructor() {
    super('Team runtime does not provide durable task submission');
    this.name = 'TaskRuntimeCapabilityUnavailableError';
  }
}

/**
 * Narrow Core seam used only by task-owned Teams. The Team layer owns agent
 * entities and runtime handles; the task host owns operation identity and all
 * durable submission state.
 */
export interface TaskTeamSubmissionBridge {
  prepareSpawn(input: {
    invocation: TaskOperationInvocation;
    requestedName: string;
    prompt: string;
    agentRuntime: string;
    intent: string;
    identity: string | null;
    skillSources: readonly AgentRuntimeSkillSource[];
  }): Promise<PreparedTaskRuntimeSubmission & { teammateName: string }>;

  prepareSend(input: {
    invocation: TaskOperationInvocation;
    prompt: string;
    intent: string | null;
    runtimeRole: TaskRuntimeRole;
    teammateName: string | null;
  }): Promise<PreparedTaskRuntimeSubmission>;

  submitPrepared(
    prepared: PreparedTaskRuntimeSubmission,
  ): Promise<AgentRuntimeTurnResult>;

  observeSettlement(input: {
    runtimeId: string;
    durabilityNamespace: string;
    turnId: string;
  }): Promise<void>;
}
