import type { RuntimeActivity } from '@excitedjs/dreamux-types';
import type { ThreadItem } from './types.js';

export interface ReasoningDelta {
  turnId: string;
  itemId: string;
  carrier: 'summary' | 'content';
  partIndex: number;
  text: string;
}

interface ReasoningItem {
  carrier: 'summary' | 'content';
  parts: Set<number>;
}

/** Live native parts only; completion snapshots never replay streamed text. */
export class CodexReasoningActivity {
  private readonly turns = new Map<string, Map<string, ReasoningItem>>();

  constructor(private readonly emit: (activity: RuntimeActivity) => void) {}

  delta(delta: ReasoningDelta): void {
    if (delta.text === '') return;
    const item = this.item(delta.turnId, delta.itemId, delta.carrier);
    if (item.carrier !== delta.carrier) return;
    item.parts.add(delta.partIndex);
    this.publish(delta.itemId, delta.partIndex, delta.text, 'streaming');
  }

  complete(turnId: string, snapshot: ThreadItem, occurredAt: number): void {
    const summary = textParts(snapshot['summary']);
    const content = textParts(snapshot['content']);
    const items = this.turns.get(turnId);
    const item = items?.get(snapshot.id);
    const carrier =
      item?.carrier ??
      (summary.some((text) => text !== '') ? 'summary' : 'content');
    const parts = carrier === 'summary' ? summary : content;
    for (const [partIndex, text] of parts.entries()) {
      const streamed = item?.parts.delete(partIndex) ?? false;
      if (!streamed && text === '') continue;
      this.publish(
        snapshot.id,
        partIndex,
        streamed ? '' : text,
        'completed',
        occurredAt,
      );
    }
    if (item !== undefined) this.closeItem(snapshot.id, item, occurredAt);
    // item/completed is the native item's terminal; there is no replay ledger.
    items?.delete(snapshot.id);
    if (items?.size === 0) this.turns.delete(turnId);
  }

  closeTurn(turnId: string): void {
    const items = this.turns.get(turnId);
    if (items === undefined) return;
    for (const [id, item] of items) this.closeItem(id, item);
    this.turns.delete(turnId);
  }

  close(): void {
    for (const turnId of this.turns.keys()) this.closeTurn(turnId);
  }

  private item(
    turnId: string,
    id: string,
    carrier: ReasoningItem['carrier'],
  ): ReasoningItem {
    let items = this.turns.get(turnId);
    if (items === undefined) {
      items = new Map();
      this.turns.set(turnId, items);
    }
    let item = items.get(id);
    if (item === undefined) {
      item = { carrier, parts: new Set() };
      items.set(id, item);
    }
    return item;
  }

  private closeItem(
    id: string,
    item: ReasoningItem,
    occurredAt = Date.now(),
  ): void {
    for (const partIndex of item.parts)
      this.publish(id, partIndex, '', 'completed', occurredAt);
  }

  private publish(
    id: string,
    partIndex: number,
    text: string,
    status: 'streaming' | 'completed',
    occurredAt = Date.now(),
  ): void {
    this.emit({
      kind: 'assistant.reasoning',
      id,
      partIndex,
      text,
      status,
      occurredAt,
    });
  }
}

function textParts(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((part) => (typeof part === 'string' ? part : ''))
    : [];
}
