/**
 * What a COT card shows for one Core fact — a tool call, or an input. Core
 * redacts; this module owns display text, deriving it from that one fact;
 * its callers build the events and fit them to Feishu's per-event limit — the
 * one bound a card string has, and the one truncation must follow.
 */
import type {
  RuntimeToolAction,
  TeammateActivity,
  TeammateInputEvent,
} from '@excitedjs/dreamux-types';

/** The one activity member this presentation layer renders. */
export type CotToolCallActivity = Extract<TeammateActivity, { kind: 'tool.call' }>;

/** What the pills of a result's item list may spend before the rest is folded into a `more` pill. */
export const TOOL_ITEMS_SOFT_MAX_BYTES = 512;
export const TRUNCATION_MARKER = '… (truncated)';

/**
 * The provenance names Core's own automated producers use, and the one line a
 * card shows instead of each notification's body.
 *
 * Provenance is open by contract — a consumer that presents inputs differently
 * by source owns that mapping, which is this. A cron fire and a restart notice
 * name themselves; a completion push-back names every producer the same way,
 * so the producer comes from the event's own `notice` fact and never from
 * reading the body back apart.
 */
const SCHEDULED_SOURCE = 'cron';
const SYSTEM_SOURCE = 'system';

export function inputDisplayContent(event: TeammateInputEvent): string {
  if (event.notice !== null) {
    return event.notice.kind === 'teammate_completion'
      ? `TEAMMATE CALLBACK · ${event.notice.producer}`
      : 'WORKFLOW FINISHED';
  }
  if (event.source === SCHEDULED_SOURCE) return 'CRON TRIGGERED';
  if (event.source === SYSTEM_SOURCE) return 'SYSTEM RESTARTED';
  return event.content;
}


/** One pill of a `list` result segment, as the COT Message Brief shapes it. */
export interface CotListItem {
  readonly text: string;
  readonly icon?: CotToolIcon;
}

/** The pills a result shows for the call's items, and the one that stands for the rest. */
export interface CotItemList {
  readonly items: readonly CotListItem[];
  readonly more?: CotListItem;
}

/** One `code` segment of a tool row, as the COT Message Brief shapes it. */
export interface CotCodeSegment {
  /** Documented as semantic only: the client labels the block, never highlights it. */
  readonly language: 'text' | 'bash' | 'json';
  readonly code: string;
}

/**
 * What the runtime said about the call, ready for the card: the row's title
 * composed from the runtime's summary, the icon of the action it named, the
 * call's arguments as one code segment, and the items the call was about as
 * the pills of a `list` segment.
 * Nothing here comes from the tool's identity: a Channel-owned tool and a
 * foreign MCP tool are presented by the same rule, so the Channel's hand-made
 * titles for its own `reply`, `react` and `list_chat_bots` all come back out.
 */
interface ToolPresentation {
  readonly toolCallName: string;
  readonly icon?: CotToolIcon;
  readonly title?: string;
  readonly arguments: CotCodeSegment | null;
  readonly items: CotItemList | null;
}

/**
 * `TOOL_CALL_START.icon` as the COT Message Brief documents it: a built-in
 * enum (`search`, `bash`, `read`, `write`, `doc`, `calendar`, `task`,
 * `meeting`, `default`) or a token from the card icon library. This Channel
 * uses the built-ins a runtime's tool actions map onto, and the library's
 * `app-default_outlined` for a call nothing could label.
 */
export type CotToolIcon = 'search' | 'bash' | 'read' | 'write' | 'app-default_outlined';

const ACTION_TOOL_NAMES: Readonly<Record<RuntimeToolAction, string>> = {
  read: 'Read',
  list_files: 'List',
  search: 'Search',
  edit: 'Edit',
  run: 'Bash',
};

const ACTION_ICONS: Readonly<Record<RuntimeToolAction, CotToolIcon>> = {
  read: 'read',
  list_files: 'search',
  search: 'search',
  edit: 'write',
  run: 'bash',
};

/**
 * The verb a row leads with when the runtime's summary names only the object
 * of the call — the path read, the pattern searched. A `run` summary is
 * already a sentence (the command's stated purpose, or the command itself)
 * and takes no verb.
 */
const ACTION_VERBS: Readonly<Record<RuntimeToolAction, string>> = {
  read: 'Read ',
  list_files: 'List ',
  search: 'Search ',
  edit: 'Edit ',
  run: '',
};

export function toolPresentation(event: CotToolCallActivity): ToolPresentation {
  const actionName = event.tool_action === null
    ? event.tool_name
    : ACTION_TOOL_NAMES[event.tool_action];
  const title = runtimeToolTitle(event);
  // A call with neither an action nor a label — an MCP tool, today — shows
  // its name behind the generic app icon.
  const icon: CotToolIcon | undefined = event.tool_action === null
    ? (title === null ? 'app-default_outlined' : undefined)
    : ACTION_ICONS[event.tool_action];
  return {
    toolCallName: actionName,
    ...(icon === undefined ? {} : { icon }),
    ...(title === null ? {} : { title }),
    arguments: argumentCode(event),
    items: itemList(event),
  };
}

