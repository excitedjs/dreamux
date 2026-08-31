import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import {
  mustNonEmptyString,
  mustString,
  optionalBooleanField,
  optionalNullableStringField,
  optionalStringField,
  type CommandPayload,
} from '../../command/payload.js';

import type { InboundDeliveryResult } from '../teammate-service/turn-recording.js';

import type { CronJob, CronJobStore } from './store.js';

export interface CronCreateRequest {
  cron: string;
  prompt: string;
  title?: string;
  recurring?: boolean;
  tz?: string;
  action?: Record<string, unknown>;
}

export interface CronUpdateRequest {
  id: string;
  cron?: string;
  prompt?: string;
  title?: string | null;
  recurring?: boolean;
  tz?: string;
  action?: Record<string, unknown>;
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
  }): Promise<InboundDeliveryResult>;
  log: DreamuxLogger;
  now?: () => number;
}

export interface SchedulerCommands {
  list(): Promise<{ jobs: CronJob[] }>;
  create(input: CronCreateRequest): Promise<CronJob>;
  update(input: CronUpdateRequest): Promise<CronJob>;
  delete(id: string): Promise<{ id: string; deleted: boolean }>;
}

/**
 * Read one cron creation request, as every surface asks it.
 *
 * `action` is deliberately absent: it is an operator-only field the Command
 * surface adds on top of this, and no Agent-facing catalog advertises it. What
 * a job actually does is derived from `prompt` by the scheduler.
 */
export function cronCreateRequest(params: CommandPayload): CronCreateRequest {
  return {
    cron: mustString(params, 'cron'),
    prompt: mustNonEmptyString(params, 'prompt'),
    ...optionalStringField(params, 'title'),
    ...optionalBooleanField(params, 'recurring'),
    ...optionalStringField(params, 'tz'),
  };
}

/** Read one cron update request. `action` is Command-only, as on create. */
export function cronUpdateRequest(params: CommandPayload): CronUpdateRequest {
  return {
    id: cronJobIdParam(params),
    ...optionalStringField(params, 'cron'),
    ...optionalStringField(params, 'prompt'),
    ...optionalNullableStringField(params, 'title'),
    ...optionalBooleanField(params, 'recurring'),
    ...optionalStringField(params, 'tz'),
    ...optionalBooleanField(params, 'enabled'),
  };
}

/** Read the job id every per-job operation addresses. */
export function cronJobIdParam(params: CommandPayload): string {
  return mustString(params, 'id');
}
