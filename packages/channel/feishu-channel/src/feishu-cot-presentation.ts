/**
 * What a COT card shows for a tool call, and the byte bounding every card
 * string shares. Core owns generic safety processing; this module owns display
 * text — deriving it from one tool call, and keeping it inside Feishu's
 * per-event content budget. Building the events themselves is
 * `feishu-cot-events.ts`, which is this module's only caller.
 */
import type {
  RuntimeToolAction,
  TeammateActivity,
} from '@excitedjs/dreamux-types';

/** The one activity member this presentation layer renders. */
export type CotToolCallActivity = Extract<TeammateActivity, { kind: 'tool.call' }>;

export const TOOL_ARGUMENTS_SOFT_MAX_BYTES = 512;
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

type OwnedTool = 'reply' | 'react' | 'list_chat_bots';
type TeammateTool = 'spawn' | 'send' | 'close' | 'workflow_run';

interface BuiltInToolPresentation {
  readonly title: string;
  readonly resultText: string;
  readonly resultLanguage: 'text' | 'javascript';
  readonly forceResultCode: boolean;
}

/**
 * What the runtime said about its own call, ready for the card: the row's
 * title composed from the runtime's summary, the invocation the expanded
 * row shows in the caller's notation instead of as JSON, and the items the
 * call was about as the pills of a `list` segment.
 */
interface RuntimeToolPresentation {
  readonly invocation: string | null;
  readonly invocationLanguage: 'text' | 'bash';
  readonly items: CotItemList | null;
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

interface ToolPresentation {
  readonly toolCallName: string;
  readonly icon?: CotToolIcon;
  readonly title?: string;
  readonly ownedTool: OwnedTool | null;
  readonly builtInTool: BuiltInToolPresentation | null;
  readonly runtimeTool: RuntimeToolPresentation | null;
}

/**
 * The built-in icons the COT Message Brief documents for `TOOL_CALL_START.icon`
 * (`search`, `bash`, `read`, `write`, `doc`, `calendar`, `task`, `meeting`,
 * `default`); this Channel uses the ones a runtime's tool actions map onto.
 */
export type CotToolIcon = 'search' | 'bash' | 'read' | 'write' | 'default';

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

const OWNED_TOOL_PRESENTATION: Readonly<Record<
  OwnedTool,
  Pick<ToolPresentation, 'icon' | 'title'>
>> = {
  reply: { icon: 'write', title: 'Reply on Feishu' },
  react: { icon: 'default', title: 'React on Feishu' },
  list_chat_bots: {
    icon: 'search',
    title: 'List chat bots',
  },
};

export function toolPresentation(
  event: CotToolCallActivity,
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
      runtimeTool: null,
    };
  }
  const builtInTool = builtInToolPresentation(event);
  if (builtInTool !== null) {
    return {
      toolCallName,
      title: builtInTool.title,
      ownedTool: null,
      builtInTool,
      runtimeTool: null,
    };
  }
  const actionName = event.tool_action === null
    ? toolCallName
    : ACTION_TOOL_NAMES[event.tool_action];
  const title = runtimeToolTitle(event, actionName);
  return {
    toolCallName: actionName,
    ...(event.tool_action === null ? {} : { icon: ACTION_ICONS[event.tool_action] }),
    ...(title === null ? {} : { title }),
    ownedTool: null,
    builtInTool: null,
    runtimeTool: {
      invocation: normalizedDetail(
        event.invocation,
        event.invocation_truncated,
        TOOL_ARGUMENTS_SOFT_MAX_BYTES,
      ),
      invocationLanguage: event.tool_action === 'run' ? 'bash' : 'text',
      items: itemList(event),
    },
  };
}

/**
 * The call's items as pills, each with the icon of the call's action, kept
 * within `TOOL_ITEMS_SOFT_MAX_BYTES` so a patch over many files leaves room
 * for its diff: the pills that fit, then one `+N` pill for the rest.
 */
function itemList(event: CotToolCallActivity): CotItemList | null {
  if (event.items.length === 0) return null;
  const icon = event.tool_action === null ? undefined : ACTION_ICONS[event.tool_action];
  const items: CotListItem[] = [];
  let bytes = 0;
  for (const [index, item] of event.items.entries()) {
    bytes += escapedBytes(item);
    if (bytes > TOOL_ITEMS_SOFT_MAX_BYTES) {
      return { items, more: { text: `+${event.items.length - index}` } };
    }
    items.push(icon === undefined ? { text: item } : { text: item, icon });
  }
  return { items };
}

function runtimeToolTitle(event: CotToolCallActivity, actionName: string): string | null {
  if (event.summary === null) return null;
  const summary = boundedTitleText(event.summary);
  if (summary === '') return null;
  return event.tool_action === null
    ? `${actionName}: ${summary}`
    : `${ACTION_VERBS[event.tool_action]}${summary}`;
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
  // Core names a Channel MCP server from the configured channel id, so accept
  // both the bare id and the namespaced form it is injected under.
  if (
    server !== 'feishu' &&
    (channelId === undefined ||
      (server !== channelId && server !== `channel-${channelId}`))
  ) {
    return null;
  }
  return leaf === 'reply' || leaf === 'react' || leaf === 'list_chat_bots'
    ? leaf
    : null;
}

function builtInToolPresentation(
  event: CotToolCallActivity,
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
      title: displayIntent === '' ? 'Spawn teammate' : `Spawn teammate: ${displayIntent}`,
      resultText: [
        `Agent runtime: ${agentRuntime === undefined || agentRuntime.trim() === ''
          ? 'unspecified'
          : agentRuntime}`,
        `Identity: ${identity === undefined || identity.trim() === ''
          ? 'unspecified'
          : identity}`,
        `Prompt: ${prompt}`,
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
      title: `Send to ${boundedTitleText(name)}`,
      resultText: `To: ${name}\nPrompt: ${prompt}`,
      resultLanguage: 'text',
      forceResultCode: false,
    };
  }
  if (tool === 'close') {
    const name = nonBlankString(args['name']);
    const note = nonBlankString(args['note']);
    if (name === null || note === null) return null;
    return {
      title: `Close teammate ${boundedTitleText(name)}`,
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

export function normalizedDetail(
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

export function truncateEscaped(
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
