/**
 * Reading this Channel's own `team.create` context off a created Team.
 *
 * A caller that already has a Feishu group can name it when it asks Core for a
 * Team, and Core hands the pair straight back on `team.created` without reading
 * it. This module is the whole Feishu side of that contract: which provider
 * value is ours, and what its payload must say. What to *do* with the answer —
 * bind the route, move COT ownership, announce it — is the routing owner's job,
 * so it is not repeated here.
 *
 * The payload is a strict `{ chat_id, title }`: the group already exists and
 * the Team is already created, so there is nothing to negotiate and no second
 * shape to accept. An unknown key means the caller believes this Channel
 * supports something it does not, which is worth saying out loud rather than
 * silently binding a group under a misunderstanding.
 */
import type { JsonValue, TeamCreatedEvent } from '@excitedjs/dreamux-types';

import { chatTarget, type FeishuTarget } from './routing/target.js';

/** The Feishu provider ref whose creation context this Channel answers for. */
const FEISHU_CONTEXT_PROVIDER = 'builtin:feishu';

/** The group this creation named, and the display name to bind it under. */
export interface FeishuTeamCreateBinding {
  readonly target: FeishuTarget;
  readonly display: string;
}

/**
 * The binding a `team.created` event asks this Channel for, or `null` when the
 * creation carried no context of ours. Throws when the context IS ours and its
 * payload does not match the contract above.
 */
export function feishuTeamCreateBinding(
  event: TeamCreatedEvent,
): FeishuTeamCreateBinding | null {
  const metadata = event.summary.metadata;
  if (metadata?.['provider'] !== FEISHU_CONTEXT_PROVIDER) return null;
  const payload = parseTeamCreatePayload(metadata['payload']);
  return {
    target: chatTarget(payload.chat_id, 'group'),
    display: payload.title,
  };
}

function parseTeamCreatePayload(
  payload: JsonValue | undefined,
): { chat_id: string; title: string } {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Feishu team.created metadata requires an object payload');
  }
  // `JsonValue` uses readonly arrays, which `Array.isArray` does not narrow
  // away. The runtime check above establishes the object branch of that union.
  const record = payload as Readonly<Record<string, JsonValue>>;
  const unknown = Object.keys(record).filter(
    (key) => key !== 'chat_id' && key !== 'title',
  );
  if (unknown.length > 0) {
    throw new Error(
      `Feishu team.create context has unknown key(s): ${unknown.join(', ')}`,
    );
  }
  const chatId = record['chat_id'];
  const title = record['title'];
  if (typeof chatId !== 'string' || chatId.trim() === '') {
    throw new Error('Feishu team.create context requires a non-empty chat_id');
  }
  if (typeof title !== 'string' || title.trim() === '') {
    throw new Error('Feishu team.create context requires a non-empty title');
  }
  return { chat_id: chatId, title };
}
