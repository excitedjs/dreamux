/**
 * Shared inbound-turn contract types.
 *
 * These declarations are consumed by the AgentRuntime contract
 * (agent-runtime/types.ts), the claude runtime, and channel — they are
 * transport-agnostic and must not live under builtin/codex/, or a
 * claude→codex cross-dependency reappears.
 */

export const DEFAULT_MESSAGE_ID_DEDUPE_WINDOW = 1024;

export interface InboundTurnInput {
  /** The turn text to deliver to the agent. */
  text: string;
  /**
   * Stable dedupe / correlation id for this inbound (formerly
   * `source_message_id`). Channel routing attributes (chat id, sender id,
   * message id) stay in the channel layer and never cross into the runtime.
   * An empty string disables dedupe.
   */
  sourceId: string;
}

export type InboundDeliveryResult =
  | { status: 'duplicate' }
  | { status: 'stopped' }
  | { status: 'submitted'; turnId: string }
  | { status: 'failed'; error: Error };

/**
 * Result of a best-effort restart-notice injection. `skipped` means a real
 * inbound had already been handed to Codex (it woke the thread on its own, so a
 * synthetic notice would be redundant) — see issue #78.
 */
export type NoticeInjectionResult =
  | { status: 'stopped' }
  | { status: 'skipped' }
  | { status: 'submitted'; turnId: string }
  | { status: 'failed'; error: Error };

export interface InboundDeliveryHooks {
  /**
   * Called after process-local dedupe accepts the message and before
   * `turn/start` is submitted.
   */
  onAccepted?: (input: InboundTurnInput) => void | Promise<void>;
}
