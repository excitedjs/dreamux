/**
 * Group `/introduce` — peer-bot introduction, issue #62 hard contract.
 *
 * Trigger rule (deliberately different from claudemux):
 *
 *   In a group, a `/introduce` message triggers **if and only if the sender is
 *   authorized to run it under the group's policy**. No `@`-mention of our bot
 *   is required, and the group's `require_mention` setting is ignored on this
 *   path.
 *
 * Authorization mirrors the delivery gate (`dreamuxFeishuGate`) for the same
 * group policy, minus the @-mention requirement that introduce deliberately
 * waives. The parity is exact except for two divergences that are intentional
 * (issue #62), not accidental — keep them when "aligning" the two gates:
 *
 *   - `block`       — never authorized (the gate drops every group message).
 *   - `follow-user` — the chat needs no authorization; `allow_chats` is ignored
 *                     exactly as the gate ignores it. The sender must be on the
 *                     global `allow_users` list.
 *   - `allowlist`   — the chat must be named in `allow_chats` (the group is the
 *                     unit of trust). The sender must ALSO be on `allow_users` —
 *                     this is the #62 divergence: a trust-changing command is
 *                     sender-scoped even in an allowlisted group, whereas the
 *                     delivery gate lets any member of an allowlisted group
 *                     speak. "Any member of an allowlisted group" is therefore
 *                     deliberately NOT a path to introduce.
 *
 * Before issue #79/#82 made the gate policy-aware, introduce kept a hardcoded
 * `chat_not_allowlisted` check for *every* policy — so an `allow_users` sender
 * could chat in a brand-new `follow-user` group but could never `/introduce`
 * there. That accidental split is the bug this contract now closes.
 *
 * The peer bots being introduced are the message's @-mentions (excluding our
 * own bot); the host records them as *trusted* for the chat. Recording a human
 * mention is harmless: the gate only lets a trusted entry bypass when the
 * *sender* is a bot, so a human open_id in the trust set never widens access.
 */

import type { Mention } from '@excitedjs/feishu-transport';

import type { DispatcherAccessState } from './feishu-gate.js';
import type { PeerBot } from './chat-bots-store.js';

const INTRODUCE_RE = /^\/introduce(?:\s|$)/i;
const UNKNOWN_PEER_LABEL = '伙伴';

export interface IntroduceAuthInput {
  chatType: string;
  chatId: string;
  senderId: string;
}

/**
 * Stable, machine-grep-able reason an `/introduce` was not authorized. Each
 * value maps one-to-one to a rejection point in `introduceDenyReason`; they are
 * logged verbatim so an operator can tell "introduce blocked by allowlist" apart
 * from an ordinary gate drop (issue #77). They carry no message content.
 */
export type IntroduceDenyReason =
  | 'non_group'
  | 'empty_sender_id'
  | 'group_blocked'
  | 'chat_not_allowlisted'
  | 'sender_not_followed';

/**
 * The reason `senderId` may NOT run `/introduce` in this chat, or `null` when it
 * is authorized. This is the single source of truth for the issue #62 hard
 * contract; `canRunIntroduce` is the boolean projection of it.
 *
 * Policy-aware, mirroring `dreamuxFeishuGate`'s group branch for the same policy
 * (minus the @-mention requirement introduce waives):
 *   - `block`       → `group_blocked` (the gate drops every group message).
 *   - `follow-user` → `allow_chats` is ignored exactly as the gate ignores it;
 *                     only the sender's membership in `allow_users` matters.
 *   - `allowlist`   → the chat must be in `allow_chats` (chat-as-unit-of-trust)
 *                     AND the sender must be on `allow_users` (the #62 sender
 *                     scoping that the delivery gate does not impose).
 * Empty allowlists authorize nobody — there is no "any member of an allowlisted
 * group" path.
 */
