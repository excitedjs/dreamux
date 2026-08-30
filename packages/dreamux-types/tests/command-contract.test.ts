/**
 * The generic Core Command port (issue #209 minimize-provider-boundaries).
 *
 * There is one authoritative Command registry, not an admin method table plus
 * a separate Channel catalog: both the `admin.sock` NDJSON adapter and the
 * in-process Channel invoker resolve the same {@link CoreCommandDefinition}
 * and go through the same {@link CoreCommandRegistry}. `CoreCommandSource` is
 * exactly the two adapters — an Agent no longer reaches Commands at all, so
 * there is no third "mcp" source.
 */
import { describe, expect, it } from 'vitest';

import type {
  ChannelCommandError,
  ChannelCommandRetryableErrorCode,
  CoreCommandContext,
  CoreCommandDefinition,
  CoreCommandRegistry,
  CoreCommandSource,
} from '../src/command.js';
import type { JsonSchema, JsonValue } from '../src/json.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 0) extends <T>() => T extends B
  ? 1
  : 0
  ? true
  : false;

function assertType<T extends true>(_proof?: T): void {
  // Compile-time-only: see agent-runtime-handle-contract.test.ts for the pattern's rationale.
}

describe('CoreCommandSource is exactly admin_socket | channel — no mcp adapter', () => {
  it('the union has exactly two members', () => {
    assertType<Equal<CoreCommandSource, 'admin_socket' | 'channel'>>();
  });
});

describe('CoreCommandContext carries factual invocation context, never a caller identity', () => {
  it('the context has exactly source/dispatcher_id/channel_id', () => {
    assertType<Equal<keyof CoreCommandContext, 'source' | 'dispatcher_id' | 'channel_id'>>();
  });

  it('dispatcher_id and channel_id are optional (an admin_socket call may carry neither)', () => {
    const bare: CoreCommandContext = { source: 'admin_socket' };
    const scoped: CoreCommandContext = {
      source: 'channel',
      dispatcher_id: 'd1',
      channel_id: 'c1',
    };
    expect(bare.dispatcher_id).toBeUndefined();
    expect(scoped.channel_id).toBe('c1');
  });
});

describe('CoreCommandDefinition owns its own schema, parse, and execute', () => {
  it('a hand-built definition parses input and executes against context', async () => {
    interface EchoInput {
      readonly text: string;
    }
    interface EchoOutput {
      readonly echoed: string;
    }

    const inputSchema: JsonSchema = { type: 'object' };
    const outputSchema: JsonSchema = { type: 'object' };

    const definition: CoreCommandDefinition<'echo', EchoInput, EchoOutput> = {
      name: 'echo',
      version: 1,
      input: inputSchema,
      output: outputSchema,
      parse(payload: JsonValue): EchoInput {
        if (
          typeof payload !== 'object' ||
          payload === null ||
          Array.isArray(payload) ||
          typeof (payload as Record<string, JsonValue>).text !== 'string'
        ) {
          throw new Error('invalid echo payload');
        }
        return { text: (payload as Record<string, JsonValue>).text as string };
      },
      async execute(_context: CoreCommandContext, input: EchoInput): Promise<EchoOutput> {
        return { echoed: input.text };
      },
    };

    const parsed = definition.parse({ text: 'hello' });
    const result = await definition.execute({ source: 'channel' }, parsed);
    expect(result).toEqual({ echoed: 'hello' });
    expect(definition.version).toBe(1);
  });
});

describe('CoreCommandRegistry is the single invoke() port both adapters bind to', () => {
  it('exposes exactly invoke, and routes by name + context for both admin_socket and channel', async () => {
    assertType<Equal<keyof CoreCommandRegistry, 'invoke'>>();

    const calls: Array<{ source: CoreCommandSource; name: string }> = [];
    const registry: CoreCommandRegistry = {
      async invoke(
        context: CoreCommandContext,
        name: string,
        _payload: JsonValue,
      ): Promise<JsonValue> {
        calls.push({ source: context.source, name });
        return { ok: true };
      },
    };

    await registry.invoke({ source: 'admin_socket' }, 'team.submit', { text: 'hi' });
    await registry.invoke({ source: 'channel', dispatcher_id: 'd1' }, 'team.submit', {
      text: 'hi',
    });

    expect(calls).toEqual([
      { source: 'admin_socket', name: 'team.submit' },
      { source: 'channel', name: 'team.submit' },
    ]);
  });
});

describe('ChannelCommandError and its narrow retryable-code vocabulary', () => {
  it('the error shape is exactly code + message', () => {
    assertType<Equal<keyof ChannelCommandError, 'code' | 'message'>>();
  });

  it('ChannelCommandRetryableErrorCode is exactly TEAM_NOT_FOUND | TEAM_CLOSED', () => {
    assertType<Equal<ChannelCommandRetryableErrorCode, 'TEAM_NOT_FOUND' | 'TEAM_CLOSED'>>();
  });

  it('code stays an open string on the error shape itself (not narrowed to the retryable codes)', () => {
    const error: ChannelCommandError = { code: 'SOME_DOMAIN_SPECIFIC_CODE', message: 'nope' };
    expect(error.code).toBe('SOME_DOMAIN_SPECIFIC_CODE');
  });
});
