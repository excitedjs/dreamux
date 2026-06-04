/**
 * Group `/introduce` — peer-bot introduction, issue #62 hard contract.
 *
 * Trigger rule (deliberately different from claudemux):
 *
 *   In a group, a `/introduce` message triggers **if and only if the sender is
 *   on the allowlist**. No `@`-mention of our bot is required, and the group's
 *   `require_mention` setting is ignored on this path.
 *
 *   "Sender on the allowlist" is sender-scoped, NOT group-scoped: it is not
 *   enough for the chat to be authorized — the *sender* must be explicitly
 *   allowlisted for the chat. An open group (no per-sender allowlist) does NOT
 *   authorize introduce. `canRunIntroduce` therefore never reuses a broad
 *   group-authorization predicate that would trust the group without checking
 *   the sender's identity.
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
  | 'chat_not_allowlisted'
  | 'sender_not_followed';

/**
 * The reason `senderId` may NOT run `/introduce` in this chat, or `null` when it
 * is authorized. This is the single source of truth for the issue #62 hard
 * contract; `canRunIntroduce` is the boolean projection of it.
 *
 * Sender-scoped, not group-scoped: the chat must be explicitly allowlisted AND
 * the sender must be on the global `allow_users` list (the same list that gates
 * direct messages and `follow-user` group delivery). Empty allowlists do not
 * authorize anyone — there is no "any member of an allowlisted group" path.
 */
export function introduceDenyReason(
  access: DispatcherAccessState,
  input: IntroduceAuthInput,
): IntroduceDenyReason | null {
  if (input.chatType !== 'group') return 'non_group';
  if (input.senderId === '') return 'empty_sender_id';
  // The chat must be explicitly allowlisted. Under the `follow-user` policy an
  // empty `allow_chats` means "every chat" for normal delivery, but a
  // trust-changing command always requires the chat to be named, so introduce
  // never fires in an incidental group regardless of the group policy.
  if (!access.group.allow_chats.includes(input.chatId)) return 'chat_not_allowlisted';
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
 * The sender-type check in the gate is what actually scopes trust to bots, so
 * a stray human mention recorded here can never widen access.
 */
export function introducedPeers(
  mentions: Mention[],
  selfOpenId: string | undefined,
): PeerBot[] {
  const peers: PeerBot[] = [];
  const seen = new Set<string>();
  for (const m of mentions) {
    const openId = m.id?.open_id ?? m.id?.union_id ?? '';
    if (openId === '' || openId === selfOpenId || seen.has(openId)) continue;
    seen.add(openId);
    peers.push(m.name !== undefined ? { openId, name: m.name } : { openId });
  }
  return peers;
}
