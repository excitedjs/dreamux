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
  /** The reason a `completeCot` call closed this card, if one ever did. */
  completedReason: string | null;
}

export interface FakeCotClient extends FeishuCotClient {
  readonly cards: FakeCotCard[];
  /** Fail every `createCot` with this error while it is set. */
  createError: Error | null;
  /** Fail every `appendCot` with this error while it is set. */
  appendError: Error | null;
}

export function createFakeCotClient(): FakeCotClient {
  const cards: FakeCotCard[] = [];
  let next = 1;
  const client: FakeCotClient = {
    cards,
    createError: null,
    appendError: null,
    async createCot(input: FeishuCotCreateInput): Promise<FeishuCotCreateResult> {
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
        completedReason: null,
      });
      return created;
    },
    async appendCot(input: FeishuCotAppendInput): Promise<void> {
      if (client.appendError !== null) throw client.appendError;
      const card = cards.find((candidate) => candidate.cotId === input.cotId);
      if (card === undefined) throw new Error(`no fake COT card ${input.cotId}`);
      card.events.push(...input.events);
    },
    async completeCot(input: FeishuCotCompleteInput): Promise<void> {
      const card = cards.find((candidate) => candidate.cotId === input.cotId);
      if (card === undefined) throw new Error(`no fake COT card ${input.cotId}`);
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

/** The status the card finished with, or `null` while it is still open. */
export function cotRunStatus(card: FakeCotCard): string | null {
  const finished = card.events.filter(
    (event) => event.eventType === 'RUN_FINISHED',
  );
  const last = finished.at(-1);
  return last === undefined ? null : String(last.content['status'] ?? '');
}

export function cotRunFinishedCount(card: FakeCotCard): number {
  return card.events.filter((event) => event.eventType === 'RUN_FINISHED').length;
}
