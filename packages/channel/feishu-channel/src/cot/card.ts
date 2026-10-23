/**
 * What a COT card shows for one Core fact: an input, an assistant message, a
 * tool call, a compaction, an interrupt, a token summary, or a run's
 * start/end. Core redacts; this module owns display text and which AG-UI
 * event kind carries it. Byte fitting is `./bytes.js`'s job — this module
 * calls into it wherever a decision needs a fitting check, but decides
 * nothing about budgets itself.
 */
import { createHash } from 'node:crypto';

import type {
  JsonValue,
  RuntimeToolAction,
  RuntimeActivity,
  TeammateInputEvent,
} from '@excitedjs/dreamux-types';
import type { FeishuCotEventInput } from '@excitedjs/feishu-transport';

import {
  boundedTextMessageEventGroup,
  checkedEvent,
  cotEventContentBytes,
  escapedBytes,
  escapedDeltaBytes,
  EVENT_CONTENT_RESERVE_BYTES,
  FEISHU_COT_EVENT_CONTENT_MAX_BYTES,
  shrinkForContentBudget,
  splitForEventContent,
  TITLE_MAX_BYTES,
  TOOL_ITEMS_SOFT_MAX_BYTES,
  TRUNCATION_MARKER,
  truncateEscaped,
} from './bytes.js';
import type { CotAdjacentMergeResult } from './recipients.js';

/** The one activity member this display layer renders as a tool row. */
export type CotToolCallActivity = Extract<
  RuntimeActivity,
  { kind: 'tool.call' }
>;

/**
 * How a card ends: the same three words the runtime uses for a turn end,
 * because a card's terminal *is* the end of what it was showing. The lifecycle
 * paths that retire an anchor or close a session use `interrupted`; replacing
 * an anchor completes its old card. Wire spelling is this module's business.
 *
 * Feishu documents one more `RUN_FINISHED.status`, `paused`, that nothing here
 * produces: a card is open or ended, never held. The omission is deliberate.
 */
export type FeishuCotTerminal = Extract<
  RuntimeActivity,
  { kind: 'turn.ended' }
>['status'];

/** One independent flavour label an append-only card opens with. */
export const FEISHU_COT_OPENING_LABELS = [
  '❋ Vibing...',
  '❋ Shipping...',
  '❋ Reticulating...',
  '❋ Manifesting...',
  '❋ Baking...',
] as const;

/** A compaction is one line, never the summary the runtime wrote for itself. */
export const COT_CONTEXT_COMPACTED_LABEL = 'COMPACTED SESSION';
/** The interrupt line on a card, in Claude Code's own words. */
export const COT_TURN_INTERRUPTED_LABEL = '[Request interrupted by user]';
/**
 * The heading one visible reasoning block opens with. The client renders a
 * native reasoning block like ordinary text, so without this a reader cannot
 * tell a thought from an answer; it is written once per block, never repeated
 * for the block's later increments.
 */
export const COT_REASONING_PREFIX = 'Thinking...';

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
    switch (event.notice.kind) {
      case 'teammate_completion':
        return `TEAMMATE CALLBACK · ${event.notice.producer}`;
      case 'teammate_message':
        // A member's explicit send reaches its leader as the model's input.
        // Only that recipient reads it as a message from the member; any other
        // recipient sees the body as written, because the label names a
        // direction, not a message kind.
        return event.role === 'team_leader'
          ? `TEAMMATE MESSAGE FROM ${event.notice.producer}`
          : event.content;
      case 'workflow_completion':
        return 'WORKFLOW FINISHED';
    }
  }
  if (event.source === SCHEDULED_SOURCE) return 'CRON TRIGGERED';
  if (event.source === SYSTEM_SOURCE) return 'SYSTEM RESTARTED';
  return event.content;
}

type CotTokenUsage = Extract<RuntimeActivity, { kind: 'token.usage' }>;

/**
 * The turn's cumulative token counters, on this recipient's card. The card
 * shows the same one-line summary runtimes used to emit as a message; the
 * structured counters themselves are not conversation content.
 */
export function tokenUsageSummary(event: CotTokenUsage): string {
  const context = event.context;
  let contextUsage = 'n/a';
  if (context !== null) {
    contextUsage =
      context.windowTokens !== null && context.windowTokens > 0
        ? `${Math.round((context.usedTokens / context.windowTokens) * 100)}%`
        : formatTokenCount(context.usedTokens);
  }
  const total = event.inputTokens + event.outputTokens;
  return `Context usage ${contextUsage} | Token usage: total=${formatTokenCount(total)} input=${formatTokenCount(event.inputTokens)} output=${formatTokenCount(event.outputTokens)}`;
}

