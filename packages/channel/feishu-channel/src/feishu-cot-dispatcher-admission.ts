/** Dispatcher COT admission for a turn this Channel just submitted. */
import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import { cotLogScope } from './feishu-cot-diagnostics.js';
import {
  DispatcherCotStateStore,
  type KeyedDispatcherTurn,
} from './feishu-cot-dispatcher-state.js';
import type { VisibleMessageAnchor } from './feishu-cot-state.js';

/**
 * Open one Dispatcher turn under the message that produced it.
 *
 * The anchor is supplied rather than derived: only the session that invoked
 * `team.submit` knows which visible message became this `turn_id`, and it says
 * so by calling here. A turn that reaches this function is therefore already
 * proven to be this Channel's own — nothing else can open a Dispatcher card.
 */
export function admitDispatcherTurn(
  store: DispatcherCotStateStore,
  turn: {
    readonly agentName: string;
    readonly turnId: string;
    readonly anchor: VisibleMessageAnchor;
  },
  input: {
    readonly dispatcherId: string;
    readonly channelId: string | undefined;
    readonly log: DreamuxLogger;
  },
): KeyedDispatcherTurn | null {
  const started = store.begin(turn.agentName, turn.turnId, turn.anchor);
  if (started.status === 'started') return started;
  if (started.status === 'full') {
    input.log.warn(
      {
        ...cotLogScope({
          dispatcherId: input.dispatcherId,
          channelId: input.channelId,
          dispatcherAgent: { agentName: turn.agentName },
        }),
        reason: started.reason,
        maximum: started.maximum,
      },
      'Feishu COT dispatcher state is full; dropping newest turn',
    );
  }
  return null;
}
