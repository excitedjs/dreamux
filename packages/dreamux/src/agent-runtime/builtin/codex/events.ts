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
 * One observed Codex notification, redacted to method + ids + item type — never
 * prompt/assistant text. Emitted to {@link TurnSubscriptionOptions.onTrace} for
 * every notification so a caller can see what Codex emitted after `turn/start`
 * (issue #126 PR8): the dispatcher never awaits completion, so the worker is the
 * only consumer of this stream, and an empty/abnormal trace is the diagnostic
 * that distinguishes an environment stall (auth/network/quota) from a missed
 * terminal event.
 */
export interface TurnTraceEvent {
  method: string;
  /** `params.threadId` if present, else null (reveals a field-shape mismatch). */
  threadId: string | null;
  turnId: string | null;
  /** `item.type` for `item/completed`; never the item text. */
  itemType: string | null;
  /** Whether this notification counted toward THIS subscription's thread. */
  matched: boolean;
}

export interface TurnSubscriptionOptions {
  /**
   * Accept `turn/completed` / `item/completed` even when the notification's
   * `threadId` field does not match. A per-task worker app-server hosts exactly
   * one thread, so any completion on its socket IS this task's completion;
   * leniency makes the worker robust to a `threadId` field-shape drift in the
   * Codex protocol that the strict dispatcher path never exercises. Default
   * false preserves the strict, thread-scoped dispatcher behaviour.
   */
  acceptAnyThread?: boolean;
  /** Diagnostic hook fired for EVERY notification, before any filtering. */
  onTrace?: (event: TurnTraceEvent) => void;
}

/**
 * Subscribe to turn notifications for one thread. Returns a collector
 * whose `awaitTurn()` resolves on `turn/completed`. Items arriving on the
 * parallel `item/completed` stream are buffered and merged in.
 */
export function subscribeTurnCollection(
  client: CodexWsClient,
  threadId: string,
  options: TurnSubscriptionOptions = {},
): TurnCollector {
  const acceptAnyThread = options.acceptAnyThread === true;
  const itemsByTurn = new Map<string, ThreadItem[]>();
  let cached: CollectedTurn | null = null;
  let awaiting: Promise<CollectedTurn> | null = null;
  let resolveTurn: ((turn: CollectedTurn) => void) | null = null;
  let done = false;

  client.onNotification((notif) => {
    const p = (notif.params ?? {}) as Record<string, unknown>;
    const nThreadId = typeof p['threadId'] === 'string' ? (p['threadId'] as string) : null;
    const matches = acceptAnyThread || nThreadId === threadId;
    if (options.onTrace !== undefined) {
      options.onTrace({
        method: notif.method,
        threadId: nThreadId,
        turnId: traceTurnId(p),
        itemType: traceItemType(p),
        matched: matches,
      });
    }
    if (done || !matches) return;
    if (notif.method === 'item/completed') {
      const params = notif.params as ItemCompletedNotification;
      const bucket = itemsByTurn.get(params.turnId) ?? [];
      bucket.push(params.item);
      itemsByTurn.set(params.turnId, bucket);
    } else if (notif.method === 'turn/completed') {
      const params = notif.params as TurnCompletedNotification;
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

function traceTurnId(params: Record<string, unknown>): string | null {
  if (typeof params['turnId'] === 'string') return params['turnId'] as string;
  const turn = params['turn'] as { id?: unknown } | undefined;
  return turn !== undefined && typeof turn.id === 'string' ? turn.id : null;
}

function traceItemType(params: Record<string, unknown>): string | null {
  const item = params['item'] as { type?: unknown } | undefined;
  return item !== undefined && typeof item.type === 'string' ? item.type : null;
}

/**
 * Append raw Responses API items to a thread's model-visible history without
 * starting a turn (`thread/inject_items`, codex 0.137+). codex folds the items
 * onto the active turn when one is running and otherwise records them against a
 * default turn context (codex_thread.rs `inject_response_items` →
 * `inject_no_new_turn`); either way it never rejects on a busy thread, so a
 * rejection here is a genuine RPC error. Persisted to the rollout, so injected
 * items survive resume.
 */
export async function injectThreadItems(
  client: CodexWsClient,
  threadId: string,
  items: ReadonlyArray<Record<string, unknown>>,
): Promise<void> {
  await client.request('thread/inject_items', { threadId, items });
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
