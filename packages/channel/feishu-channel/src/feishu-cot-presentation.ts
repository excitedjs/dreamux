/**
 * What a COT card shows for a tool call. Core redacts; this module owns display
 * text, deriving it from one tool call; `feishu-cot-events.ts`, its only
 * caller, builds the events and fits them to Feishu's per-event limit — the
 * one bound a card string has (operator ruling, 2026-09-04: 「截断长度以飞书平台
 * 上给出的最长长度为准」).
 */
import type {
  RuntimeToolAction,
  TeammateActivity,
} from '@excitedjs/dreamux-types';

/** The one activity member this presentation layer renders. */
export type CotToolCallActivity = Extract<TeammateActivity, { kind: 'tool.call' }>;

/** What the pills of a result's item list may spend before the rest is folded into a `more` pill. */
export const TOOL_ITEMS_SOFT_MAX_BYTES = 512;
export const TRUNCATION_MARKER = '… (truncated)';
const TOOL_NAME_MAX_BYTES = 80;

function displayToolName(toolName: string): string {
  const leaf = toolName
    .split(/(?:__|[.:/\\])/)
    .filter((part) => part !== '')
    .at(-1)
    ?.trim();
  return truncateUtf8(
    leaf === undefined || leaf === '' ? 'tool' : leaf,
    TOOL_NAME_MAX_BYTES,
  );
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

/**
 * What the runtime said about the call, ready for the card: the row's title
 * composed from the runtime's summary, the icon of the action it named, the
 * invocation the expanded row shows in the caller's notation instead of as
 * JSON, and the items the call was about as the pills of a `list` segment.
 * Nothing here comes from the tool's identity: a Channel-owned tool and a
 * foreign MCP tool are presented by the same rule (operator ruling,
 * 2026-09-04: 「这些全部回退吧」, on the Channel's hand-made titles for its own
 * `reply`, `react` and `list_chat_bots`).
 */
interface ToolPresentation {
  readonly toolCallName: string;
  readonly icon?: CotToolIcon;
  readonly title?: string;
  readonly invocation: string | null;
  readonly invocationLanguage: 'text' | 'bash';
  readonly items: CotItemList | null;
}

/**
 * `TOOL_CALL_START.icon` as the COT Message Brief documents it: a built-in
 * enum (`search`, `bash`, `read`, `write`, `doc`, `calendar`, `task`,
 * `meeting`, `default`) or a token from the card icon library. This Channel
 * uses the built-ins a runtime's tool actions map onto, and the library's
 * `app-default_outlined` for a call nothing could label (operator ruling,
 * 2026-09-04: 「mcp 工具隐藏掉参数吧，icon 选 app-default_outlined」).
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
    ? displayToolName(event.tool_name)
    : ACTION_TOOL_NAMES[event.tool_action];
  const title = runtimeToolTitle(event, actionName);
  // A call with neither an action nor a label — an MCP tool, today — shows
  // its name behind the generic app icon; its arguments are not shown.
  const icon: CotToolIcon | undefined = event.tool_action === null
    ? (title === null ? 'app-default_outlined' : undefined)
    : ACTION_ICONS[event.tool_action];
  return {
    toolCallName: actionName,
    ...(icon === undefined ? {} : { icon }),
    ...(title === null ? {} : { title }),
    invocation: nonEmpty(event.invocation),
    invocationLanguage: event.tool_action === 'run' ? 'bash' : 'text',
    items: itemList(event),
  };
}

/**
 * The call's items as pills, each with the icon of the call's action, kept
 * within `TOOL_ITEMS_SOFT_MAX_BYTES` so a patch over many files leaves room
 * for its diff: the pills that fit, then one `+N` pill for the rest. A first
 * item longer than the whole budget is truncated into one pill instead of
 * being folded into a count no pill explains (operator ruling, 2026-09-04:
 * 「按照单条去截断即可」).
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

function runtimeToolTitle(event: CotToolCallActivity, actionName: string): string | null {
  if (event.summary === null) return null;
  const summary = event.summary.trim();
  if (summary === '') return null;
  return event.tool_action === null
    ? `${actionName}: ${summary}`
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
 * no-break space stays where it was (probe card, 2026-09-04: raw spaces
 * collapsed, U+00A0 and the `&nbsp;` entity both kept the indentation, a
 * `<pre>` wrapper was shown as literal text). Each space that begins a line,
 * or sits in a run of two or more, becomes U+00A0; a single space between
 * words stays a space, so a long line still wraps there. The character, not
 * the entity: two bytes of the event budget instead of six.
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

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, 'utf8');
  const prefixBudget = Math.max(0, maxBytes - markerBytes);
  const prefix: string[] = [];
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > prefixBudget) break;
    prefix.push(character);
    bytes += characterBytes;
  }
  return `${prefix.join('')}${TRUNCATION_MARKER}`;
}
