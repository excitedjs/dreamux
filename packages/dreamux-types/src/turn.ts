/**
 * Neutral inbound-turn contract declarations.
 *
 * Declaration-only subset of the core turn contract: the data shapes a provider
 * package needs to author against. The runtime helpers (`renderChannelInput`,
 * the dedupe-window constant) stay in `@excitedjs/dreamux` because they are
 * executable code, not declarations.
 */

/**
 * A channel-supplied attachment, in a neutral shape (no channel-typed field
 * names). Passed through to the runtime so a runtime can render attachments its
 * own way.
 */
export interface InboundAttachment {
  /** Opaque media kind the channel assigns, e.g. `image` | `file`. */
  kind: string;
  /** Display name when the channel knows one. */
  name?: string;
  /** Local filesystem path when the channel downloaded the resource; absent otherwise. */
  localPath?: string;
}

export interface InboundTurnInput {
  /** The turn text to deliver to the agent (used when no channel body is set). */
  text: string;
  /**
   * Stable dedupe / correlation id for this inbound. An empty string disables
   * dedupe.
   */
  sourceId: string;
  /**
   * Opaque channel-source label (e.g. `feishu`), rendered as the
   * `<channel source="…">` attribute. Data, not a typed concept.
   */
  source?: string;
  /**
   * Opaque display attributes rendered verbatim into the runtime's channel
   * block. The runtime MUST NOT interpret or route on them.
   */
  attrs?: Array<[string, string]>;
  /** Pre-rendered, already-escaped message body the runtime wraps into its channel block. */
  body?: string;
  /** Structured attachments for future per-runtime rendering. */
  attachments?: readonly InboundAttachment[];
}

export type InboundDeliveryResult =
  | { status: 'duplicate' }
  | { status: 'stopped' }
  | { status: 'submitted'; turnId: string }
  | { status: 'failed'; error: Error };

/**
 * A neutral "turn settled" signal: a delivered turn reached a terminal state.
 * Capability-neutral — carries no channel or runtime specifics.
 */
export interface TurnSettledSignal {
  turnId: string;
  status: 'completed' | 'failed' | 'stopped';
  result?: {
    text: string | null;
    truncated?: boolean;
  };
  error?: Error;
}
