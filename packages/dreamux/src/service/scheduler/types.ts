import type { DreamuxLogger } from '@excitedjs/dreamux-types';

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
