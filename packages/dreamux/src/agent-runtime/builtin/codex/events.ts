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
  TurnErrorNotification,
  TurnStartResponse,
  UserInput,
} from './types.js';

export interface CollectedTurn {
  threadId: string;
  turnId: string;
  items: ThreadItem[];
}

export interface TurnCollector {
  awaitTurn(turnId?: string): Promise<CollectedTurn>;
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
 * Subscribe to turn notifications for one thread. Returns a collector whose
 * `awaitTurn()` resolves on `turn/completed` and REJECTS on a terminal turn
 * failure — either an `error` notification with `willRetry === false` (a fatal
 * error that interrupts the turn; codex emits no `turn/completed` after it, so a
 * resolve-only collector would hang forever) or a `turn/completed` carrying a
 * `turn.error`. Items arriving on the parallel `item/completed` stream are
 * buffered and merged into the resolved turn.
 */
export function subscribeTurnCollection(
  client: CodexWsClient,
  threadId: string,
  options: TurnSubscriptionOptions = {},
): TurnCollector {
  const acceptAnyThread = options.acceptAnyThread === true;
  const itemsByTurn = new Map<string, ThreadItem[]>();
  const completedByTurn = new Map<string, CollectedTurn>();
  const failuresByTurn = new Map<string, Error>();
  let firstCompleted: CollectedTurn | null = null;
  let firstFailure: Error | null = null;
  let unscopedFailure: Error | null = null;
  let closed = false;
  let awaiting:
    | {
        turnId: string | null;
        promise: Promise<CollectedTurn>;
        resolve: (turn: CollectedTurn) => void;
        reject: (err: Error) => void;
      }
    | null = null;

  const closeCollector = (): void => {
    closed = true;
    itemsByTurn.clear();
  };

  const resolveAwaiting = (): void => {
    if (awaiting === null) return;
    const expectedTurnId = awaiting.turnId;
    if (unscopedFailure !== null) {
      awaiting.reject(unscopedFailure);
      awaiting = null;
      closeCollector();
      return;
    }
    if (expectedTurnId !== null) {
      const failure = failuresByTurn.get(expectedTurnId);
      if (failure !== undefined) {
        awaiting.reject(failure);
        awaiting = null;
        closeCollector();
        return;
      }
      const completed = completedByTurn.get(expectedTurnId);
      if (completed !== undefined) {
        awaiting.resolve(completed);
        awaiting = null;
        closeCollector();
      }
      return;
    }
    if (firstFailure !== null) {
      awaiting.reject(firstFailure);
      awaiting = null;
      closeCollector();
      return;
    }
    if (firstCompleted !== null) {
      awaiting.resolve(firstCompleted);
      awaiting = null;
      closeCollector();
    }
  };

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
    if (closed || !matches) return;
    if (notif.method === 'item/completed') {
      const params = notif.params as ItemCompletedNotification;
      const bucket = itemsByTurn.get(params.turnId) ?? [];
      bucket.push(params.item);
      itemsByTurn.set(params.turnId, bucket);
    } else if (notif.method === 'turn/completed') {
      const params = notif.params as TurnCompletedNotification;
      if (params.turn.error != null) {
        const failure = new Error(params.turn.error.message || 'codex turn failed');
        failuresByTurn.set(params.turn.id, failure);
        firstFailure ??= failure;
        resolveAwaiting();
        return;
      }
      const items = itemsByTurn.get(params.turn.id) ?? params.turn.items ?? [];
      const completed = { threadId, turnId: params.turn.id, items };
      completedByTurn.set(params.turn.id, completed);
      firstCompleted ??= completed;
      resolveAwaiting();
    } else if (notif.method === 'error') {
      const params = notif.params as TurnErrorNotification;
      // Only a fatal (non-retried) error terminates the turn. A transient
      // `willRetry: true` error is followed by codex's own retry and an
      // eventual `turn/completed`, so we ignore it here.
      if (params.willRetry === false) {
        const failure = new Error(params.error?.message ?? 'codex turn error');
        if (typeof params.turnId === 'string') failuresByTurn.set(params.turnId, failure);
        else unscopedFailure = failure;
        firstFailure ??= failure;
        resolveAwaiting();
      }
    }
  });

  return {
    awaitTurn(turnId?: string): Promise<CollectedTurn> {
      const expectedTurnId = turnId ?? null;
      if (unscopedFailure !== null) {
        closeCollector();
        return Promise.reject(unscopedFailure);
      }
      if (expectedTurnId !== null) {
        const failure = failuresByTurn.get(expectedTurnId);
        if (failure !== undefined) {
          closeCollector();
          return Promise.reject(failure);
        }
        const completed = completedByTurn.get(expectedTurnId);
        if (completed !== undefined) {
          closeCollector();
          return Promise.resolve(completed);
        }
      } else {
        if (firstFailure !== null) {
          closeCollector();
          return Promise.reject(firstFailure);
        }
        if (firstCompleted !== null) {
          closeCollector();
          return Promise.resolve(firstCompleted);
        }
      }
      if (awaiting !== null) return awaiting.promise;
      let resolveTurn!: (turn: CollectedTurn) => void;
      let rejectTurn!: (err: Error) => void;
      const promise = new Promise<CollectedTurn>((res, rej) => {
        resolveTurn = res;
        rejectTurn = rej;
      });
      awaiting = {
        turnId: expectedTurnId,
        promise,
        resolve: resolveTurn,
        reject: rejectTurn,
      };
      return promise;
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
  const res = await submitTurnStart(client, threadId, prompt, cwd);
  return collector.awaitTurn(res.turn.id);
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
