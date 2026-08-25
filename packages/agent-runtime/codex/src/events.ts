/**
 * Collects a Codex turn from the JSON-RPC notification stream.
 *
 * Adapted from claudemux's `plugins/claudemux/core/src/engines/codex/events.ts`.
 * We drop token-usage bookkeeping and `notLoaded` item merging. Feishu
 * outbound delivery is MCP reply-only, so collected assistant text is for
 * diagnostics and tests rather than channel forwarding.
 */

import type { CodexWsClient } from './rpc.js';
import { createHash } from 'node:crypto';
import type {
  ItemCompletedNotification,
  ItemStartedNotification,
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
  releaseTurn(turnId: string): void;
  dispose(): void;
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
  /** Keep listening while a resident runtime observes successive native turns. */
  retainAfterTerminal?: boolean;
  onItemStarted?: (turnId: string, item: ThreadItem) => void;
  onItemCompleted?: (turnId: string, item: ThreadItem, occurredAt: number) => void;
  onTerminal?: (turnId: string, terminal: CollectedTurn | Error) => void;
  onUnscopedFailure?: (error: Error) => void;
  onProtocolViolation?: (error: Error) => void;
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
  const retainAfterTerminal = options.retainAfterTerminal === true;
  const itemsByTurn = new Map<string, ThreadItem[]>();
  const completedByTurn = new Map<string, CollectedTurn>();
  const failuresByTurn = new Map<string, Error>();
  const terminalFingerprints = new Map<string, string>();
  let firstCompleted: CollectedTurn | null = null;
  let firstFailure: Error | null = null;
  let firstFailureTurnId: string | null = null;
  let unscopedFailure: Error | null = null;
  let closed = false;
  let unsubscribe = (): void => {};
  const awaiting = new Map<
    string | null,
    {
      promise: Promise<CollectedTurn>;
      resolve: (turn: CollectedTurn) => void;
      reject: (err: Error) => void;
    }
  >();

  const closeCollector = (): void => {
    if (closed) return;
    closed = true;
    itemsByTurn.clear();
    completedByTurn.clear();
    failuresByTurn.clear();
    terminalFingerprints.clear();
    unsubscribe();
  };

  const resolveAwaiting = (): void => {
    if (unscopedFailure !== null) {
      for (const waiter of awaiting.values()) waiter.reject(unscopedFailure);
      awaiting.clear();
      closeCollector();
      return;
    }
    for (const [expectedTurnId, waiter] of [...awaiting]) {
      const failure = expectedTurnId === null
        ? firstFailure
        : (failuresByTurn.get(expectedTurnId) ?? null);
      const completed = expectedTurnId === null
        ? firstCompleted
        : (completedByTurn.get(expectedTurnId) ?? null);
      if (failure !== null) waiter.reject(failure);
      else if (completed !== null) waiter.resolve(completed);
      else continue;
      awaiting.delete(expectedTurnId);
      if (!retainAfterTerminal) {
        closeCollector();
        return;
      }
    }
  };

  unsubscribe = client.onNotification((notif) => {
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
    if (notif.method === 'item/started') {
      const params = notif.params as ItemStartedNotification;
      if (terminalFingerprints.has(params.turnId)) return;
      options.onItemStarted?.(params.turnId, params.item);
    } else if (notif.method === 'item/completed') {
      const params = notif.params as ItemCompletedNotification;
      if (terminalFingerprints.has(params.turnId)) return;
      const bucket = itemsByTurn.get(params.turnId) ?? [];
      bucket.push(params.item);
      itemsByTurn.set(params.turnId, bucket);
      options.onItemCompleted?.(params.turnId, params.item, params.completedAtMs);
    } else if (notif.method === 'turn/completed') {
      const params = notif.params as TurnCompletedNotification;
      if (params.turn.error != null) {
        const failure = new Error(params.turn.error.message || 'codex turn failed');
        const terminalState = rememberTerminal(
          terminalFingerprints,
          params.turn.id,
          terminalFingerprint('failed', failure.message),
        );
        if (terminalState === 'conflict') {
          options.onProtocolViolation?.(new Error(
            `codex emitted conflicting terminal facts for turn ${params.turn.id}`,
          ));
          return;
        }
        if (terminalState === 'duplicate') return;
        failuresByTurn.set(params.turn.id, failure);
        if (firstFailure === null) {
          firstFailure = failure;
          firstFailureTurnId = params.turn.id;
        }
        options.onTerminal?.(params.turn.id, failure);
        resolveAwaiting();
        return;
      }
      const items = itemsByTurn.get(params.turn.id) ?? params.turn.items ?? [];
      const completed = { threadId, turnId: params.turn.id, items };
      const terminalState = rememberTerminal(
        terminalFingerprints,
        params.turn.id,
        terminalFingerprint('completed', params.turn),
      );
      if (terminalState === 'conflict') {
        options.onProtocolViolation?.(new Error(
          `codex emitted conflicting terminal facts for turn ${params.turn.id}`,
        ));
        return;
      }
      if (terminalState === 'duplicate') return;
      completedByTurn.set(params.turn.id, completed);
      firstCompleted ??= completed;
      options.onTerminal?.(params.turn.id, completed);
      resolveAwaiting();
    } else if (notif.method === 'error') {
      const params = notif.params as TurnErrorNotification;
      // Only a fatal (non-retried) error terminates the turn. A transient
      // `willRetry: true` error is followed by codex's own retry and an
      // eventual `turn/completed`, so we ignore it here.
      if (params.willRetry === false) {
        const failure = new Error(params.error?.message ?? 'codex turn error');
        if (typeof params.turnId === 'string') {
          const terminalState = rememberTerminal(
            terminalFingerprints,
            params.turnId,
            terminalFingerprint('failed', failure.message),
          );
          if (terminalState === 'conflict') {
            options.onProtocolViolation?.(new Error(
              `codex emitted conflicting terminal facts for turn ${params.turnId}`,
            ));
            return;
          }
          if (terminalState === 'duplicate') return;
          failuresByTurn.set(params.turnId, failure);
          options.onTerminal?.(params.turnId, failure);
        }
        else {
          unscopedFailure = failure;
          options.onUnscopedFailure?.(failure);
        }
        if (firstFailure === null) {
          firstFailure = failure;
          firstFailureTurnId = typeof params.turnId === 'string' ? params.turnId : null;
        }
        resolveAwaiting();
      }
    }
  });

  return {
    awaitTurn(turnId?: string): Promise<CollectedTurn> {
      const expectedTurnId = turnId ?? null;
      if (closed) {
        return Promise.reject(new Error('codex turn collector disposed'));
      }
      if (unscopedFailure !== null) {
        closeCollector();
        return Promise.reject(unscopedFailure);
      }
      if (expectedTurnId !== null) {
        const failure = failuresByTurn.get(expectedTurnId);
        if (failure !== undefined) {
          if (!retainAfterTerminal) closeCollector();
          return Promise.reject(failure);
        }
        const completed = completedByTurn.get(expectedTurnId);
        if (completed !== undefined) {
          if (!retainAfterTerminal) closeCollector();
          return Promise.resolve(completed);
        }
      } else {
        if (firstFailure !== null) {
          if (!retainAfterTerminal) closeCollector();
          return Promise.reject(firstFailure);
        }
        if (firstCompleted !== null) {
          if (!retainAfterTerminal) closeCollector();
          return Promise.resolve(firstCompleted);
        }
      }
      const existing = awaiting.get(expectedTurnId);
      if (existing !== undefined) return existing.promise;
      let resolveTurn!: (turn: CollectedTurn) => void;
      let rejectTurn!: (err: Error) => void;
      const promise = new Promise<CollectedTurn>((res, rej) => {
        resolveTurn = res;
        rejectTurn = rej;
      });
      awaiting.set(expectedTurnId, {
        promise,
        resolve: resolveTurn,
        reject: rejectTurn,
      });
      return promise;
    },
    releaseTurn(turnId: string): void {
      itemsByTurn.delete(turnId);
      completedByTurn.delete(turnId);
      failuresByTurn.delete(turnId);
      if (firstCompleted?.turnId === turnId) firstCompleted = null;
      if (firstFailureTurnId === turnId) {
        firstFailure = null;
        firstFailureTurnId = null;
      }
    },
    dispose(): void {
      const error = new Error('codex turn collector disposed');
      for (const waiter of awaiting.values()) waiter.reject(error);
      awaiting.clear();
      closeCollector();
    },
  };
}

