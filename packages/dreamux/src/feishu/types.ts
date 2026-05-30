/**
 * Shared types for the Feishu adapter.
 *
 * Issue #2 §"实现陷阱": access gate (DmPolicy / GroupPolicy / pairing) is
 * intentionally NOT in P0 — see "P0 Trust Model". The types below are the
 * minimum subset content.ts needs.
 */

/** One @-mention inside an inbound Feishu message. */
export interface Mention {
  /** The placeholder token (e.g. `@_user_1`) used in the message text. */
  key: string;
  id?: { open_id?: string; union_id?: string; user_id?: string };
  name?: string;
}
