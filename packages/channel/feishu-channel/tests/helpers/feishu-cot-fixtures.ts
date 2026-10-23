/**
 * One set of fixtures and event factories for the two COT suites.
 *
 * `feishu-cot.test.ts` drives anchors, cards, and terminals;
 * `feishu-cot-reasoning.test.ts` drives reasoning projection, cadence, and
 * bounded outbox behavior. Both publish the same Core event shapes, so the
 * shapes live here once instead of drifting between copies.
 *
 * The suites differ only in how long a settle advances the fake clock, which
 * `cotTestClock` takes as its parameter.
 *
 * Every identifier here is a placeholder.
 */
import { vi } from 'vitest';

import type {
  DreamuxLogger,
  RuntimeActivity,
  TeamStateEvent,
  TeammateActivityEvent,
  TeammateInputEvent,
  TeammateRole,
} from '@excitedjs/dreamux-types';

import type { FeishuCotAdapter } from '../../src/cot/adapter.js';
import type { VisibleMessageAnchor } from '../../src/cot/recipients.js';
import { chatTarget, type FeishuTarget } from '../../src/routing/target.js';

/** The cadence the adapter must honor between append starts. */
export const COT_APPEND_INTERVAL_MS = 500;
/** Advance past the writer's five-second drain cap during test cleanup. */
const CLOSE_DRAIN_MS = 10_000;

export const silentLog: DreamuxLogger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  child: () => silentLog,
};

/** One recipient as Core publishes it, plus the label a suite prints. */
export interface Recipient {
  readonly label?: string;
  readonly teammateName: string;
  readonly role: TeammateRole;
  readonly teamName: string | null;
}

export const LEADER: Recipient = {
  label: 'TeamLeader',
  teammateName: 'alpha-leader',
  role: 'team_leader',
  teamName: 'alpha',
};

export const DISPATCHER: Recipient = {
  label: 'Dispatcher',
  teammateName: 'dispatcher-agent',
  role: 'dispatcher',
  teamName: null,
};

export function anchorAt(
  chatId: string,
  messageId: string,
  target: FeishuTarget = chatTarget(chatId, 'group'),
): VisibleMessageAnchor {
  return { chatId, messageId, target, servingTarget: null };
}

let sequence = 0;

function nextOccurrence(): number {
  return 1_700_000_000_000 + (sequence += 1);
}

export function activity(
  recipient: Recipient,
  payload: RuntimeActivity,
): TeammateActivityEvent {
  return {
    schemaVersion: 1,
    kind: 'teammate.activity',
    occurredAt: nextOccurrence(),
    teammateName: recipient.teammateName,
    role: recipient.role,
    teamName: recipient.teamName,
    activity: payload,
  };
}

export function input(
  recipient: Recipient,
  content: string,
  source = 'feishu',
  sourceId: string | null = null,
  notice: TeammateInputEvent['notice'] = null,
): TeammateInputEvent {
  return {
    schemaVersion: 1,
    kind: 'teammate.input',
    occurredAt: nextOccurrence(),
    teammateName: recipient.teammateName,
    role: recipient.role,
    teamName: recipient.teamName,
    source,
    sourceId,
    content,
    notice,
  };
}

export function message(
  recipient: Recipient,
  content: string,
): TeammateActivityEvent {
  return activity(recipient, {
    kind: 'assistant.message',
    occurredAt: 1,
    id: `event-${(sequence += 1)}`,
    text: content,
  });
}

export function reasoning(
  recipient: Recipient,
  id: string,
  partIndex: number,
  text: string,
  status: 'streaming' | 'completed' = 'streaming',
): TeammateActivityEvent {
  return activity(recipient, {
    kind: 'assistant.reasoning',
    occurredAt: 1,
    id,
    partIndex,
    text,
    status,
  });
}

export function toolCall(
  recipient: Recipient,
  callId: string,
  status: 'started' | 'completed' | 'failed',
): TeammateActivityEvent {
  return activity(recipient, {
    kind: 'tool.call',
    occurredAt: 1,
    id: callId,
    toolName: 'Read',
    action: 'read',
    summary: null,
    invocation: null,
    items: [],
    status,
    arguments: status === 'started' ? '{"file_path":"/tmp/example"}' : null,
    result: status === 'started' ? null : 'file contents',
    error: null,
  });
}

export function nativeEnd(
  recipient: Recipient,
  status: 'completed' | 'failed' | 'interrupted',
  reason: string | null = null,
): TeammateActivityEvent {
  return activity(recipient, {
    kind: 'turn.ended',
    occurredAt: 1,
    status,
    reason,
  });
}

export function teamState(
  teamName: string,
  leaderName: string,
  status: 'starting' | 'running' | 'closed',
): TeamStateEvent {
  return {
    schemaVersion: 1,
    kind: 'team.state',
    occurredAt: nextOccurrence(),
    teamName,
    leaderName,
    status,
    teammates: [],
  };
}

/** Take the recipient's anchor and submit the input that established it. */
export function submitInbound(
  adapter: FeishuCotAdapter,
  recipient: Recipient,
  turnId: string,
  anchor: VisibleMessageAnchor,
): void {
  const sourceId = `message-${turnId}`;
  const lease = adapter.beginInboundSubmission({
    teamName: recipient.role === 'dispatcher' ? null : recipient.teamName,
    anchor,
    sourceId,
  });
  adapter.handle(
    input(recipient, 'the already visible inbound', 'feishu', sourceId),
  );
  lease?.release();
}

/** The suite's fake clock and the two ways its tests advance time. */
export function cotTestClock(options: { readonly settleMs: number }): {
  settle(ms?: number): Promise<void>;
  closeWithin(owner: { close(): Promise<void> }): Promise<void>;
} {
  const settle = async (ms = options.settleMs): Promise<void> => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(ms);
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  };
  const closeWithin = async (owner: {
    close(): Promise<void>;
  }): Promise<void> => {
    const closing = owner.close();
    await vi.advanceTimersByTimeAsync(CLOSE_DRAIN_MS);
    await closing;
  };
  return { settle, closeWithin };
}

/** The fake clock both COT suites run on. */
export function useCotClock(): void {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
}

export function restoreCotClock(): void {
  vi.useRealTimers();
}
