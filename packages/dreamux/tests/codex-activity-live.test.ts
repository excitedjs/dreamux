/** Actual growing Codex rollouts and native turns without a Dreamux submission. */
import { describe, expect, it } from 'vitest';
// Test-only native wire types have no public equivalent; these assertions
// observe real RPC/terminal facts rather than replacing the provider with a fake.
import type {
  ItemStartedNotification,
  TurnCompletedNotification,
  TurnStartResponse,
} from '../../agent-runtime/codex/dist/types.js';
import {
  completeLiveTurn,
  liveCodexProvider,
  skipLiveModelGate,
} from './helpers/live-codex-provider.js';

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('real Codex live activity contracts', () => {
  it.skipIf(skipLiveModelGate)(
    'observes readRecentActivity growing while a real submitted turn is still in flight',
    async () => {
      const f = await liveCodexProvider();
      try {
        const created = await f.create('activity-live', null);
        await created.runtime.start();
        const session = created.updates.find(
          (update) => update.kind === 'session',
        );
        if (session?.kind !== 'session')
          throw new Error('Real Codex did not publish its native session id');
        const client = f.clients[0]!;
        const nativeEnds = () =>
          f.notifications.filter(
            (entry) =>
              entry.client === client &&
              entry.notification.method === 'turn/completed',
          );
        const admission = await created.runtime.submit({
          text: [
            'First call exec_command with cmd "sleep 3; echo activity-live-done" and wait for it.',
            'After it returns, reply with exactly the word done.',
          ].join(' '),
        });
        expect(admission.status).toBe('submitted');
        if (admission.status !== 'submitted')
          throw new Error(`activity-live turn was ${admission.status}`);
        let settled = false;
        void admission.submission.settled.then(() => {
          settled = true;
        });

        // Observe the real app-server starting the requested operation. The
        // activity evidence below comes from the provider's disk reader, not
        // these WebSocket observations or a constructed rollout fixture.
        await waitFor(
          () =>
            f.notifications.some((entry) => {
              if (
                entry.client !== client ||
                entry.notification.method !== 'item/started'
              )
                return false;
              const { item } = entry.notification
                .params as ItemStartedNotification;
              return (
                item.type === 'commandExecution' &&
                typeof item.command === 'string' &&
                item.command.includes('activity-live-done')
              );
            }),
          'the real activity command started',
        );

        const query = { sessionId: session.sessionId };
        const context = {
          config: f.config,
          cwd: f.cwd,
          logger: created.context.logger,
        };
        let midTurnCount = 0;
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline && midTurnCount === 0 && !settled) {
          try {
            const page = await f.provider.readRecentActivity(query, context);
            midTurnCount = page.records.length;
          } catch (error) {
            // Codex may not have created the rollout yet. Every other read
            // failure remains a failure of this live contract.
            const unavailable =
              error !== null &&
              typeof error === 'object' &&
              (error as { name?: unknown }).name === 'AgentActivityError' &&
              (error as { reason?: unknown }).reason === 'session_unavailable';
            if (!unavailable) throw error;
          }
          if (midTurnCount === 0 && !settled)
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        expect(midTurnCount).toBeGreaterThan(0);
        // A successful read after the native turn finished is not evidence for
        // the historical in-flight contract.
        expect(settled).toBe(false);
        expect(nativeEnds()).toHaveLength(0);

        const settlement = await admission.submission.settled;
        expect(settlement).toMatchObject({
          kind: 'completion',
          completion: { status: 'completed' },
        });
        const finalPage = await f.provider.readRecentActivity(query, context);
        expect(finalPage.records.length).toBeGreaterThanOrEqual(midTurnCount);
      } finally {
        await f.dispose();
      }
    },
    180_000,
  );

  it.skipIf(skipLiveModelGate)(
    'ends a native turn no Dreamux submission ever bound, through real codex',
    async () => {
      const f = await liveCodexProvider();
      try {
        const created = await f.create('unbound-end-live', null);
        const ends = () =>
          created.activities.filter(
            (activity) => activity.kind === 'turn.ended',
          );
        await created.runtime.start();
        // An ordinary submission opens the production collector and establishes
        // the first native end before any unbound work starts.
        await completeLiveTurn(
          created.runtime,
          'Reply with exactly the word ok.',
        );
        await waitFor(
          () => ends().length === 1,
          'the submitted turn ended',
          30_000,
        );
        expect(ends()[0]).toMatchObject({
          kind: 'turn.ended',
          status: 'completed',
        });
        const session = created.updates.find(
          (update) => update.kind === 'session',
        );
        if (session?.kind !== 'session')
          throw new Error('Real Codex did not publish its native session id');
        const client = f.clients[0]!;
        const baseline = f.requests.find(
          (request) =>
            request.client === client && request.method === 'turn/start',
        )!.result as TurnStartResponse;

        // This request bypasses runtime.submit: no Dreamux admission or
        // submission binds the second native turn. The transport observer calls
        // through to the same live app-server connection without fabricating IO.
        const native = await client.request<TurnStartResponse>('turn/start', {
          threadId: session.sessionId,
          input: [
            {
              type: 'text',
              text: 'Reply with exactly the word two.',
              text_elements: [],
            },
          ],
          cwd: f.cwd,
        });
        expect(native.turn.id).not.toBe(baseline.turn.id);
        await waitFor(() => ends().length === 2, 'the unbound turn ended');
        expect(ends()).toHaveLength(2);
        expect(ends().at(-1)).toMatchObject({
          kind: 'turn.ended',
          status: 'completed',
        });
        const nativeTerminals = f.notifications.filter((entry) => {
          if (
            entry.client !== client ||
            entry.notification.method !== 'turn/completed'
          )
            return false;
          const event = entry.notification.params as TurnCompletedNotification;
          return (
            event.threadId === session.sessionId &&
            event.turn.id === native.turn.id
          );
        });
        expect(nativeTerminals).toHaveLength(1);
        expect(nativeTerminals[0]!.notification.params).toMatchObject({
          turn: { id: native.turn.id, status: 'completed' },
        });
        expect(
          f.requests.filter(
            (request) =>
              request.client === client && request.method === 'turn/start',
          ),
        ).toHaveLength(2);
      } finally {
        await f.dispose();
      }
    },
    180_000,
  );
});
