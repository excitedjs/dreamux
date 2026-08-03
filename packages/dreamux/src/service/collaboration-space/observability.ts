import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import {
  boundedLogText,
  LOG_ERROR_MAX_LENGTH,
} from '../../platform/log-fields.js';
import type { ProvisionedTargetRecord } from './types.js';

export function logTargetCloseStarted(
  log: DreamuxLogger,
  dispatcherId: string,
  target: ProvisionedTargetRecord,
): void {
  log.info(targetCloseFields(dispatcherId, target), 'collaboration target close started');
}

export function logTargetCloseFailed(
  log: DreamuxLogger,
  dispatcherId: string,
  target: ProvisionedTargetRecord,
  errorMessage: string,
): void {
  log.error(
    {
      ...targetCloseFields(dispatcherId, target),
      err: { message: boundedLogText(errorMessage, LOG_ERROR_MAX_LENGTH) },
    },
    'collaboration target close failed (target remains in closing state for retry)',
  );
}

export function logTargetCloseCompleted(
  log: DreamuxLogger,
  dispatcherId: string,
  target: ProvisionedTargetRecord,
): void {
  log.info(
    {
      ...targetCloseFields(dispatcherId, target),
      lifecycle_status: target.lifecycle_status,
    },
    'collaboration target close completed',
  );
}

function targetCloseFields(
  dispatcherId: string,
  target: ProvisionedTargetRecord,
): Record<string, unknown> {
  return {
    dispatcher_id: boundedLogText(dispatcherId),
    space_name: boundedLogText(target.space_name),
    channel_id: boundedLogText(target.channel_id),
    provider: boundedLogText(target.provider),
    container_key: boundedLogText(target.container_key),
    binding_generation: target.binding_generation,
    target_type: boundedLogText(target.target_type),
    target_key: boundedLogText(target.target_key),
    team_name: boundedLogText(target.team_name),
  };
}
