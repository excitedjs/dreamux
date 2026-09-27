/**
 * Feishu access state v3 — pairing-token model: shape, constants, and
 * defaults.
 *
 * v3 replaces the v2 "everything is allowlist" model with per-sender pairing
 * slots. An operator (human admin out-of-band) approves a 6-hex token to add
 * a sender to `allow_users`. `group.allow_chats` is the operator-owned list
 * of trusted human group memberships, not something pairing approval mutates.
 *
 * `./gate.js` holds the pure decision logic over this shape (including
 * minting a pairing token, part of the `pair` transition); `./index.js` holds
 * `FeishuAccess`, the class that owns this state's `TransactionalStore` and
 * every IO/mutation that answers something other than a gate decision.
 */

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

export const ACCESS_STATE_VERSION = 3 as const;
// Ten active onboarding slots keeps one dispatcher useful in a busy chat while
// bounding spam from many unknown senders.
export const MAX_PENDING = 10;
export const PAIRING_TTL_MS = 60 * 60 * 1000;
export const PAIRING_TOKEN_BYTES = 3;
export const PAIRING_TOKEN_REGEX = /^[0-9a-fA-F]{6}$/;

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

export type DmPolicy = 'all' | 'allowlist' | 'pairing' | 'disabled';
export type GroupPolicy = 'block' | 'allowlist' | 'follow-user';
export type PendingPairingKind = 'dm' | 'group';

export interface PendingPairingEntry {
  sender_id: string;
  chat_id: string;
  // Write-only: only `expires_at` drives TTL. Kept as a human-legible
  // timestamp for an operator reading access.json by hand during the
  // quiesced-edit procedure `feishu-access-v3.md` documents.
  created_at: number;
  expires_at: number;
  prompt_message_id?: string | undefined;
}

export interface DispatcherAccessStateV3 {
  version: typeof ACCESS_STATE_VERSION;
  dm_policy: DmPolicy;
  group: {
    policy: GroupPolicy;
    allow_chats: string[];
    require_mention: boolean;
  };
  allow_users: string[];
  pending: Record<string, PendingPairingEntry>;
}

export type DispatcherAccessState = DispatcherAccessStateV3;

// ─────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────

export function defaultDispatcherAccessState(): DispatcherAccessStateV3 {
  return {
    version: ACCESS_STATE_VERSION,
    dm_policy: 'pairing',
    group: {
      policy: 'follow-user',
      allow_chats: [],
      require_mention: true,
    },
    allow_users: [],
    pending: {},
  };
}
