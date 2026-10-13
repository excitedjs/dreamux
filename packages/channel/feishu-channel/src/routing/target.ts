/**
 * The Feishu target model — this Channel's own, and nobody else's.
 *
 * Core no longer holds a target type, a target key, a bindable flag, or a
 * fallback list, because none of those were ever Core facts: they are how one
 * external product happens to name a place a message can arrive. Feishu names
 * them here, matches on them here, and hands Core only a `team_name`.
 *
 * Three kinds exist because Feishu has three: a direct chat, an ordinary group,
 * and one topic. A topic is the only one with a parent, which is the whole of
 * this module's hierarchy: a message in a topic that has no binding of its own
 * is still a message in its group. Identity is Feishu's own `thread_id` and
 * does not depend on the group's current message format — whether an unbound
 * topic may automatically receive a new Team is a separate, routing-owned
 * question.
 */

export type FeishuTargetKind = 'p2p' | 'group' | 'topic';

export interface FeishuTarget {
  readonly kind: FeishuTargetKind;
  readonly chatId: string;
  /** Set exactly when `kind` is `topic`. */
  readonly threadId?: string;
}

export function chatTarget(chatId: string, rawType: string): FeishuTarget {
  return { kind: rawType === 'p2p' ? 'p2p' : 'group', chatId };
}

export function topicTarget(chatId: string, threadId: string): FeishuTarget {
  return { kind: 'topic', chatId, threadId };
}

/**
 * The target a message sits in, from the place Feishu reports for it — pure,
 * and the one owner of that composition.
 *
 * A non-empty `thread_id` names a topic whatever the group's current message
 * format is; neither `root_id` nor `parent_id` is consulted. A direct chat
 * stays direct; a message whose source supplies no chat kind (a message read
 * back from the API, a send response) is the ordinary-group case it has always
 * been assumed to be.
 */
export function messageTarget(place: {
  chatId: string;
  chatType?: string | undefined;
  threadId?: string | undefined;
}): FeishuTarget {
  const chatType = place.chatType ?? 'group';
  if (
    chatType !== 'p2p' &&
    place.threadId !== undefined &&
    place.threadId !== ''
  ) {
    return topicTarget(place.chatId, place.threadId);
  }
  return chatTarget(place.chatId, chatType);
}

/** The chat a target lives in: a topic's parent group, or the target itself. */
export function containingChat(target: FeishuTarget): FeishuTarget {
  return target.kind === 'topic' ? chatTarget(target.chatId, 'group') : target;
}

/**
 * The identity a binding row is keyed by. Injective over the three kinds: a
 * chat id cannot contain `\0`, so no group key can spell a topic key.
 */
export function targetKey(target: FeishuTarget): string {
  return target.kind === 'topic'
    ? `topic\0${target.chatId}\0${target.threadId ?? ''}`
    : `${target.kind}\0${target.chatId}`;
}

/**
 * Where an inbound message may find a binding, most specific first.
 *
 * This is the entire fallback rule, and it is deliberately one level deep: a
 * topic falls back to its own group and stops. There is no chain to walk and no
 * inherited binding beyond the conversation the message is visibly in.
 */
export function resolutionChain(target: FeishuTarget): readonly FeishuTarget[] {
  return target.kind === 'topic' ? [target, containingChat(target)] : [target];
}

export function sameTarget(left: FeishuTarget, right: FeishuTarget): boolean {
  return targetKey(left) === targetKey(right);
}

/** A stable human label for logs and tool results; never a routing key. */
export function describeTarget(target: FeishuTarget): string {
  return target.kind === 'topic'
    ? `${target.chatId}#${target.threadId ?? ''}`
    : target.chatId;
}

export function isBindableTarget(target: FeishuTarget): boolean {
  // A direct chat is one person's conversation with the bot, not a place a
  // Team can be published to; binding one would route somebody's DM into a
  // shared Team without them ever being told. It is still a conversation —
  // it simply talks to the Dispatcher Agent, as it always has.
  return target.kind !== 'p2p';
}
