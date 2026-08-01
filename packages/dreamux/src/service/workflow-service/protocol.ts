export interface WorkflowAgentOptions {
  label?: string;
  phase?: string;
  schema?: Record<string, unknown>;
  agentType?: string;
  intent?: string;
  identity?: string;
}

export interface WorkflowRunStartMessage {
  type: 'run_start';
  script: string;
  args: unknown;
}

export interface WorkflowAgentResultMessage {
  type: 'agent_result';
  index: number;
  result?: unknown;
  error?: string;
}

export interface WorkflowAbortMessage {
  type: 'abort';
}

export type WorkflowRunnerParentMessage =
  | WorkflowRunStartMessage
  | WorkflowAgentResultMessage
  | WorkflowAbortMessage;

export interface WorkflowAgentStartMessage {
  type: 'agent_start';
  index: number;
  prompt: string;
  options: WorkflowAgentOptions;
}

export interface WorkflowEmitMessage {
  type: 'emit';
  kind: 'phase' | 'log';
  message: string;
}

export type WorkflowRunResultMessage =
  | {
      type: 'run_result';
      status: 'completed';
      result?: unknown;
    }
  | {
      type: 'run_result';
      status: 'failed';
      error: string;
    };

export type WorkflowRunnerChildMessage =
  | WorkflowAgentStartMessage
  | WorkflowEmitMessage
  | WorkflowRunResultMessage;

export interface WorkflowScriptMeta {
  name: string;
  description: string;
  phases?: string[];
}
