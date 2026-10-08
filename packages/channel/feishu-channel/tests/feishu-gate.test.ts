/**
 * Feishu access gate v3 — pairing-token model.
 *
 * Pure-function unit tests for `dreamuxFeishuGate`, the pairing helper
 * primitives, and the IO loader/saver fail-loud contract.
 */

import { describe, expect, it } from 'vitest';
import {
  ACCESS_STATE_VERSION,
  PAIRING_TOKEN_BYTES,
  MAX_PENDING,
  PAIRING_TTL_MS,
  defaultDispatcherAccessState,
  type DispatcherAccessState,
  type DispatcherAccessStateV3,
  type DmPolicy,
  type GroupPolicy,
  type PendingPairingEntry,
} from '../src/access/state.js';
import {
  dreamuxFeishuGate,
  generatePairingToken,
  generateUniquePairingToken,
  type GateInbound,
} from '../src/access/gate.js';

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
    sender_id: kind === 'dm' ? `u-${id}` : SENDER_STRANGER,
    chat_id: kind === 'group' ? `c-${id}` : `dm-${id}`,
    created_at: now,
    expires_at: now + ttl,
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
    statePatch: {
      dm_policy: 'allowlist' as DmPolicy,
      allow_users: [SENDER_KNOWN],
    },
    expect: { action: 'drop', reason: 'dm_not_on_allowlist' },
  },
  {
    name: 'DM / allowlist + known user → deliver',
    input: { chat_type: 'p2p', sender_id: SENDER_KNOWN },
    statePatch: {
      dm_policy: 'allowlist' as DmPolicy,
      allow_users: [SENDER_KNOWN],
    },
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
    statePatch: {
      dm_policy: 'pairing' as DmPolicy,
      allow_users: [SENDER_KNOWN],
    },
    expect: { action: 'deliver' },
  },
  {
    name: 'DM / pairing + already paired (same sender, not expired) → pair + is_resend',
    input: { chat_type: 'p2p', sender_id: SENDER_STRANGER },
    statePatch: {
      dm_policy: 'pairing' as DmPolicy,
      pending: {
        [DM_RESEND_TOKEN]: {
          sender_id: SENDER_STRANGER,
          chat_id: 'dm-self',
          created_at: NOW,
          expires_at: NOW + PAIRING_TTL_MS,
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
      group: {
        policy: 'follow-user',
        allow_chats: [CHAT_ALLOWED],
        require_mention: true,
      },
      allow_users: [SENDER_KNOWN],
    },
    expect: { action: 'drop', reason: 'group_bot_not_mentioned' },
  },
  {
    name: 'GROUP / require_mention=false + not mentioned + follow-user + allowed sender → deliver',
    input: {
      chat_type: 'group',
      bot_mentioned: false,
      sender_id: SENDER_KNOWN,
    },
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
      group: {
        policy: 'block' as GroupPolicy,
        allow_chats: [CHAT_ALLOWED],
        require_mention: false,
      },
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
    input: {
      chat_type: 'group',
      chat_id: CHAT_ALLOWED,
      sender_id: SENDER_KNOWN,
      bot_mentioned: true,
    },
    statePatch: {
      group: {
        policy: 'allowlist',
        allow_chats: [CHAT_ALLOWED],
        require_mention: true,
      },
      allow_users: [SENDER_KNOWN],
    },
    expect: { action: 'deliver' },
  },
  {
    name: 'GROUP / allowlist + trusted chat + stranger + mentioned → deliver without pairing',
    input: {
      chat_type: 'group',
      chat_id: CHAT_ALLOWED,
      sender_id: SENDER_STRANGER,
      bot_mentioned: true,
    },
    statePatch: {
      group: {
        policy: 'allowlist',
        allow_chats: [CHAT_ALLOWED],
        require_mention: true,
      },
    },
    expect: { action: 'deliver' },
  },
  {
    name: 'GROUP / allowlist + non-allowlisted chat + not mentioned → drop rule1',
    input: { chat_type: 'group', chat_id: CHAT_STRANGER, bot_mentioned: false },
    statePatch: {
      group: {
        policy: 'allowlist',
        allow_chats: [CHAT_ALLOWED],
        require_mention: false,
      },
    },
    expect: { action: 'drop', reason: 'group_not_on_allowlist' },
  },
  {
    name: 'GROUP / allowlist + non-allowlisted chat + mentioned → drop rule1 (no group-kind pairing anymore)',
    input: {
      chat_type: 'group',
      chat_id: CHAT_STRANGER,
      sender_id: SENDER_STRANGER,
      bot_mentioned: true,
    },
    statePatch: {
      group: {
        policy: 'allowlist',
        allow_chats: [CHAT_ALLOWED],
        require_mention: true,
      },
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
    input: {
      chat_type: 'group',
      sender_id: SENDER_KNOWN,
      bot_mentioned: true,
      chat_id: CHAT_STRANGER,
    },
    statePatch: {
      group: { policy: 'follow-user', allow_chats: [], require_mention: true },
      allow_users: [SENDER_KNOWN],
    },
    expect: { action: 'deliver' },
  },
  {
    name: 'GROUP / follow-user + trusted chat + stranger → deliver without pairing',
    input: {
      chat_type: 'group',
      sender_id: SENDER_STRANGER,
      bot_mentioned: true,
    },
    statePatch: {
      group: {
        policy: 'follow-user',
        allow_chats: [CHAT_ALLOWED],
        require_mention: true,
      },
      allow_users: [],
    },
    expect: { action: 'deliver' },
  },
  {
    name: 'GROUP / follow-user + stranger + not mentioned → drop dm=pairing no mention',
    input: {
      chat_type: 'group',
      sender_id: SENDER_STRANGER,
      bot_mentioned: false,
    },
    statePatch: {
      group: { policy: 'follow-user', allow_chats: [], require_mention: false },
    },
    expect: { action: 'drop', reason: 'group_pairing_stranger_not_mentioned' },
  },
  {
    name: 'GROUP / follow-user + stranger + mentioned → pair dm-kind (陌生人@bot → 个人授权请求)',
    input: {
      chat_type: 'group',
      sender_id: SENDER_STRANGER,
      bot_mentioned: true,
      chat_id: CHAT_STRANGER,
    },
    statePatch: {
      group: { policy: 'follow-user', allow_chats: [], require_mention: true },
    },
    expect: { action: 'pair', kind: 'dm', isResend: false },
  },

  // ── GROUP: trusted bot ────────────────────────────────────────────────
  {
    name: 'GROUP / trusted bot sender + mentioned → deliver',
    input: {
      chat_type: 'group',
      sender_id: 'peer-bot',
      is_bot_sender: true,
      trusted_bot: true,
      bot_mentioned: true,
    },
    statePatch: {
      group: { policy: 'follow-user', allow_chats: [], require_mention: true },
    },
    expect: { action: 'deliver' },
  },
  {
    name: 'GROUP / trusted bot sender + NOT mentioned → drop',
    input: {
      chat_type: 'group',
      sender_id: 'peer-bot',
      is_bot_sender: true,
      trusted_bot: true,
      bot_mentioned: false,
    },
    statePatch: {
      group: { policy: 'follow-user', allow_chats: [], require_mention: false },
    },
    expect: { action: 'drop', reason: 'group_bot_not_mentioned' },
  },
  {
    name: 'GROUP / untrusted bot sender → drop bot_untrusted',
    input: {
      chat_type: 'group',
      sender_id: 'unknown-bot',
      is_bot_sender: true,
      trusted_bot: false,
      bot_mentioned: true,
    },
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
    input: {
      chat_type: 'group',
      sender_id: SENDER_STRANGER,
      chat_id: CHAT_STRANGER,
      bot_mentioned: true,
    },
    statePatch: {
      group: { policy: 'follow-user', allow_chats: [], require_mention: true },
      pending: {
        [GROUP_RESEND_TOKEN]: {
          sender_id: SENDER_STRANGER,
          chat_id: CHAT_STRANGER,
          created_at: NOW,
          expires_at: NOW + PAIRING_TTL_MS,
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
          sender_id: SENDER_STRANGER,
          chat_id: 'dm-x',
          created_at: NOW - PAIRING_TTL_MS - 1000,
          expires_at: NOW - 1,
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
      for (let i = 0; i < MAX_PENDING; i++) {
        pending[`d${i}`] = {
          sender_id: `u-${i}`,
          chat_id: `dm-${i}`,
          created_at: NOW,
          expires_at: NOW + PAIRING_TTL_MS,
        };
      }
      return { dm_policy: 'pairing' as DmPolicy, pending };
    })(),
    expect: { action: 'drop', reason: 'dm_pairing_slot_cap' },
  },
  {
    name: 'GROUP / follow-user + 10 DM pending full (10 不同陌生人各占一槽) → next new stranger drops dm_pairing_slot_cap',
    input: {
      chat_type: 'group',
      sender_id: SENDER_STRANGER,
      chat_id: CHAT_STRANGER,
      bot_mentioned: true,
    },
    statePatch: (() => {
      const pending: Record<string, PendingPairingEntry> = {};
      for (let i = 0; i < MAX_PENDING; i++) {
        pending[`d-g${i}`] = {
          sender_id: `u-${i}`,
          chat_id: `c-${i}`,
          created_at: NOW,
          expires_at: NOW + PAIRING_TTL_MS,
        };
      }
      return {
        group: {
          policy: 'follow-user',
          allow_chats: [],
          require_mention: true,
        },
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
    });
  }
});

describe('A2. trusted allow_chats truth table', () => {
  for (const policy of ['allowlist', 'follow-user'] as const) {
    for (const dmPolicy of [
      'disabled',
      'all',
      'allowlist',
      'pairing',
    ] as const) {
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
      expect(gate({ bot_mentioned: false }, access).action).toEqual({
        action: 'deliver',
      });
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
      group: {
        policy: 'follow-user' as const,
        allow_chats: [],
        require_mention: false,
      },
      allow_users: [] as string[],
    };
    expect(
      gate(
        { chat_id: CHAT_STRANGER },
        state({ ...base, dm_policy: 'disabled' }),
      ).action,
    ).toMatchObject({ action: 'drop', reason: 'dm_disabled' });
    expect(
      gate({ chat_id: CHAT_STRANGER }, state({ ...base, dm_policy: 'all' }))
        .action,
    ).toEqual({ action: 'deliver' });
    expect(
      gate(
        { chat_id: CHAT_STRANGER },
        state({ ...base, dm_policy: 'allowlist' }),
      ).action,
    ).toMatchObject({ action: 'drop', reason: 'group_user_not_on_allowlist' });
    expect(
      gate(
        { chat_id: CHAT_STRANGER, bot_mentioned: true },
        state({ ...base, dm_policy: 'pairing' }),
      ).action,
    ).toMatchObject({ action: 'pair', kind: 'dm' });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// B. TTL double-guard
// ──────────────────────────────────────────────────────────────────────────

describe('B. TTL double-guard', () => {
  it('expired pending entry is NOT counted as existing — fresh token generated', () => {
    const expired: PendingPairingEntry = {
      sender_id: SENDER_STRANGER,
      chat_id: 'dm-self',
      created_at: NOW - PAIRING_TTL_MS - 1000,
      expires_at: NOW - 1,
    };
    const access = state({
      dm_policy: 'pairing',
      pending: { deadtoken: expired },
    });
    const result = gate(
      { chat_type: 'p2p', sender_id: SENDER_STRANGER },
      access,
      NOW,
    );
    expect(result.action.action).toBe('pair');
    if (result.action.action !== 'pair') throw new Error('unreachable');
    expect(result.action.is_resend).toBe(false);
    expect(result.action.token).not.toBe('deadtoken');
    // Pruned entry should no longer be present
    expect(result.nextState.pending.deadtoken).toBeUndefined();
    // The new live entry is present under a different key
    const newToken = result.action.token;
    expect(result.nextState.pending[newToken]).toBeDefined();
    expect(result.nextState.pending[newToken].expires_at).toBe(
      NOW + PAIRING_TTL_MS,
    );
  });

  it('non-expired pending is counted as existing (resend with same token — dm-kind)', () => {
    // C3 rewrite: group-triggered pair requests create dm-kind entries. The
    // dedupe key is sender_id (not chat_id). So we seed a dm-kind pending
    // entry for the SAME sender that triggers the repeat @-mention.
    const live: PendingPairingEntry = {
      sender_id: SENDER_STRANGER,
      chat_id: CHAT_STRANGER,
      created_at: NOW - 1000,
      expires_at: NOW + PAIRING_TTL_MS - 1000,
    };
    const access = state({
      group: { policy: 'follow-user', allow_chats: [], require_mention: true },
      pending: { livetoken: live },
    });
    const result = gate(
      {
        chat_type: 'group',
        chat_id: CHAT_STRANGER,
        sender_id: SENDER_STRANGER,
        bot_mentioned: true,
      },
      access,
      NOW,
    );
    expect(result.action.action).toBe('pair');
    if (result.action.action !== 'pair') throw new Error('unreachable');
    expect(result.action.is_resend).toBe(true);
    expect(result.action.token).toBe('livetoken');
    expect(result.action.prompt_message_id).toBeUndefined();
    // TTL refreshed from the user's pov
    expect(result.nextState.pending.livetoken.expires_at).toBe(
      NOW + PAIRING_TTL_MS,
    );
  });

  it('pruneExpiredPending (via gate) removes only expired entries and preserves live ones', () => {
    const live: PendingPairingEntry = {
      sender_id: 'u-live',
      chat_id: 'dm-live',
      created_at: NOW,
      expires_at: NOW + 1000,
    };
    const dead: PendingPairingEntry = {
      sender_id: 'u-dead',
      chat_id: 'dm-dead',
      created_at: NOW - 10_000,
      expires_at: NOW - 1,
    };
    const dead2: PendingPairingEntry = {
      sender_id: 'x',
      chat_id: 'c-dead',
      created_at: NOW - 10_000,
      expires_at: 0,
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

describe('C. Per-kind pending quota (MAX_PENDING = 10)', () => {
  it('fill 10 DM pending → next DM pair request drops dm_pairing_slot_cap', () => {
    const pending: Record<string, PendingPairingEntry> = {};
    for (let i = 0; i < MAX_PENDING; i++) {
      pending[`d${i}`] = makePendingEntry('dm', i, NOW);
    }
    const access = state({ dm_policy: 'pairing', pending });
    const result = gate(
      { chat_type: 'p2p', sender_id: 'new-stranger' },
      access,
      NOW,
    );
    expect(result.action).toEqual({
      action: 'drop',
      reason: 'dm_pairing_slot_cap',
      context: { pending: MAX_PENDING, max: MAX_PENDING },
    });
  });

  it('10 DM pending ALSO blocks in-group pair request (shared dm-kind counter after C3 rewrite)', () => {
    const pending: Record<string, PendingPairingEntry> = {};
    for (let i = 0; i < MAX_PENDING; i++) {
      pending[`d${i}`] = makePendingEntry('dm', i, NOW);
    }
    const access = state({
      group: { policy: 'follow-user', allow_chats: [], require_mention: true },
      pending,
    });
    const result = gate(
      {
        chat_type: 'group',
        sender_id: SENDER_STRANGER,
        chat_id: CHAT_STRANGER,
        bot_mentioned: true,
      },
      access,
      NOW,
    );
    // Group-triggered pair requests now generate dm-kind entries → they share
    // the dm counter with DM-triggered entries. 10 full → drop.
    expect(result.action).toEqual({
      action: 'drop',
      reason: 'dm_pairing_slot_cap',
      context: { pending: MAX_PENDING, max: MAX_PENDING },
    });
  });

  it('fill 10 dm-kind pending (mixed DM + group sources) → next new stranger in group drops dm_pairing_slot_cap', () => {
    const pending: Record<string, PendingPairingEntry> = {};
    for (let i = 0; i < MAX_PENDING; i++) {
      pending[`mix${i}`] = makePendingEntry('dm', i, NOW);
    }
    const access = state({
      group: { policy: 'follow-user', allow_chats: [], require_mention: true },
      pending,
    });
    const result = gate(
      {
        chat_type: 'group',
        sender_id: SENDER_STRANGER,
        chat_id: 'c-brand-new',
        bot_mentioned: true,
      },
      access,
      NOW,
    );
    expect(result.action).toEqual({
      action: 'drop',
      reason: 'dm_pairing_slot_cap',
      context: { pending: MAX_PENDING, max: MAX_PENDING },
    });
  });

  it('expired entries do NOT count toward quota — new slot succeeds', () => {
    // Fill with all expired entries
    const pending: Record<string, PendingPairingEntry> = {};
    for (let i = 0; i < MAX_PENDING + 5; i++) {
      pending[`x${i}`] = makePendingEntry('dm', i, NOW, true);
    }
    const access = state({ dm_policy: 'pairing', pending });
    const result = gate(
      { chat_type: 'p2p', sender_id: 'new-stranger' },
      access,
      NOW,
    );
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
      sender_id: 'u-maxed',
      chat_id: 'c-any',
      created_at: NOW - 1000,
      expires_at: NOW + PAIRING_TTL_MS,

      prompt_message_id: 'om_prompt',
    };
    const access = state({
      group: { policy: 'follow-user', allow_chats: [], require_mention: true },
      pending: { EXHAUST: exhausted },
    });
    // Same sender (dm-kind dedupe key is sender_id) → hits the exhausted slot.
    const result = gate(
      {
        chat_type: 'group',
        sender_id: 'u-maxed',
        chat_id: 'c-any',
        bot_mentioned: true,
      },
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
      {
        chat_type: 'group',
        sender_id: SENDER_KNOWN,
        bot_mentioned: false,
        chat_id: CHAT_STRANGER,
      },
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
      {
        chat_type: 'group',
        sender_id: SENDER_STRANGER,
        bot_mentioned: false,
        chat_id: CHAT_STRANGER,
      },
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

  describe('constant values', () => {
    it('ACCESS_STATE_VERSION is 3', () => {
      expect(ACCESS_STATE_VERSION).toBe(3);
    });
    it('PAIRING_TTL_MS is 1 hour in ms', () => {
      expect(PAIRING_TTL_MS).toBe(60 * 60 * 1000);
    });
    it('MAX_PENDING is 10', () => {
      expect(MAX_PENDING).toBe(10);
    });
    it('PAIRING_TOKEN_BYTES bytes → 6 hex chars total', () => {
      expect(PAIRING_TOKEN_BYTES * 2).toBe(6);
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Export compatibility check
// ──────────────────────────────────────────────────────────────────────────

it('DispatcherAccess type alias equals DispatcherAccessStateV3', () => {
  const state: DispatcherAccessState = defaultDispatcherAccessState();
  const v3: DispatcherAccessStateV3 = state;
  expect(v3.version).toBe(3);
});
