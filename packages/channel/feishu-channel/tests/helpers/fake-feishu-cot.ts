/**
 * A recording stand-in for the platform COT capability.
 *
 * It is deliberately dumb: it hands back ids, keeps every appended event in
 * arrival order, and remembers which reason completed a card. Everything a COT
 * test asserts — how many cards exist, where each one hangs, what it shows, and
 * how it ended — is read back off these records, so no test needs to know the
 * official wire envelope.
 */
import type {
  FeishuCotAppendInput,
  FeishuCotClient,
  FeishuCotCompleteInput,
  FeishuCotCreateInput,
  FeishuCotCreateResult,
  FeishuCotEventInput,
} from '@excitedjs/feishu-transport';

export interface FakeCotCard {
  readonly cotId: string;
  readonly messageId: string;
  /** Where the card was created: the anchor's chat and visible message. */
  readonly chatId: string;
  readonly originMessageId: string | undefined;
  readonly events: FeishuCotEventInput[];
  /** Clock reading when `createCot` was called. */
  readonly createdAt: number;
  /** Clock readings at which each `appendCot` call started. */
  readonly appendStarts: number[];
  /** The events each `appendCot` call carried, in call order. */
  readonly appendBatches: FeishuCotEventInput[][];
  /** The reason a `completeCot` call closed this card, if one ever did. */
  completedReason: string | null;
}

export interface FakeCotClient extends FeishuCotClient {
  readonly cards: FakeCotCard[];
  /** Fail every `createCot` with this error while it is set. */
  createError: Error | null;
  /** Fail every `appendCot` with this error while it is set. */
  appendError: Error | null;
  /**
   * Delay the next `appendCot` call by this many milliseconds, once. The card
   * records the call's start before waiting, so a stalled test can see when
   * the platform call was really issued.
   */
  stallNextAppendMs: number | null;
}

export function createFakeCotClient(): FakeCotClient {
  const cards: FakeCotCard[] = [];
  let next = 1;
  const client: FakeCotClient = {
    cards,
    createError: null,
    appendError: null,
    stallNextAppendMs: null,
    async createCot(
      input: FeishuCotCreateInput,
    ): Promise<FeishuCotCreateResult> {
      if (client.createError !== null) throw client.createError;
      const ordinal = next++;
      const created = {
        cotId: `cot-${ordinal}`,
        messageId: `cot-message-${ordinal}`,
      };
      cards.push({
        ...created,
        chatId: input.chatId,
        originMessageId: input.originMessageId,
        events: [],
        createdAt: Date.now(),
        appendStarts: [],
        appendBatches: [],
        completedReason: null,
      });
      return created;
    },
    async appendCot(input: FeishuCotAppendInput): Promise<void> {
      if (client.appendError !== null) throw client.appendError;
      const card = cards.find((candidate) => candidate.cotId === input.cotId);
      if (card === undefined)
        throw new Error(`no fake COT card ${input.cotId}`);
      card.appendStarts.push(Date.now());
      card.appendBatches.push([...input.events]);
      const stall = client.stallNextAppendMs;
      if (stall !== null) {
        client.stallNextAppendMs = null;
        await new Promise<void>((resolve) => setTimeout(resolve, stall));
      }
      card.events.push(...input.events);
    },
    async completeCot(input: FeishuCotCompleteInput): Promise<void> {
      const card = cards.find((candidate) => candidate.cotId === input.cotId);
      if (card === undefined)
        throw new Error(`no fake COT card ${input.cotId}`);
      card.completedReason = input.reason;
    },
  };
  return client;
}

export interface RenderedCotMessage {
  readonly role: string;
  readonly text: string;
}

