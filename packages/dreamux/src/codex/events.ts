/**
 * Collects a Codex turn from the JSON-RPC notification stream.
 *
 * Adapted from claudemux's `plugins/claudemux/core/src/engines/codex/events.ts`.
 * We drop token-usage bookkeeping and `notLoaded` item merging. Feishu
 * outbound delivery is MCP reply-only, so collected assistant text is for
 * diagnostics and tests rather than channel forwarding.
 */

import type { CodexWsClient } from './rpc.js';
import type {
  ItemCompletedNotification,
  ThreadItem,
  TurnCompletedNotification,
  TurnStartResponse,
  UserInput,
} from './types.js';

export interface CollectedTurn {
  threadId: string;
  turnId: string;
  items: ThreadItem[];
}

export interface TurnCollector {
  awaitTurn(): Promise<CollectedTurn>;
}

/**
 * Subscribe to turn notifications for one thread. Returns a collector
 * whose `awaitTurn()` resolves on `turn/completed`. Items arriving on the
 * parallel `item/completed` stream are buffered and merged in.
 */
export function subscribeTurnCollection(
  client: CodexWsClient,
  threadId: string,
): TurnCollector {
  const itemsByTurn = new Map<string, ThreadItem[]>();
  let cached: CollectedTurn | null = null;
  let awaiting: Promise<CollectedTurn> | null = null;
  let resolveTurn: ((turn: CollectedTurn) => void) | null = null;
  let done = false;

  client.onNotification((notif) => {
    if (done) return;
    if (notif.method === 'item/completed') {
      const params = notif.params as ItemCompletedNotification;
      if (params.threadId !== threadId) return;
      const bucket = itemsByTurn.get(params.turnId) ?? [];
      bucket.push(params.item);
      itemsByTurn.set(params.turnId, bucket);
    } else if (notif.method === 'turn/completed') {
      const params = notif.params as TurnCompletedNotification;
      if (params.threadId !== threadId) return;
      done = true;
      const items = itemsByTurn.get(params.turn.id) ?? params.turn.items ?? [];
      cached = { threadId, turnId: params.turn.id, items };
      if (resolveTurn !== null) {
        resolveTurn(cached);
        resolveTurn = null;
      }
    }
  });

  return {
    awaitTurn(): Promise<CollectedTurn> {
      if (cached !== null) return Promise.resolve(cached);
      if (awaiting !== null) return awaiting;
      awaiting = new Promise<CollectedTurn>((res) => {
        resolveTurn = res;
      });
      return awaiting;
    },
  };
}

/**
 * Send a `turn/start` request and resolve once Codex accepts the submission.
 * This is the production Feishu inbound primitive: it intentionally does not
 * wait for `turn/completed`.
 */
export async function submitTurnStart(
  client: CodexWsClient,
  threadId: string,
  prompt: string,
  cwd: string | null,
): Promise<TurnStartResponse> {
  const input: UserInput[] = [
    { type: 'text', text: prompt, text_elements: [] },
  ];
  return client.request<TurnStartResponse>(
    'turn/start',
    cwd === null ? { threadId, input } : { threadId, input, cwd },
  );
}

/**
 * Send a `turn/start` request and await `turn/completed`.
 * Returns the collected turn, or throws on RPC failure.
 */
export async function runTurn(
  client: CodexWsClient,
  threadId: string,
  prompt: string,
  cwd: string | null,
): Promise<CollectedTurn> {
  const collector = subscribeTurnCollection(client, threadId);
  await submitTurnStart(client, threadId, prompt, cwd);
  return collector.awaitTurn();
}

/**
 * Extract the final assistant message text from a collected turn.
 * Returns null if the turn had no assistant message — caller decides
 * what to surface to the user (see issue #2 §"开放问题 Q4").
 */
export function extractAssistantText(turn: CollectedTurn): string | null {
  const messages = turn.items.filter((it) => it.type === 'agentMessage');
  if (messages.length === 0) return null;
  const last = messages[messages.length - 1];
  return typeof last?.text === 'string' && last.text.length > 0
    ? last.text
    : null;
}
