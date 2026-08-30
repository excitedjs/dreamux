/**
 * Coverage cell C (registry half): the error boundary and the shutdown
 * admission fence.
 *
 * `platform/errors.ts` names exactly three generic failure origins
 * (ValidationError/TransportError/InternalError) plus the process-wide
 * ServerShuttingDownError; every other public failure is a business error
 * that extends `DreamuxError` directly and keeps its own code. These tests
 * prove that vocabulary survives both adapters unchanged, and that
 * `CoreCommandPort` — the shared admission fence both adapters invoke
 * through — never lets a request past the fence, whatever Command it names.
 */
import { describe, expect, it, vi } from 'vitest';

import type { CoreCommandDefinition } from '@excitedjs/dreamux-types';

import {
  DreamuxError,
  InternalError,
  ServerShuttingDownError,
  TransportError,
  ValidationError,
} from '../src/command/errors.js';
import * as platformErrors from '../src/platform/errors.js';
import { AdminClientError, adminJsonInvoker } from '../src/admin/client.js';
import { CoreCommandPort } from '../src/command/port.js';
import { CoreCommands } from '../src/command/registry.js';
import { NO_INPUT, objectSchema } from '../src/command/schema.js';
import { DispatcherNotFoundError } from '../src/service/dispatchers/errors.js';
import {
  IdempotencyConflictError,
  TeamClosedError,
  TeamNotFoundError,
} from '../src/service/team-collection/errors.js';
import {
  adminContext,
  channelContext,
  createCommandHarness,
  createHarnessChannelInvoker,
  startHarnessAdminSocket,
  startRawStubSocket,
  type HarnessAdminSocket,
} from './helpers/command-harness.js';

describe('the generic failure vocabulary', () => {
  it('ValidationError carries BAD_REQUEST', () => {
    expect(new ValidationError('bad').code).toBe('BAD_REQUEST');
  });

  it('TransportError carries TRANSPORT_ERROR, never BAD_REQUEST', () => {
    const error = new TransportError('framing failed');
    expect(error.code).toBe('TRANSPORT_ERROR');
    expect(error.code).not.toBe('BAD_REQUEST');
  });

  it('InternalError carries INTERNAL', () => {
    expect(new InternalError('unclassified').code).toBe('INTERNAL');
  });

  it('ServerShuttingDownError carries its own stable code', () => {
    expect(new ServerShuttingDownError().code).toBe('SERVER_SHUTTING_DOWN');
  });

  it('there is no DomainError base class exported alongside DreamuxError', () => {
    // The three generic subclasses and the business errors all extend
    // DreamuxError directly (platform/errors.ts). A `DomainError`
    // intermediate would be a second, undocumented authority for what a
    // failure's shape means — proving the module never exported one is what
    // "extends DreamuxError directly" actually means, not just a naming
    // convention.
    expect('DomainError' in platformErrors).toBe(false);
  });

  it('a DreamuxError carries no layer, category, or retry taxonomy — only a stable code and a message', () => {
    const forbiddenKeys = ['layer', 'category', 'retryable', 'retry', 'audience', 'scope'];
    const instances: DreamuxError[] = [
      new ValidationError('x'),
      new TransportError('x'),
      new InternalError('x'),
      new ServerShuttingDownError(),
      new TeamNotFoundError('x'),
      new TeamClosedError('x'),
      new IdempotencyConflictError('x'),
      new DispatcherNotFoundError('x'),
    ];
    for (const instance of instances) {
      for (const key of forbiddenKeys) {
        expect(Object.prototype.hasOwnProperty.call(instance, key)).toBe(false);
      }
    }
  });

  it('business errors extend DreamuxError DIRECTLY — no DomainError-shaped intermediate in between', () => {
    for (const ErrorClass of [
      TeamNotFoundError,
      TeamClosedError,
      IdempotencyConflictError,
      DispatcherNotFoundError,
    ]) {
      expect(Object.getPrototypeOf(ErrorClass.prototype)).toBe(DreamuxError.prototype);
    }
  });

  it('each business error keeps its own distinct, operation-independent code', () => {
    const codes = new Set([
      new TeamNotFoundError('x').code,
      new TeamClosedError('x').code,
      new IdempotencyConflictError('x').code,
      new DispatcherNotFoundError('x').code,
    ]);
    // Four distinct classes, four distinct codes: none collapsed into a
    // shared reason-tagged error or into INTERNAL.
    expect(codes.size).toBe(4);
    expect(codes.has('INTERNAL')).toBe(false);
  });
});