export function introduceDenyReason(
  access: DispatcherAccessState,
  input: IntroduceAuthInput,
): IntroduceDenyReason | null {
  if (input.chatType !== 'group') return 'non_group';
  if (input.senderId === '') return 'empty_sender_id';
  const policy = access.group.policy;
  // `block` drops every group message; a trust-changing command is no exception.
  // (Before this was explicit, `block` blocked introduce only by accident — its
  // empty `allow_chats` tripped `chat_not_allowlisted`. Once `follow-user` stops
  // checking `allow_chats`, the block case needs its own guard.)
  if (policy === 'block') return 'group_blocked';
  // Under `allowlist` the group is the unit of trust, so the chat must be named.
  // Under `follow-user` the chat allowlist is intentionally ignored — the group
  // needs no authorization, exactly as the delivery gate ignores it. This is the
  // line that was previously hardcoded for every policy and split introduce from
  // the gate (issue #82 made the gate policy-aware but left this behind).
  if (policy === 'allowlist' && !access.group.allow_chats.includes(input.chatId)) {
    return 'chat_not_allowlisted';
  }
  // The sender must be on the global allow-user list — the same list that gates
  // direct messages and `follow-user` group delivery. An empty list authorizes
  // nobody, keeping the rule sender-scoped rather than "any member of an
  // allowlisted group". The `sender_not_followed` code name predates the
  // single-list unification (issue #79) but still reads correctly: the sender
  // is not a followed/allow-listed user.
  if (!access.allow_users.includes(input.senderId)) return 'sender_not_followed';
  return null;
}

/**
 * True when `senderId` may run `/introduce` in this chat. Boolean projection of
 * `introduceDenyReason`; kept as a named predicate so callers on the consume
 * path read clearly and stay byte-identical to the pre-issue-#77 behavior.
 */
export function canRunIntroduce(
  access: DispatcherAccessState,
  input: IntroduceAuthInput,
): boolean {
  return introduceDenyReason(access, input) === null;
}

/**
 * Detect a `/introduce` command. Text messages only; leading Feishu mention
 * placeholder tokens (e.g. `@_user_1 `) are stripped first so an `@`-prefixed
 * `/introduce` still matches — the trigger does not depend on who, if anyone,
 * was mentioned.
 */
export function detectIntroduce(
  messageType: string,
  rawContent: string,
  mentions: Mention[],
): boolean {
  if (messageType !== 'text') return false;
  let text: string;
  try {
    const parsed = JSON.parse(rawContent) as unknown;
    text =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? typeof (parsed as Record<string, unknown>)['text'] === 'string'
          ? ((parsed as Record<string, unknown>)['text'] as string)
          : ''
        : '';
  } catch {
    return false;
  }
  // Strip leading Feishu mention keys longest-first: keys can be prefixes of
  // one another (`@_user_1` vs `@_user_10`), so checking the shorter key first
  // would consume a partial token and leave a stray suffix, false-negating an
  // `@`-prefixed `/introduce`. (Same longest-key-first rule used for rendering.)
  const keys = mentions
    .map((m) => m.key)
    .filter((key) => key !== '')
    .sort((a, b) => b.length - a.length);
  let remaining = text.trimStart();
  let progress = true;
  while (progress) {
    progress = false;
    for (const key of keys) {
      if (remaining.startsWith(key)) {
        remaining = remaining.slice(key.length).trimStart();
        progress = true;
        break;
      }
    }
  }
  return INTRODUCE_RE.test(remaining);
}

/**
 * The peer bots an `/introduce` names — every @-mention except our own bot.
 *
 * Trust identity is **only** a mention's `open_id`. A mention that lacks
 * `open_id` is skipped — we never fall back to `union_id` or `user_id` (issue
 * #102). Within one receiving app a peer bot's `open_id` is stable across the
 * "mentioned" and "sender" contexts, so the mention `open_id` recorded here is
 * exactly what the inbound gate later matches against the bot's sender
 * `open_id`; a `union_id`/`user_id` would not. The sender-type check in the
 * gate is what actually scopes trust to bots, so a stray human mention recorded
 * here can never widen access.
 */
export function introducedPeers(
  mentions: Mention[],
  selfOpenId: string | undefined,
): PeerBot[] {
  const peers: PeerBot[] = [];
  const seen = new Set<string>();
  for (const m of mentions) {
    const openId = m.id?.open_id ?? '';
    if (openId === '' || openId === selfOpenId || seen.has(openId)) continue;
    seen.add(openId);
    peers.push(m.name !== undefined ? { openId, name: m.name } : { openId });
  }
  return peers;
}

/**
 * User-visible channel ack for an authorized `/introduce`. The fallback avoids
 * exposing raw open_id values when Feishu did not provide a display name.
 */
export function introduceAckText(peers: PeerBot[]): string | null {
  if (peers.length === 0) return null;
  const items = peers.map((peer) => `@${displayNameForAck(peer)}`).join(' ');
  return `✅ 已认识本群 ${peers.length} 个伙伴：${items}`;
}

function displayNameForAck(peer: PeerBot): string {
  const name = peer.name !== undefined ? safeInlineText(peer.name) : '';
  return name !== '' ? name : UNKNOWN_PEER_LABEL;
}

function safeInlineText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[`*[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