const TERMINAL_FINGERPRINT_LIMIT = 1_024;

function terminalFingerprint(kind: string, payload: unknown): string {
  return createHash('sha256').update(JSON.stringify([kind, payload])).digest('base64url');
}

function rememberTerminal(
  terminals: Map<string, string>,
  turnId: string,
  fingerprint: string,
): 'new' | 'duplicate' | 'conflict' {
  const previous = terminals.get(turnId);
  if (previous !== undefined) return previous === fingerprint ? 'duplicate' : 'conflict';
  terminals.set(turnId, fingerprint);
  while (terminals.size > TERMINAL_FINGERPRINT_LIMIT) {
    const oldest = terminals.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    terminals.delete(oldest);
  }
  return 'new';
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
 * Send a `turn/start` request and resolve once Codex accepts the submission.
 * This is the production Feishu inbound primitive: it intentionally does not
 * wait for `turn/completed`.
 */
export async function submitTurnStart(
  client: CodexWsClient,
  threadId: string,
  prompt: string,
  cwd: string | null,
  outputSchema?: Record<string, unknown>,
): Promise<TurnStartResponse> {
  const input: UserInput[] = [
    { type: 'text', text: prompt, text_elements: [] },
  ];
  const params: Record<string, unknown> = { threadId, input };
  if (cwd !== null) params.cwd = cwd;
  if (outputSchema !== undefined) params.outputSchema = outputSchema;
  return client.request<TurnStartResponse>('turn/start', params);
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
  try {
    const res = await submitTurnStart(client, threadId, prompt, cwd);
    return await collector.awaitTurn(res.turn.id);
  } finally {
    collector.dispose();
  }
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
