import {
  isBotMentioned,
  isBotSenderType,
  type Mention,
} from '@excitedjs/feishu-transport';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { dispatcherAccessPath } from '../runtime/paths.js';

export const TRUST_DOMAIN_WARNING =
  'dispatcher shares one Codex context across multiple Feishu chats';

/**
 * Group-access mode — which trust model gates group messages.
 *
 *  - `block`       — every group message is dropped.
 *  - `allowlist`   — the *group* is the unit of trust: a chat must be in
 *                    `group.allow_chats`, and any member there may speak
 *                    (subject to `group.require_mention`).
 *  - `follow-user` — the *sender* is the unit of trust: the group needs no
 *                    authorization (`allow_chats` is ignored), a message is
 *                    always mention-gated, and the sender's open_id must be on
 *                    the top-level `allow_users` list — the same list that
 *                    authorizes direct messages.
 */
export type GroupPolicy = 'block' | 'allowlist' | 'follow-user';

export interface DispatcherAccessState {
  /**
   * Schema version. `1` was the legacy two-list shape (`dm.allow_users` +
   * `group.follow_users`); `2` unifies them into the top-level `allow_users`
   * and adds the explicit `group.policy`. `readDispatcherAccess` migrates a v1
   * file forward by field presence; the marker just records that the rewrite
   * happened.
   */
  version: 2;
  /**
   * The single global allowlist of sender open_ids, shared by direct messages
   * and the group `follow-user` policy (the dreamux equivalent of the transport
   * gate's top-level `allowFrom`). An empty list authorizes nobody.
   */
  allow_users: string[];
  group: {
    policy: GroupPolicy;
    /** Authorized chat_ids — consulted only under the `allowlist` policy. */
    allow_chats: string[];
    require_mention: boolean;
  };
  observed_chats: string[];
  warnings: string[];
  last_gate: GateDiagnostic | null;
}

export interface GateDiagnostic {
  at: number;
  action: 'deliver' | 'drop';
  chat_id: string;
  chat_type: string;
  sender_id: string;
  reason?: string;
}

export interface DreamuxFeishuGateInput {
  senderId: string;
  senderType?: string;
  chatId: string;
  chatType: string;
  mentions?: Mention[];
  botOpenId?: string;
  now?: number;
  /**
   * Peer-bot open_ids trusted in this chat via an allowlisted `/introduce`
   * (issue #62, #102). A bot sender is dropped unless its open_id is in this
   * set AND the message @-mentions this bot — trust is a precondition, not a
   * bypass of the mention gate. `undefined` for direct messages and for callers
   * that do not track trust, in which case no bot sender is ever delivered —
   * preserving prior behavior.
   */
  trustedBotIds?: ReadonlySet<string>;
}

export type DreamuxFeishuGateResult =
  | {
      action: 'deliver';
      access: DispatcherAccessState;
      warning: string | null;
    }
  | {
      action: 'drop';
      access: DispatcherAccessState;
      reason: string;
      warning: null;
    };

export function defaultDispatcherAccessState(): DispatcherAccessState {
  return {
    version: 2,
    allow_users: [],
    group: {
      policy: 'follow-user',
      allow_chats: [],
      require_mention: true,
    },
    observed_chats: [],
    warnings: [],
    last_gate: null,
  };
}

export async function loadDispatcherAccess(
  dispatcherId: string,
): Promise<DispatcherAccessState> {
  const path = dispatcherAccessPath(dispatcherId);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return defaultDispatcherAccessState();
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`dispatcher access parse error in ${path}: ${msg}`);
  }
  return readDispatcherAccess(parsed, path);
}

