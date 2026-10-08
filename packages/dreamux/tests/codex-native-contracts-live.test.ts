/** Real model turns, persisted rollout contexts and native cold resume. */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
// Test-only native wire types have no public equivalent; these assertions
// observe real RPC/terminal facts rather than replacing the provider with a fake.
import type {
  ThreadStartResponse,
  ThreadResumeResponse,
} from '../../agent-runtime/codex/dist/types.js';
import {
  completeLiveTurn,
  liveCodexProvider,
  skipLiveModelGate,
} from './helpers/live-codex-provider.js';

describe('real Codex native provider contracts', () => {
  it.skipIf(skipLiveModelGate)(
    'applies ultrathink effort and restores ordinary effort across turns and cold resume',
    async () => {
      const f = await liveCodexProvider();
      const config = {
        ...f.config,
        extra_args: ['-c', 'model_reasoning_effort="low"'],
      };
      try {
        const fresh = await f.create('effort-live', null, { config });
        expect(await fresh.runtime.start()).toEqual({ continuity: 'fresh' });
        const firstClient = f.clients[0]!;
        const started = f.requests.find(
          (request) =>
            request.client === firstClient && request.method === 'thread/start',
        )!.result as ThreadStartResponse;
        for (const text of [
          'ultrathink. Reply only ok.',
          'Reply only ok.',
          'ultrathink. Reply only ok.',
        ]) {
          await completeLiveTurn(fresh.runtime, text);
        }
        const efforts = f.requests
          .filter(
            (request) =>
              request.client === firstClient && request.method === 'turn/start',
          )
          .map((request) => (request.params as { effort: string }).effort);
        expect(['high', 'xhigh', 'max']).toContain(efforts[0]);
        expect(efforts).toEqual([efforts[0], 'low', efforts[0]]);
        await fresh.runtime.stop();

        const resumed = await f.create('effort-live', started.thread.id, {
          config,
        });
        expect(await resumed.runtime.start()).toEqual({
          continuity: 'resumed',
        });
        await completeLiveTurn(resumed.runtime, 'Reply only ok.');
        const secondClient = f.clients[1]!;
        const resumedTurns = f.requests.filter(
          (request) =>
            request.client === secondClient && request.method === 'turn/start',
        );
        expect(resumedTurns).toHaveLength(1);
        expect(resumedTurns[0]!.params).toMatchObject({ effort: 'low' });
        await resumed.runtime.stop();

        // Native persistence proves the process consumed each override, beyond
        // observing the real outbound RPC and its receipt.
        expect(typeof started.thread.path).toBe('string');
        const rollout = await readFile(started.thread.path!, 'utf8');
        const contexts = rollout
          .trim()
          .split('\n')
          .map(
            (line) =>
              JSON.parse(line) as {
                type: string;
                payload: { effort?: string };
              },
          )
          .filter((item) => item.type === 'turn_context');
        expect(contexts.map((item) => item.payload.effort)).toEqual([
          ...efforts,
          'low',
        ]);
      } finally {
        await f.dispose();
      }
    },
    240_000,
  );

  it.skipIf(skipLiveModelGate)(
    'reports fresh continuity then resumes the same actually persisted native thread',
    async () => {
      const f = await liveCodexProvider();
      try {
        const fresh = await f.create('continuity-live', null);
        expect(await fresh.runtime.start()).toEqual({ continuity: 'fresh' });
        const update = fresh.updates.find(
          (update) => update.kind === 'session',
        );
        if (update?.kind !== 'session')
          throw new Error('Real Codex did not publish its native session id');
        const sessionId = update.sessionId;
        const started = f.requests.find(
          (request) => request.method === 'thread/start',
        )!.result as ThreadStartResponse;
        expect(started.thread.id).toBe(sessionId);
        // A thread/start receipt alone is not a resumable rollout. Complete one
        // real model turn before checking the file and starting another process.
        await completeLiveTurn(
          fresh.runtime,
          'Reply with exactly the word ok.',
        );
        await fresh.runtime.stop();
        expect(typeof started.thread.path).toBe('string');
        expect(
          (await readFile(started.thread.path!, 'utf8')).length,
        ).toBeGreaterThan(0);

        const resumed = await f.create('continuity-live', sessionId);
        expect(await resumed.runtime.start()).toEqual({
          continuity: 'resumed',
        });
        expect(resumed.updates).toContainEqual({ kind: 'session', sessionId });
        const resumedClient = f.clients[1]!;
        const requests = f.requests.filter(
          (request) => request.client === resumedClient,
        );
        expect(
          requests.filter((request) => request.method === 'thread/start'),
        ).toHaveLength(0);
        const resume = requests.find(
          (request) => request.method === 'thread/resume',
        );
        expect(resume?.params).toMatchObject({ threadId: sessionId });
        expect((resume!.result as ThreadResumeResponse).thread.id).toBe(
          sessionId,
        );
      } finally {
        await f.dispose();
      }
    },
    180_000,
  );

  it.skipIf(skipLiveModelGate)(
    'binds an output schema at create time and returns matching portable structured JSON through real Codex',
    async () => {
      const f = await liveCodexProvider();
      try {
        const outputSchema = {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['portable'] },
            score: { type: 'integer', minimum: 7, maximum: 7 },
            nullableFlag: { type: ['boolean', 'null'] },
            optionalNote: { type: 'string', enum: ['present'] },
          },
          required: ['kind', 'score', 'nullableFlag'],
          additionalProperties: false,
        };
        const { runtime } = await f.create('schema-live', null, {
          outputSchema,
        });
        await runtime.start();
        const text = await completeLiveTurn(
          runtime,
          'Return the requested structured result. Use kind "portable", score 7, nullableFlag null, and optionalNote null.',
        );
        expect(text).not.toBeNull();
        expect(JSON.parse(text!)).toEqual({
          kind: 'portable',
          score: 7,
          nullableFlag: null,
        });
      } finally {
        await f.dispose();
      }
    },
    180_000,
  );
});
