/**
 * Collects a Codex turn from the JSON-RPC notification stream.
 *
 * Adapted from claudemux's `plugins/claudemux/core/src/engines/codex/events.ts`.
 * We drop `notLoaded` item merging. Feishu
 * outbound delivery is MCP reply-only, so collected assistant text is for
 * diagnostics and tests rather than channel forwarding.
 */

import type { CodexWsClient } from './rpc.js';
import type {
  ItemCompletedNotification,
  ItemStartedNotification,
  ThreadItem,
  ThreadTokenUsage,
  ThreadTokenUsageUpdatedNotification,
  TurnCompletedNotification,
  TurnErrorNotification,
  TurnStartResponse,
  TurnStatus,
  UserInput,
} from './types.js';

export interface CollectedTurn {
  threadId: string;
  turnId: string;
  items: ThreadItem[];
  /** codex's own terminal for this turn; see {@link TurnStatus}. */
  status: TurnStatus;
}

export interface TurnCollector {
  /**
   * Forget a turn's buffered `item/completed` items. `itemsByTurn` has no
   * size bound of its own (unlike the terminal-id set below): every
   * `item/completed` notification appends to it, and nothing else ever
   * deletes an entry, so a long-lived resident collector leaks one array per
   * native turn it has ever seen unless the caller releases each turn once
   * it is done with it.
   */
  releaseTurn(turnId: string): void;
  dispose(): void;
}

export interface TurnSubscriptionOptions {
  onTokenUsage?: (usage: ThreadTokenUsage) => void;
  onItemStarted?: (turnId: string, item: ThreadItem) => void;
  onItemCompleted?: (
    turnId: string,
    item: ThreadItem,
    occurredAt: number,
  ) => void;
  onTerminal?: (turnId: string, terminal: CollectedTurn | Error) => void;
  /**
   * An `error` notification with no `turnId` — a connection-level protocol
   * failure rather than one turn's failure. The collector stops reacting to
   * further notifications once this fires: nothing scopes a recovery to a
   * single turn.
   */
  onUnscopedFailure?: (error: Error) => void;
}

/**
 * Subscribe to turn notifications for one thread, pushing each turn's
 * lifecycle to the given callbacks as codex reports it. Stays subscribed
 * across successive native turns until `dispose()`.
 */
export function subscribeTurnCollection(
  client: CodexWsClient,
  threadId: string,
  options: TurnSubscriptionOptions = {},
): TurnCollector {
  const itemsByTurn = new Map<string, ThreadItem[]>();
  const terminalTurnIds = new Set<string>();
  let closed = false;
  let unsubscribe = (): void => {};

  const closeCollector = (): void => {
    if (closed) return;
    closed = true;
    itemsByTurn.clear();
    terminalTurnIds.clear();
    unsubscribe();
  };

  unsubscribe = client.onNotification((notif) => {
    const p = (notif.params ?? {}) as Record<string, unknown>;
    const nThreadId =
      typeof p['threadId'] === 'string' ? (p['threadId'] as string) : null;
    const matches = nThreadId === threadId;
    if (closed || !matches) return;
    if (notif.method === 'thread/tokenUsage/updated') {
      const params = notif.params as ThreadTokenUsageUpdatedNotification;
      options.onTokenUsage?.(params.tokenUsage);
    } else if (notif.method === 'item/started') {
      const params = notif.params as ItemStartedNotification;
      if (terminalTurnIds.has(params.turnId)) return;
      options.onItemStarted?.(params.turnId, params.item);
    } else if (notif.method === 'item/completed') {
      const params = notif.params as ItemCompletedNotification;
      if (terminalTurnIds.has(params.turnId)) return;
      const bucket = itemsByTurn.get(params.turnId) ?? [];
      bucket.push(params.item);
      itemsByTurn.set(params.turnId, bucket);
      options.onItemCompleted?.(
        params.turnId,
        params.item,
        params.completedAtMs,
      );
    } else if (notif.method === 'turn/completed') {
      const params = notif.params as TurnCompletedNotification;
      if (params.turn.error != null) {
        const failure = new Error(
          params.turn.error.message || 'codex turn failed',
        );
        if (!rememberTerminal(terminalTurnIds, params.turn.id)) return;
        options.onTerminal?.(params.turn.id, failure);
        return;
      }
      const items = itemsByTurn.get(params.turn.id) ?? params.turn.items ?? [];
      const completed = {
        threadId,
        turnId: params.turn.id,
        items,
        status: params.turn.status,
      };
      if (!rememberTerminal(terminalTurnIds, params.turn.id)) return;
      options.onTerminal?.(params.turn.id, completed);
    } else if (notif.method === 'error') {
      const params = notif.params as TurnErrorNotification;
      // Only a fatal (non-retried) error terminates the turn. A transient
      // `willRetry: true` error is followed by codex's own retry and an
      // eventual `turn/completed`, so we ignore it here.
      if (params.willRetry === false) {
        const failure = new Error(params.error?.message ?? 'codex turn error');
        if (typeof params.turnId === 'string') {
          if (!rememberTerminal(terminalTurnIds, params.turnId)) return;
          options.onTerminal?.(params.turnId, failure);
        } else {
          options.onUnscopedFailure?.(failure);
          closeCollector();
        }
      }
    }
  });

  return {
    releaseTurn(turnId: string): void {
      itemsByTurn.delete(turnId);
    },
    dispose(): void {
      closeCollector();
    },
  };
}

const TERMINAL_TURN_ID_LIMIT = 1_024;

/** Record a turn's terminal as seen; returns false for a duplicate report. */
function rememberTerminal(terminals: Set<string>, turnId: string): boolean {
  if (terminals.has(turnId)) return false;
  terminals.add(turnId);
  while (terminals.size > TERMINAL_TURN_ID_LIMIT) {
    const oldest = terminals.values().next().value as string | undefined;
    if (oldest === undefined) break;
    terminals.delete(oldest);
  }
  return true;
}

/**
 * Send a `turn/start` request and resolve once Codex accepts the submission.
 * This is the production Feishu inbound primitive: it intentionally does not
 * wait for `turn/completed`.
 */
export async function submitTurnStart(
  client: CodexWsClient,
  threadId: string,
  texts: string[],
  outputSchema?: Record<string, unknown>,
  effort?: string,
): Promise<TurnStartResponse> {
  const input: UserInput[] = texts.map((text) => ({
    type: 'text',
    text,
    text_elements: [],
  }));
  const params: Record<string, unknown> = { threadId, input };
  if (outputSchema !== undefined) params.outputSchema = outputSchema;
  if (effort !== undefined) params.effort = effort;
  return client.request<TurnStartResponse>('turn/start', params);
}

/** Interrupt one running turn and resolve once Codex accepts the request. */
export async function interruptTurn(
  client: CodexWsClient,
  threadId: string,
  turnId: string,
): Promise<void> {
  await client.request<Record<string, never>>('turn/interrupt', {
    threadId,
    turnId,
  });
}

/**
 * Extract the final assistant message text from a collected turn.
 * Returns null if the turn had no assistant message — caller decides
 * what to surface to the user (see issue #2 "open questions", Q4).
 */
export function extractAssistantText(turn: CollectedTurn): string | null {
  const messages = turn.items.filter((it) => it.type === 'agentMessage');
  if (messages.length === 0) return null;
  const last = messages[messages.length - 1];
  return typeof last?.text === 'string' && last.text.length > 0
    ? last.text
    : null;
}