export async function saveDispatcherAccess(
  dispatcherId: string,
  access: DispatcherAccessState,
): Promise<void> {
  const path = dispatcherAccessPath(dispatcherId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(access, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export function dreamuxFeishuGate(
  input: DreamuxFeishuGateInput,
  access: DispatcherAccessState,
): DreamuxFeishuGateResult {
  const now = input.now ?? Date.now();
  const drop = (reason: string): DreamuxFeishuGateResult => ({
    action: 'drop',
    reason,
    warning: null,
    access: withDiagnostic(access, input, now, 'drop', reason),
  });

  if (input.senderId === '') return drop('missing sender id');
  if (input.botOpenId !== undefined && input.senderId === input.botOpenId) {
    return drop('message sent by this bot');
  }
  const senderIsBot = isBotSenderType(input.senderType);

  if (input.chatType === 'p2p') {
    if (senderIsBot) return drop(`bot sender type: ${input.senderType}`);
    if (!access.allow_users.includes(input.senderId)) {
      return drop('direct sender not allowed');
    }
    return deliver(access, input, now);
  }

  if (input.chatType !== 'group') {
    return drop(`unsupported chat type: ${input.chatType}`);
  }

  const policy = access.group.policy;
  if (policy === 'block') {
    return drop('group messages are blocked (group policy: block)');
  }

  // Under `allowlist` the group is the unit of trust: the chat must be named.
  // Under `follow-user` the chat allowlist is intentionally ignored — the group
  // needs no authorization, only the sender does.
  if (policy === 'allowlist' && !access.group.allow_chats.includes(input.chatId)) {
    return drop('group chat not allowed');
  }

  if (senderIsBot) {
    // A peer bot speaks only if it was introduced (trusted) for this chat by an
    // allowlisted `/introduce` AND it @-mentions this bot (issue #102, aligned
    // with upstream lineage): trust is a precondition for entry, not a bypass of
    // the mention gate. Untrusted bots are dropped regardless of mention. This
    // is per-chat trust (`trustedBotIds` is scoped to this chat by the caller)
    // and is never reached through the human `allow_users` list.
    if (!(input.trustedBotIds?.has(input.senderId) ?? false)) {
      return drop(`bot sender type: ${input.senderType}`);
    }
    if (input.botOpenId === undefined) {
      return drop('group message requires a bot mention but bot open_id is unknown');
    }
    if (!isBotMentioned(input.mentions, input.botOpenId)) {
      return drop('bot not mentioned');
    }
    return deliver(access, input, now);
  }

  if (policy === 'follow-user') {
    // A deliberate @-mention is always required — without it the bot would
    // react to every message in the group. The flag `group.require_mention`
    // governs only the `allowlist` policy.
    if (input.botOpenId === undefined) {
      return drop('group message requires a bot mention but bot open_id is unknown');
    }
    if (!isBotMentioned(input.mentions, input.botOpenId)) {
      return drop('bot not mentioned');
    }
    if (!access.allow_users.includes(input.senderId)) {
      return drop('sender not on allowlist');
    }
    return deliver(access, input, now);
  }

  // policy === 'allowlist': the chat is already authorized above; any member
  // may speak, subject to the configurable mention gate.
  if (access.group.require_mention) {
    if (input.botOpenId === undefined) {
      return drop('group message requires a bot mention but bot open_id is unknown');
    }
    if (!isBotMentioned(input.mentions, input.botOpenId)) {
      return drop('bot not mentioned');
    }
  }

  return deliver(access, input, now);
}

function deliver(
  access: DispatcherAccessState,
  input: DreamuxFeishuGateInput,
  now: number,
): DreamuxFeishuGateResult {
  let next = withDiagnostic(access, input, now, 'deliver');
  if (!next.observed_chats.includes(input.chatId)) {
    next = {
      ...next,
      observed_chats: [...next.observed_chats, input.chatId],
    };
  }

  const needsWarning =
    next.group.allow_chats.length > 1 || next.observed_chats.length > 1;
  const warning =
    needsWarning && !next.warnings.includes(TRUST_DOMAIN_WARNING)
      ? TRUST_DOMAIN_WARNING
      : null;
  if (warning !== null) {
    next = {
      ...next,
      warnings: [...next.warnings, warning],
    };
  }

  return { action: 'deliver', access: next, warning };
}

function withDiagnostic(
  access: DispatcherAccessState,
  input: DreamuxFeishuGateInput,
  now: number,
  action: 'deliver' | 'drop',
  reason?: string,
): DispatcherAccessState {
  return {
    ...access,
    last_gate: {
      at: now,
      action,
      chat_id: input.chatId,
      chat_type: input.chatType,
      sender_id: input.senderId,
      ...(reason !== undefined ? { reason } : {}),
    },
  };
}

function readDispatcherAccess(
  raw: unknown,
  path: string,
): DispatcherAccessState {
  if (!isRecord(raw)) {
    throw new Error(`dispatcher access error in ${path}: top-level must be an object`);
  }
  const defaults = defaultDispatcherAccessState();
  const dm = isRecord(raw['dm']) ? raw['dm'] : {};
  const group = isRecord(raw['group']) ? raw['group'] : {};
  const lastGate = raw['last_gate'];

  // v2 unifies three possible sources of allowed senders into one list:
  //   - top-level `allow_users` (v2),
  //   - legacy `dm.allow_users` (v1 direct allowlist),
  //   - legacy `group.follow_users` (v1 group sender allowlist).
  // They are merged and de-duplicated; the legacy fields are read but never
  // written back, so the first save collapses the file to the v2 shape. The
  // union means DM access becomes `dm.allow_users ∪ group.follow_users` — for
  // the common case (the two were equal, or dm ⊇ follow) DM is unchanged.
  const topAllow = readStringArray(raw, 'allow_users', [], path);
  const legacyDmAllow = readStringArray(dm, 'allow_users', [], path);
  const legacyFollow = readStringArray(group, 'follow_users', [], path);
  const allowUsers = [...new Set([...topAllow, ...legacyDmAllow, ...legacyFollow])];
  const allowChats = readStringArray(
    group,
    'allow_chats',
    defaults.group.allow_chats,
    path,
  );

  // Group policy: an explicit value always wins. Otherwise infer from the
  // legacy shape — a non-empty `follow_users` is the strongest signal the
  // operator wanted sender-scoped gating, so preserve it as `follow-user`
  // (never silently relax it to chat-only `allowlist`); then a non-empty
  // `allow_chats` means chat-scoped gating; else the secure default.
  const explicitPolicy = readGroupPolicy(group['policy'], path);
  const policy: GroupPolicy =
    explicitPolicy ??
    (legacyFollow.length > 0
      ? 'follow-user'
      : allowChats.length > 0
        ? 'allowlist'
        : defaults.group.policy);

  return {
    version: 2,
    allow_users: allowUsers,
    group: {
      policy,
      allow_chats: allowChats,
      require_mention: readBoolean(
        group,
        'require_mention',
        defaults.group.require_mention,
        path,
      ),
    },
    observed_chats: readStringArray(
      raw,
      'observed_chats',
      defaults.observed_chats,
      path,
    ),
    warnings: readStringArray(raw, 'warnings', defaults.warnings, path),
    last_gate: lastGate === null || lastGate === undefined
      ? null
      : readGateDiagnostic(lastGate, path),
  };
}

function readGroupPolicy(
  value: unknown,
  path: string,
): GroupPolicy | undefined {
  if (value === undefined) return undefined;
  if (value !== 'block' && value !== 'allowlist' && value !== 'follow-user') {
    throw new Error(
      `dispatcher access error in ${path}: group.policy must be block, allowlist, or follow-user`,
    );
  }
  return value;
}

function readGateDiagnostic(raw: unknown, path: string): GateDiagnostic {
  if (!isRecord(raw)) {
    throw new Error(`dispatcher access error in ${path}: last_gate must be an object`);
  }
  const action = raw['action'];
  if (action !== 'deliver' && action !== 'drop') {
    throw new Error(
      `dispatcher access error in ${path}: last_gate.action must be deliver or drop`,
    );
  }
  return {
    at: readNumber(raw, 'at', path),
    action,
    chat_id: readString(raw, 'chat_id', path),
    chat_type: readString(raw, 'chat_type', path),
    sender_id: readString(raw, 'sender_id', path),
    ...(typeof raw['reason'] === 'string' ? { reason: raw['reason'] } : {}),
  };
}

function readStringArray(
  obj: Record<string, unknown>,
  key: string,
  fallback: string[],
  path: string,
): string[] {
  const value = obj[key];
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(
      `dispatcher access error in ${path}: ${key} must be an array of strings`,
    );
  }
  return [...new Set(value)];
}

function readBoolean(
  obj: Record<string, unknown>,
  key: string,
  fallback: boolean,
  path: string,
): boolean {
  const value = obj[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw new Error(`dispatcher access error in ${path}: ${key} must be a boolean`);
  }
  return value;
}

function readNumber(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): number {
  const value = obj[key];
  if (typeof value !== 'number') {
    throw new Error(`dispatcher access error in ${path}: ${key} must be a number`);
  }
  return value;
}

function readString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const value = obj[key];
  if (typeof value !== 'string') {
    throw new Error(`dispatcher access error in ${path}: ${key} must be a string`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