function formatTokenCount(count: number): string {
  if (count < 1_000) return String(count);
  const units = ['k', 'm', 'b'];
  let value = count / 1_000;
  let unit = 0;
  while (Math.round(value * 10) / 10 >= 1_000 && unit < units.length - 1) {
    value /= 1_000;
    unit++;
  }
  return `${Math.round(value * 10) / 10}${units[unit]}`;
}

export function runStartedEvent(presentationId: string): FeishuCotEventInput {
  return checkedEvent({
    eventType: 'RUN_STARTED',
    content: { threadId: presentationId, runId: presentationId },
  });
}

/**
 * The one event that ends a card, across two event types: Feishu documents
 * `RUN_FINISHED.status` as exactly `done | paused | interrupted` and puts a
 * failure in its own `RUN_ERROR` event ("COT Message Brief", on the enterprise
 * docs host `open.larkoffice.com`; the public `open.feishu.cn` docs carry no
 * `message_cot` reference at all). A live probe agrees: `RUN_FINISHED` with
 * `failed` renders the client's 已完成 ("completed"), exactly as a deliberately
 * nonsense status does, and only `RUN_ERROR` renders its 任务失败 ("task
 * failed"). The platform accepted every one of them, so only the rendered card
 * is evidence, never the response code.
 *
 * `RUN_ERROR` sends `{ code }` alone. The reference documents a `message`
 * beside it, but two probes show the client neither renders it — an expanded
 * card shows the text appended before the terminal and then the client's own
 * fixed failure line, never the supplied string — nor requires it: a terminal
 * carrying only `code` renders identically. The failure reason reaches the
 * operator as that appended text message, which is the only thing that puts it
 * on the card.
 */
export function runTerminalEvent(
  presentationId: string,
  terminal: FeishuCotTerminal,
): FeishuCotEventInput {
  const run = { threadId: presentationId, runId: presentationId };
  switch (terminal) {
    case 'completed':
      return checkedEvent({
        eventType: 'RUN_FINISHED',
        content: { ...run, status: 'done' },
      });
    case 'interrupted':
      return checkedEvent({
        eventType: 'RUN_FINISHED',
        content: { ...run, status: 'interrupted' },
      });
    case 'failed':
      return checkedEvent({
        eventType: 'RUN_ERROR',
        content: { code: 'RUN_FAILED' },
      });
  }
}

/**
 * A runtime reports one native id for several facts: a turn's usage and its
 * interrupt marker share one. A display id therefore combines the row's
 * namespace with its source. Rows Feishu adds itself — input echoes, opening
 * receipts, and end reasons — take a random source.
 */
function opaqueDisplayId(kind: string, source: string): string {
  const digest = createHash('sha256')
    .update(kind)
    .update('\0')
    .update(source)
    .digest('base64url')
    .slice(0, 18);
  return `${kind}-${digest}`;
}

export function textMessageEvents(input: {
  readonly namespace: string;
  readonly sourceId: string;
  readonly role: 'assistant' | 'user';
  readonly content: string;
}): FeishuCotEventInput[] {
  if (input.content.trim() === '') return [];
  const messageId = opaqueDisplayId(input.namespace, input.sourceId);
  const start = checkedEvent({
    eventType: 'TEXT_MESSAGE_START',
    content: { messageId, role: input.role },
  });
  const end = checkedEvent({
    eventType: 'TEXT_MESSAGE_END',
    content: { messageId },
  });
  const contentEvents = splitForEventContent(input.content, (delta) => ({
    messageId,
    delta,
  })).map((content) =>
    checkedEvent({
      eventType: 'TEXT_MESSAGE_CONTENT',
      content,
    }),
  );
  if (contentEvents.length === 0) return [];
  return boundedTextMessageEventGroup(start, contentEvents, end, messageId);
}

/** One native reasoning part, as the live activity contract names it. */
export type CotReasoningActivity = Extract<
  RuntimeActivity,
  { kind: 'assistant.reasoning' }
>;

/**
 * The native identity of one reasoning part: the provider's item id plus its
 * content position. Both are needed — a provider reuses an item id across
 * parts — and the pair is the key a presentation uses to recognize a part it
 * has already opened.
 */
export function reasoningPartKey(
  activity: Pick<CotReasoningActivity, 'id' | 'partIndex'>,
): string {
  return `${activity.id}\0${activity.partIndex}`;
}

