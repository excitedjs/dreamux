/**
 * The one model-facing submission envelope Core assembles.
 *
 * The Agent Runtime seam carries text alone, so somebody has to turn "this text
 * came from a Feishu group message" into something the model can see. That used
 * to be each Provider's job, which meant every runtime re-implemented the same
 * XML and every new Channel form had to teach every runtime about itself. It is
 * Core's job now, and it is deliberately the *only* thing Core knows about a
 * source: a name and some attributes it renders and never reads.
 *
 * Core therefore stays business-agnostic. `channel`, `cron`, `task`,
 * `task-notification`, and `system` are values their owners pick; nothing here
 * branches on them, and adding a Channel form is a change in that Channel, not
 * a change here. The single reservation — `system` for Dispatcher-owned notices
 * — is structural rather than enforced: no caller-facing surface carries a
 * source at all, so no external payload can select one.
 *
 * These tags are provenance and boundary hints for a model, not an injection or
 * authorization boundary: attribute values are escaped so a start tag stays
 * well formed, and the body is passed through byte for byte. A body is model
 * input, not a document — rewriting its entities, wrapping it in CDATA, or
 * converting its Markdown fences would corrupt exactly the text the source
 * meant the model to read.
 */
import type { TurnCompletionDelivery } from './turn-recording.js';

/**
 * One admitted submission, as `TeammateService` accepts it.
 *
 * The first four fields are the complete model-facing input. The last three are
 * Core-only facts that are never rendered: `sourceId` is the key of the bounded
 * duplicate ledger, `intent` is the durable recovery subject of the turn Core
 * actually admits, and `deliverCompletion` is the optional callback for a
 * Core-side initiator awaiting this turn's completion.
 */
export interface TeammateSubmitInput {
  /** Open, owner-selected provenance name. Rendered as the envelope root. */
  readonly source: string;
  /** Unordered display attributes. Omitted is exactly the empty set. */
  readonly attrs?: Readonly<Record<string, string>>;
  /** The source's model-facing body, rendered exactly as supplied. */
  readonly text: string;
  /** One optional trailing note, rendered once after the source block. */
  readonly reminder?: string;
  /** Stable per-source id for Core's duplicate ledger. Never rendered. */
  readonly sourceId?: string;
  /** Recovery subject for a newly admitted turn. Never rendered. */
  readonly intent?: string;
  /** Optional Core completion callback. Never rendered. */
  readonly deliverCompletion?: TurnCompletionDelivery;
}

/**
 * Names safe to write into a start tag.
 *
 * Deliberately narrower than XML's own Name production: a source or attribute
 * name is chosen by the Core path that submits, never by external data, so the
 * useful property is that a mistake fails loud rather than that every legal
 * Unicode name is accepted.
 */
const SAFE_TAG_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/u;

/**
 * Whether one source or attribute name may be written into a start tag.
 *
 * Exported because a caller-facing surface has to refuse a bad name as the
 * caller's mistake, with its own wording, before the submission reaches the
 * renderer — where the same name would be an internal defect. The rule itself
 * is defined once, here, so the two layers cannot drift apart.
 */
export function isSafeTagName(name: string): boolean {
  return SAFE_TAG_NAME.test(name);
}

/** The reminder's own root. Generic, so no source owns or repeats it. */
const REMINDER_TAG = 'reminder';

/**
 * Assemble the text one submission delivers to the runtime.
 *
 * Only `source`, `attrs`, `text`, and `reminder` participate. An invalid source
 * or attribute name is a defect in the submitting Core path — it cannot be
 * repaired by escaping and must not silently produce a malformed tag — so it
 * throws instead of degrading.
 */
export function renderSubmission(input: TeammateSubmitInput): string {
  assertSafeName(input.source, 'submission source');
  let start = `<${input.source}`;
  for (const [name, value] of Object.entries(input.attrs ?? {})) {
    assertSafeName(name, 'submission attribute');
    start += ` ${name}="${escapeAttributeValue(value)}"`;
  }
  // The body is inserted directly between the paired tags: no content child, no
  // indentation, no entity rewriting. What the source formatted is what the
  // model reads.
  const block = `${start}>${input.text}</${input.source}>`;
  if (input.reminder === undefined || input.reminder === '') return block;
  // One sibling at the very end of the complete input, never repeated inside
  // each message.
  return `${block}\n\n<${REMINDER_TAG}>${input.reminder}</${REMINDER_TAG}>`;
}

function assertSafeName(name: string, what: string): void {
  if (!isSafeTagName(name)) {
    throw new Error(`${what} ${JSON.stringify(name)} is not a safe tag name`);
  }
}

/**
 * Escape one attribute value.
 *
 * Values do carry external data — a chat title, a sender's display name — so
 * this is the one place the renderer rewrites anything. `<` and `>` are escaped
 * alongside the strictly required `&` and `"` so a value can never look like a
 * nested tag to a reading model.
 */
function escapeAttributeValue(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