/** The text messages a card shows, in display order. */
export function cotMessages(card: FakeCotCard): RenderedCotMessage[] {
  const order: string[] = [];
  const byId = new Map<string, { role: string; text: string }>();
  for (const event of card.events) {
    const content = event.content;
    const messageId = String(content['messageId'] ?? '');
    if (event.eventType === 'TEXT_MESSAGE_START') {
      order.push(messageId);
      byId.set(messageId, { role: String(content['role'] ?? ''), text: '' });
      continue;
    }
    if (event.eventType === 'TEXT_MESSAGE_CONTENT') {
      const message = byId.get(messageId);
      if (message !== undefined) message.text += String(content['delta'] ?? '');
    }
  }
  return order.map((id) => byId.get(id) ?? { role: '', text: '' });
}

/** Just the visible text bodies, which is what most assertions care about. */
export function cotTexts(card: FakeCotCard): string[] {
  return cotMessages(card).map((message) => message.text);
}

export interface RenderedReasoningBlock {
  readonly messageId: string;
  /** All increments appended to this block, in order. */
  text: string;
  /** How many `REASONING_MESSAGE_START` events named this block. */
  starts: number;
  /** How many `REASONING_MESSAGE_END` events closed it. */
  ends: number;
}

/** The reasoning blocks a card shows, in display order. */
export function cotReasoningBlocks(
  card: FakeCotCard,
): RenderedReasoningBlock[] {
  const order: string[] = [];
  const byId = new Map<string, RenderedReasoningBlock>();
  for (const event of card.events) {
    const messageId = String(event.content['messageId'] ?? '');
    if (event.eventType === 'REASONING_MESSAGE_START') {
      let block = byId.get(messageId);
      if (block === undefined) {
        block = { messageId, text: '', starts: 0, ends: 0 };
        byId.set(messageId, block);
        order.push(messageId);
      }
      block.starts += 1;
      continue;
    }
    const block = byId.get(messageId);
    if (block === undefined) continue;
    if (event.eventType === 'REASONING_MESSAGE_CONTENT') {
      block.text += String(event.content['delta'] ?? '');
    } else if (event.eventType === 'REASONING_MESSAGE_END') {
      block.ends += 1;
    }
  }
  return order.map((id) => byId.get(id)!);
}

/** How many reasoning sections the card opened and closed. */
export function cotReasoningSections(card: FakeCotCard): {
  started: number;
  ended: number;
  messageStarts: number;
  messageEnds: number;
  contents: number;
} {
  const count = (eventType: string): number =>
    card.events.filter((event) => event.eventType === eventType).length;
  return {
    started: count('REASONING_START'),
    ended: count('REASONING_END'),
    messageStarts: count('REASONING_MESSAGE_START'),
    messageEnds: count('REASONING_MESSAGE_END'),
    contents: count('REASONING_MESSAGE_CONTENT'),
  };
}

/** The tool rows a card opened, by the name it displayed them under. */
export function cotToolNames(card: FakeCotCard): string[] {
  return card.events
    .filter((event) => event.eventType === 'TOOL_CALL_START')
    .map((event) => String(event.content['toolCallName'] ?? ''));
}

export function cotToolResultCount(card: FakeCotCard): number {
  return card.events.filter((event) => event.eventType === 'TOOL_CALL_RESULT')
    .length;
}

/**
 * How the card ended, or `null` while it is still open.
 *
 * A card ends through either of two AG-UI events: `RUN_FINISHED` carries the
 * ordinary statuses and `RUN_ERROR` is the failure terminal, so a helper that
 * only looked at `RUN_FINISHED` would report a failed card as still open.
 */
export function cotTerminal(card: FakeCotCard): string | null {
  const last = card.events.filter(isCotTerminal).at(-1);
  if (last === undefined) return null;
  return last.eventType === 'RUN_ERROR'
    ? 'error'
    : String(last.content['status'] ?? '');
}

/** How many times this card was ended; the invariant is at most once. */
export function cotTerminalCount(card: FakeCotCard): number {
  return card.events.filter(isCotTerminal).length;
}

function isCotTerminal(event: { eventType: string }): boolean {
  return event.eventType === 'RUN_FINISHED' || event.eventType === 'RUN_ERROR';
}
