import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import type { TurnAdmission } from '../agent/admission.js';

import type { CronJobStore } from './store.js';

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
  id: string;
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

export interface SchedulerServiceOptions {
  ownerId: string;
  store: CronJobStore;
  admit<T>(task: () => Promise<T>): Promise<T>;
  /**
   * Submit one due fire as an ordinary admitted input.
   *
   * No cancellation crosses this call, and no idle question either. The owner
   * supplies the same submission path any other caller uses; whether the
   * runtime folds the input into an active turn or starts a new one is the
   * runtime's decision, made where it is already made.
   */
  submitScheduled(input: {
    jobId: string;
    prompt: string;
    sourceId: string;
  }): Promise<TurnAdmission>;
  log: DreamuxLogger;
  now?: () => number;
}

export interface SchedulerCommands {
  list(): Promise<{ jobs: CronJob[] }>;
  create(input: CronCreateRequest): Promise<CronJob>;
  update(input: CronUpdateRequest): Promise<CronJob>;
  delete(id: string): Promise<{ id: string; deleted: boolean }>;
}