describe('a known business error survives to the caller with its own code — through both adapters', () => {
  it('TeamNotFoundError (team.dissolve) keeps TEAM_NOT_FOUND, never INTERNAL or BAD_REQUEST', async () => {
    const harness = createCommandHarness({
      dispatcherOverrides: {
        dissolveTeam: async () => {
          throw new TeamNotFoundError("no Team 'ghost'");
        },
      },
    });
    const admin = await startHarnessAdminSocket(harness);
    const lease = createHarnessChannelInvoker(harness);
    try {
      const viaAdmin = await admin.send('team.dissolve', {
        dispatcher_id: 'harness-d1',
        team_name: 'ghost',
        note: 'cleanup',
      });
      expect(viaAdmin.ok).toBe(false);
      expect((viaAdmin as { error: { code: string } }).error.code).toBe('TEAM_NOT_FOUND');

      await expect(
        lease.port.invoke.invoke('team.dissolve', { team_name: 'ghost', note: 'cleanup' }),
      ).rejects.toMatchObject({ code: 'TEAM_NOT_FOUND' });
    } finally {
      await admin.close();
    }
  });

  it('TeamClosedError (team.submit to a closed Team) keeps TEAM_CLOSED, distinct from TEAM_NOT_FOUND', async () => {
    const harness = createCommandHarness({
      dispatcherOverrides: {
        submitToTeamLeader: async () => {
          throw new TeamClosedError("Team 'alpha' is closed");
        },
      },
    });
    const admin = await startHarnessAdminSocket(harness);
    const lease = createHarnessChannelInvoker(harness);
    try {
      const viaAdmin = await admin.send('team.submit', {
        dispatcher_id: 'harness-d1',
        team_name: 'alpha',
        text: 'hello',
      });
      expect((viaAdmin as { error: { code: string } }).error.code).toBe('TEAM_CLOSED');

      await expect(
        lease.port.invoke.invoke('team.submit', { team_name: 'alpha', text: 'hello' }),
      ).rejects.toMatchObject({ code: 'TEAM_CLOSED' });
    } finally {
      await admin.close();
    }
  });

  it('IdempotencyConflictError (team.create replay) keeps IDEMPOTENCY_CONFLICT, not INTERNAL', async () => {
    const harness = createCommandHarness({
      dispatcherOverrides: {
        createTeam: async () => {
          throw new IdempotencyConflictError('request_id replayed with a different payload');
        },
      },
    });
    const lease = createHarnessChannelInvoker(harness);
    await expect(
      lease.port.invoke.invoke('team.create', {
        request_id: 'req-1',
        name_prefix: 'alpha',
        intent: 'do the work',
        leader: { agent_runtime: 'codex' },
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('DispatcherNotFoundError (any dispatcher-scoped Command) keeps DISPATCHER_NOT_FOUND', async () => {
    const harness = createCommandHarness({ dispatcherRow: null });
    const admin = await startHarnessAdminSocket(harness);
    try {
      const viaAdmin = await admin.send('dispatcher.status', { dispatcher_id: 'harness-d1' });
      expect((viaAdmin as { error: { code: string } }).error.code).toBe('DISPATCHER_NOT_FOUND');
    } finally {
      await admin.close();
    }
  });

  it('an unclassified thrown Error becomes INTERNAL — only a genuinely unknown failure does', async () => {
    const harness = createCommandHarness({
      dispatcherOverrides: {
        createTeam: async () => {
          throw new Error('some unrelated bug, not a DreamuxError');
        },
      },
    });
    const admin = await startHarnessAdminSocket(harness);
    const lease = createHarnessChannelInvoker(harness);
    try {
      const viaAdmin = await admin.send('team.create', {
        dispatcher_id: 'harness-d1',
        request_id: 'req-1',
        name_prefix: 'alpha',
        intent: 'do the work',
        leader: { agent_runtime: 'codex' },
      });
      expect((viaAdmin as { error: { code: string } }).error.code).toBe('INTERNAL');

      await expect(
        lease.port.invoke.invoke('team.create', {
          request_id: 'req-2',
          name_prefix: 'alpha',
          intent: 'do the work',
          leader: { agent_runtime: 'codex' },
        }),
      ).rejects.toMatchObject({ code: 'INTERNAL' });
    } finally {
      await admin.close();
    }
  });
});

describe('admin.sock transport failures vs server-side invalid params', () => {
  it('an unframeable line (bad JSON) is TRANSPORT_ERROR, never BAD_REQUEST', async () => {
    const harness = createCommandHarness();
    const admin = await startHarnessAdminSocket(harness);
    try {
      const response = await admin.sendRaw('{not valid json');
      expect(response.ok).toBe(false);
      expect((response as { error: { code: string } }).error.code).toBe('TRANSPORT_ERROR');
    } finally {
      await admin.close();
    }
  });

  it('a well-framed request with a malformed params shape is BAD_REQUEST, not TRANSPORT_ERROR', async () => {
    const harness = createCommandHarness();
    const admin = await startHarnessAdminSocket(harness);
    try {
      // The envelope itself parses fine as JSON; `params` being a string
      // rather than an object is a caller mistake the admin adapter itself
      // catches before any Command is reached — still ValidationError, since
      // the request *did* reach a transport boundary that could read it.
      const response = await admin.sendRaw(
        JSON.stringify({ id: 'req-x', method: 'server.status', params: 'oops' }),
      );
      expect(response.ok).toBe(false);
      expect((response as { error: { code: string } }).error.code).toBe('BAD_REQUEST');
    } finally {
      await admin.close();
    }
  });
});

describe('the real admin client (src/admin/client.ts) — connection/timeout/malformed-response', () => {
  it('reports a server-refused request as AdminClientError, carrying the server code unchanged', async () => {
    // The client side of the same fact core-command-errors already proves
    // server-side: a Command failure is not a transport failure. It reaches
    // the client as a *different* class from TransportError, still carrying
    // the server's own stable code.
    const harness = createCommandHarness({
      dispatcherOverrides: {
        dissolveTeam: async () => {
          throw new TeamNotFoundError("no Team 'ghost'");
        },
      },
    });
    const admin = await startHarnessAdminSocket(harness);
    try {
      const invoker = adminJsonInvoker({ socketPath: admin.socketPath });
      await expect(
        invoker.invoke('team.dissolve', {
          dispatcher_id: 'harness-d1',
          team_name: 'ghost',
          note: 'cleanup',
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(AdminClientError);
        expect((error as AdminClientError).code).toBe('TEAM_NOT_FOUND');
        // Not the transport class: the request DID reach a Command.
        expect(error).not.toBeInstanceOf(TransportError);
        return true;
      });
    } finally {
      await admin.close();
    }
  });

  it('a refused connection (no server listening) is TransportError, never BAD_REQUEST or an AdminClientError', async () => {
    const invoker = adminJsonInvoker({
      socketPath: '/tmp/dreamux-command-harness-no-such-socket.sock',
      timeoutMs: 2_000,
    });
    await expect(invoker.invoke('server.status', {})).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(TransportError);
      expect((error as TransportError).code).toBe('TRANSPORT_ERROR');
      expect(error).not.toBeInstanceOf(AdminClientError);
      return true;
    });
  });

  it('a malformed reply line is TransportError — the request never delivered an answer', async () => {
    const stub = await startRawStubSocket((socket) => {
      socket.on('data', () => {
        socket.write('{not json at all\n');
      });
    });
    try {
      const invoker = adminJsonInvoker({ socketPath: stub.socketPath, timeoutMs: 2_000 });
      await expect(invoker.invoke('server.status', {})).rejects.toMatchObject({
        code: 'TRANSPORT_ERROR',
      });
    } finally {
      await stub.close();
    }
  });

  it('a server that accepts the connection and never answers times out as TransportError', async () => {
    const stub = await startRawStubSocket(() => {
      // Accept, then say nothing — the request never gets a response line.
    });
    try {
      const invoker = adminJsonInvoker({ socketPath: stub.socketPath, timeoutMs: 200 });
      await expect(invoker.invoke('server.status', {})).rejects.toMatchObject({
        code: 'TRANSPORT_ERROR',
      });
    } finally {
      await stub.close();
    }
  });

  it('a connection closed before any response line is TransportError', async () => {
    const stub = await startRawStubSocket((socket) => {
      socket.on('data', () => {
        socket.end();
      });
    });
    try {
      const invoker = adminJsonInvoker({ socketPath: stub.socketPath, timeoutMs: 2_000 });
      await expect(invoker.invoke('server.status', {})).rejects.toMatchObject({
        code: 'TRANSPORT_ERROR',
      });
    } finally {
      await stub.close();
    }
  });
});

describe('CoreCommandPort — the shared admission fence', () => {
  function harnessPort() {
    const executed = vi.fn();
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: CoreCommandDefinition<'harness.slow', unknown, unknown> = {
      name: 'harness.slow',
      version: 1,
      input: NO_INPUT,
      output: objectSchema({}),
      parse: () => ({}),
      async execute() {
        await gate;
        executed();
        return {};
      },
    };
    const registry = new CoreCommands([slow]);
    const port = new CoreCommandPort(registry);
    return { port, release: () => release?.(), executed };
  }

  it('refuses a new invocation immediately once admission is closed, before the handler runs', async () => {
    const { port, executed } = harnessPort();
    port.closeAdmission();

    await expect(port.invoke({ source: 'admin_socket' }, 'harness.slow', {})).rejects.toThrow(
      ServerShuttingDownError,
    );
    expect(executed).not.toHaveBeenCalled();
  });

  it('an invocation admitted before the fence keeps running, and drain() waits for it to settle', async () => {
    const { port, release, executed } = harnessPort();
    const inFlight = port.invoke({ source: 'admin_socket' }, 'harness.slow', {});
    port.closeAdmission();

    // Racing the fence: a second call issued right after closeAdmission is
    // refused outright — never an ambiguous partial mutation.
    await expect(port.invoke({ source: 'channel' }, 'harness.slow', {})).rejects.toMatchObject({
      code: 'SERVER_SHUTTING_DOWN',
    });
    expect(executed).not.toHaveBeenCalled();

    let drained = false;
    const draining = port.drain().then(() => {
      drained = true;
    });
    // The admitted call has not settled yet, so drain() has not resolved.
    await Promise.resolve();
    expect(drained).toBe(false);

    release();
    await inFlight;
    await draining;
    expect(drained).toBe(true);
    expect(executed).toHaveBeenCalledTimes(1);
  });

  it('a request racing the fence never surfaces as a Team error or INTERNAL — only ServerShuttingDownError', async () => {
    const harness = createCommandHarness({
      dispatcherOverrides: {
        dissolveTeam: async () => {
          throw new Error('would have been a business failure, never reached');
        },
      },
    });
    harness.port.closeAdmission();

    await expect(
      harness.port.invoke(adminContext('harness-d1'), 'team.dissolve', {
        team_name: 'alpha',
        note: 'cleanup',
      }),
    ).rejects.toMatchObject({ code: 'SERVER_SHUTTING_DOWN' });
    await expect(
      harness.port.invoke(channelContext(), 'team.dissolve', {
        team_name: 'alpha',
        note: 'cleanup',
      }),
    ).rejects.toMatchObject({ code: 'SERVER_SHUTTING_DOWN' });
  });

  it('the fence is the same object both adapters call through: closing it once refuses both', async () => {
    const harness = createCommandHarness();
    const admin: HarnessAdminSocket = await startHarnessAdminSocket(harness);
    const lease = createHarnessChannelInvoker(harness);
    try {
      harness.port.closeAdmission();

      const viaAdmin = await admin.send('server.status');
      expect((viaAdmin as { error: { code: string } }).error.code).toBe('SERVER_SHUTTING_DOWN');

      await expect(lease.port.invoke.invoke('server.status', {})).rejects.toMatchObject({
        code: 'SERVER_SHUTTING_DOWN',
      });
    } finally {
      await admin.close();
    }
  });
});
