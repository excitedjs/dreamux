import type { DreamuxLogger, InboundDeliveryResult } from '@excitedjs/dreamux-types';

import type {
  CronDeliverTarget,
  CronJob,
  CronJobStore,
} from './store.js';

export interface CronCreateRequest {
  cron: string;
  prompt: string;
  title?: string;
  recurring?: boolean;
  tz?: string;
  action?: Record<string, unknown>;
  deliver?: CronDeliverTarget;
}

export interface CronUpdateRequest {
  id: string;
  cron?: string;
  prompt?: string;
  title?: string | null;
  recurring?: boolean;
  tz?: string;
  action?: Record<string, unknown>;
  deliver?: CronDeliverTarget | null;
  enabled?: boolean;
}

export interface SchedulerServiceOptions {
  ownerId: string;
  store: CronJobStore;
  absentRuntimeStrategy: 'miss' | 'submit';
  admit<T>(task: () => Promise<T>): Promise<T>;
  getWriter(): { waitIdle(): Promise<void> } | null;
  submitScheduled(input: {
    jobId: string;
    prompt: string;
    sourceId: string;
    /** Aborted once this held fire has been stopped, deleted, or superseded. */
    signal: AbortSignal;
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
