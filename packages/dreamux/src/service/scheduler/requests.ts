import {
  mustNonEmptyString,
  mustString,
  optionalBooleanField,
  optionalNullableStringField,
  optionalStringField,
  type CommandPayload,
} from '../../command/payload.js';

import type { CronCreateRequest, CronJob, CronUpdateRequest } from './types.js';

/**
 * Read one cron creation request, as every surface asks it.
 *
 * There is no `action` field: what a job does is derived from `prompt` alone
 * by the scheduler, on every surface.
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

/** Read one cron update request. */
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

/**
 * The canonical public value of one cron job.
 *
 * Field by field rather than handed out whole: both caller-facing surfaces
 * declare a closed result schema, so a field added to the stored job must be
 * a deliberate addition here instead of silently widening one wire and
 * failing the other.
 */
export function cronJobResult(job: CronJob): CronJob {
  return {
    id: job.id,
    ...(job.title !== undefined ? { title: job.title } : {}),
    cron: job.cron,
    tz: job.tz,
    recurring: job.recurring,
    action: job.action,
    enabled: job.enabled,
    created_at: job.created_at,
    updated_at: job.updated_at,
    next_run_at: job.next_run_at,
    last_fired_at: job.last_fired_at,
  };
}

/** The canonical public value of one cron job list. */
export function cronListResult(result: { jobs: CronJob[] }): {
  jobs: CronJob[];
} {
  return { jobs: result.jobs.map(cronJobResult) };
}
