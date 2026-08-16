import { describe, expect, it, vi } from 'vitest';

import type {
  AgentRuntimeProvider,
  AgentRuntimeTranscriptError,
  AgentRuntimeTranscriptPage,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import {
  TRANSCRIPT_INTERNAL_ERROR_MESSAGE,
  TRANSCRIPT_PUBLIC_ERRORS,
  mapAgentTranscriptAdminError,
} from '../src/admin/transcript-errors.js';
import { adminMethods } from '../src/admin/methods.js';
import type { Server } from '../src/server.js';
import {
  AgentTranscriptReadError,
  readAgentTranscript,
} from '../src/service/agent-entity/transcript-reader.js';
import type { AgentEntityIdentity } from '../src/service/agent-entity/types.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';

describe('core Agent Runtime transcript delegation', () => {
  it('normalizes the query and never constructs a Runtime', async () => {
    const createRuntime = vi.fn(() => {
      throw new Error('cold transcript read must not construct a Runtime');
    });
    const readTranscript = vi.fn(async (): Promise<AgentRuntimeTranscriptPage> => ({
      turns: [
        {
          startedAt: 1,
          endedAt: 2,
          blocks: [
            {
              kind: 'message',
              role: 'assistant',
              text: 'done',
              truncated: false,
              privateNativeId: 'message-private',
            },
          ],
          privateTurnId: 'turn-private',
        },
      ],
      nextCursor: 'next',
      truncated: false,
      privateLocator: '/private/native/session.jsonl',
    } as unknown as AgentRuntimeTranscriptPage));
    const provider = fakeProvider({ createRuntime, readTranscript });

    const result = await readAgentTranscript({
      config: config(),
      providers: catalog(provider),
      identity: identity(),
      query: {},
      log: log(),
    });
    expect(JSON.stringify(result)).not.toContain('message-private');
    expect(JSON.stringify(result)).not.toContain('turn-private');
    expect(JSON.stringify(result)).not.toContain('/private/native/');

    expect(result).toMatchObject({
      requestedTurns: 1,
      nextCursor: 'next',
      turns: [
        {
          blocks: [
            { kind: 'message', role: 'assistant', text: 'done' },
          ],
        },
      ],
    });
    expect(readTranscript).toHaveBeenCalledWith(
      { turns: 1, includeTools: true },
      expect.objectContaining({
        checkpoint: {
          id: 'session-a',
          transcript_locator: '/native/session-a.jsonl',
        },
        outputBudgetBytes: 262_144,
      }),
    );
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it('rejects a provider page that exceeds the fixed output budget', async () => {
    const provider = fakeProvider({
      createRuntime: vi.fn(),
      readTranscript: vi.fn(async () => ({
        turns: [
          {
            startedAt: null,
            endedAt: null,
            blocks: [
              {
                kind: 'message' as const,
                role: 'assistant' as const,
                text: 'x'.repeat(262_145),
                truncated: false,
              },
            ],
          },
        ],
        nextCursor: null,
        truncated: false,
      })),
    });

    let readError: unknown;
    try {
      await readAgentTranscript({
        config: config(),
        providers: catalog(provider),
        identity: identity(),
        query: { turns: 1 },
        log: log(),
      });
    } catch (error) {
      readError = error;
    }
    expect(() => mapAgentTranscriptAdminError(readError)).toThrow(
      expect.objectContaining({
        code: 'INTERNAL',
        message: TRANSCRIPT_INTERNAL_ERROR_MESSAGE,
      }),
    );
  });

  it('rejects malformed opaque cursor text before provider dispatch', async () => {
    const readTranscript = vi.fn();
    const provider = fakeProvider({
      createRuntime: vi.fn(),
      readTranscript,
    });

    let readError: unknown;
    try {
      await readAgentTranscript({
        config: config(),
        providers: catalog(provider),
        identity: identity(),
        query: { cursor: 'not base64url!' },
        log: log(),
      });
    } catch (error) {
      readError = error;
    }
    expect(() => mapAgentTranscriptAdminError(readError)).toThrow(
      expect.objectContaining({
        code: 'TRANSCRIPT_CURSOR_INVALID',
        message: 'The transcript cursor is invalid.',
      }),
    );
    expect(readTranscript).not.toHaveBeenCalled();
  });

  it.each(TRANSCRIPT_PUBLIC_ERRORS)(
    'maps transcript reason $reason to fixed admin error $code without provider text',
    async ({ reason, code, message }) => {
      const privateDetail = '/private/native/session.jsonl: provider detail';
      const logger = capturingLog();
      const provider = fakeProvider({
        createRuntime: vi.fn(),
        readTranscript: vi.fn(async () => {
          throw transcriptError(reason, privateDetail);
        }),
      });
      let readError: unknown;
      try {
        await readAgentTranscript({
          config: config(),
          providers: catalog(provider),
          identity: identity(),
          query: {},
          log: logger.log,
        });
      } catch (error) {
        readError = error;
      }

      expect(() => mapAgentTranscriptAdminError(readError)).toThrow(
        expect.objectContaining({ code, message }),
      );
      expect(caughtMessage(() => mapAgentTranscriptAdminError(readError)))
        .not.toContain(privateDetail);
      expect(logger.errors).toEqual([
        {
          fields: {
            teammate: 'reviewer',
            transcript_reason: reason,
          },
          message: 'Agent Runtime transcript read failed',
        },
      ]);
      expect(JSON.stringify(logger.errors)).not.toContain(privateDetail);
    },
  );

  it.each(TRANSCRIPT_PUBLIC_ERRORS)(
    'projects transcript reason $reason through the teammate.last admin handler',
    async ({ reason, code, message }) => {
      const server = adminServerThatThrows(
        new AgentTranscriptReadError(reason),
      );
      await expect(
        adminMethods['teammate.last']!(server, {
          dispatcher_id: 'dispatcher-a',
          name: 'reviewer',
        }),
      ).rejects.toMatchObject({ name: 'AdminError', code, message });
    },
  );

  it('sanitizes an unknown teammate.last failure at the admin handler', async () => {
    const server = adminServerThatThrows(
      new AgentTranscriptReadError(null),
    );
    await expect(
      adminMethods['teammate.last']!(server, {
        dispatcher_id: 'dispatcher-a',
        name: 'reviewer',
      }),
    ).rejects.toMatchObject({
      name: 'AdminError',
      code: 'INTERNAL',
      message: TRANSCRIPT_INTERNAL_ERROR_MESSAGE,
    });
  });

  it('preserves non-transcript teammate.last service failures', async () => {
    const serviceError = new Error('TeamMate "missing" does not exist');
    const server = adminServerThatThrows(serviceError);

    await expect(
      adminMethods['teammate.last']!(server, {
        dispatcher_id: 'dispatcher-a',
        name: 'missing',
      }),
    ).rejects.toBe(serviceError);
  });

  it('keeps ordinary turns validation as BAD_REQUEST at the admin handler', async () => {
    const server = adminServerThatThrows(
      new Error('service must not be reached'),
    );
    await expect(
      adminMethods['teammate.last']!(server, {
        dispatcher_id: 'dispatcher-a',
        name: 'reviewer',
        turns: 51,
      }),
    ).rejects.toMatchObject({
      name: 'AdminError',
      code: 'BAD_REQUEST',
      message: 'teammate.last turns must be an integer in 1..50',
    });
  });

  it.each([
    new Error('/private/native/session.jsonl: arbitrary provider failure'),
    {
      name: 'AgentRuntimeTranscriptError',
      reason: 'future_private_reason',
      message: '/private/native/session.jsonl: malformed provider error',
    },
  ])('maps unknown or malformed provider exceptions to the generic internal error', async (
    providerError,
  ) => {
    const logger = capturingLog();
    const provider = fakeProvider({
      createRuntime: vi.fn(),
      readTranscript: vi.fn(async () => {
        throw providerError;
      }),
    });
    let readError: unknown;
    try {
      await readAgentTranscript({
        config: config(),
        providers: catalog(provider),
        identity: identity(),
        query: {},
        log: logger.log,
      });
    } catch (error) {
      readError = error;
    }

    expect(() => mapAgentTranscriptAdminError(readError)).toThrow(
      expect.objectContaining({
        code: 'INTERNAL',
        message: TRANSCRIPT_INTERNAL_ERROR_MESSAGE,
      }),
    );
    expect(caughtMessage(() => mapAgentTranscriptAdminError(readError)))
      .not.toContain('/private/');
    expect(logger.errors).toEqual([
      {
        fields: {
          teammate: 'reviewer',
          transcript_reason: 'internal',
        },
        message: 'Agent Runtime transcript read failed',
      },
    ]);
    expect(JSON.stringify(logger.errors)).not.toContain('/private/');
  });
});

function adminServerThatThrows(error: Error): Server {
  return {
    repos: {
      dispatchers: {
        get: () => ({ dispatcher_id: 'dispatcher-a' }),
      },
    },
    getDispatcher: () => ({
      teammates: {
        last: async () => {
          throw error;
        },
      },
    }),
  } as unknown as Server;
}

function transcriptError(
  reason: AgentRuntimeTranscriptError['reason'],
  message: string,
): AgentRuntimeTranscriptError {
  return Object.assign(new Error(message), {
    name: 'AgentRuntimeTranscriptError' as const,
    reason,
  });
}

function caughtMessage(callback: () => never): string {
  try {
    callback();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function fakeProvider(input: {
  createRuntime: AgentRuntimeProvider['createRuntime'];
  readTranscript: AgentRuntimeProvider['readTranscript'];
}): AgentRuntimeProvider {
  return {
    ref: 'test:runtime',
    descriptor: {
      id: 'test-runtime',
      kind: 'agentRuntime',
      ref: { source: 'builtin', id: 'test-runtime', raw: 'test:runtime' },
    },
    getCapabilities: () => ({ resume: { supported: true } }),
    createRuntime: input.createRuntime,
    readTranscript: input.readTranscript,
  };
}

function catalog(provider: AgentRuntimeProvider) {
  return {
    resolve: () => provider,
  } as never;
}

function config() {
  return testDreamuxConfig([
    testDispatcherConfig({
      id: 'dispatcher-a',
      agentRuntime: 'agent-a',
      runtimeProvider: 'test:runtime',
    }),
  ]);
}

function identity(): AgentEntityIdentity {
  return {
    version: 1,
    dispatcher_id: 'dispatcher-a',
    name: 'reviewer',
    role: 'teammate',
    team_id: null,
    agent_runtime: 'agent-a',
    session_id: 'session-a',
    transcript_locator: '/native/session-a.jsonl',
    source_cwd: '/workspace',
    source_repo: null,
    cwd: '/workspace',
    runtime_cwd: '/workspace',
    worktree: {
      mode: 'reuse-cwd',
      slug: null,
      path: '/workspace',
      branch: null,
      base_ref: null,
      cleanup: 'keep',
      cleanup_state: 'not-managed',
      cleanup_error: null,
    },
    intent: 'review',
    identity_prompt: null,
    skill_sources: [],
    created_at: 1,
    updated_at: 1,
    status: 'closed',
    last_error: null,
    closed_at: 1,
    close_note: 'done',
  };
}

function log(): DreamuxLogger {
  return {
    error: () => undefined,
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
  };
}

function capturingLog(): {
  log: DreamuxLogger;
  errors: Array<{
    fields: Record<string, unknown>;
    message: string | undefined;
  }>;
} {
  const errors: Array<{
    fields: Record<string, unknown>;
    message: string | undefined;
  }> = [];
  return {
    errors,
    log: {
      error: (
        fieldsOrMessage: Record<string, unknown> | string,
        message?: string,
      ) => {
        errors.push({
          fields:
            typeof fieldsOrMessage === 'string' ? {} : fieldsOrMessage,
          message:
            typeof fieldsOrMessage === 'string'
              ? fieldsOrMessage
              : message,
        });
      },
      warn: () => undefined,
      info: () => undefined,
      debug: () => undefined,
      trace: () => undefined,
    },
  };
}
