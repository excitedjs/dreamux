/**
 * Shared inbound-turn contract types.
 *
 * These declarations are consumed by the AgentRuntime contract
 * (agent-runtime/types.ts), the claude runtime, and channel — they are
 * transport-agnostic and must not live under builtin/codex/, or a
 * claude→codex cross-dependency reappears.
 */

export const DEFAULT_MESSAGE_ID_DEDUPE_WINDOW = 1024;

/**
 * A channel-supplied attachment, in a neutral shape (no channel-typed field
 * names). Passed through to the runtime so a runtime CAN render attachments its
 * own way in future (e.g. claude inlining image content blocks vs codex text
 * references); today both runtimes render the channel-supplied {@link
 * InboundTurnInput.body}, which already contains the textual attachment refs, so
 * this structured form is reserved for that future per-runtime divergence.
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
   * Stable dedupe / correlation id for this inbound (formerly
   * `source_message_id`). An empty string disables dedupe.
   *
   * Note on channel attributes (chat id, sender id, message id): *routing
   * decisions* stay in the channel layer and never cross into the runtime — a
   * runtime must not route or reply-target on them. What MAY cross is opaque
   * *display* passthrough via {@link InboundTurnInput.attrs}: values the runtime
   * renders verbatim into the model-visible block but never interprets. Reply
   * targeting still happens in the channel layer (the Feishu reply MCP tool
   * takes chat_id as an explicit parameter).
   */
  sourceId: string;
  /**
   * Opaque channel-source label (e.g. `feishu`), rendered as the
   * `<channel source="…">` attribute. Data, not a typed concept — the runtime
   * never branches on its value.
   */
  source?: string;
  /**
   * Opaque display attributes rendered verbatim into the runtime's channel
   * block. The runtime MUST NOT interpret or route on them. Keys that fail the
   * safe-key check are dropped at render time.
   */
  attrs?: Array<[string, string]>;
  /** Pre-rendered, already-escaped message body the runtime wraps into its channel block. */
  body?: string;
  /** Structured attachments for future per-runtime rendering (see {@link InboundAttachment}). */
  attachments?: readonly InboundAttachment[];
}

const SAFE_CHANNEL_ATTR_KEY = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function escapeChannelAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * Wrap a channel turn body in the native `<channel source="…" …>` envelope —
 * the shape claude-code emits for MCP channel messages. Mirrors claude-code's
 * `wrapChannelMessage`: only safe attribute keys (`^[a-zA-Z_][a-zA-Z0-9_]*$`)
 * are rendered and every value is XML-escaped. Lives in the neutral turn
 * contract so both builtins reuse it without a cross-builtin import.
 */
export function renderChannelBlock(
  source: string,
  attrs: ReadonlyArray<readonly [string, string]>,
  body: string,
): string {
  const rendered = attrs
    .filter(([key]) => SAFE_CHANNEL_ATTR_KEY.test(key))
    .map(([key, value]) => ` ${key}="${escapeChannelAttr(value)}"`)
    .join('');
  return `<channel source="${escapeChannelAttr(source)}"${rendered}>\n${body}\n</channel>`;
}

/**
 * Render an inbound turn to delivery text. A channel-structured input (both
 * `attrs` and `body` present) is wrapped into the runtime-owned `<channel>`
 * block; a plain input (e.g. a system trigger turn) passes its `text` through
 * unchanged.
 */
export function renderChannelInput(input: InboundTurnInput): string {
  if (input.attrs === undefined || input.body === undefined) {
    return input.text;
  }
  return renderChannelBlock(input.source ?? 'channel', input.attrs, input.body);
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

/**
 * A neutral "turn settled" signal: a delivered turn reached a terminal state.
 * `completed` is a successful turn, `failed` a turn that errored, `stopped` a
 * turn cut short by runtime teardown/stop. `turnId` is the runtime's turn id
 * when known (null when the turn never got one). Capability-neutral — carries no
 * channel or runtime specifics. This is the opposite lifetime of
 * {@link InboundDeliveryResult}: that one returns on submit, this one fires
 * later when the turn actually settles.
 */
export interface TurnSettledSignal {
  turnId: string | null;
  status: 'completed' | 'failed' | 'stopped';
  error?: Error;
}