/**
 * The display identity of one native reasoning part inside one presentation.
 *
 * Derived from the native part key, never from concatenating ids the platform
 * could read back. The identity is stable across a part's increments, which is
 * what makes the client append them to one block, and scoped to a presentation
 * because a replacement card starts empty. Hashing is only needed when a part
 * first opens; callers that already hold this card's part map reuse its value.
 */
export function reasoningDisplayId(
  activity: Pick<CotReasoningActivity, 'id' | 'partIndex'>,
): string {
  return opaqueDisplayId('reasoning', reasoningPartKey(activity));
}

/**
 * One reasoning block, in the AG-UI shape the COT reference documents: the
 * section opens (40), the message opens with the reasoning role (41), each
 * content event appends (42), then the message (43) and section (45) close.
 * A block that is reopened on the same presentation starts a new section.
 */
export function reasoningStartEvent(messageId: string): FeishuCotEventInput {
  return checkedEvent({
    eventType: 'REASONING_START',
    content: { messageId },
  });
}

export function reasoningMessageStartEvent(
  messageId: string,
): FeishuCotEventInput {
  return checkedEvent({
    eventType: 'REASONING_MESSAGE_START',
    content: { messageId, role: 'reasoning' },
  });
}

export function reasoningMessageEndEvent(
  messageId: string,
): FeishuCotEventInput {
  return checkedEvent({
    eventType: 'REASONING_MESSAGE_END',
    content: { messageId },
  });
}

export function reasoningEndEvent(messageId: string): FeishuCotEventInput {
  return checkedEvent({
    eventType: 'REASONING_END',
    content: { messageId },
  });
}

/**
 * This increment as one or more content events, split to the per-event budget.
 * The prefix rides in the text before splitting, so the event that carries it
 * is fitted as a whole and no later increment needs it again.
 */
export function reasoningContentEvents(input: {
  readonly messageId: string;
  readonly text: string;
  readonly prefix: boolean;
}): FeishuCotEventInput[] {
  const text = input.prefix
    ? `${COT_REASONING_PREFIX}\n\n${input.text}`
    : input.text;
  return splitForEventContent(text, (delta) => ({
    messageId: input.messageId,
    delta,
  })).map((content) =>
    checkedEvent({ eventType: 'REASONING_MESSAGE_CONTENT', content }),
  );
}

/**
 * Merge one reasoning increment into the outbox tail when that tail is the
 * previous increment of the same block, so a paced flush carries one content
 * event instead of every provider chunk.
 *
 * A text or tool event between them is a barrier: the tail is a different
 * event, so nothing merges across it. The byte increases come from the
 * incoming fragment alone plus the one boundary code unit, never from
 * serializing the accumulated text again; whether the merged content still
 * fits one event's budget is the outbox's decision, because it holds the
 * tail's measured size.
 */
export function mergeAdjacentReasoningDelta(
  tail: FeishuCotEventInput,
  next: FeishuCotEventInput,
): CotAdjacentMergeResult | null {
  if (
    tail.eventType !== 'REASONING_MESSAGE_CONTENT' ||
    next.eventType !== 'REASONING_MESSAGE_CONTENT'
  ) {
    return null;
  }
  const messageId = next.content['messageId'];
  if (
    typeof messageId !== 'string' ||
    messageId === '' ||
    tail.content['messageId'] !== messageId
  ) {
    return null;
  }
  const previous =
    typeof tail.content['delta'] === 'string' ? tail.content['delta'] : '';
  const incoming =
    typeof next.content['delta'] === 'string' ? next.content['delta'] : '';
  if (incoming === '') return null;
  const { contentBytes, wireBytes } = escapedDeltaBytes(previous, incoming);
  return {
    event: {
      eventType: 'REASONING_MESSAGE_CONTENT',
      content: { messageId, delta: `${previous}${incoming}` },
    },
    extraContentBytes: contentBytes,
    extraWireBytes: wireBytes,
  };
}

/** `TOOL_CALL_START.icon` as the COT Message Brief documents it: a built-in
 * enum (`search`, `bash`, `read`, `write`, `doc`, `calendar`, `task`,
 * `meeting`, `default`) or a token from the card icon library. This Channel
 * uses the built-ins a runtime's tool actions map onto, and the library's
 * `app-default_outlined` for a call nothing could label.
 */
export type CotToolIcon =
  'search' | 'bash' | 'read' | 'write' | 'app-default_outlined';

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
  readonly icon?: CotToolIcon | undefined;
  readonly title?: string;
  readonly arguments: CotCodeSegment | null;
  readonly items: CotItemList | null;
}

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

