import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import type { RestartIntentConsumer } from '../../daemon/restart-intent.js';
import { errorInfo } from '../../platform/error-info.js';
import type { TeammateService } from '../teammate-service/index.js';

export async function injectRestartNoticeIfNeeded(input: {
  dispatcherId: string;
  agent: TeammateService;
  restartIntent: RestartIntentConsumer | null;
  now: number;
  log: DreamuxLogger;
}): Promise<void> {
  if (!input.agent.wasCheckpointResumed()) return;
  const notice = input.restartIntent?.claim(input.dispatcherId, input.now) ?? null;
  if (notice === null) return;
  try {
    const result = await input.agent.controlInput({
      text: notice,
      sourceId: `restart-notice:${input.dispatcherId}`,
    });
    if (result.status === 'failed' || result.status === 'ambiguous') {
      input.log.warn(
        { dispatcher_id: input.dispatcherId, err: errorInfo(result.error) },
        result.status === 'ambiguous'
          ? 'restart notice injection was ambiguous; not retrying'
          : 'restart notice injection failed',
      );
    }
  } catch (err) {
    input.log.warn(
      { dispatcher_id: input.dispatcherId, err: errorInfo(err) },
      'restart notice injection errored',
    );
  }
}
