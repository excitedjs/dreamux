/**
 * Neutral recent-Activity read contract (issue #209 minimize-provider-boundaries).
 *
 * `AgentActivityRecord` is the ONE stable progress view a provider owes Core —
 * distinct from the transient, optional live {@link AgentRuntimeActivitySink}.
 * It is deliberately thin: an assistant-message text fact, or a tool name plus
 * status. Tool arguments, tool results, and provider-native lines never cross
 * this boundary; those stayed on the deleted `readTranscript` /
 * `transcript_locator` surface this refactor removed.
 */
import { describe, expect, it } from 'vitest';

import type {
  AgentActivityError,
  AgentActivityPage,
  AgentActivityQuery,
  AgentActivityRecord,
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

describe('AgentActivityRecord exposes no tool arguments, results, or native-line member', () => {
  it('the assistant_message branch carries only kind/text/occurredAt', () => {
    assertType<
      Equal<
        keyof Extract<AgentActivityRecord, { kind: 'assistant_message' }>,
        'kind' | 'text' | 'occurredAt'
      >
    >();
  });

  it('the tool branch carries only kind/name/status/occurredAt — no arguments or result', () => {
    assertType<
      Equal<
        keyof Extract<AgentActivityRecord, { kind: 'tool' }>,
        'kind' | 'name' | 'status' | 'occurredAt'
      >
    >();
  });

  it('the record kind union is exactly assistant_message | tool', () => {
    assertType<Equal<AgentActivityRecord['kind'], 'assistant_message' | 'tool'>>();
  });

  it('every record renders through an exhaustive switch that only reads name+status for tools', () => {
    function summarize(record: AgentActivityRecord): string {
      switch (record.kind) {
        case 'assistant_message':
          return `assistant:${record.text}`;
        case 'tool':
          // Only `name` and `status` are readable here — a compile error would
          // surface immediately if `arguments`/`result` reappeared and this
          // switch tried to read them, since the branch type would then widen.
          return `tool:${record.name}:${record.status}`;
        default:
          return assertNever(record);
      }
    }

    expect(summarize({ kind: 'assistant_message', text: 'hi there' })).toBe('assistant:hi there');
    expect(summarize({ kind: 'tool', name: 'search', status: 'completed' })).toBe(
      'tool:search:completed',
    );
  });

  it('tool status is exactly started | completed | failed', () => {
    assertType<
      Equal<
        Extract<AgentActivityRecord, { kind: 'tool' }>['status'],
        'started' | 'completed' | 'failed'
      >
    >();
  });
});

describe('AgentActivityQuery is a bounded, provider-cursor-opaque request', () => {
  it('accepts sessionId/cursor/limit/includeTools with cursor and limit optional', () => {
    const minimal: AgentActivityQuery = { sessionId: 'sess-1' };
    const full: AgentActivityQuery = {
      sessionId: 'sess-1',
      cursor: 'opaque-cursor-token',
      limit: 50,
      includeTools: false,
    };

    expect(minimal.cursor).toBeUndefined();
    expect(full.includeTools).toBe(false);
  });

  it('the session is addressed by a plain opaque id, not a structured reference', () => {
    // Core hands back exactly the string the provider published. A query cannot
    // carry a second durable session fact, because there is no object to hang
    // one on.
    assertType<Equal<AgentActivityQuery['sessionId'], string>>();
  });
});

describe('AgentActivityPage is a chronological page with a truncation flag', () => {
  it('nextCursor is optional (absent means no further page) and truncated is mandatory', () => {
    const finalPage: AgentActivityPage = {
      records: [{ kind: 'assistant_message', text: 'done' }],
      truncated: false,
    };
    const boundedPage: AgentActivityPage = {
      records: [],
      nextCursor: 'cursor-2',
      truncated: true,
    };

    expect(finalPage.nextCursor).toBeUndefined();
    expect(boundedPage.truncated).toBe(true);
  });
});

describe('AgentActivityError reasons stay neutral — no path, native layout, or scan mode', () => {
  it('reason is exactly session_unavailable | cursor_invalid | activity_corrupt | provider_failure', () => {
    assertType<
      Equal<
        AgentActivityError['reason'],
        'session_unavailable' | 'cursor_invalid' | 'activity_corrupt' | 'provider_failure'
      >
    >();
  });

  it('callers branch on error.name rather than instanceof, per the declaration-only contract', () => {
    function makeActivityError(reason: AgentActivityError['reason']): AgentActivityError {
      const error = new Error(`activity read failed: ${reason}`) as AgentActivityError;
      error.name = 'AgentActivityError';
      error.reason = reason;
      return error;
    }

    const error = makeActivityError('cursor_invalid');
    expect(error.name).toBe('AgentActivityError');
    expect(error.reason).toBe('cursor_invalid');
    expect(error).toBeInstanceOf(Error);
  });
});
