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
 * True when `senderId` may run `/introduce` in this chat.
 *
 * Sender-scoped, not group-scoped (the issue #62 hard contract): the chat must
 * be explicitly allowlisted AND the sender must be on the per-chat sender
 * allowlist. Empty allowlists do not authorize anyone — there is no "any member
 * of an allowlisted group" path.
 */
export function canRunIntroduce(
  access: DispatcherAccessState,
  input: IntroduceAuthInput,
): boolean {
  if (input.chatType !== 'group') return false;
  if (input.senderId === '') return false;
  // The chat must be explicitly allowlisted. An empty allow_chats means "every
  // chat" for normal delivery, but for a trust-changing command we require the
  // chat to be named, so introduce never fires in an incidental group.
  if (!access.group.allow_chats.includes(input.chatId)) return false;
  // The sender must be explicitly allowlisted. An empty follow_users authorizes
  // nobody for introduce — this is the line that makes the rule sender-scoped
  // rather than "any member of an allowlisted group".
  if (!access.group.follow_users.includes(input.senderId)) return false;
  return true;
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
