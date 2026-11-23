import type {
  SessionNotification,
  ToolCall,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import type {
  AgentRuntimeEventSink,
  JsonValue,
  RuntimeToolAction,
} from '@excitedjs/dreamux-types';

type NativeTool = ToolCall | ToolCallUpdate;

/** Live ACP objects only: their identifiers are supplied by the agent. */
export class AcpActivity {
  private readonly messages = new Map<string, string>();
  private readonly tools = new Map<string, NativeTool>();
  private readonly runningTools = new Set<string>();
  private readonly failedTools = new Set<string>();
  private currentMessage: string | null = null;

  constructor(private readonly events: AgentRuntimeEventSink) {}

  update(notification: SessionNotification): string | null {
    const update = notification.update;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        if (update.content.type !== 'text') return null;
        const id = update.messageId;
        if (id) {
          if (this.currentMessage && this.currentMessage !== id)
            this.finishMessage(this.currentMessage);
          this.currentMessage = id;
          this.messages.set(
            id,
            (this.messages.get(id) ?? '') + update.content.text,
          );
        }
        return update.content.text;
      }
      case 'tool_call':
      case 'tool_call_update':
        this.tool(update);
        break;
      case 'session_info_update':
        if (typeof update.title === 'string') {
          this.events({ kind: 'session.title.changed', title: update.title });
        }
        break;
      case 'compaction_update':
        if (update.status === 'completed' && update.compactionId) {
          this.events({
            kind: 'context.compacted',
            occurredAt: Date.now(),
            id: update.compactionId,
          });
        }
        break;
      default:
        break;
    }
    return null;
  }

  finishMessages(): void {
    for (const id of this.messages.keys()) this.finishMessage(id);
    this.currentMessage = null;
  }

  discardMessages(): void {
    this.messages.clear();
    this.currentMessage = null;
  }

  reset(): void {
    this.discardMessages();
    this.tools.clear();
    this.runningTools.clear();
    this.failedTools.clear();
  }

  hasRunningTools(): boolean {
    return this.runningTools.size > 0;
  }

  hasFailedTools(): boolean {
    return this.failedTools.size > 0;
  }

  clearFailedTools(): void {
    this.failedTools.clear();
  }

  private finishMessage(id: string): void {
    const text = this.messages.get(id);
    if (text)
      this.events({
        kind: 'assistant.message',
        occurredAt: Date.now(),
        id,
        text,
      });
    this.messages.delete(id);
  }

  private tool(update: NativeTool): void {
    const id = update.toolCallId;
    if (!id) return;
    const previous = this.tools.get(id);
    const current: NativeTool = { ...previous, ...update };
    this.tools.set(id, current);
    if (current.status === 'failed') this.failedTools.add(id);
    else this.failedTools.delete(id);
    if (current.status === 'completed' || current.status === 'failed')
      this.runningTools.delete(id);
    else this.runningTools.add(id);
    const name = current.name;
    if (!name) {
      if (!this.runningTools.has(id)) this.tools.delete(id);
      return;
    }
    const status =
      current.status === 'completed'
        ? 'completed'
        : current.status === 'failed'
          ? 'failed'
          : 'started';
    const rawInput = current.rawInput ?? null;
    const input =
      typeof rawInput === 'object' &&
      rawInput !== null &&
      !Array.isArray(rawInput)
        ? (rawInput as Record<string, unknown>)
        : null;
    const invocation =
      typeof input?.['CommandLine'] === 'string' ? input['CommandLine'] : null;
    this.events({
      kind: 'tool.call',
      occurredAt: Date.now(),
      id,
      toolName: name,
      action: actionFor(current.kind),
      summary: current.title ?? null,
      invocation,
      items: (current.locations ?? []).map((location) => location.path),
      status,
      arguments: rawInput as JsonValue,
      result: (current.rawOutput ?? null) as JsonValue,
      error:
        status === 'failed' && typeof current.rawOutput === 'string'
          ? current.rawOutput
          : null,
    });
    if (status !== 'started') this.tools.delete(id);
  }
}

function actionFor(kind: NativeTool['kind']): RuntimeToolAction | null {
  switch (kind) {
    case 'read':
      return 'read';
    case 'search':
      return 'search';
    case 'edit':
      return 'edit';
    case 'execute':
      return 'run';
    default:
      return null;
  }
}
