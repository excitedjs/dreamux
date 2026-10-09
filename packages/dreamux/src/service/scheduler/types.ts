export interface CronPromptAgentAction {
  kind: 'prompt-agent';
  prompt: string;
}

/**
 * What a cron job does when it fires, and the only thing it has ever done.
 *
 * A job injects its prompt into the Dispatcher or TeamLeader that owns the
 * schedule. It does not spawn an agent and it does not address a Channel: those
 * were declared shapes with no execution behind them, so the union is the one
 * action Dreamux actually performs.
 */
export type CronJobAction = CronPromptAgentAction;

export interface CronJob {
  id: string;
  title?: string | undefined;
  cron: string;
  tz: string;
  recurring: boolean;
  action: CronJobAction;
  enabled: boolean;
  created_at: number;
  updated_at: number;
  next_run_at: number | null;
  last_fired_at: number | null;
}

export interface CronJobCreateInput {
  title?: string | undefined;
  cron: string;
  tz: string;
  recurring: boolean;
  action: CronJobAction;
  nextRunAt: number | null;
}

export interface CronJobUpdateInput {
  title?: string | null | undefined;
  cron?: string;
  tz?: string;
  recurring?: boolean;
  action?: CronJobAction;
  enabled?: boolean | undefined;
  nextRunAt?: number | null;
}

export interface CronCreateRequest {
  cron: string;
  prompt: string;
  title?: string;
  recurring?: boolean;
  tz?: string;
}

export interface CronUpdateRequest {
  id: string;
  cron?: string;
  prompt?: string;
  title?: string | null;
  recurring?: boolean;
  tz?: string;
  enabled?: boolean;
}

export interface SchedulerCommands {
  list(): Promise<{ jobs: CronJob[] }>;
  create(input: CronCreateRequest): Promise<CronJob>;
  update(input: CronUpdateRequest): Promise<CronJob>;
  delete(id: string): Promise<{ id: string; deleted: boolean }>;
}
