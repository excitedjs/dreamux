/**
 * The platform side of the COT display, observed exactly as Feishu would.
 *
 * It is deliberately built on the *real* `createFeishuCotClient` over a stub
 * request function, so what a test observes is the actual HTTP request the
 * transport would send — method, url, query params, and body. A test can only
 * read an AG-UI field by parsing `events[i].content`, and the fake cannot drift
 * from the transport's wire contract because it does not model the wire at all.
 */
import {
  createFeishuCotClient,
  type FeishuCotClient,
} from '@excitedjs/feishu-transport';

/**
 * The per-event envelope the official Append page specifies, declared here
 * independently of the transport. A test that imported the production type
 * would absorb a drift in it instead of catching one.
 */
interface ExpectedWireEvent {
  event_type: string;
  content: string;
  timestamp: number;
}

/** One HTTP request the real COT client issued, exactly as Feishu would see it. */
export interface RecordedCotRequest {
  readonly method: string;
  readonly url: string;
  readonly params?: Record<string, unknown>;
  readonly data?: Record<string, unknown>;
}

/** One appended event with its `content` string parsed back, for assertions. */
export interface DecodedCotEvent {
  readonly eventType: string;
  readonly content: Record<string, unknown>;
  readonly timestamp: number;
}

export interface FakeCotClient extends FeishuCotClient {
  /** Every COT request issued, in order. The single recorded model. */
  readonly requests: RecordedCotRequest[];
  createRequests(): RecordedCotRequest[];
  appendRequests(): RecordedCotRequest[];
  completeRequests(): RecordedCotRequest[];
  /** Appended events for one card, in order, with `content` parsed. */
  eventsFor(cotId: string): DecodedCotEvent[];
  eventTypesFor(cotId: string): string[];
  /** Every appended event across every card, in issue order. */
  allEvents(): DecodedCotEvent[];
  failNextCreate(error: Error): void;
  failNextAppend(error: Error): void;
  failNextComplete(error: Error): void;
  /** Hold the next create until the returned resolver is called. */
  blockNextCreate(): () => void;
  /** Hold the next append until the returned resolver is called. */
  blockNextAppend(): () => void;
}

export function createFakeCotClient(
  options: { now?: () => number } = {},
): FakeCotClient {
  const requests: RecordedCotRequest[] = [];
  let nextId = 1;
  let createError: Error | null = null;
  let appendError: Error | null = null;
  let completeError: Error | null = null;
  let createGate: Promise<void> | null = null;
  let appendGate: Promise<void> | null = null;

  const client = createFeishuCotClient(
    {
      async request(input: unknown): Promise<unknown> {
        const request = input as RecordedCotRequest;
        requests.push(request);
        if (isCreate(request)) {
          const id = nextId;
          nextId += 1;
          return {
            code: 0,
            data: { cot_id: `cot-${id}`, message_id: `om-cot-${id}` },
          };
        }
        return { code: 0 };
      },
    } as Parameters<typeof createFeishuCotClient>[0],
    options.now !== undefined ? { now: options.now } : {},
  );

  const takeError = (held: Error | null, clear: () => void): void => {
    if (held === null) return;
    clear();
    throw held;
  };

  const wireEvents = (request: RecordedCotRequest): ExpectedWireEvent[] =>
    (request.data?.['events'] ?? []) as ExpectedWireEvent[];

  const decode = (event: ExpectedWireEvent): DecodedCotEvent => ({
    eventType: event.event_type,
    content: JSON.parse(event.content) as Record<string, unknown>,
    timestamp: event.timestamp,
  });

  const fake: FakeCotClient = {
    requests,
    createRequests: () => requests.filter(isCreate),
    appendRequests: () => requests.filter(isAppend),
    completeRequests: () => requests.filter(isComplete),
    eventsFor(cotId: string): DecodedCotEvent[] {
      return requests
        .filter(
          (request) => isAppend(request) && request.data?.['cot_id'] === cotId,
        )
        .flatMap(wireEvents)
        .map(decode);
    },
    eventTypesFor(cotId: string): string[] {
      return this.eventsFor(cotId).map((event) => event.eventType);
    },
    allEvents(): DecodedCotEvent[] {
      return requests.filter(isAppend).flatMap(wireEvents).map(decode);
    },
    failNextCreate: (error) => {
      createError = error;
    },
    failNextAppend: (error) => {
      appendError = error;
    },
    failNextComplete: (error) => {
      completeError = error;
    },
    blockNextCreate(): () => void {
      let resolve: () => void = () => undefined;
      createGate = new Promise<void>((r) => {
        resolve = r;
      });
      return resolve;
    },
    blockNextAppend(): () => void {
      let resolve: () => void = () => undefined;
      appendGate = new Promise<void>((r) => {
        resolve = r;
      });
      return resolve;
    },

    async createCot(input) {
      const gate = createGate;
      createGate = null;
      if (gate !== null) await gate;
      takeError(createError, () => {
        createError = null;
      });
      return client.createCot(input);
    },
    async appendCot(input) {
      const gate = appendGate;
      appendGate = null;
      if (gate !== null) await gate;
      takeError(appendError, () => {
        appendError = null;
      });
      return client.appendCot(input);
    },
    async completeCot(input) {
      takeError(completeError, () => {
        completeError = null;
      });
      return client.completeCot(input);
    },
  };
  return fake;
}

function isCreate(request: RecordedCotRequest): boolean {
  return request.method === 'POST' && !request.url.includes('/complete/');
}

function isAppend(request: RecordedCotRequest): boolean {
  return request.method === 'PUT';
}

function isComplete(request: RecordedCotRequest): boolean {
  return request.method === 'POST' && request.url.includes('/complete/');
}

/** Let every enqueued adapter task and its bounded operation settle. */
export async function settleCot(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
