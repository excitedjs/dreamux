import { describe, expect, it } from 'vitest';
import { createServer, type Server as NetServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';

import { runTeamMateMcp } from '../src/mcp/teammate-mcp.js';
import type { AdminRequest, AdminResponse } from '../src/admin/protocol.js';

class JsonLineReader {
  private buffer = '';
  private waiters: Array<(value: unknown) => void> = [];

  constructor(stream: PassThrough) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      this.buffer += chunk;
      this.drain();
    });
  }

  next(): Promise<unknown> {
    const line = this.shiftLine();
    if (line !== null) return Promise.resolve(JSON.parse(line));
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private drain(): void {
    while (this.waiters.length > 0) {
      const line = this.shiftLine();
      if (line === null) return;
      this.waiters.shift()!(JSON.parse(line));
    }
  }

  private shiftLine(): string | null {
    const idx = this.buffer.indexOf('\n');
    if (idx === -1) return null;
    const line = this.buffer.slice(0, idx);
    this.buffer = this.buffer.slice(idx + 1);
    return line;
  }
}

interface FakeAdminServer {
  socketPath: string;
  requests: AdminRequest[];
  close(): Promise<void>;
}

async function startFakeAdminServer(
  respond: (request: AdminRequest) => AdminResponse,
): Promise<FakeAdminServer> {
  const dir = mkdtempSync(join(tmpdir(), 'dreamux-teammate-mcp-admin-'));
  const socketPath = join(dir, 'admin.sock');
  const requests: AdminRequest[] = [];
  const server: NetServer = createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line === '') continue;
        const request = JSON.parse(line) as AdminRequest;
        requests.push(request);
        socket.write(`${JSON.stringify(respond(request))}\n`);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    socketPath,
    requests,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function writeJson(input: PassThrough, value: unknown): void {
  input.write(`${JSON.stringify(value)}\n`);
}

