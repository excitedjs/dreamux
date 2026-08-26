/**
 * Projects Core-sanitized dispatcher and TeamLeader conversation activity into
 * Feishu COT AG-UI events. Core owns generic safety processing. This layer only
 * selects presentation content and enforces Feishu event and batch budgets.
 */
import { createHash } from 'node:crypto';

import type {
  ChannelTurnToolCallEvent,
  RuntimeToolAction,
} from '@excitedjs/dreamux-types';
import type { FeishuCotEventInput } from '@excitedjs/feishu-transport';

export const FEISHU_COT_EVENT_CONTENT_MAX_BYTES = 4_096;
export const FEISHU_COT_APPEND_MAX_BYTES = 64 * 1_024;

const TEXT_MESSAGE_EVENT_GROUP_MAX_BYTES = 224 * 1_024;
const TOOL_NAME_MAX_BYTES = 80;
const TOOL_ARGUMENTS_SOFT_MAX_BYTES = 512;
const TOOL_RESULT_SOFT_MAX_BYTES = 1_024;
const TOOL_RESULT_CONTENT_RESERVE_BYTES = 256;
const SHORT_TEXT_MAX_BYTES = 120;
const TRUNCATION_MARKER = '…（已截断）';
const COT_EVENT_ENCODING_RESERVE_BYTES = 128;
const COT_REQUEST_ENCODING_RESERVE_BYTES = 512;

export type FeishuCotRunStatus = 'done' | 'interrupted';

export function runStartedEvent(presentationId: string): FeishuCotEventInput {
  return checkedEvent({
    eventType: 'RUN_STARTED',
    content: { threadId: presentationId, runId: presentationId },
  });
}

export function runFinishedEvent(
  presentationId: string,
  status: FeishuCotRunStatus,
): FeishuCotEventInput {
  return checkedEvent({
    eventType: 'RUN_FINISHED',
    content: { threadId: presentationId, runId: presentationId, status },
  });
}

export function textMessageEvents(input: {
  readonly sourceId: string;
  readonly role: 'assistant' | 'user';
  readonly content: string;
}): FeishuCotEventInput[] {
  if (input.content.trim() === '') return [];
  const messageId = opaqueDisplayId('message', input.sourceId);
  const start = checkedEvent({
    eventType: 'TEXT_MESSAGE_START',
    content: { messageId, role: input.role },
  });
  const end = checkedEvent({
    eventType: 'TEXT_MESSAGE_END',
    content: { messageId },
  });
  const contentEvents = splitForEventContent(
    input.content,
    (delta) => ({ messageId, delta }),
  ).map((content) => checkedEvent({
    eventType: 'TEXT_MESSAGE_CONTENT',
    content,
  }));
  if (contentEvents.length === 0) return [];
  return boundedTextMessageEventGroup(start, contentEvents, end, messageId);
}

export function toolCallStartEvents(
  event: ChannelTurnToolCallEvent,
  channelId?: string,
): FeishuCotEventInput[] {
  const toolCallId = opaqueDisplayId('call', event.call_id);
  const presentation = toolPresentation(event, channelId);
  const events = [
    checkedEvent({
      eventType: 'TOOL_CALL_START',
      content: {
        toolCallId,
        toolCallName: presentation.toolCallName,
        ...(presentation.icon === undefined ? {} : { icon: presentation.icon }),
        ...(presentation.title === undefined ? {} : { title: presentation.title }),
      },
    }),
  ];
  if (presentation.ownedTool === null && presentation.builtInTool === null) {
    const args = normalizedDetail(
      event.arguments_json,
      event.arguments_truncated,
      TOOL_ARGUMENTS_SOFT_MAX_BYTES,
    );
    if (args !== null) {
      events.push(checkedEvent({
        eventType: 'TOOL_CALL_ARGS',
        content: { toolCallId, delta: args },
      }));
    }
  }
  events.push(checkedEvent({
    eventType: 'TOOL_CALL_END',
    content: { toolCallId },
  }));
  return events;
}

