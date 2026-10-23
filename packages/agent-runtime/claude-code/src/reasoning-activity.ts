import type { AgentRuntimeEventSink } from '@excitedjs/dreamux-types';
import { isPlainObject, nonEmptyString } from '@excitedjs/dreamux-utils';
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
    const event = raw['event'];
    if (!isPlainObject(event)) return;
    if (event['type'] === 'message_start') {
      const message = event['message'];
      const id = isPlainObject(message)
        ? nonEmptyString(message['id'])
        : undefined;
      if (this.currentId !== null) this.closeMessage(this.currentId);
      this.currentId = id ?? null;
      if (id !== undefined && !this.messages.has(id))
        this.messages.set(id, { blocks: new Map(), activeIndex: null });
      return;
    }
    // New CLI builds also carry the API id on partial envelopes, including
    // synthetic stops for responses cut short before an assistant snapshot.
    const abandoned = raw['abandoned_blocks'];
    const id =
      nonEmptyString(raw['api_message_id']) ??
      (isPlainObject(abandoned)
        ? nonEmptyString(abandoned['api_message_id'])
        : undefined) ??
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
      const block = event['content_block'];
      if (!isPlainObject(block) || typeof block['type'] !== 'string') return;
      ensureBlock(message, index, block['type']);
      message.activeIndex = index;
      if (block['type'] === 'thinking')
        this.delta(id, index, block['thinking']);
    } else if (event['type'] === 'content_block_delta') {
      const delta = event['delta'];
      if (isPlainObject(delta) && delta['type'] === 'thinking_delta') {
        ensureBlock(message, index, 'thinking');
        this.delta(id, index, delta['thinking']);
      }
    } else if (event['type'] === 'content_block_stop') {
      this.closeBlock(id, index);
      if (message.activeIndex === index) message.activeIndex = null;
    }
  }

  snapshot(raw: JsonObject, offset: number): void {
    const message = raw['message'];
    if (!isPlainObject(message)) return;
    const content = message['content'];
    if (!Array.isArray(content)) return;
    const block = content[offset];
    if (!isPlainObject(block)) return;
    const id = nonEmptyString(message['id']);
    const native = id === undefined ? undefined : this.messages.get(id);
    if (native === undefined || id === undefined) {
      // No partial context: the envelope UUID and its own array positions
      // are native identities too. Never synthesize an API block index.
      const uuid = nonEmptyString(raw['uuid']);
      const thinking = nonEmptyString(block['thinking']);
      if (
        uuid !== undefined &&
        block['type'] === 'thinking' &&
        thinking !== undefined
      )
        this.publish(uuid, offset, thinking, 'completed');
      return;
    }
    const index = this.snapshotIndex(native, block['type']);
    if (index === undefined) return;
    const known = native.blocks.get(index)!;
    known.snapshot = true;
    if (known.type !== 'thinking') return;
    const thinking = nonEmptyString(block['thinking']);
    if (known.status === 'unseen' && thinking !== undefined) {
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

function ensureBlock(
  message: NativeMessage,
  index: number,
  type: string,
): void {
  if (!message.blocks.has(index))
    message.blocks.set(index, { type, status: 'unseen', snapshot: false });
}