describe('teammate-mcp stdio shim', () => {
  it('announces the scheduling tool without reading dreamux config', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const reader = new JsonLineReader(output);
    const run = runTeamMateMcp({
      dispatcherId: 'dispatcher-a',
      callerKind: 'dispatcher',
      adminSocketPath: '/tmp/not-used.sock',
      input,
      output,
      log: () => {},
    });

    writeJson(input, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(await reader.next()).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'dreamux-teammate' },
      },
    });

    writeJson(input, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const tools = await reader.next() as { result: { tools: Array<{ name: string }> } };
    const names = tools.result.tools.map((tool) => tool.name);
    expect(names).toEqual([
      'schedule',
      'run_task',
      'execute_task',
      'send_input',
      'cancel_task',
      'get_task_logs',
      'get_capabilities',
      'list_tasks',
      'get_task',
      'pull_result',
    ]);
    // await_completion is intentionally NOT a dispatcher-facing tool (issue #126
    // PR8): normal orchestration is run_task → turn ends → delivery/wakeup, not
    // dispatcher-side waiting/polling.
    expect(names).not.toContain('await_completion');
    // Completion ingest is NOT a dispatcher-facing MCP tool, so a dispatcher
    // model cannot fake a TeamMate completion.
    expect(names).not.toContain('complete');

    input.end();
    await run;
  });

  it('forwards pull_result to the dispatcher-scoped admin pull method', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: {
        result: {
          task_id: 'tmtsk_1_task',
          status: 'delivery_failed',
          outcome: 'completed',
          text: 'the retained result',
          delivered: false,
          delivery_attempts: 3,
        },
      },
    }));
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      const reader = new JsonLineReader(output);
      const run = runTeamMateMcp({
        dispatcherId: 'dispatcher-a',
        callerKind: 'dispatcher',
        adminSocketPath: admin.socketPath,
        input,
        output,
        log: () => {},
      });

      writeJson(input, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'pull_result', arguments: { task_id: 'tmtsk_1_task' } },
      });

      expect(await reader.next()).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          structuredContent: {
            result: { status: 'delivery_failed', text: 'the retained result' },
          },
        },
      });
      expect(admin.requests).toEqual([
        {
          id: expect.any(String) as string,
          method: 'mcp.teammate.pull',
          params: { dispatcher_id: 'dispatcher-a', task_id: 'tmtsk_1_task' },
        },
      ]);

      input.end();
      await run;
    } finally {
      await admin.close();
    }
  });

  it('forwards schedule tool calls to the dispatcher-scoped admin IPC method', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: {
        status: 'accepted',
        task_id: 'tmtsk_1_task',
        dispatcher_id: 'dispatcher-a',
        created_at: 1000,
      },
    }));
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      const reader = new JsonLineReader(output);
      const run = runTeamMateMcp({
        dispatcherId: 'dispatcher-a',
        callerKind: 'dispatcher',
        adminSocketPath: admin.socketPath,
        input,
        output,
        log: () => {},
      });

      writeJson(input, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'schedule',
          arguments: {
            title: 'Review issue',
            prompt: 'Read the issue and return a short summary.',
            teammate_id: 'reviewer-1',
          },
        },
      });

      expect(await reader.next()).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          structuredContent: {
            status: 'accepted',
            task_id: 'tmtsk_1_task',
            dispatcher_id: 'dispatcher-a',
            created_at: 1000,
          },
        },
      });
      expect(admin.requests).toEqual([
        {
          id: expect.any(String) as string,
          method: 'mcp.teammate.schedule',
          params: {
            dispatcher_id: 'dispatcher-a',
            caller_kind: 'dispatcher',
            title: 'Review issue',
            prompt: 'Read the issue and return a short summary.',
            teammate_id: 'reviewer-1',
          },
        },
      ]);

      input.end();
      await run;
    } finally {
      await admin.close();
    }
  });

  it('returns validation failures as MCP tool errors', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const reader = new JsonLineReader(output);
    const run = runTeamMateMcp({
      dispatcherId: 'dispatcher-a',
      callerKind: 'dispatcher',
      adminSocketPath: '/tmp/not-used.sock',
      input,
      output,
      log: () => {},
    });

    writeJson(input, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'schedule', arguments: { title: 'Missing prompt' } },
    });

    expect(await reader.next()).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        isError: true,
        content: [{ type: 'text', text: 'prompt must be a non-empty string' }],
      },
    });

    input.end();
    await run;
  });

  it('returns admin nested-dispatch rejection as an MCP tool error', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: false,
      error: {
        code: 'TEAMMATE_NESTED_DISPATCH_REJECTED',
        message: 'TeamMate tasks cannot schedule more TeamMate tasks',
      },
    }));
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      const reader = new JsonLineReader(output);
      const run = runTeamMateMcp({
        dispatcherId: 'dispatcher-a',
        callerKind: 'teammate',
        adminSocketPath: admin.socketPath,
        input,
        output,
        log: () => {},
      });

      writeJson(input, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'schedule',
          arguments: {
            title: 'Nested',
            prompt: 'Nested scheduling attempt.',
          },
        },
      });

      expect(await reader.next()).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          isError: true,
          content: [
            {
              type: 'text',
              text:
                '[TEAMMATE_NESTED_DISPATCH_REJECTED] ' +
                'TeamMate tasks cannot schedule more TeamMate tasks',
            },
          ],
        },
      });
      expect(admin.requests[0]).toMatchObject({
        method: 'mcp.teammate.schedule',
        params: {
          dispatcher_id: 'dispatcher-a',
          caller_kind: 'teammate',
          title: 'Nested',
          prompt: 'Nested scheduling attempt.',
        },
      });

      input.end();
      await run;
    } finally {
      await admin.close();
    }
  });

  it('never writes non-protocol output to stdout, even on error paths', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const rawLines: string[] = [];
    output.setEncoding('utf8');
    let pending = '';
    output.on('data', (chunk: string) => {
      pending += chunk;
      let idx: number;
      while ((idx = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, idx);
        pending = pending.slice(idx + 1);
        if (line.trim() !== '') rawLines.push(line);
      }
    });
    const logMessages: string[] = [];
    const run = runTeamMateMcp({
      dispatcherId: 'dispatcher-a',
      callerKind: 'dispatcher',
      adminSocketPath: '/tmp/dreamux-teammate-nonexistent.sock',
      input,
      output,
      log: (message) => logMessages.push(message),
    });

    input.write('this is not json\n');
    writeJson(input, { jsonrpc: '2.0', id: 1, method: 'no/such/method', params: {} });
    writeJson(input, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'schedule',
        arguments: { title: 'Task', prompt: 'Prompt' },
      },
    });

    input.end();
    await run;
    await new Promise((resolve) => setImmediate(resolve));

    expect(rawLines.length).toBe(3);
    const parsed = rawLines.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    for (const envelope of parsed) {
      expect(envelope['jsonrpc']).toBe('2.0');
    }
    expect(parsed[0]).toMatchObject({ id: null, error: { code: -32700 } });
    expect(parsed[1]).toMatchObject({ id: 1, error: { code: -32601 } });
    expect(parsed[2]).toMatchObject({ id: 2, result: { isError: true } });

    const stdout = rawLines.join('\n');
    for (const message of logMessages) {
      expect(stdout).not.toContain(message);
    }
  });

  it('forwards run_task with caller kind and a flattened target path', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: {
        task: { task_id: 'tmtsk_1_run', lifecycle_status: 'accepted' },
        execution: { status: 'provider_unavailable' },
      },
    }));
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      const reader = new JsonLineReader(output);
      const run = runTeamMateMcp({
        dispatcherId: 'dispatcher-a',
        callerKind: 'dispatcher',
        adminSocketPath: admin.socketPath,
        input,
        output,
        log: () => {},
      });

      writeJson(input, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'run_task',
          arguments: {
            title: 'Run it',
            prompt: 'do the work',
            target: { kind: 'path', path: 'sub/repo' },
            target_mode: 'in_place',
            operation_id: 'op-1',
          },
        },
      });

      expect(await reader.next()).toMatchObject({
        id: 1,
        result: {
          structuredContent: {
            execution: { status: 'provider_unavailable' },
          },
        },
      });
      expect(admin.requests[0]).toEqual({
        id: expect.any(String) as string,
        method: 'mcp.teammate.run',
        params: {
          dispatcher_id: 'dispatcher-a',
          caller_kind: 'dispatcher',
          title: 'Run it',
          prompt: 'do the work',
          target_path: 'sub/repo',
          target_mode: 'in_place',
          operation_id: 'op-1',
        },
      });

      input.end();
      await run;
    } finally {
      await admin.close();
    }
  });

  it('forwards cancel_task with an optional note (PR5)', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: {
        task_id: 'tmtsk_1_run',
        status: 'cancelled',
        lifecycle_status: 'cancelled',
        cancelled_live_session: true,
      },
    }));
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      const reader = new JsonLineReader(output);
      const run = runTeamMateMcp({
        dispatcherId: 'dispatcher-a',
        callerKind: 'dispatcher',
        adminSocketPath: admin.socketPath,
        input,
        output,
        log: () => {},
      });

      writeJson(input, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'cancel_task',
          arguments: { task_id: 'tmtsk_1_run', note: 'stop now' },
        },
      });

      expect(await reader.next()).toMatchObject({
        id: 1,
        result: { structuredContent: { status: 'cancelled' } },
      });
      expect(admin.requests[0]).toEqual({
        id: expect.any(String) as string,
        method: 'mcp.teammate.cancel',
        params: {
          dispatcher_id: 'dispatcher-a',
          task_id: 'tmtsk_1_run',
          note: 'stop now',
        },
      });

      input.end();
      await run;
    } finally {
      await admin.close();
    }
  });

  it('forwards get_task_logs with bounded tail params (PR5)', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: {
        task_id: 'tmtsk_1_run',
        provider_ref: 'builtin:codex',
        logs_supported: true,
        streams: [{ stream: 'stderr', available: true, bytes: 4, truncated: false, text: 'hi\n\n' }],
      },
    }));
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      const reader = new JsonLineReader(output);
      const run = runTeamMateMcp({
        dispatcherId: 'dispatcher-a',
        callerKind: 'dispatcher',
        adminSocketPath: admin.socketPath,
        input,
        output,
        log: () => {},
      });

      writeJson(input, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'get_task_logs',
          arguments: { task_id: 'tmtsk_1_run', max_bytes: 256, stream: 'stderr' },
        },
      });

      expect(await reader.next()).toMatchObject({
        id: 1,
        result: { structuredContent: { logs_supported: true } },
      });
      expect(admin.requests[0]).toEqual({
        id: expect.any(String) as string,
        method: 'mcp.teammate.logs',
        params: {
          dispatcher_id: 'dispatcher-a',
          task_id: 'tmtsk_1_run',
          max_bytes: 256,
          stream: 'stderr',
        },
      });

      input.end();
      await run;
    } finally {
      await admin.close();
    }
  });

  it('rejects await_completion as an unknown tool (removed from the dispatcher surface)', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const reader = new JsonLineReader(output);
    const run = runTeamMateMcp({
      dispatcherId: 'dispatcher-a',
      callerKind: 'dispatcher',
      adminSocketPath: '/tmp/not-used.sock',
      input,
      output,
      log: () => {},
    });

    writeJson(input, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'await_completion',
        arguments: { task_id: 'tmtsk_1_run' },
      },
    });

    expect(await reader.next()).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        isError: true,
        content: [
          { type: 'text', text: "unknown TeamMate tool 'await_completion'" },
        ],
      },
    });

    input.end();
    await run;
  });

  it('defaults send_input to no explicit mode and forwards it as given', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: { input_id: 'input_1', mode: 'queue', status: 'queued' },
    }));
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      const reader = new JsonLineReader(output);
      const run = runTeamMateMcp({
        dispatcherId: 'dispatcher-a',
        callerKind: 'dispatcher',
        adminSocketPath: admin.socketPath,
        input,
        output,
        log: () => {},
      });

      writeJson(input, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'send_input',
          arguments: { task_id: 'tmtsk_1_run', prompt: 'also lint', mode: 'queue' },
        },
      });

      await reader.next();
      expect(admin.requests[0]).toEqual({
        id: expect.any(String) as string,
        method: 'mcp.teammate.send_input',
        params: {
          dispatcher_id: 'dispatcher-a',
          task_id: 'tmtsk_1_run',
          prompt: 'also lint',
          mode: 'queue',
        },
      });

      input.end();
      await run;
    } finally {
      await admin.close();
    }
  });
});
