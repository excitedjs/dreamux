import type {
  ChannelInboundEnvelope,
  ChannelSession,
  ChannelTargetLifecycleEvent,
  InboundDeliveryResult,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';

import type { TaskChannelHostCollection } from '../channel-task-host/index.js';

export async function startChannelSessions(input: {
  sessions: Map<string, ChannelSession>;
  taskHosts: TaskChannelHostCollection;
  deliver: (
    channelId: string,
    turn: InboundTurnInput,
    envelope: ChannelInboundEnvelope,
  ) => Promise<InboundDeliveryResult>;
  targetLifecycle: (
    channelId: string,
    event: ChannelTargetLifecycleEvent,
  ) => Promise<void>;
  assertReady: () => void;
  adopt: (sessions: Map<string, ChannelSession>) => void;
}): Promise<void> {
  const live = new Map<string, ChannelSession>();
  for (const [channelId, session] of input.sessions) {
    const taskHost = input.taskHosts.beginSession(channelId);
    await session.start({
      deliver: (turn, envelope) => input.deliver(channelId, turn, envelope),
      targetLifecycle: (event) => input.targetLifecycle(channelId, event),
      ...(taskHost !== undefined ? { taskHost } : {}),
    });
    if (taskHost !== undefined) {
      input.taskHosts.attachEventSink(
        channelId,
        taskHost.scope.session_fence,
        session.taskHostEvents,
      );
    }
    input.assertReady();
    live.set(channelId, session);
    input.adopt(live);
  }
  if (input.sessions.size === 0) input.adopt(live);
}
