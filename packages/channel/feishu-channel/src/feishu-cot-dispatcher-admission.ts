/** Dispatcher COT admission from a presentable Channel turn. */
import type {
  ChannelTurnSubmittedEvent,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import { cotLogScope } from './feishu-cot-diagnostics.js';
import {
  DispatcherCotStateStore,
  type DispatcherTurnState,
  visibleAnchorFromOrigin,
} from './feishu-cot-state.js';

export interface DispatcherCotAdmission {
  readonly key: string;
  readonly state: DispatcherTurnState;
}

export function admitDispatcherTurn(
  store: DispatcherCotStateStore,
  event: ChannelTurnSubmittedEvent & { readonly role: 'dispatcher' },
  input: {
    readonly dispatcherId: string;
    readonly channelId: string | undefined;
    readonly log: DreamuxLogger;
  },
): DispatcherCotAdmission | null {
  const origin = event.channel_origin;
  if (origin === undefined) return null;
  const anchor = visibleAnchorFromOrigin(origin, input.channelId);
  if (anchor === null) return null;
  const started = store.begin(event.agent_name, event.turn_id, anchor);
  if (started.status === 'started') return started;
  if (started.status === 'full') {
    input.log.warn(
      {
        ...cotLogScope({
          dispatcherId: input.dispatcherId,
          channelId: input.channelId,
          dispatcherAgent: { agentName: event.agent_name },
        }),
        reason: started.reason,
        maximum: started.maximum,
      },
      'Feishu COT dispatcher state is full; dropping newest turn',
    );
  }
  return null;
}
