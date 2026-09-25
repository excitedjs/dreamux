/**
 * Feishu access gate v3 — pairing-token model.
 *
 * Pure-function unit tests for `dreamuxFeishuGate` and the pairing token
 * helper primitives. The IO loader/saver contract now lives on
 * `readDispatcherAccess` in `feishu-gate-io.ts` and the session's held
 * `TransactionalStore`.
 */

import { describe, expect, it } from 'vitest';

import {
  ACCESS_STATE_VERSION,
  PAIRING_TOKEN_BYTES,
  PAIRING_TTL_MS,
  defaultDispatcherAccessState,
  dreamuxFeishuGate,
  generatePairingToken,
  generateUniquePairingToken,
  type DispatcherAccessState,
  type DispatcherAccessStateV3,
  type GateInbound,
} from '../src/feishu-gate.js';

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const SENDER_KNOWN = 'sender-known';
const SENDER_STRANGER = 'sender-stranger';
const CHAT_ALLOWED = 'chat-allowed';
const CHAT_STRANGER = 'chat-stranger';

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
    it('PAIRING_TOKEN_BYTES bytes → 6 hex chars total', () => {
      expect(PAIRING_TOKEN_BYTES * 2).toBe(6);
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Export compatibility check
// ──────────────────────────────────────────────────────────────────────────

describe('Export compatibility', () => {
  it('DispatcherAccess type alias equals DispatcherAccessStateV3', () => {
    // Compile-time assertion — if this compiles, the aliases agree.
    const _v3: DispatcherAccessState = defaultDispatcherAccessState();
    const _also: DispatcherAccessStateV3 = _v3;
    expect(_also.version).toBe(3);
  });
});