function toolPresentation(event: CotToolCallActivity): ToolPresentation {
  const actionName =
    event.action === null ? event.toolName : ACTION_TOOL_NAMES[event.action];
  const title = runtimeToolTitle(event);
  // A call with neither an action nor a label — an MCP tool, today — shows
  // its name behind the generic app icon.
  const icon: CotToolIcon | undefined =
    event.action === null
      ? title === null
        ? 'app-default_outlined'
        : undefined
      : ACTION_ICONS[event.action];
  return {
    toolCallName: actionName,
    icon,
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
 * call that has none falls back to `arguments`, pretty-printed when it is
 * an object or an array and shown as it came otherwise. The notation follows
 * the action the runtime named: a `run` invocation is a shell command line,
 * and nothing else claims to be.
 */
function argumentCode(event: CotToolCallActivity): CotCodeSegment | null {
  const invocation = nonEmpty(event.invocation);
  if (invocation !== null) {
    return {
      language: event.action === 'run' ? 'bash' : 'text',
      code: invocation,
    };
  }
  const args = nonEmpty(payloadText(event.arguments));
  if (args === null) return null;
  const structured = prettyJson(args);
  return structured === null
    ? { language: 'text', code: args }
    : { language: 'json', code: structured };
}

/** Objects and scalars become JSON text; runtime strings keep their contents. */
function payloadText(value: JsonValue): string | null {
  if (value === null) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * The pretty-printed form of a payload that is a JSON object or array, or
 * `null` for anything else — a bare scalar and unparsable text alike. What a
 * value *is* decides how it is shown, on the way in and on the way back.
 */
function prettyJson(text: string): string | null {
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
  const icon = event.action === null ? undefined : ACTION_ICONS[event.action];
  const pill = (text: string): CotListItem =>
    icon === undefined ? { text } : { text, icon };
  const items: CotListItem[] = [];
  let bytes = 0;
  for (const [index, item] of event.items.entries()) {
    bytes += escapedBytes(item);
    if (bytes > TOOL_ITEMS_SOFT_MAX_BYTES) {
      if (items.length > 0) {
        return { items, more: { text: `+${event.items.length - index}` } };
      }
      const rest = event.items.length - index - 1;
      const truncated = [
        pill(truncateEscaped(item, TOOL_ITEMS_SOFT_MAX_BYTES)),
      ];
      return rest === 0
        ? { items: truncated }
        : { items: truncated, more: { text: `+${rest}` } };
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
  return event.action === null
    ? summary
    : `${ACTION_VERBS[event.action]}${summary}`;
}

/** A detail the runtime gave, or `null` when it gave none or an empty one. */
function nonEmpty(value: string | null): string | null {
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
function preserveSpacing(text: string): string {
  return text.replace(/^ +| {2,}/gmu, (run) =>
    NO_BREAK_SPACE.repeat(run.length),
  );
}

export function toolCallStartEvents(
  event: CotToolCallActivity,
): FeishuCotEventInput[] {
  const toolCallId = opaqueDisplayId('call', event.id);
  const presentation = toolPresentation(event);
  return [
    checkedEvent({
      eventType: 'TOOL_CALL_START',
      content: {
        toolCallId,
        toolCallName: presentation.toolCallName,
        icon: presentation.icon,
        ...(presentation.title === undefined
          ? {}
          : { title: truncateEscaped(presentation.title, TITLE_MAX_BYTES) }),
      },
    }),
    // No row sends `TOOL_CALL_ARGS`: beside a title the client shows the
    // delta nowhere, and a row nothing could title hides it too. What the
    // call was reaches the card as a segment of its result instead.
    checkedEvent({
      eventType: 'TOOL_CALL_END',
      content: { toolCallId },
    }),
  ];
}

/**
 * What came back, as the card shows it: a structured value pretty-printed as
 * a `json` code segment, anything else as plain text — text output stays
 * text, and only what parses as JSON goes into a code segment. The whole text
 * is parsed first and cut last, so a cut never decides what a value was.
 * Plain text keeps ten content lines, then preserves its spacing the way the
 * client keeps it (`preserveSpacing`) before byte fitting. JSON keeps its lines
 * and spaces until byte fitting.
 */
export interface ToolResultOutput {
  readonly kind: 'json' | 'text';
  readonly text: string;
}

export function toolResultOutput(result: JsonValue): ToolResultOutput | null {
  const text = nonEmpty(payloadText(result));
  if (text === null) return null;
  const structured = prettyJson(text);
  if (structured !== null) return { kind: 'json', text: structured };
  let boundary = -1;
  for (let line = 0; line < 10; line += 1) {
    boundary = text.indexOf('\n', boundary + 1);
    if (boundary === -1 || boundary === text.length - 1) {
      return { kind: 'text', text: preserveSpacing(text) };
    }
  }
  return {
    kind: 'text',
    text: preserveSpacing(text.slice(0, boundary + 1) + TRUNCATION_MARKER),
  };
}

/**
 * The heading and divider that separate what was asked from what came back.
 *
 * Its own segment, before the output rather than glued onto it, so it survives
 * whatever the output turns out to be — a `json` code block included.
 */
const RESULT_HEADER = '###### RESULT\n\n---';

/**
 * One row's content, fitted to what a Feishu event may carry.
 *
 * The two variable strings are cut in the order a reader can spare them:
 * output first, then the arguments, each shrunk by what the whole content
 * overshot. Both shrink to their truncation marker at worst, and the fixed
 * labels beside them are a few dozen bytes, so this always converges well
 * inside the budget; `toolCallResultEvents` still measures the finished event.
 */
function toolResultContent(
  failed: boolean,
  argumentCode: CotCodeSegment | null,
  output: ToolResultOutput | null,
): unknown {
  const maxBytes =
    FEISHU_COT_EVENT_CONTENT_MAX_BYTES - EVENT_CONTENT_RESERVE_BYTES;
  let code = argumentCode;
  let result = output;
  let content = toolResultSegments(failed, code, result);

  if (jsonBytes(content) > maxBytes && result !== null) {
    result = {
      kind: result.kind,
      text: shrinkForContentBudget(result.text, jsonBytes(content) - maxBytes),
    };
    content = toolResultSegments(failed, code, result);
  }
  if (jsonBytes(content) > maxBytes && code !== null) {
    code = {
      language: code.language,
      code: shrinkForContentBudget(code.code, jsonBytes(content) - maxBytes),
    };
    content = toolResultSegments(failed, code, result);
  }
  return content;
}

/**
 * What an expanded row shows, in the order it happened: what was asked, then
 * the RESULT heading and divider, then what came back. Without output, Complete or Failed
 * fills that area; actual output needs no additional status line.
 */
function toolResultSegments(
  failed: boolean,
  argumentCode: CotCodeSegment | null,
  result: ToolResultOutput | null,
): unknown {
  const segments: Array<Record<string, unknown>> = [];
  if (argumentCode !== null) {
    segments.push({
      type: 'code',
      language: argumentCode.language,
      code: argumentCode.code,
    });
  }
  segments.push({ type: 'text', text: RESULT_HEADER });
  if (result !== null) {
    segments.push(
      result.kind === 'json'
        ? { type: 'code', language: 'json', code: result.text }
        : { type: 'text', text: result.text },
    );
  } else {
    segments.push({ type: 'text', text: failed ? 'Failed' : 'Complete' });
  }
  return segments;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export function toolCallResultEvents(
  event: CotToolCallActivity,
): FeishuCotEventInput[] {
  const messageId = opaqueDisplayId('result', event.id);
  const toolCallId = opaqueDisplayId('call', event.id);
  const presentation = toolPresentation(event);
  const failed = event.status === 'failed';
  const statusText = failed ? 'Failed' : 'Completed';
  // A call that named the things it was about is presented by those pills
  // alone, whatever its status: they already say what it touched, and the
  // client cannot fold a code segment away beside them, so a diff and an
  // output below them would bury the row that was supposed to be a glance.
  const content: unknown =
    presentation.items !== null
      ? { type: 'list', ...presentation.items }
      : toolResultContent(
          failed,
          presentation.arguments,
          toolResultOutput(
            failed ? (event.error ?? event.result) : event.result,
          ),
        );
  const projected = {
    eventType: 'TOOL_CALL_RESULT',
    content: {
      messageId,
      toolCallId,
      content,
      role: 'tool',
    },
  } satisfies FeishuCotEventInput;

  if (cotEventContentBytes(projected) <= FEISHU_COT_EVENT_CONTENT_MAX_BYTES) {
    return [checkedEvent(projected)];
  }
  return [
    checkedEvent({
      eventType: 'TOOL_CALL_RESULT',
      content: {
        messageId,
        toolCallId,
        content: { type: 'text', text: statusText },
        role: 'tool',
      },
    }),
  ];
}
