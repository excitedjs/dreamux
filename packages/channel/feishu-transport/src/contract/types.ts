/**
 * Shared Feishu content types for the transport layer.
 */

/** One @-mention inside an inbound Feishu message. */
export interface Mention {
  /** The placeholder token (e.g. `@_user_1`) used in the message text. */
  key: string
  /** Resolved identity of the mentioned party. */
  id?: { open_id?: string; union_id?: string; user_id?: string }
  /** Display name of the mentioned party. */
  name?: string
}
