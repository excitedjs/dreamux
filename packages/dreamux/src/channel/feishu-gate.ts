import {
  isBotMentioned,
  isBotSenderType,
  type Mention,
} from '@excitedjs/feishu-transport';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import { dispatcherAccessPath } from '../runtime/paths.js';

export const TRUST_DOMAIN_WARNING =
  'dispatcher shares one Codex context across multiple Feishu chats';

export interface DispatcherAccessState {
  version: 1;
  dm: {
    allow_users: string[];
  };
  group: {
    allow_chats: string[];
    follow_users: string[];
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
    version: 1,
    dm: {
      allow_users: [],
    },
    group: {
      allow_chats: [],
      follow_users: [],
      require_mention: true,
    },
    observed_chats: [],
    warnings: [],
    last_gate: null,
  };
}

export function loadDispatcherAccess(dispatcherId: string): DispatcherAccessState {
  const path = dispatcherAccessPath(dispatcherId);
  if (!existsSync(path)) return defaultDispatcherAccessState();
  const raw = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`dispatcher access parse error in ${path}: ${msg}`);
  }
  return readDispatcherAccess(parsed, path);
}

export function saveDispatcherAccess(
  dispatcherId: string,
  access: DispatcherAccessState,
): void {
  const path = dispatcherAccessPath(dispatcherId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(access, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
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
  if (isBotSenderType(input.senderType)) {
    return drop(`bot sender type: ${input.senderType}`);
  }

  if (input.chatType === 'p2p') {
    if (!access.dm.allow_users.includes(input.senderId)) {
      return drop('direct sender not allowed');
    }
    return deliver(access, input, now);
  }

  if (input.chatType !== 'group') {
    return drop(`unsupported chat type: ${input.chatType}`);
  }

  if (access.group.allow_chats.length > 0 &&
    !access.group.allow_chats.includes(input.chatId)) {
    return drop('group chat not allowed');
  }
  if (access.group.follow_users.length > 0 &&
    !access.group.follow_users.includes(input.senderId)) {
    return drop('sender not allowed by follow-user gate');
  }
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

  return {
    version: 1,
    dm: {
      allow_users: readStringArray(dm, 'allow_users', defaults.dm.allow_users, path),
    },
    group: {
      allow_chats: readStringArray(
        group,
        'allow_chats',
        defaults.group.allow_chats,
        path,
      ),
      follow_users: readStringArray(
        group,
        'follow_users',
        defaults.group.follow_users,
        path,
      ),
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
