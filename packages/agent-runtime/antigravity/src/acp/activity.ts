import type {
  PromptResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import type {
  AgentRuntimeEventSink,
  JsonValue,
  RuntimeCompletion,
} from '@excitedjs/dreamux-types';

import {
  isCommandExitFailure,
  toolDisplay,
  toolResult,
  type NativeTool,
} from './tool-display.js';

interface ReasoningBlock {
  readonly id: string;
  readonly nativeId: string | null;
}

interface MessageBlock {
  readonly id: string;
  readonly nativeId: string | null;
  text: string;
}

/**
 * Live ACP activity projection.
 *
 * Uses native identifiers whenever ACP supplies them (`toolCallId`,
 * `compactionId`, `messageId`). When `agy` omits `messageId` on streamed
 * `agent_thought_chunk` or `agent_message_chunk` updates, allocates one
 * monotonic in-memory display block ID per contiguous block so live COT cards
 * still render reasoning and assistant messages without touching cold reads.
 */
export class AcpActivity {
  private readonly tools = new Map<string, NativeTool>();
  private readonly startedTools = new Set<string>();
  private readonly runningTools = new Set<string>();
  private readonly failedTools = new Set<string>();
  private currentMessage: MessageBlock | null = null;
  private currentReasoning: ReasoningBlock | null = null;
  private nextBlockId = 0;

  constructor(private readonly events: AgentRuntimeEventSink) {}

  finishTurn(
    reason: PromptResponse['stopReason'],
    resultText: string | null,
  ): RuntimeCompletion | null {
    this.closeReasoning();
    // Flush an anonymous (ID-less) message block at every native terminal so an
    // overlapping follow-up prompt cannot append into the finished turn's text.
    // Native-ID messages retain their existing overlapping-group flush timing.
    if (this.currentMessage?.nativeId === null) this.flushCurrentMessage();
    if (reason === 'cancelled') {
      this.events({
        kind: 'turn.ended',
        occurredAt: Date.now(),
        status: 'interrupted',
        reason: null,
      });
      return null;
    }
    const completion: RuntimeCompletion = Object.freeze(
      reason === 'end_turn'
        ? { status: 'completed', resultText }
        : {
            status: 'failed',
            error: new Error(`Antigravity ACP stopped: ${reason}`),
          },
    );
    this.events({ kind: 'turn.result', completion });
    this.events({
      kind: 'turn.ended',
      occurredAt: Date.now(),
      status: completion.status,
      reason: completion.status === 'failed' ? completion.error.message : null,
    });
    return completion;
  }

  update(notification: SessionNotification): void {
    const update = notification.update;
    switch (update.sessionUpdate) {
      case 'agent_thought_chunk':
        if (update.content.type === 'text' && update.content.text !== '') {
          this.reasoningChunk(update.messageId ?? null, update.content.text);
        }
        break;
      case 'agent_message_chunk':
        if (update.content.type === 'text' && update.content.text !== '') {
          this.messageChunk(update.messageId ?? null, update.content.text);
        }
        break;
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
  }

  finishMessages(): void {
    this.closeReasoning();
    this.flushCurrentMessage();
  }

  reset(): void {
    this.closeReasoning();
    this.currentMessage = null;
    this.tools.clear();
    this.startedTools.clear();
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

  private reasoningChunk(nativeId: string | null, text: string): void {
    this.flushCurrentMessage();
    const key = nativeId || null;
    if (this.currentReasoning && this.currentReasoning.nativeId !== key) {
      this.closeReasoning();
    }
    this.currentReasoning ??= {
      id: key ?? `acp-reasoning-${++this.nextBlockId}`,
      nativeId: key,
    };
    this.events({
      kind: 'assistant.reasoning',
      occurredAt: Date.now(),
      id: this.currentReasoning.id,
      partIndex: 0,
      text,
      status: 'streaming',
    });
  }

  private closeReasoning(): void {
    if (this.currentReasoning === null) return;
    const id = this.currentReasoning.id;
    this.currentReasoning = null;
    this.events({
      kind: 'assistant.reasoning',
      occurredAt: Date.now(),
      id,
      partIndex: 0,
      text: '',
      status: 'completed',
    });
  }

  private messageChunk(nativeId: string | null, text: string): void {
    this.closeReasoning();
    const key = nativeId || null;
    if (this.currentMessage && this.currentMessage.nativeId !== key) {
      this.flushCurrentMessage();
    }
    this.currentMessage ??= {
      id: key ?? `acp-message-${++this.nextBlockId}`,
      nativeId: key,
      text: '',
    };
    this.currentMessage.text += text;
  }

  private flushCurrentMessage(): void {
    if (this.currentMessage === null) return;
    const { id, text } = this.currentMessage;
    this.currentMessage = null;
    if (text) {
      this.events({
        kind: 'assistant.message',
        occurredAt: Date.now(),
        id,
        text,
      });
    }
  }

  private tool(update: NativeTool): void {
    const id = update.toolCallId;
    if (!id) return;
    const previous = this.tools.get(id);
    // ACP v1 specifies that omitted or null `name` on `tool_call_update`
    // retains the previous name; keep cached display metadata (`title`,
    // `rawInput`, `locations`) under the same null-preserving merge.
    const current: NativeTool = {
      ...previous,
      ...update,
      ...(update.name == null && previous?.name != null
        ? { name: previous.name }
        : {}),
      ...(update.title == null && previous?.title != null
        ? { title: previous.title }
        : {}),
      ...(update.rawInput == null && previous?.rawInput != null
        ? { rawInput: previous.rawInput }
        : {}),
      ...(update.locations == null && previous?.locations != null
        ? { locations: previous.locations }
        : {}),
    };
    this.tools.set(id, current);
    // Keep settlement's permission-cancellation signal tied strictly to native
    // ACP `status: 'failed'`, never ordinary shell exit codes.
    if (current.status === 'failed') this.failedTools.add(id);
    else this.failedTools.delete(id);
    const terminal =
      current.status === 'completed' || current.status === 'failed';
    if (terminal) this.runningTools.delete(id);
    else this.runningTools.add(id);
    const name = current.name;
    if (!name) {
      if (terminal) {
        this.tools.delete(id);
        this.startedTools.delete(id);
      }
      return;
    }
    if (!terminal) {
      if (this.startedTools.has(id)) return;
      this.startedTools.add(id);
    }
    this.closeReasoning();
    this.flushCurrentMessage();
    const status = !terminal
      ? 'started'
      : current.status === 'failed' || isCommandExitFailure(current)
        ? 'failed'
        : 'completed';
    const result = status === 'started' ? null : toolResult(current);
    this.events({
      kind: 'tool.call',
      occurredAt: Date.now(),
      id,
      toolName: name,
      ...toolDisplay(current),
      status,
      arguments: (current.rawInput ?? null) as JsonValue,
      result,
      // Only plain string errors populate `error`; structured failures stay on
      // `result` so Core redacts secret key names via `redactJson` and Feishu
      // renders `event.error ?? event.result`.
      error: status === 'failed' && typeof result === 'string' ? result : null,
    });
    if (terminal) {
      this.tools.delete(id);
      this.startedTools.delete(id);
    }
  }
}
