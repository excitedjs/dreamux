import type { AgentRuntimeSkillSource } from '@excitedjs/dreamux-types';

export interface TeamMateWorktreeRequest {
  mode: 'reuse-cwd' | 'managed';
  slug?: string;
  base_ref?: string;
  branch?: string;
  cleanup?: 'keep' | 'delete-on-close';
}

export interface SpawnTeamMateInput {
  name: string;
  prompt: string;
  agentRuntime?: string;
  cwd?: string;
  worktree?: TeamMateWorktreeRequest;
  intent: string;
  identity?: string;
  /** Additional admin-supplied runtime skill roots; bundled role policy is separate. */
  skillSources?: readonly AgentRuntimeSkillSource[];
}

export interface SendTeamMateInput {
  name: string;
  prompt: string;
  intent?: string;
}

export interface CloseTeamMateInput {
  name: string;
  note: string;
}