/**
 * What the call was, as one code segment.
 *
 * `invocation` is the one member of the input that has a notation of its own —
 * the command line, the diff, the prompt handed to a sub-agent — so it wins
 * over the full structured input for every tool: it is what the runtime's own
 * UI would show, and the JSON around it adds nothing a reader wants. Only a
 * call that has none falls back to `arguments_json`, pretty-printed when it is
 * an object or an array and shown as it came otherwise. The notation follows
 * the action the runtime named: a `run` invocation is a shell command line,
 * and nothing else claims to be.
 */
function argumentCode(event: CotToolCallActivity): CotCodeSegment | null {
  const invocation = nonEmpty(event.invocation);
  if (invocation !== null) {
    return {
      language: event.tool_action === 'run' ? 'bash' : 'text',
      code: invocation,
    };
  }
  const args = nonEmpty(event.arguments_json);
  if (args === null) return null;
  const structured = prettyJson(args);
  return structured === null
    ? { language: 'text', code: args }
    : { language: 'json', code: structured };
}

/**
 * The pretty-printed form of a payload that is a JSON object or array, or
 * `null` for anything else — a bare scalar and unparsable text alike. What a
 * value *is* decides how it is shown, on the way in and on the way back.
 */
export function prettyJson(text: string): string | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === 'object' && value !== null) {
      return JSON.stringify(value, null, 2);
    }
  } catch {
    // Not JSON: the runtime's own text, shown as text.
  }
  return null;
}

/**
 * The call's items as pills, each with the icon of the call's action, kept
 * within `TOOL_ITEMS_SOFT_MAX_BYTES` so a patch over many files leaves room
 * for its diff: the pills that fit, then one `+N` pill for the rest. A first
 * item longer than the whole budget is truncated into one pill instead of
 * being folded into a count no pill explains; truncation happens per item.
 */
function itemList(event: CotToolCallActivity): CotItemList | null {
  if (event.items.length === 0) return null;
  const icon = event.tool_action === null ? undefined : ACTION_ICONS[event.tool_action];
  const pill = (text: string): CotListItem => (icon === undefined ? { text } : { text, icon });
  const items: CotListItem[] = [];
  let bytes = 0;
  for (const [index, item] of event.items.entries()) {
    bytes += escapedBytes(item);
    if (bytes > TOOL_ITEMS_SOFT_MAX_BYTES) {
      if (items.length > 0) {
        return { items, more: { text: `+${event.items.length - index}` } };
      }
      const rest = event.items.length - index - 1;
      const truncated = [pill(truncateEscaped(item, TOOL_ITEMS_SOFT_MAX_BYTES))];
      return rest === 0 ? { items: truncated } : { items: truncated, more: { text: `+${rest}` } };
    }
    items.push(pill(item));
  }
  return { items };
}

/**
 * The row's title: the runtime's own one-line label for the call. A runtime
 * that named an action labelled the object of the call — a path, a pattern —
 * so the row leads with that action's verb; a runtime that named none wrote a
 * whole label already, and repeating the tool's name in front of it says the
 * same thing twice beside a row that already shows the name.
 */
function runtimeToolTitle(event: CotToolCallActivity): string | null {
  if (event.summary === null) return null;
  const summary = event.summary.trim();
  if (summary === '') return null;
  return event.tool_action === null
    ? summary
    : `${ACTION_VERBS[event.tool_action]}${summary}`;
}

/** A detail the runtime gave, or `null` when it gave none or an empty one. */
export function nonEmpty(value: string | null): string | null {
  return value === null || value === '' ? null : value;
}

const NO_BREAK_SPACE = '\u00a0';

/**
 * A `text` segment as the Feishu client keeps its spacing. The client
 * collapses a run of ordinary spaces to one and drops the run that begins a
 * line, so a text output lost its indentation and its column alignment; a
 * no-break space stays where it was: raw spaces collapse, while both U+00A0
 * and the `&nbsp;` entity keep the indentation, and a `<pre>` wrapper renders
 * as literal text instead of preserving whitespace. Each space that begins a
 * line, or sits in a run of two or more, becomes U+00A0; a single space
 * between words stays a space, so a long line still wraps there. The
 * character, not the entity: two bytes of the event budget instead of six.
 */
export function preserveSpacing(text: string): string {
  return text.replace(/^ +| {2,}/gmu, (run) => NO_BREAK_SPACE.repeat(run.length));
}

export function truncateEscaped(value: string, maxBytes: number): string {
  const valueBytes = escapedBytes(value);
  if (valueBytes <= maxBytes) return value;
  const markerBytes = escapedBytes(TRUNCATION_MARKER);
  const prefixBudget = Math.max(0, maxBytes - markerBytes);
  const prefix: string[] = [];
  let bytes = 0;
  for (const character of value) {
    const characterBytes = escapedBytes(character);
    if (bytes + characterBytes > prefixBudget) break;
    prefix.push(character);
    bytes += characterBytes;
  }
  return `${prefix.join('')}${TRUNCATION_MARKER}`;
}

export function escapedBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value).slice(1, -1), 'utf8');
}
