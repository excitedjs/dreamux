import type { AgentRuntime, DreamuxLogger } from '@excitedjs/dreamux-types';

import type { RestartIntentConsumer } from '../../daemon/restart-intent.js';
import { errInfo } from './runtime-helpers.js';

export async function injectRestartNoticeIfNeeded(input: {
  dispatcherId: string;
  runtime: AgentRuntime;
  restartIntent: RestartIntentConsumer | null;
  now: number;
  log: DreamuxLogger;
}): Promise<void> {
  if (!input.runtime.wasCheckpointResumed()) return;
  const notice = input.restartIntent?.claim(input.dispatcherId, input.now) ?? null;
  if (notice === null) return;
  try {
    const result = await input.runtime.completionInput({
      text: notice,
      sourceId: `restart-notice:${input.dispatcherId}`,
    });
    if (result.status === 'failed') {
      input.log.warn(
        { dispatcher_id: input.dispatcherId, err: errInfo(result.error) },
        'restart notice injection failed',
      );
    }
  } catch (err) {
    input.log.warn(
      { dispatcher_id: input.dispatcherId, err: errInfo(err) },
      'restart notice injection errored',
    );
  }
}
