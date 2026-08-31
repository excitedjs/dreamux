/**
 * AgentRuntime push-only state sink, system-prompt semantics, and opaque
 * session-id identity (issue #209 minimize-provider-boundaries).
 *
 * Every runtime fact flows OUT through {@link AgentRuntimeStateSink}; nothing
 * is pulled back off the handle (see agent-runtime-handle-contract.test.ts for
 * the handle-shape half of that invariant). This file covers the sink itself,
 * the lease-revocation error it can reject with, the neutral system-prompt
 * shape, and the opacity of the session id.
 */
import { describe, expect, it } from 'vitest';

import type {
  AgentRuntimeIdentity,
  AgentRuntimeStateLeaseRevokedError,
  AgentRuntimeStateSink,
  AgentRuntimeStateUpdate,
  AgentRuntimeSystemPrompt,
} from '../src/agent-runtime.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 0) extends <T>() => T extends B
  ? 1
  : 0
  ? true
  : false;

function assertType<T extends true>(_proof?: T): void {
  // Compile-time-only: see agent-runtime-handle-contract.test.ts for the pattern's rationale.
}

function assertNever(value: never): never {
  throw new Error(`unreachable union member: ${JSON.stringify(value)}`);
}

describe('AgentRuntimeStateSink is push-only: publish(update) and nothing else', () => {
  it('the sink exposes no pull counterpart alongside publish', () => {
    assertType<Equal<keyof AgentRuntimeStateSink, 'publish'>>();
  });

  it('AgentRuntimeStateUpdate is exactly status | session | session_lost', () => {
    assertType<
      Equal<AgentRuntimeStateUpdate['kind'], 'status' | 'session' | 'session_lost'>
    >();
  });

  it('a fake sink records every published update kind through an exhaustive switch', async () => {
    const received: string[] = [];
    const sink: AgentRuntimeStateSink = {
      async publish(update: AgentRuntimeStateUpdate): Promise<void> {
        switch (update.kind) {
          case 'status':
            received.push(`status:${update.status}`);
            return;
          case 'session':
            received.push(`session:${update.sessionId}`);
            return;
          case 'session_lost':
            received.push(`session_lost:${update.reason}`);
            return;
          default:
            return assertNever(update);
        }
      },
    };

    await sink.publish({ kind: 'status', status: 'ready' });
    await sink.publish({ kind: 'session', sessionId: 'sess-1' });
    await sink.publish({ kind: 'session_lost', reason: 'native process exited' });

    expect(received).toEqual([
      'status:ready',
      'session:sess-1',
      'session_lost:native process exited',
    ]);
  });

  it('publish rejects with a structurally branded AgentRuntimeStateLeaseRevokedError once revoked', async () => {
    function makeLeaseRevokedError(): AgentRuntimeStateLeaseRevokedError {
      const error = new Error('lease revoked') as AgentRuntimeStateLeaseRevokedError;
      error.name = 'AgentRuntimeStateLeaseRevokedError';
      return error;
    }

    const sink: AgentRuntimeStateSink = {
      async publish(): Promise<void> {
        throw makeLeaseRevokedError();
      },
    };

    await expect(sink.publish({ kind: 'status', status: 'stopped' })).rejects.toMatchObject({
      name: 'AgentRuntimeStateLeaseRevokedError',
    });

    // Callers branch on `error.name`, not `instanceof`, precisely because this
    // package is declaration-only and ships no runtime error class to
    // `instanceof` against.
    try {
      await sink.publish({ kind: 'status', status: 'stopped' });
      expect.unreachable('publish must reject once the lease is revoked');
    } catch (caught) {
      const revoked = caught as AgentRuntimeStateLeaseRevokedError;
      expect(revoked.name).toBe('AgentRuntimeStateLeaseRevokedError');
      expect(revoked).toBeInstanceOf(Error);
    }
  });
});

describe('AgentRuntimeSystemPrompt: replace and append are both optional and independent', () => {
  it('replace-only, append-only, and both-forms values are all admissible', () => {
    const replaceOnly: AgentRuntimeSystemPrompt = { replace: 'full replacement text' };
    const appendOnly: AgentRuntimeSystemPrompt = { append: ['fragment one', 'fragment two'] };
    const both: AgentRuntimeSystemPrompt = {
      replace: 'base',
      append: ['extra one', 'extra two'],
    };
    const empty: AgentRuntimeSystemPrompt = {};

    expect(replaceOnly.append).toBeUndefined();
    expect(appendOnly.replace).toBeUndefined();
    expect(both.replace).toBe('base');
    expect(empty.replace).toBeUndefined();
    expect(empty.append).toBeUndefined();
  });

  it('append is an ordered readonly array — fragment order is a load-bearing part of the contract', () => {
    const prompt: AgentRuntimeSystemPrompt = { append: ['first', 'second', 'third'] };
    // Order must round-trip exactly; a provider applying at most one form still
    // owes the caller a stable append order when it does apply this form.
    expect([...(prompt.append ?? [])]).toEqual(['first', 'second', 'third']);
  });

  it('the interface has exactly replace and append — no third alternate form', () => {
    assertType<Equal<keyof AgentRuntimeSystemPrompt, 'replace' | 'append'>>();
  });
});

describe('AgentRuntimeIdentity carries the session as one opaque id and nothing more', () => {
  it('a resumable identity is a runtime id plus the provider\'s own prior session id', () => {
    const identity: AgentRuntimeIdentity = {
      runtimeId: 'runtime-42',
      sessionId: 'sess-42',
    };

    expect(identity.sessionId).toBe('sess-42');
  });

  it('a fresh start carries sessionId: null', () => {
    const identity: AgentRuntimeIdentity = {
      runtimeId: 'runtime-fresh',
      sessionId: null,
    };
    expect(identity.sessionId).toBeNull();
  });

  it('the identity is exactly runtimeId + sessionId — no third durable session fact', () => {
    // The session is a string, not an object a provider could extend: there is
    // nowhere to hang a second durable fact, so "Core does not interpret the
    // session" holds literally rather than by convention.
    assertType<Equal<keyof AgentRuntimeIdentity, 'runtimeId' | 'sessionId'>>();
    assertType<Equal<AgentRuntimeIdentity['sessionId'], string | null>>();
  });

  it('the published session update carries the same plain id Core will persist', () => {
    assertType<
      Equal<
        keyof Extract<AgentRuntimeStateUpdate, { kind: 'session' }>,
        'kind' | 'sessionId'
      >
    >();
  });
});
