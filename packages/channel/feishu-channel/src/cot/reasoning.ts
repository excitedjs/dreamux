/**
 * Native reasoning projection for one COT presentation.
 *
 * A visible block is one native part: its item id plus its content position.
 * Its first visible increment opens a section and carries the prefix; later
 * increments only append. Parts are independent — a provider may leave one
 * open while another starts, and neither closes the other; only the part's own
 * completion does. An empty completion closes an open part and never opens
 * one, which is what makes an authoritative snapshot with no increments
 * harmless. Completion closes only the part, not the turn.
 *
 * The projector is pure: it plans events from the open set it is given, and
 * the caller commits the plan only after admission. A dropped increment
 * therefore never makes the next one believe the prefix was already shown.
 * Concrete event shapes stay in `./card.js`; this module owns only which parts
 * a card currently shows as open.
 */
import type { FeishuCotEventInput } from '@excitedjs/feishu-transport';

import {
  reasoningContentEvents,
  reasoningDisplayId,
  reasoningEndEvent,
  reasoningMessageEndEvent,
  reasoningMessageStartEvent,
  reasoningStartEvent,
  type CotReasoningActivity,
} from './card.js';

/** The events one activity adds, and the part whose state it changes. */
export interface ReasoningProjection {
  readonly events: FeishuCotEventInput[];
  readonly displayId: string;
  /** The activity closes this part rather than leaving it open. */
  readonly completed: boolean;
  /**
   * The events are one standalone content event, so the outbox may merge a
   * later increment of the same part into it.
   */
  readonly coalescible: boolean;
}

/**
 * Plan one native activity against the parts this card has open.
 *
 * `openParts` is absent when no card is open at all; that presentation has no
 * parts, so the activity opens the first block on the card about to be made.
 */
export function planReasoningActivity(
  activity: CotReasoningActivity,
  openParts: ReadonlySet<string> | undefined,
): ReasoningProjection | null {
  const displayId = reasoningDisplayId(activity);
  const opening = openParts === undefined || !openParts.has(displayId);

  if (activity.text === '') {
    if (activity.status !== 'completed' || opening) return null;
    return {
      events: [
        reasoningMessageEndEvent(displayId),
        reasoningEndEvent(displayId),
      ],
      displayId,
      completed: true,
      coalescible: false,
    };
  }

  const contentEvents = reasoningContentEvents({
    messageId: displayId,
    text: activity.text,
    prefix: opening,
  });
  if (contentEvents.length === 0) return null;
  const events: FeishuCotEventInput[] = opening
    ? [
        reasoningStartEvent(displayId),
        reasoningMessageStartEvent(displayId),
        ...contentEvents,
      ]
    : [...contentEvents];
  const completed = activity.status === 'completed';
  if (completed) {
    events.push(
      reasoningMessageEndEvent(displayId),
      reasoningEndEvent(displayId),
    );
  }
  return {
    events,
    displayId,
    completed,
    coalescible: events.length === 1,
  };
}

/** Apply an admitted projection to the card's open parts. */
export function commitReasoningProjection(
  openParts: Set<string>,
  projection: ReasoningProjection,
): void {
  if (projection.completed) openParts.delete(projection.displayId);
  else openParts.add(projection.displayId);
}

/**
 * Close every part the card left open, in the order they opened.
 *
 * A card that stops mid-thought would otherwise end its event stream without
 * the message ends; the caller queues these before the run terminal.
 */
export function closeReasoningParts(
  openParts: Set<string>,
): FeishuCotEventInput[] {
  const events: FeishuCotEventInput[] = [];
  for (const displayId of openParts) {
    events.push(
      reasoningMessageEndEvent(displayId),
      reasoningEndEvent(displayId),
    );
  }
  openParts.clear();
  return events;
}