export function toolCallResultEvents(
  event: ChannelTurnToolCallEvent,
  channelId?: string,
): FeishuCotEventInput[] {
  const messageId = opaqueDisplayId('result', event.event_id);
  const toolCallId = opaqueDisplayId('call', event.call_id);
  const presentation = toolPresentation(event, channelId);
  const statusText = event.status === 'failed' ? '执行失败' : '执行完成';
  let content: unknown;
  if (presentation.ownedTool !== null) {
    content = { type: 'text', text: statusText };
  } else if (presentation.builtInTool !== null) {
    content = assembleToolResultContent({
      failed: event.status === 'failed',
      argumentsText: null,
      resultText: normalizedDetail(
        presentation.builtInTool.resultText,
        false,
        FEISHU_COT_EVENT_CONTENT_MAX_BYTES,
      ),
      resultLanguage: presentation.builtInTool.resultLanguage,
      forceResultCode: presentation.builtInTool.forceResultCode,
    });
  } else {
    content = assembleToolResultContent({
      failed: event.status === 'failed',
      argumentsText: null,
      resultText: normalizedDetail(
        event.result_json,
        event.result_truncated,
        TOOL_RESULT_SOFT_MAX_BYTES,
      ),
    });
  }
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

/** Serialized content size checked before any event reaches an outbox. */
export function cotEventContentBytes(event: FeishuCotEventInput): number {
  return Buffer.byteLength(JSON.stringify(event.content), 'utf8');
}

/**
 * Conservative encoded-size estimate used for outbox and append bounds.
 * Transport owns the private request envelope; fixed reserves cover its
 * framing without reproducing that wire shape here.
 */
export function cotEventBytes(event: FeishuCotEventInput): number {
  const semanticContent = JSON.stringify(event.content);
  return jsonBytes(event.eventType) + jsonBytes(semanticContent) +
    COT_EVENT_ENCODING_RESERVE_BYTES;
}

export function cotAppendBatchBytes(
  input: {
    readonly cotId: string;
    readonly messageId: string;
    readonly events: readonly FeishuCotEventInput[];
  },
): number {
  return input.events.reduce((total, event) => total + cotEventBytes(event), 0) +
    jsonBytes(input.messageId) + jsonBytes(input.cotId) +
    COT_REQUEST_ENCODING_RESERVE_BYTES;
}

function checkedEvent(event: FeishuCotEventInput): FeishuCotEventInput {
  if (cotEventContentBytes(event) > FEISHU_COT_EVENT_CONTENT_MAX_BYTES) {
    throw new Error('Feishu COT projector produced oversized event content');
  }
  return event;
}

function opaqueDisplayId(kind: string, source: string): string {
  const digest = createHash('sha256')
    .update(kind)
    .update('\0')
    .update(source)
    .digest('base64url')
    .slice(0, 18);
  return `${kind}-${digest}`;
}

function displayToolName(toolName: string): string {
  const leaf = toolName
    .split(/(?:__|[.:/\\])/)
    .filter((part) => part !== '')
    .at(-1)
    ?.trim();
  return truncateUtf8(
    leaf === undefined || leaf === '' ? '工具' : leaf,
    TOOL_NAME_MAX_BYTES,
  );
}

type OwnedTool = 'reply' | 'react' | 'list_chat_bots';
type TeammateTool = 'spawn' | 'send' | 'close' | 'workflow_run';

interface BuiltInToolPresentation {
  readonly title: string;
  readonly resultText: string;
  readonly resultLanguage: 'text' | 'javascript';
  readonly forceResultCode: boolean;
}

interface ToolPresentation {
  readonly toolCallName: string;
  readonly icon?: 'search' | 'bash' | 'read' | 'write' | 'default';
  readonly title?: string;
  readonly ownedTool: OwnedTool | null;
  readonly builtInTool: BuiltInToolPresentation | null;
}

const ACTION_TOOL_NAMES: Readonly<Record<RuntimeToolAction, string>> = {
  read: 'Read',
  list_files: 'List',
  search: 'Search',
  edit: 'Edit',
  run: 'Bash',
};

const OWNED_TOOL_PRESENTATION: Readonly<Record<
  OwnedTool,
  Pick<ToolPresentation, 'icon' | 'title'>
>> = {
  reply: { icon: 'write', title: '回复飞书消息' },
  react: { icon: 'default', title: '点击飞书表情' },
  list_chat_bots: {
    icon: 'search',
    title: '查看群机器人',
  },
};

function toolPresentation(
  event: ChannelTurnToolCallEvent,
  channelId: string | undefined,
): ToolPresentation {
  const toolCallName = displayToolName(event.tool_name);
  const ownedTool = ownedFeishuTool(event.tool_name, channelId);
  if (ownedTool !== null) {
    return {
      toolCallName,
      ...OWNED_TOOL_PRESENTATION[ownedTool],
      ownedTool,
      builtInTool: null,
    };
  }
  const builtInTool = builtInToolPresentation(event);
  if (builtInTool !== null) {
    return {
      toolCallName,
      title: builtInTool.title,
      ownedTool: null,
      builtInTool,
    };
  }
  return {
    toolCallName: event.tool_action === null
      ? toolCallName
      : ACTION_TOOL_NAMES[event.tool_action],
    ownedTool: null,
    builtInTool: null,
  };
}

function ownedFeishuTool(
  toolName: string,
  channelId: string | undefined,
): OwnedTool | null {
  let server: string | null = null;
  let leaf: string | null = null;
  const mcpParts = toolName.split('__');
  if (mcpParts.length === 3 && mcpParts[0] === 'mcp') {
    [, server, leaf] = mcpParts;
  } else {
    const separator = toolName.lastIndexOf('.');
    if (separator > 0 && separator < toolName.length - 1) {
      server = toolName.slice(0, separator);
      leaf = toolName.slice(separator + 1);
    }
  }
  if (server !== 'feishu' && (channelId === undefined || server !== channelId)) {
    return null;
  }
  return leaf === 'reply' || leaf === 'react' || leaf === 'list_chat_bots'
    ? leaf
    : null;
}

function builtInToolPresentation(
  event: ChannelTurnToolCallEvent,
): BuiltInToolPresentation | null {
  const tool = teammateTool(event.tool_name);
  if (
    tool === null ||
    event.arguments_truncated ||
    event.arguments_json === null
  ) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.arguments_json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const args = parsed as Record<string, unknown>;
  if (tool === 'spawn') {
    const namePrefix = nonBlankString(args['name_prefix']);
    const prompt = nonBlankString(args['prompt']);
    const intent = stringValue(args['intent']);
    const agentRuntime = optionalString(args['agent_runtime']);
    const identity = optionalString(args['identity']);
    if (
      namePrefix === null ||
      prompt === null ||
      intent === null ||
      agentRuntime === null ||
      identity === null
    ) {
      return null;
    }
    const displayIntent = boundedTitleText(intent);
    return {
      title: displayIntent === '' ? '分派成员' : `分派成员 ${displayIntent}`,
      resultText: [
        `Agent Runtime：${agentRuntime === undefined || agentRuntime.trim() === ''
          ? '未指定'
          : agentRuntime}`,
        `Identity：${identity === undefined || identity.trim() === ''
          ? '未指定'
          : identity}`,
        `Prompt：${prompt}`,
      ].join('\n'),
      resultLanguage: 'text',
      forceResultCode: false,
    };
  }
  if (tool === 'send') {
    const name = nonBlankString(args['name']);
    const prompt = nonBlankString(args['prompt']);
    if (name === null || prompt === null) return null;
    return {
      title: `发送消息 → ${boundedTitleText(name)}`,
      resultText: `目标：${name}\nPrompt：${prompt}`,
      resultLanguage: 'text',
      forceResultCode: false,
    };
  }
  if (tool === 'close') {
    const name = nonBlankString(args['name']);
    const note = nonBlankString(args['note']);
    if (name === null || note === null) return null;
    return {
      title: `关闭成员 ${boundedTitleText(name)}`,
      resultText: note,
      resultLanguage: 'text',
      forceResultCode: false,
    };
  }
  const script = nonBlankString(args['script']);
  const scriptPath = nonBlankString(args['scriptPath']);
  const resultText = script ?? scriptPath;
  if (resultText === null) return null;
  const workflowName = script === null ? null : workflowMetaName(script);
  return {
    title: workflowName === null
      ? 'Workflow'
      : `Workflow ${boundedTitleText(workflowName)}`,
    resultText,
    resultLanguage: script === null ? 'text' : 'javascript',
    forceResultCode: script !== null,
  };
}

function teammateTool(toolName: string): TeammateTool | null {
  const prefixes = ['mcp__teammate__', 'teammate.'] as const;
  const prefix = prefixes.find((candidate) => toolName.startsWith(candidate));
  if (prefix === undefined) return null;
  const verb = toolName.slice(prefix.length);
  return verb === 'spawn' || verb === 'send' || verb === 'close' ||
    verb === 'workflow_run'
    ? verb
    : null;
}

function nonBlankString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function optionalString(value: unknown): string | null | undefined {
  return value === undefined || typeof value === 'string' ? value : null;
}

function boundedTitleText(value: string): string {
  return normalizedDetail(value, false, TOOL_ARGUMENTS_SOFT_MAX_BYTES)?.trim() ?? '';
}

function workflowMetaName(script: string): string | null {
  const match = /\bexport\s+const\s+meta\s*=\s*\{[^}]*?\bname\s*:\s*(['"])([^'"\\\r\n]+)\1/u
    .exec(script);
  const name = match?.[2]?.trim();
  return name === undefined || name === '' ? null : name;
}

function normalizedDetail(
  value: string | null,
  sourceTruncated: boolean,
  softMaxBytes: number,
): string | null {
  if (value === null || value === '') return null;
  // Preserve provider detail verbatim here; the escaped-byte budget below
  // remains the authoritative safety boundary for display payload size.
  const normalized = value;
  if (normalized === '') return null;
  if (!sourceTruncated && escapedBytes(normalized) <= softMaxBytes) return normalized;
  return truncateEscaped(normalized, softMaxBytes, true);
}

export interface ToolResultParts {
  readonly failed: boolean;
  readonly argumentsText: string | null;
  readonly resultText: string | null;
  readonly resultLanguage?: 'text' | 'javascript';
  readonly forceResultCode?: boolean;
}

export function assembleToolResultContent(parts: ToolResultParts): unknown {
  let argumentsText = parts.argumentsText;
  let resultText = parts.resultText;
  const maxBytes = FEISHU_COT_EVENT_CONTENT_MAX_BYTES -
    TOOL_RESULT_CONTENT_RESERVE_BYTES;
  let content = toolResultSegments(parts, argumentsText, resultText);

  if (jsonBytes(content) > maxBytes && resultText !== null) {
    resultText = shrinkForContentBudget(
      resultText,
      jsonBytes(content) - maxBytes,
    );
    content = toolResultSegments(parts, argumentsText, resultText);
  }
  if (jsonBytes(content) > maxBytes && argumentsText !== null) {
    argumentsText = shrinkForContentBudget(
      argumentsText,
      jsonBytes(content) - maxBytes,
    );
    content = toolResultSegments(parts, argumentsText, resultText);
  }
  if (jsonBytes(content) > maxBytes) {
    resultText = null;
    content = toolResultSegments(parts, argumentsText, resultText);
  }
  if (jsonBytes(content) > maxBytes) {
    argumentsText = null;
    content = toolResultSegments(parts, argumentsText, resultText);
  }
  if (jsonBytes(content) > maxBytes) {
    return { type: 'text', text: parts.failed ? '执行失败' : '执行完成' };
  }
  return content;
}

function toolResultSegments(
  parts: ToolResultParts,
  argumentsText: string | null,
  resultText: string | null,
): unknown {
  const segments: Array<Record<string, unknown>> = [];
  if (parts.failed) segments.push({ type: 'text', text: '执行失败' });
  if (argumentsText !== null) {
    segments.push({ type: 'code', language: 'text', content: argumentsText });
  }
  if (resultText !== null) {
    segments.push({
      type: 'code',
      language: parts.resultLanguage ?? 'text',
      content: resultText,
    });
  }
  if (segments.length === 0) {
    return { type: 'text', text: parts.failed ? '执行失败' : '执行完成' };
  }
  if (segments.length === 1) {
    const onlyText = argumentsText ?? resultText;
    if (
      onlyText !== null &&
      !parts.forceResultCode &&
      !onlyText.includes('\n') &&
      Buffer.byteLength(onlyText, 'utf8') <= SHORT_TEXT_MAX_BYTES
    ) {
      return { type: 'text', text: onlyText };
    }
    return segments[0];
  }
  return segments;
}

function shrinkForContentBudget(value: string, overflowBytes: number): string {
  const target = Math.max(
    escapedBytes(TRUNCATION_MARKER),
    escapedBytes(value) - overflowBytes - 32,
  );
  return truncateEscaped(value, target);
}

function truncateEscaped(
  value: string,
  maxBytes: number,
  forceMarker = false,
): string {
  const valueBytes = escapedBytes(value);
  if (!forceMarker && valueBytes <= maxBytes) return value;
  const markerBytes = escapedBytes(TRUNCATION_MARKER);
  if (
    forceMarker &&
    value.endsWith(TRUNCATION_MARKER) &&
    valueBytes <= maxBytes
  ) {
    return value;
  }
  if (forceMarker && valueBytes + markerBytes <= maxBytes) {
    return `${value}${TRUNCATION_MARKER}`;
  }
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

function escapedBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value).slice(1, -1), 'utf8');
}

function splitForEventContent(
  text: string,
  content: (chunk: string) => Record<string, unknown>,
): Record<string, unknown>[] {
  const emptyBytes = jsonBytes(content(''));
  const payloadBudget = FEISHU_COT_EVENT_CONTENT_MAX_BYTES - emptyBytes;
  if (payloadBudget <= 0) return [];
  const chunks: string[] = [];
  let characters: string[] = [];
  let bytes = 0;
  for (const character of text) {
    const escaped = JSON.stringify(character).slice(1, -1);
    const characterBytes = Buffer.byteLength(escaped, 'utf8');
    if (characters.length > 0 && bytes + characterBytes > payloadBudget) {
      chunks.push(characters.join(''));
      characters = [];
      bytes = 0;
    }
    if (characterBytes > payloadBudget) continue;
    characters.push(character);
    bytes += characterBytes;
  }
  if (characters.length > 0) chunks.push(characters.join(''));
  return chunks.map(content);
}

function boundedTextMessageEventGroup(
  start: FeishuCotEventInput,
  contentEvents: readonly FeishuCotEventInput[],
  end: FeishuCotEventInput,
  messageId: string,
): FeishuCotEventInput[] {
  const boundaryBytes = cotEventBytes(start) + cotEventBytes(end);
  let bytes = boundaryBytes;
  const accepted: FeishuCotEventInput[] = [];
  for (const event of contentEvents) {
    const eventBytes = cotEventBytes(event);
    if (bytes + eventBytes > TEXT_MESSAGE_EVENT_GROUP_MAX_BYTES) break;
    accepted.push(event);
    bytes += eventBytes;
  }
  if (accepted.length === contentEvents.length) return [start, ...accepted, end];

  const marker = checkedEvent({
    eventType: 'TEXT_MESSAGE_CONTENT',
    content: { messageId, delta: TRUNCATION_MARKER },
  });
  const markerBytes = cotEventBytes(marker);
  while (
    accepted.length > 0 &&
    bytes + markerBytes > TEXT_MESSAGE_EVENT_GROUP_MAX_BYTES
  ) {
    const removed = accepted.pop();
    if (removed !== undefined) bytes -= cotEventBytes(removed);
  }
  return [start, ...accepted, marker, end];
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

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
