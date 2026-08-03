/**
 * Feishu access gate v3 — pairing-token model.
 *
 * Pure-function unit tests for `dreamuxFeishuGate`, the pairing helper
 * primitives, and the IO loader/saver fail-loud contract.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  ACCESS_STATE_VERSION,
  PAIRING_TOKEN_BYTES,
  MAX_PENDING_PER_KIND,
  PAIRING_TTL_MS,
  TRUST_DOMAIN_WARNING,
  defaultDispatcherAccessState,
  dreamuxFeishuGate,
  generatePairingToken,
  generateUniquePairingToken,
  loadDispatcherAccess,
  readDispatcherAccess,
  saveDispatcherAccess,
  type DispatcherAccessState,
  type DispatcherAccessStateV3,
  type DmPolicy,
  type GateInbound,
  type GroupPolicy,
  type PendingPairingEntry,
} from '../src/feishu-gate.js';

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const SENDER_KNOWN = 'sender-known';
const SENDER_STRANGER = 'sender-stranger';
const CHAT_ALLOWED = 'chat-allowed';
const CHAT_STRANGER = 'chat-stranger';
const DM_RESEND_TOKEN = generatePairingToken();
const GROUP_RESEND_TOKEN = generatePairingToken();

function state(
  overrides: Partial<DispatcherAccessStateV3> = {},
): DispatcherAccessStateV3 {
  const base = defaultDispatcherAccessState();
  return {
    ...base,
    ...overrides,
    group: { ...base.group, ...(overrides.group ?? {}) },
  };
}

function gate(
  input: Partial<GateInbound>,
  access: DispatcherAccessStateV3 = state(),
  now: number = NOW,
) {
  const fullInput: GateInbound = {
    chat_type: 'group',
    sender_id: SENDER_KNOWN,
    chat_id: CHAT_ALLOWED,
    is_bot_sender: false,
    trusted_bot: false,
    bot_mentioned: true,
    ...input,
  };
  return dreamuxFeishuGate(access, fullInput, now);
}

function makePendingEntry(
  kind: 'dm' | 'group',
  idx: number,
  now: number,
  expired = false,
): PendingPairingEntry {
  const ttl = expired ? -1000 : PAIRING_TTL_MS;
  const id = String(1000 + idx);
  return {
    kind,
    sender_id: kind === 'dm' ? `u-${id}` : SENDER_STRANGER,
    chat_id: kind === 'group' ? `c-${id}` : `dm-${id}`,
    created_at: now,
    expires_at: now + ttl,
    replies: 1,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// A. Branch table — every distinct gate decision
// ──────────────────────────────────────────────────────────────────────────

type TableCase = {
  name: string;
  input: Partial<GateInbound>;
  statePatch?: Partial<DispatcherAccessStateV3>;
  expect: {
    action: 'deliver' | 'drop' | 'pair';
    reason?: string;
    isResend?: boolean;
    kind?: 'dm' | 'group';
  };
};

const BRANCH_CASES: TableCase[] = [
  // ── DM ────────────────────────────────────────────────────────────────
  {
    name: 'DM / disabled → drop dm_disabled',
    input: { chat_type: 'p2p', sender_id: SENDER_STRANGER },
    statePatch: { dm_policy: 'disabled' as DmPolicy },
    expect: { action: 'drop', reason: 'dm_disabled' },
  },
  {
    name: 'DM / allowlist + stranger → drop dm_not_on_allowlist',
    input: { chat_type: 'p2p', sender_id: SENDER_STRANGER },
    statePatch: { dm_policy: 'allowlist' as DmPolicy, allow_users: [SENDER_KNOWN] },
    expect: { action: 'drop', reason: 'dm_not_on_allowlist' },
  },
  {
    name: 'DM / allowlist + known user → deliver',
    input: { chat_type: 'p2p', sender_id: SENDER_KNOWN },
    statePatch: { dm_policy: 'allowlist' as DmPolicy, allow_users: [SENDER_KNOWN] },
    expect: { action: 'deliver' },
  },
  {
    name: 'DM / pairing + stranger → pair (new slot)',
    input: { chat_type: 'p2p', sender_id: SENDER_STRANGER },
    statePatch: { dm_policy: 'pairing' as DmPolicy },
    expect: { action: 'pair', kind: 'dm', isResend: false },
  },
  {
    name: 'DM / pairing + known user → deliver (short-circuit allowlist)',
    input: { chat_type: 'p2p', sender_id: SENDER_KNOWN },
    statePatch: { dm_policy: 'pairing' as DmPolicy, allow_users: [SENDER_KNOWN] },
    expect: { action: 'deliver' },
  },
  {
    name: 'DM / pairing + already paired (same sender, not expired) → pair + is_resend',
    input: { chat_type: 'p2p', sender_id: SENDER_STRANGER },
    statePatch: {
      dm_policy: 'pairing' as DmPolicy,
      pending: {
        [DM_RESEND_TOKEN]: {
          kind: 'dm',
          sender_id: SENDER_STRANGER,
          chat_id: 'dm-self',
          created_at: NOW,
          expires_at: NOW + PAIRING_TTL_MS,
          replies: 1,
        },
      },
    },
    expect: { action: 'pair', kind: 'dm', isResend: true },
  },
  {
    name: 'DM / all → deliver',
    input: { chat_type: 'p2p', sender_id: 'anyone' },
    statePatch: { dm_policy: 'all' as DmPolicy },
    expect: { action: 'deliver' },
  },
  {
    name: 'DM / bot sender (is_bot_sender) → drop bot_untrusted',
    input: { chat_type: 'p2p', sender_id: 'peer-bot', is_bot_sender: true },
    statePatch: { dm_policy: 'all' as DmPolicy },
    expect: { action: 'drop', reason: 'bot_untrusted' },
  },

  // ── GROUP: require_mention ────────────────────────────────────────────
  {
    name: 'GROUP / require_mention + not mentioned → drop group_bot_not_mentioned',
    input: { chat_type: 'group', bot_mentioned: false },
    statePatch: {
      group: { policy: 'follow-user', allow_chats: [CHAT_ALLOWED], require_mention: true },
      allow_users: [SENDER_KNOWN],
    },
    expect: { action: 'drop', reason: 'group_bot_not_mentioned' },
  },
  {
    name: 'GROUP / require_mention=false + not mentioned + follow-user + allowed sender → deliver',
    input: { chat_type: 'group', bot_mentioned: false, sender_id: SENDER_KNOWN },
    statePatch: {
      group: { policy: 'follow-user', allow_chats: [], require_mention: false },
      allow_users: [SENDER_KNOWN],
    },
    expect: { action: 'deliver' },
  },

  // ── GROUP: block ──────────────────────────────────────────────────────
  {
    name: 'GROUP / block → drop group_policy_block',
    input: { chat_type: 'group', bot_mentioned: true },
    statePatch: {
      group: { policy: 'block' as GroupPolicy, allow_chats: [CHAT_ALLOWED], require_mention: false },
      allow_users: [SENDER_KNOWN],
    },
    expect: { action: 'drop', reason: 'group_policy_block' },
  },

  // ── GROUP: allowlist ──────────────────────────────────────────────────
  //
  // allowlist trusts listed groups as the human authorization unit. Unlisted
  // groups drop; listed groups bypass dm_policy and allow_users after mention.
  {
    name: 'GROUP / allowlist + trusted chat + known sender → deliver',
    input: { chat_type: 'group', chat_id: CHAT_ALLOWED, sender_id: SENDER_KNOWN, bot_mentioned: true },
    statePatch: {
      group: { policy: 'allowlist', allow_chats: [CHAT_ALLOWED], require_mention: true },
      allow_users: [SENDER_KNOWN],
    },
    expect: { action: 'deliver' },
  },
  {
    name: 'GROUP / allowlist + trusted chat + stranger + mentioned → deliver without pairing',
    input: { chat_type: 'group', chat_id: CHAT_ALLOWED, sender_id: SENDER_STRANGER, bot_mentioned: true },
    statePatch: {
      group: { policy: 'allowlist', allow_chats: [CHAT_ALLOWED], require_mention: true },
    },
    expect: { action: 'deliver' },
  },
  {
    name: 'GROUP / allowlist + non-allowlisted chat + not mentioned → drop rule1',
    input: { chat_type: 'group', chat_id: CHAT_STRANGER, bot_mentioned: false },
    statePatch: {
      group: { policy: 'allowlist', allow_chats: [CHAT_ALLOWED], require_mention: false },
    },
    expect: { action: 'drop', reason: 'group_not_on_allowlist' },
  },
  {
    name: 'GROUP / allowlist + non-allowlisted chat + mentioned → drop rule1 (no group-kind pairing anymore)',
    input: { chat_type: 'group', chat_id: CHAT_STRANGER, sender_id: SENDER_STRANGER, bot_mentioned: true },
    statePatch: {
      group: { policy: 'allowlist', allow_chats: [CHAT_ALLOWED], require_mention: true },
      // Even if the sender IS on allow_users, an untrusted chat is blocked.
      allow_users: [SENDER_STRANGER],
    },
    expect: { action: 'drop', reason: 'group_not_on_allowlist' },
  },

  // ── GROUP: follow-user ────────────────────────────────────────────────
  //
  // follow-user = trusted chat OR the existing dm_policy sender path.
  {
    name: 'GROUP / follow-user + known sender (allow_users) → deliver',
    input: { chat_type: 'group', sender_id: SENDER_KNOWN, bot_mentioned: true, chat_id: CHAT_STRANGER },
    statePatch: {
      group: { policy: 'follow-user', allow_chats: [], require_mention: true },
      allow_users: [SENDER_KNOWN],
    },
    expect: { action: 'deliver' },
  },
  {
    name: 'GROUP / follow-user + trusted chat + stranger → deliver without pairing',
    input: { chat_type: 'group', sender_id: SENDER_STRANGER, bot_mentioned: true },
    statePatch: {
      group: { policy: 'follow-user', allow_chats: [CHAT_ALLOWED], require_mention: true },
      allow_users: [],
    },
    expect: { action: 'deliver' },
  },
  {
    name: 'GROUP / follow-user + stranger + not mentioned → drop dm=pairing no mention',
    input: { chat_type: 'group', sender_id: SENDER_STRANGER, bot_mentioned: false },
    statePatch: {
      group: { policy: 'follow-user', allow_chats: [], require_mention: false },
    },
    expect: { action: 'drop', reason: 'group_pairing_stranger_not_mentioned' },
  },
  {
    name: 'GROUP / follow-user + stranger + mentioned → pair dm-kind (陌生人@bot → 个人授权请求)',
    input: { chat_type: 'group', sender_id: SENDER_STRANGER, bot_mentioned: true, chat_id: CHAT_STRANGER },
    statePatch: {
      group: { policy: 'follow-user', allow_chats: [], require_mention: true },
    },
    expect: { action: 'pair', kind: 'dm', isResend: false },
  },

  // ── GROUP: trusted bot ────────────────────────────────────────────────
  {
    name: 'GROUP / trusted bot sender + mentioned → deliver',
    input: { chat_type: 'group', sender_id: 'peer-bot', is_bot_sender: true, trusted_bot: true, bot_mentioned: true },
    statePatch: {
      group: { policy: 'follow-user', allow_chats: [], require_mention: true },
    },
    expect: { action: 'deliver' },
  },
  {
    name: 'GROUP / trusted bot sender + NOT mentioned → drop',
    input: { chat_type: 'group', sender_id: 'peer-bot', is_bot_sender: true, trusted_bot: true, bot_mentioned: false },
    statePatch: {
      group: { policy: 'follow-user', allow_chats: [], require_mention: false },
    },
    expect: { action: 'drop', reason: 'group_bot_not_mentioned' },
  },
  {
    name: 'GROUP / untrusted bot sender → drop bot_untrusted',
    input: { chat_type: 'group', sender_id: 'unknown-bot', is_bot_sender: true, trusted_bot: false, bot_mentioned: true },
    statePatch: {
      group: { policy: 'follow-user', allow_chats: [], require_mention: false },
    },
    expect: { action: 'drop', reason: 'bot_untrusted' },
  },

  // ── GROUP: already pending (resend) ───────────────────────────────────
  //
  // In-group pairing is dm-kind (C3 rewrite): the dedupe key is SENDER_ID,
  // not chat_id. A second user in the same group does NOT reuse the first
  // user's pending token (that was the old group-kind behavior). A repeat
  // @-mention by the SAME user DOES resend their existing dm-kind token.
  {
    name: 'GROUP / follow-user + stranger + already pending same sender → pair resend dm-kind',
    input: { chat_type: 'group', sender_id: SENDER_STRANGER, chat_id: CHAT_STRANGER, bot_mentioned: true },
    statePatch: {
      group: { policy: 'follow-user', allow_chats: [], require_mention: true },
      pending: {
        [GROUP_RESEND_TOKEN]: {
          kind: 'dm',
          sender_id: SENDER_STRANGER,
          chat_id: CHAT_STRANGER,
          created_at: NOW,
          expires_at: NOW + PAIRING_TTL_MS,
          replies: 1,
        },
      },
    },
    expect: { action: 'pair', kind: 'dm', isResend: true },
  },

  // ── Quota / matrix edge cases ─────────────────────────────────────────
  {
    name: 'DM / pairing + stranger + same-sender expired → pair with FRESH token (TTL guard)',
    input: { chat_type: 'p2p', sender_id: SENDER_STRANGER },
    statePatch: {
      dm_policy: 'pairing' as DmPolicy,
      pending: {
        oldtoken: {
          kind: 'dm',
          sender_id: SENDER_STRANGER,
          chat_id: 'dm-x',
          created_at: NOW - PAIRING_TTL_MS - 1000,
          expires_at: NOW - 1,
          replies: 1,
        },
      },
    },
    expect: { action: 'pair', kind: 'dm', isResend: false },
  },
  {
    name: 'DM / pairing + stranger + 10 non-expired DM pending → drop dm_pairing_slot_cap',
    input: { chat_type: 'p2p', sender_id: SENDER_STRANGER },
    statePatch: (() => {
      const pending: Record<string, PendingPairingEntry> = {};
      for (let i = 0; i < MAX_PENDING_PER_KIND; i++) {
        pending[`d${i}`] = {
          kind: 'dm',
          sender_id: `u-${i}`,
          chat_id: `dm-${i}`,
          created_at: NOW,
          expires_at: NOW + PAIRING_TTL_MS,
          replies: 1,
        };
      }
      return { dm_policy: 'pairing' as DmPolicy, pending };
    })(),
    expect: { action: 'drop', reason: 'dm_pairing_slot_cap' },
  },
  {
    name: 'GROUP / follow-user + 10 DM pending full (10 不同陌生人各占一槽) → next new stranger drops dm_pairing_slot_cap',
    input: { chat_type: 'group', sender_id: SENDER_STRANGER, chat_id: CHAT_STRANGER, bot_mentioned: true },
    statePatch: (() => {
      const pending: Record<string, PendingPairingEntry> = {};
      for (let i = 0; i < MAX_PENDING_PER_KIND; i++) {
        pending[`d-g${i}`] = {
          kind: 'dm',
          sender_id: `u-${i}`,
          chat_id: `c-${i}`,
          created_at: NOW,
          expires_at: NOW + PAIRING_TTL_MS,
          replies: 1,
        };
      }
      return {
        group: { policy: 'follow-user', allow_chats: [], require_mention: true },
        pending,
      };
    })(),
    expect: { action: 'drop', reason: 'dm_pairing_slot_cap' },
  },
];

describe('A. Branch table — every distinct gate decision', () => {
  for (const tc of BRANCH_CASES) {
    it(tc.name, () => {
      const access = state(tc.statePatch ?? {});
      const result = gate(tc.input, access, NOW);

      expect(result.action.action).toBe(tc.expect.action);

      if (tc.expect.action === 'drop') {
        expect(result.action).toMatchObject({
          action: 'drop',
          reason: tc.expect.reason,
        });
      }
      if (tc.expect.action === 'pair') {
        expect(result.action).toMatchObject({
          action: 'pair',
          kind: tc.expect.kind,
          is_resend: !!tc.expect.isResend,
        });
        const act = result.action;
        if (act.action === 'pair') {
          expect(act.token.length).toBe(PAIRING_TOKEN_BYTES * 2);
          expect(/^[0-9a-f]{6}$/.test(act.token)).toBe(true);
          expect(act.ttl_left_ms).toBeGreaterThan(0);
        }
      }

      // last_gate invariant
      expect(result.nextState.last_gate.at).toBe(NOW);
      expect(result.nextState.last_gate.sender_id).toBe(
        (tc.input.sender_id ?? SENDER_KNOWN) as string,
      );
      expect(result.nextState.last_gate.chat_id).toBe(
        (tc.input.chat_id ?? CHAT_ALLOWED) as string,
      );
    });
  }
});

describe('A2. trusted allow_chats truth table', () => {
  for (const policy of ['allowlist', 'follow-user'] as const) {
    for (const dmPolicy of ['disabled', 'all', 'allowlist', 'pairing'] as const) {
      it(`${policy} trusted chat delivers an exact human under dm_policy=${dmPolicy}`, () => {
        const access = state({
          dm_policy: dmPolicy,
          group: { policy, allow_chats: [CHAT_ALLOWED], require_mention: true },
          allow_users: [],
        });
        const result = gate({ sender_id: SENDER_STRANGER }, access);
        expect(result.action).toEqual({ action: 'deliver' });
        expect(result.nextState.pending).toEqual({});
      });
    }
  }

  for (const policy of ['allowlist', 'follow-user'] as const) {
    it(`${policy} trusted chat still obeys require_mention=true`, () => {
      const access = state({
        dm_policy: 'disabled',
        group: { policy, allow_chats: [CHAT_ALLOWED], require_mention: true },
      });
      expect(gate({ bot_mentioned: false }, access).action).toMatchObject({
        action: 'drop',
        reason: 'group_bot_not_mentioned',
      });
    });

    it(`${policy} trusted chat has no hidden mention gate when require_mention=false`, () => {
      const access = state({
        dm_policy: 'disabled',
        group: { policy, allow_chats: [CHAT_ALLOWED], require_mention: false },
      });
      expect(gate({ bot_mentioned: false }, access).action).toEqual({ action: 'deliver' });
    });
  }

  for (const requireMention of [false, true]) {
    it(`block drops a trusted human when require_mention=${requireMention}`, () => {
      const access = state({
        dm_policy: 'all',
        group: {
          policy: 'block',
          allow_chats: [CHAT_ALLOWED],
          require_mention: requireMention,
        },
      });
      const result = gate({ bot_mentioned: true }, access);
      expect(result.action).toMatchObject({
        action: 'drop',
        reason: 'group_policy_block',
      });
    });
  }

  it('an untrusted follow-user chat retains the existing sender path', () => {
    const base = {
      group: { policy: 'follow-user' as const, allow_chats: [], require_mention: false },
      allow_users: [] as string[],
    };
    expect(gate({ chat_id: CHAT_STRANGER }, state({ ...base, dm_policy: 'disabled' })).action)
      .toMatchObject({ action: 'drop', reason: 'dm_disabled' });
    expect(gate({ chat_id: CHAT_STRANGER }, state({ ...base, dm_policy: 'all' })).action)
      .toEqual({ action: 'deliver' });
    expect(gate({ chat_id: CHAT_STRANGER }, state({ ...base, dm_policy: 'allowlist' })).action)
      .toMatchObject({ action: 'drop', reason: 'group_user_not_on_allowlist' });
    expect(gate(
      { chat_id: CHAT_STRANGER, bot_mentioned: true },
      state({ ...base, dm_policy: 'pairing' }),
    ).action).toMatchObject({ action: 'pair', kind: 'dm' });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// B. TTL double-guard
// ──────────────────────────────────────────────────────────────────────────

describe('B. TTL double-guard', () => {
  it('expired pending entry is NOT counted as existing — fresh token generated', () => {
    const expired: PendingPairingEntry = {
      kind: 'dm',
      sender_id: SENDER_STRANGER,
      chat_id: 'dm-self',
      created_at: NOW - PAIRING_TTL_MS - 1000,
      expires_at: NOW - 1,
      replies: 1,
    };
    const access = state({
      dm_policy: 'pairing',
      pending: { deadtoken: expired },
    });
    const result = gate({ chat_type: 'p2p', sender_id: SENDER_STRANGER }, access, NOW);
    expect(result.action.action).toBe('pair');
    if (result.action.action !== 'pair') throw new Error('unreachable');
    expect(result.action.is_resend).toBe(false);
    expect(result.action.token).not.toBe('deadtoken');
    // Pruned entry should no longer be present
    expect(result.nextState.pending.deadtoken).toBeUndefined();
    // The new live entry is present under a different key
    const newToken = result.action.token;
    expect(result.nextState.pending[newToken]).toBeDefined();
    expect(result.nextState.pending[newToken].expires_at).toBe(NOW + PAIRING_TTL_MS);
  });

  it('non-expired pending is counted as existing (resend with same token — dm-kind)', () => {
    // C3 rewrite: group-triggered pair requests create dm-kind entries. The
    // dedupe key is sender_id (not chat_id). So we seed a dm-kind pending
    // entry for the SAME sender that triggers the repeat @-mention.
    const live: PendingPairingEntry = {
      kind: 'dm',
      sender_id: SENDER_STRANGER,
      chat_id: CHAT_STRANGER,
      created_at: NOW - 1000,
      expires_at: NOW + PAIRING_TTL_MS - 1000,
      replies: 1,
    };
    const access = state({
      group: { policy: 'follow-user', allow_chats: [], require_mention: true },
      pending: { livetoken: live },
    });
    const result = gate(
      { chat_type: 'group', chat_id: CHAT_STRANGER, sender_id: SENDER_STRANGER, bot_mentioned: true },
      access,
      NOW,
    );
    expect(result.action.action).toBe('pair');
    if (result.action.action !== 'pair') throw new Error('unreachable');
    expect(result.action.is_resend).toBe(true);
    expect(result.action.token).toBe('livetoken');
    expect(result.action.prompt_message_id).toBeUndefined();
    // TTL refreshed from the user's pov
    expect(result.nextState.pending.livetoken.expires_at).toBe(NOW + PAIRING_TTL_MS);
    expect(result.nextState.pending.livetoken.replies).toBe(1);
  });

  it('pruneExpiredPending (via gate) removes only expired entries and preserves live ones', () => {
    const live: PendingPairingEntry = {
      kind: 'dm',
      sender_id: 'u-live',
      chat_id: 'dm-live',
      created_at: NOW,
      expires_at: NOW + 1000,
      replies: 1,
    };
    const dead: PendingPairingEntry = {
      kind: 'dm',
      sender_id: 'u-dead',
      chat_id: 'dm-dead',
      created_at: NOW - 10_000,
      expires_at: NOW - 1,
      replies: 1,
    };
    const dead2: PendingPairingEntry = {
      kind: 'group',
      sender_id: 'x',
      chat_id: 'c-dead',
      created_at: NOW - 10_000,
      expires_at: 0,
      replies: 1,
    };
    const access = state({
      dm_policy: 'all',
      pending: { LIVE: live, DEAD: dead, DEAD2: dead2 },
    });
    const result = gate({ chat_type: 'p2p', sender_id: 'anyone' }, access, NOW);
    expect(result.action.action).toBe('deliver');
    expect(Object.keys(result.nextState.pending)).toEqual(['LIVE']);
    expect(result.nextState.pending.LIVE).toEqual(live);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// C. Per-kind pending quota
// ──────────────────────────────────────────────────────────────────────────

describe('C. Per-kind pending quota (MAX_PENDING_PER_KIND = 10)', () => {
  it('fill 10 DM pending → next DM pair request drops dm_pairing_slot_cap', () => {
    const pending: Record<string, PendingPairingEntry> = {};
    for (let i = 0; i < MAX_PENDING_PER_KIND; i++) {
      pending[`d${i}`] = makePendingEntry('dm', i, NOW);
    }
    const access = state({ dm_policy: 'pairing', pending });
    const result = gate({ chat_type: 'p2p', sender_id: 'new-stranger' }, access, NOW);
    expect(result.action).toEqual({
      action: 'drop',
      reason: 'dm_pairing_slot_cap',
      context: { pending: MAX_PENDING_PER_KIND, max: MAX_PENDING_PER_KIND },
    });
  });

  it('10 DM pending ALSO blocks in-group pair request (shared dm-kind counter after C3 rewrite)', () => {
    const pending: Record<string, PendingPairingEntry> = {};
    for (let i = 0; i < MAX_PENDING_PER_KIND; i++) {
      pending[`d${i}`] = makePendingEntry('dm', i, NOW);
    }
    const access = state({
      group: { policy: 'follow-user', allow_chats: [], require_mention: true },
      pending,
    });
    const result = gate(
      { chat_type: 'group', sender_id: SENDER_STRANGER, chat_id: CHAT_STRANGER, bot_mentioned: true },
      access,
      NOW,
    );
    // Group-triggered pair requests now generate dm-kind entries → they share
    // the dm counter with DM-triggered entries. 10 full → drop.
    expect(result.action).toEqual({
      action: 'drop',
      reason: 'dm_pairing_slot_cap',
      context: { pending: MAX_PENDING_PER_KIND, max: MAX_PENDING_PER_KIND },
    });
  });

  it('fill 10 dm-kind pending (mixed DM + group sources) → next new stranger in group drops dm_pairing_slot_cap', () => {
    const pending: Record<string, PendingPairingEntry> = {};
    for (let i = 0; i < MAX_PENDING_PER_KIND; i++) {
      pending[`mix${i}`] = makePendingEntry('dm', i, NOW);
    }
    const access = state({
      group: { policy: 'follow-user', allow_chats: [], require_mention: true },
      pending,
    });
    const result = gate(
      { chat_type: 'group', sender_id: SENDER_STRANGER, chat_id: 'c-brand-new', bot_mentioned: true },
      access,
      NOW,
    );
    expect(result.action).toEqual({
      action: 'drop',
      reason: 'dm_pairing_slot_cap',
      context: { pending: MAX_PENDING_PER_KIND, max: MAX_PENDING_PER_KIND },
    });
  });

  it('LEGACY group-kind pending entries (pre-C3) do NOT block DM pair request', () => {
    // After the C3 rewrite no token generates group-kind entries any more,
    // but legacy ones sitting on disk still parse. Their kind is 'group' so
    // they don't count toward the dm-kind quota.
    const pending: Record<string, PendingPairingEntry> = {};
    for (let i = 0; i < MAX_PENDING_PER_KIND; i++) {
      pending[`g${i}`] = makePendingEntry('group', i, NOW);
    }
    const access = state({ dm_policy: 'pairing', pending });
    const result = gate({ chat_type: 'p2p', sender_id: 'new-stranger' }, access, NOW);
    expect(result.action.action).toBe('pair');
    if (result.action.action !== 'pair') throw new Error('unreachable');
    expect(result.action.kind).toBe('dm');
  });

  it('expired entries do NOT count toward quota — new slot succeeds', () => {
    // Fill with all expired entries
    const pending: Record<string, PendingPairingEntry> = {};
    for (let i = 0; i < MAX_PENDING_PER_KIND + 5; i++) {
      pending[`x${i}`] = makePendingEntry('dm', i, NOW, true);
    }
    const access = state({ dm_policy: 'pairing', pending });
    const result = gate({ chat_type: 'p2p', sender_id: 'new-stranger' }, access, NOW);
    // All expired → pruned → quota free → new pair slot
    expect(result.action.action).toBe('pair');
    if (result.action.action !== 'pair') throw new Error('unreachable');
    expect(result.action.is_resend).toBe(false);
    // None of the expired entries should remain
    for (const k of Object.keys(pending)) {
      expect(result.nextState.pending[k]).toBeUndefined();
    }
  });

  it('existing pending returns the same token even when the legacy replies count is high', () => {
    const exhausted: PendingPairingEntry = {
      kind: 'dm',
      sender_id: 'u-maxed',
      chat_id: 'c-any',
      created_at: NOW - 1000,
      expires_at: NOW + PAIRING_TTL_MS,
      replies: 999,
      prompt_message_id: 'om_prompt',
    };
    const access = state({
      group: { policy: 'follow-user', allow_chats: [], require_mention: true },
      pending: { EXHAUST: exhausted },
    });
    // Same sender (dm-kind dedupe key is sender_id) → hits the exhausted slot.
    const result = gate(
      { chat_type: 'group', sender_id: 'u-maxed', chat_id: 'c-any', bot_mentioned: true },
      access,
      NOW,
    );
    expect(result.action).toMatchObject({
      action: 'pair',
      token: 'EXHAUST',
      is_resend: true,
      prompt_message_id: 'om_prompt',
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// D. v3 loader contract (shape fail-loud, policy string validation is shallow)
// ──────────────────────────────────────────────────────────────────────────

describe('D. v3 loader contract', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'dreamux-access-'));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  function writeRaw(raw: unknown): void {
    const path = join(stateDir, 'access.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(raw), 'utf8');
  }

  it('missing access.json → returns default v3 state', async () => {
    const loaded = await loadDispatcherAccess(stateDir);
    expect(loaded).toEqual(defaultDispatcherAccessState());
    expect(loaded.version).toBe(ACCESS_STATE_VERSION);
    expect(loaded.version).toBe(3);
    expect(loaded.dm_policy).toBe('pairing');
    expect(loaded.group.policy).toBe('follow-user');
    expect(loaded.allow_users).toEqual([]);
    expect(loaded.group.require_mention).toBe(true);
  });

  it('v2 file → throws error mentioning version 3 and migration guidance', async () => {
    writeRaw({
      version: 2,
      allow_users: ['user-a'],
      group: { policy: 'follow-user', allow_chats: [], require_mention: true },
    });
    await expect(loadDispatcherAccess(stateDir)).rejects.toThrow(/v3/);
    await expect(loadDispatcherAccess(stateDir)).rejects.toThrow(/migration|CHANGELOG|access\.json/i);
  });

  it('v1 file → throws error mentioning v3', async () => {
    writeRaw({ version: 1, dm: { allow_users: ['u'] } });
    await expect(loadDispatcherAccess(stateDir)).rejects.toThrow(/v3/);
  });

  it('missing version field → throws error mentioning v3 shape', async () => {
    writeRaw({ allow_users: ['u'] });
    await expect(loadDispatcherAccess(stateDir)).rejects.toThrow(/v3/);
  });

  it('malformed JSON → throws mentioning v3 / access.json', async () => {
    const path = join(stateDir, 'access.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{not json', 'utf8');
    await expect(loadDispatcherAccess(stateDir)).rejects.toThrow(/access\.json/);
  });

  it('shallow-loads a typo group policy but the gate fails closed before trusted delivery', async () => {
    const secureDefault = defaultDispatcherAccessState();
    writeRaw({
      ...secureDefault,
      dm_policy: 'disabled',
      group: {
        ...secureDefault.group,
        policy: 'follow_user',
        allow_chats: [CHAT_ALLOWED],
      },
    });

    // The current V3 reader deliberately validates this field only as a string.
    const loaded = await loadDispatcherAccess(stateDir);
    expect((loaded.group as { policy: string }).policy).toBe('follow_user');

    const result = gate(
      {
        chat_type: 'group',
        chat_id: CHAT_ALLOWED,
        sender_id: SENDER_STRANGER,
        bot_mentioned: true,
      },
      loaded,
    );
    expect(result.action).toEqual({ action: 'drop', reason: 'internal' });
  });

  it('save → load round-trips v3 state with 0600 file mode', async () => {
    const s = state({
      dm_policy: 'allowlist',
      allow_users: ['u-1'],
      group: { policy: 'allowlist', allow_chats: ['c-1'], require_mention: false },
    });
    await saveDispatcherAccess(stateDir, s);
    const path = join(stateDir, 'access.json');
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const loaded = await readDispatcherAccess(stateDir);
    expect(loaded).toEqual(s);
    // JSON on disk has the v3 version literal
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    expect(raw.version).toBe(ACCESS_STATE_VERSION);
  });

  it('save rejects non-v3 shape', async () => {
    const bad = { ...defaultDispatcherAccessState(), version: 2 as const };
    await expect(
      saveDispatcherAccess(stateDir, bad as unknown as DispatcherAccessStateV3),
    ).rejects.toThrow(/non-v3|refusing/i);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// E. require_mention default
// ──────────────────────────────────────────────────────────────────────────

describe('E. require_mention default', () => {
  it('defaultDispatcherAccessState().group.require_mention === true', () => {
    expect(defaultDispatcherAccessState().group.require_mention).toBe(true);
  });

  it('default state + human group + no mention → drop group_bot_not_mentioned', () => {
    const access = defaultDispatcherAccessState();
    expect(access.group.require_mention).toBe(true);
    const result = gate(
      { chat_type: 'group', sender_id: SENDER_STRANGER, bot_mentioned: false },
      access,
      NOW,
    );
    expect(result.action).toMatchObject({
      action: 'drop',
      reason: 'group_bot_not_mentioned',
    });
  });

  it('require_mention=false + known sender + no mention → proceeds (deliver)', () => {
    // With allow_users, require_mention=false + no mention → deliver
    const access = state({
      group: { policy: 'follow-user', allow_chats: [], require_mention: false },
      allow_users: [SENDER_KNOWN],
    });
    const r = gate(
      { chat_type: 'group', sender_id: SENDER_KNOWN, bot_mentioned: false, chat_id: CHAT_STRANGER },
      access,
      NOW,
    );
    expect(r.action.action).toBe('deliver');
  });

  it('require_mention=false + allowlist untrusted chat → group allowlist drop', () => {
    const access = state({
      group: { policy: 'allowlist', allow_chats: [], require_mention: false },
    });
    const result = gate(
      { chat_type: 'group', sender_id: SENDER_STRANGER, bot_mentioned: false, chat_id: CHAT_STRANGER },
      access,
      NOW,
    );
    expect(result.action).toMatchObject({
      action: 'drop',
      reason: 'group_not_on_allowlist',
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// F. Misc
// ──────────────────────────────────────────────────────────────────────────

describe('F. Misc constants and helpers', () => {
  describe('generatePairingToken', () => {
    it('returns 6-char hex string (PAIRING_TOKEN_BYTES bytes = 2*len chars)', () => {
      // Random, so try several times
      for (let i = 0; i < 20; i++) {
        const token = generatePairingToken();
        expect(typeof token).toBe('string');
        expect(token).toHaveLength(PAIRING_TOKEN_BYTES * 2);
        expect(/^[0-9a-fA-F]{6}$/.test(token)).toBe(true);
      }
    });

    it('generateUniquePairingToken avoids existing keys', () => {
      const existing: Record<string, boolean> = {};
      for (let i = 0; i < 100; i++) {
        const token = generateUniquePairingToken(existing);
        expect(existing[token]).toBeUndefined();
        expect(/^[0-9a-fA-F]{6}$/.test(token)).toBe(true);
        existing[token] = true;
      }
    });
  });

  describe('pushWarn — FIFO cap at 200', () => {
    it('caps warnings at 200 entries, FIFO eviction of oldest', () => {
      // Drive the slot-cap drop path via dm-kind entries; it pushes a warning
      // per call while avoiding the same-sender existing-prompt branch.
      let access: DispatcherAccessStateV3 = state({
        group: { policy: 'follow-user', allow_chats: [], require_mention: true },
      });
      const MAX_WARN = 200;
      const iterations = MAX_WARN + 50;
      for (let i = 0; i < iterations; i++) {
        const senderId = `u-warn-${i}`;
        const pending: Record<string, PendingPairingEntry> = {};
        for (let j = 0; j < MAX_PENDING_PER_KIND; j++) {
          pending[`dm${i}-${j}`] = {
            kind: 'dm',
            sender_id: `u-existing-${i}-${j}`,
            chat_id: 'c-same-for-all',
            created_at: NOW,
            expires_at: NOW + PAIRING_TTL_MS,
            replies: 1,
          };
        }
        const seedAccess: DispatcherAccessStateV3 = {
          ...access,
          pending,
        };
        const r = gate(
          { chat_type: 'group', sender_id: senderId, chat_id: 'c-same-for-all', bot_mentioned: true },
          seedAccess,
          NOW + i,
        );
        expect(r.action).toMatchObject({ action: 'drop', reason: 'dm_pairing_slot_cap' });
        access = r.nextState;
      }
      expect(access.warnings.length).toBe(MAX_WARN);
      // Strict FIFO ordering: timestamps monotonically non-decreasing
      for (let i = 1; i < access.warnings.length; i++) {
        expect(access.warnings[i].at).toBeGreaterThanOrEqual(access.warnings[i - 1].at);
      }
      // Oldest kept warning should be the (iterations - MAX_WARN)-th one
      expect(access.warnings[0].at).toBe(NOW + (iterations - MAX_WARN));
      // Newest should be the last
      expect(access.warnings[MAX_WARN - 1].at).toBe(NOW + (iterations - 1));
    });
  });

  describe('TRUST_DOMAIN_WARNING', () => {
    it('is a non-empty string constant', () => {
      expect(typeof TRUST_DOMAIN_WARNING).toBe('string');
      expect(TRUST_DOMAIN_WARNING.length).toBeGreaterThan(0);
    });

    it('is emitted when dispatcher observes > 1 distinct chats, one-shot', () => {
      const start = state({
        allow_users: [SENDER_KNOWN],
        group: { policy: 'follow-user', allow_chats: [], require_mention: false },
      });
      const r1 = gate(
        { chat_type: 'group', sender_id: SENDER_KNOWN, chat_id: 'chat-a', bot_mentioned: false },
        start,
        NOW,
      );
      expect(r1.action.action).toBe('deliver');
      expect(r1.nextState.warnings.filter((w: DispatcherAccessStateV3['warnings'][number]) => w.msg === TRUST_DOMAIN_WARNING)).toEqual([]);
      expect(r1.nextState.observed_chats).toEqual(['chat-a']);

      const r2 = gate(
        { chat_type: 'group', sender_id: SENDER_KNOWN, chat_id: 'chat-b', bot_mentioned: false },
        r1.nextState,
        NOW + 1,
      );
      expect(r2.action.action).toBe('deliver');
      expect(r2.nextState.observed_chats).toEqual(['chat-a', 'chat-b']);
      expect(
        r2.nextState.warnings.some((w: DispatcherAccessStateV3['warnings'][number]) => w.msg === TRUST_DOMAIN_WARNING),
      ).toBe(true);

      // Third chat should NOT duplicate the one-shot warning
      const r3 = gate(
        { chat_type: 'group', sender_id: SENDER_KNOWN, chat_id: 'chat-c', bot_mentioned: false },
        r2.nextState,
        NOW + 2,
      );
      const trustWarnCount = r3.nextState.warnings.filter(
        (w: DispatcherAccessStateV3['warnings'][number]) => w.msg === TRUST_DOMAIN_WARNING,
      ).length;
      expect(trustWarnCount).toBe(1);
    });
  });

  describe('constant values', () => {
    it('ACCESS_STATE_VERSION is 3', () => {
      expect(ACCESS_STATE_VERSION).toBe(3);
    });
    it('PAIRING_TTL_MS is 1 hour in ms', () => {
      expect(PAIRING_TTL_MS).toBe(60 * 60 * 1000);
    });
    it('MAX_PENDING_PER_KIND is 10', () => {
      expect(MAX_PENDING_PER_KIND).toBe(10);
    });
    it('PAIRING_TOKEN_BYTES bytes → 6 hex chars total', () => {
      expect(PAIRING_TOKEN_BYTES * 2).toBe(6);
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Export compatibility check
// ──────────────────────────────────────────────────────────────────────────

describe('Export compatibility', () => {
  it('loadDispatcherAccess is an alias for readDispatcherAccess', () => {
    expect(loadDispatcherAccess).toBe(readDispatcherAccess);
  });

  it('DispatcherAccess type alias equals DispatcherAccessStateV3', () => {
    // Compile-time assertion — if this compiles, the aliases agree.
    const _v3: DispatcherAccessState = defaultDispatcherAccessState();
    const _also: DispatcherAccessStateV3 = _v3;
    expect(_also.version).toBe(3);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Invariant tests flagged by the boundary audit:
//   • saveDispatcherAccess writes mode 0600 (never world-readable).
//   • N concurrent saveDispatcherAccess calls under Promise.all never
//     clobber each other's writes into a torn file (tmpfile + rename
//     atomicity) AND each call's payload is fully preserved in the final
//     file (last-writer-wins semantics).
// ──────────────────────────────────────────────────────────────────────────

describe('Atomic write invariants (KB §§ Invariants 7–9)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'feishu-gate-atomic-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('saveDispatcherAccess writes the access file at mode 0o600', async () => {
    const dir = join(tmp, 'feishu');
    mkdirSync(dir, { mode: 0o700 });
    const file = join(dir, 'access.json');
    const s = defaultDispatcherAccessState();
    await saveDispatcherAccess(dir, s);
    expect(existsSync(file)).toBe(true);
    const mode = statSync(file).mode & 0o777;
    expect(mode.toString(8)).toBe('600');
  });

  it('concurrent saveDispatcherAccess (Promise.all) never produces a torn file', async () => {
    const dir = join(tmp, 'feishu');
    mkdirSync(dir, { mode: 0o700 });
    // Generate N distinct states, each identifiable by a unique allow_users[0]
    // open_id string. If atomic write is broken we'll either see a truncated
    // JSON (parse failure) or a file that doesn't match ONE of the N writes
    // (last-writer-wins should produce exactly one of them).
    const N = 50;
    const writers = Array.from({ length: N }, (_, i) => {
      const s: DispatcherAccessStateV3 = {
        ...defaultDispatcherAccessState(),
        allow_users: [`ou_${String(i).padStart(4, '0')}`],
      };
      return saveDispatcherAccess(dir, s).then(() => s);
    });
    await expect(Promise.all(writers)).resolves.toBeDefined();

    const reloaded = await readDispatcherAccess(dir);
    // The reloaded file must be a valid state (parse did not throw); its
    // allow_users[0] must match one of the writers' ids (last-writer-wins).
    expect(reloaded.allow_users).toHaveLength(1);
    const id = reloaded.allow_users[0];
    expect(id).toMatch(/^ou_\d{4}$/);
    // Additionally: every writer wrote a valid JSON, the final file is one
    // of them. Re-reading the file fresh confirms we don't have e.g. two
    // writes concatenated.
    const raw = JSON.parse(readFileSync(join(dir, 'access.json'), 'utf8'));
    expect(raw.allow_users).toEqual([id]);
    expect(raw.version).toBe(3);
  });
});
