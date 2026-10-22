import type { AgentRuntimeEventSink } from '@excitedjs/dreamux-types';
import type { JsonObject } from './types.js';

interface ContentBlock {
  type: string;
  status: 'unseen' | 'streaming' | 'completed';
  snapshot: boolean;
}

interface NativeMessage {
  blocks: Map<number, ContentBlock>;
  activeIndex: number | null;
}

/** Native API message/block correlation, retained only until the turn ends. */
export class ClaudeReasoningActivity {
  private readonly messages = new Map<string, NativeMessage>();
  private currentId: string | null = null;

  constructor(private readonly events: AgentRuntimeEventSink) {}

  stream(raw: JsonObject): void {
    const event = record(raw['event']);
    if (event === null) return;
    if (event['type'] === 'message_start') {
      const id = nonempty(record(event['message'])?.['id']);
      if (this.currentId !== null) this.closeMessage(this.currentId);
      this.currentId = id;
      if (id !== null && !this.messages.has(id))
        this.messages.set(id, { blocks: new Map(), activeIndex: null });
      return;
    }
    // New CLI builds also carry the API id on partial envelopes, including
    // synthetic stops for responses cut short before an assistant snapshot.
    const abandoned = record(raw['abandoned_blocks']);
    const id =
      nonempty(raw['api_message_id']) ??
      nonempty(abandoned?.['api_message_id']) ??
      this.currentId;
    if (id === null) return;
    let message = this.messages.get(id);
    if (message === undefined) {
      message = { blocks: new Map(), activeIndex: null };
      this.messages.set(id, message);
    }
    if (event['type'] === 'message_stop') {
      this.closeMessage(id);
      if (this.currentId === id) this.currentId = null;
      // A synthetic stop's lower blocks may still receive snapshots. Keep
      // closed parts through the native result so those cannot replay deltas.
      return;
    }
    const index = event['index'];
    if (typeof index !== 'number') return;
    if (event['type'] === 'content_block_start') {
      const block = record(event['content_block']);
      if (typeof block?.['type'] !== 'string') return;
      if (!message.blocks.has(index))
        message.blocks.set(index, {
          type: block['type'],
          status: 'unseen',
          snapshot: false,
        });
      message.activeIndex = index;
      if (block['type'] === 'thinking')
        this.delta(id, index, block['thinking']);
    } else if (event['type'] === 'content_block_delta') {
      const delta = record(event['delta']);
      if (delta?.['type'] === 'thinking_delta') {
        if (!message.blocks.has(index))
          message.blocks.set(index, {
            type: 'thinking',
            status: 'unseen',
            snapshot: false,
          });
        this.delta(id, index, delta['thinking']);
      }
    } else if (event['type'] === 'content_block_stop') {
      this.closeBlock(id, index);
      if (message.activeIndex === index) message.activeIndex = null;
    }
  }

  snapshot(raw: JsonObject, offset: number): void {
    const message = record(raw['message']);
    const content = message?.['content'];
    if (!Array.isArray(content)) return;
    const block = record(content[offset]);
    if (block === null) return;
    const id = nonempty(message?.['id']);
    const native = id === null ? undefined : this.messages.get(id);
    if (native === undefined || id === null) {
      // No partial context: the envelope UUID and its own array positions
      // are native identities too. Never synthesize an API block index.
      const uuid = nonempty(raw['uuid']);
      const thinking = nonempty(block['thinking']);
      if (uuid !== null && block['type'] === 'thinking' && thinking !== null)
        this.publish(uuid, offset, thinking, 'completed');
      return;
    }
    const index = this.snapshotIndex(native, block['type']);
    if (index === undefined) return;
    const known = native.blocks.get(index)!;
    known.snapshot = true;
    if (known.type !== 'thinking') return;
    const thinking = nonempty(block['thinking']);
    if (known.status === 'unseen' && thinking !== null) {
      this.publish(id, index, thinking, 'completed');
      known.status = 'completed';
    } else this.closeBlock(id, index);
  }

  close(): void {
    for (const id of this.messages.keys()) this.closeMessage(id);
    this.messages.clear();
    this.currentId = null;
  }

  private snapshotIndex(
    message: NativeMessage,
    type: unknown,
  ): number | undefined {
    // CLI snapshots are normally singleton arrays emitted before block_stop.
    // Their array offset is never the stream index (e.g. thinking at index 2).
    if (
      message.activeIndex !== null &&
      message.blocks.get(message.activeIndex)?.type === type
    )
      return message.activeIndex;
    const matching = [...message.blocks].filter(
      ([, block]) => block.type === type,
    );
    return (matching.find(([, block]) => !block.snapshot) ??
      matching.at(-1))?.[0];
  }

  private delta(id: string, index: number, text: unknown): void {
    const block = this.messages.get(id)?.blocks.get(index);
    if (
      block?.type !== 'thinking' ||
      block.status === 'completed' ||
      typeof text !== 'string' ||
      text === ''
    )
      return;
    block.status = 'streaming';
    this.publish(id, index, text, 'streaming');
  }

  private closeBlock(id: string, index: number): void {
    const block = this.messages.get(id)?.blocks.get(index);
    if (block?.status !== 'streaming') return;
    this.publish(id, index, '', 'completed');
    block.status = 'completed';
  }

  private closeMessage(id: string): void {
    const message = this.messages.get(id);
    if (message === undefined) return;
    for (const index of message.blocks.keys()) this.closeBlock(id, index);
    message.activeIndex = null;
  }

  private publish(
    id: string,
    partIndex: number,
    text: string,
    status: 'streaming' | 'completed',
  ): void {
    this.events(
      Object.freeze({
        kind: 'assistant.reasoning',
        id,
        partIndex,
        text,
        status,
        occurredAt: Date.now(),
      }),
    );
  }
}

function record(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function nonempty(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}
