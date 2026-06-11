import { createServer, type Server as NetServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import type { AdminRequest, AdminResponse } from '../src/admin/protocol.js';
import { runTeamMateMcp } from '../src/mcp/teammate-mcp.js';

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

async function listTools(callerKind: 'dispatcher' | 'team_leader' | 'teammate'): Promise<string[]> {
  const input = new PassThrough();
  const output = new PassThrough();
  const reader = new JsonLineReader(output);
  const run = runTeamMateMcp({
    dispatcherId: 'dispatcher-a',
    callerKind,
    ...(callerKind === 'team_leader'
      ? { teamId: 'alpha', leaderName: 'alpha-leader' }
      : {}),
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
  const response = (await reader.next()) as {
    result: { tools: Array<{ name: string }> };
  };
  input.end();
  await run;
  return response.result.tools.map((tool) => tool.name);
}

async function toolSchemas(
  callerKind: 'dispatcher' | 'team_leader' | 'teammate',
): Promise<Array<Record<string, unknown>>> {
  const input = new PassThrough();
  const output = new PassThrough();
  const reader = new JsonLineReader(output);
  const run = runTeamMateMcp({
    dispatcherId: 'dispatcher-a',
    callerKind,
    ...(callerKind === 'team_leader'
      ? { teamId: 'alpha', leaderName: 'alpha-leader' }
      : {}),
    adminSocketPath: '/tmp/not-used.sock',
    input,
    output,
    log: () => {},
  });
  writeJson(input, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const response = (await reader.next()) as {
    result: { tools: Array<Record<string, unknown>> };
  };
  input.end();
  await run;
  return response.result.tools;
}

describe('teammate-mcp stdio shim', () => {
  it('exposes agent-centric lifecycle tools to dispatchers only', async () => {
    await expect(listTools('dispatcher')).resolves.toEqual([
      'spawn',
      'send',
      'close',
      'history',
      'list',
      'status',
      'last',
      'get_capabilities',
    ]);

    await expect(listTools('teammate')).resolves.toEqual([
      'history',
      'list',
      'status',
      'last',
      'get_capabilities',
    ]);
  });

  it('marks spawn cwd as required and advertises managed worktree options', async () => {
    const tools = await toolSchemas('dispatcher');
    const spawn = tools.find((entry) => entry['name'] === 'spawn') as {
      inputSchema: {
        required: string[];
        properties: Record<string, unknown>;
      };
    };
    // Issue #182 PR-3: spawn.intent is required (durable recovery subject).
    expect(spawn.inputSchema.required).toEqual(['name', 'prompt', 'cwd', 'intent']);
    expect(spawn.inputSchema.properties).toHaveProperty('worktree');
    expect(JSON.stringify(spawn.inputSchema.properties['worktree'])).toContain(
      'delete-on-close',
    );
  });

  it('marks spawn.intent and close.note required, and send.intent optional (#182 PR-3)', async () => {
    for (const callerKind of ['dispatcher', 'team_leader'] as const) {
      const tools = await toolSchemas(callerKind);
      const spawn = tools.find((e) => e['name'] === 'spawn') as {
        inputSchema: { required: string[]; properties: Record<string, unknown> };
      };
      const send = tools.find((e) => e['name'] === 'send') as {
        inputSchema: { required: string[]; properties: Record<string, unknown> };
      };
      const close = tools.find((e) => e['name'] === 'close') as {
        inputSchema: { required: string[]; properties: Record<string, unknown> };
      };
      // spawn.intent required for both caller kinds.
      expect(spawn.inputSchema.required).toContain('intent');
      // send.intent is an advertised optional property, not required.
      expect(send.inputSchema.properties).toHaveProperty('intent');
      expect(send.inputSchema.required).toEqual(['name', 'prompt']);
      // close.note required.
      expect(close.inputSchema.required).toEqual(['name', 'note']);
    }
  });

  it('advertises history as the session-ledger search surface and last with turns (#188)', async () => {
    const tools = await toolSchemas('dispatcher');
    const history = tools.find((entry) => entry['name'] === 'history') as {
      inputSchema: { required: string[]; properties: Record<string, unknown> };
    };
    const last = tools.find((entry) => entry['name'] === 'last') as {
      inputSchema: { required: string[]; properties: Record<string, unknown> };
    };
    expect(history.inputSchema.required).toEqual([]);
    expect(history.inputSchema.properties).toHaveProperty('limit');
    expect(history.inputSchema.properties).toHaveProperty('cursor');
    expect(history.inputSchema.properties).toHaveProperty('source_cwd');
    // #188: last takes name + an optional 1..5 turns count; ctx/history_events gone.
    expect(last.inputSchema.required).toEqual(['name']);
    expect(last.inputSchema.properties).toHaveProperty('turns');
    expect(last.inputSchema.properties['turns']).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 5,
    });
    expect(tools.find((entry) => entry['name'] === 'ctx')).toBeUndefined();
    expect(
      tools.find((entry) => entry['name'] === 'history_events'),
    ).toBeUndefined();
  });

  it('forwards spawn to the dispatcher-scoped admin method', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: {
        teammate: { name: 'reviewer', status: 'running' },
        turn: { status: 'submitted', turn_id: 'turn-1' },
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
          name: 'spawn',
          arguments: {
            name: 'reviewer',
            prompt: 'Review the change.',
            agent_runtime: 'codex',
            cwd: '/workspace',
            worktree: {
              mode: 'managed',
              slug: 'reviewer',
              base_ref: 'origin/main',
              branch: 'dreamux/reviewer',
              cleanup: 'delete-on-close',
            },
            intent: 'review',
          },
        },
      });

      expect(await reader.next()).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          structuredContent: {
            teammate: { name: 'reviewer', status: 'running' },
            turn: { status: 'submitted', turn_id: 'turn-1' },
          },
        },
      });
      expect(admin.requests).toEqual([
        {
          id: expect.any(String) as string,
          method: 'mcp.teammate.spawn',
          params: {
            dispatcher_id: 'dispatcher-a',
            caller_kind: 'dispatcher',
            name: 'reviewer',
            prompt: 'Review the change.',
            agent_runtime: 'codex',
            cwd: '/workspace',
            worktree: {
              mode: 'managed',
              slug: 'reviewer',
              base_ref: 'origin/main',
              branch: 'dreamux/reviewer',
              cleanup: 'delete-on-close',
            },
            intent: 'review',
          },
        },
      ]);

      input.end();
      await run;
    } finally {
      await admin.close();
    }
  });

  it('rejects spawn without cwd before admin IPC', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: {},
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
          name: 'spawn',
          arguments: {
            name: 'reviewer',
            prompt: 'Review the change.',
            // intent present so this isolates the missing-cwd case.
            intent: 'review',
          },
        },
      });

      expect(await reader.next()).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          isError: true,
          content: [{ text: 'cwd must be a non-empty string' }],
        },
      });
      expect(admin.requests).toEqual([]);

      input.end();
      await run;
    } finally {
      await admin.close();
    }
  });

  it('rejects spawn without intent and close without note before admin IPC (#182 PR-3)', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: {},
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

      // spawn without intent → rejected before admin IPC.
      writeJson(input, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'spawn',
          arguments: { name: 'reviewer', prompt: 'go', cwd: '/workspace' },
        },
      });
      expect(await reader.next()).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          isError: true,
          content: [{ text: 'intent must be a non-empty string' }],
        },
      });

      // close without note → rejected before admin IPC.
      writeJson(input, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'close', arguments: { name: 'reviewer' } },
      });
      expect(await reader.next()).toMatchObject({
        jsonrpc: '2.0',
        id: 2,
        result: {
          isError: true,
          content: [{ text: 'note must be a non-empty string' }],
        },
      });

      expect(admin.requests).toEqual([]);
      input.end();
      await run;
    } finally {
      await admin.close();
    }
  });

  it('rejects lifecycle tools from teammate callers before admin IPC', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: {},
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
          name: 'spawn',
          arguments: { name: 'nested', prompt: 'Do nested work.' },
        },
      });

      expect(await reader.next()).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          isError: true,
        },
      });
      expect(admin.requests).toEqual([]);

      input.end();
      await run;
    } finally {
      await admin.close();
    }
  });

  it('forwards TeamLeader spawn without caller cwd or worktree', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: {
        teammate: { name: 'builder', status: 'running' },
        turn: { status: 'submitted', turn_id: 'turn-1' },
      },
    }));
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      const reader = new JsonLineReader(output);
      const run = runTeamMateMcp({
        dispatcherId: 'dispatcher-a',
        callerKind: 'team_leader',
        teamId: 'alpha',
        leaderName: 'alpha-leader',
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
          name: 'spawn',
          arguments: {
            name: 'builder',
            prompt: 'Build the change.',
            cwd: '/ignored',
            worktree: { mode: 'managed', cleanup: 'delete-on-close' },
            intent: 'build',
          },
        },
      });

      expect(await reader.next()).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          structuredContent: {
            teammate: { name: 'builder', status: 'running' },
          },
        },
      });
      expect(admin.requests).toEqual([
        {
          id: expect.any(String) as string,
          method: 'mcp.teammate.spawn',
          params: {
            dispatcher_id: 'dispatcher-a',
            name: 'builder',
            prompt: 'Build the change.',
            intent: 'build',
            caller_kind: 'team_leader',
            team_id: 'alpha',
            leader_name: 'alpha-leader',
          },
        },
      ]);

      input.end();
      await run;
    } finally {
      await admin.close();
    }
  });

  it('forwards get_capabilities with spawnable agent runtime ids only', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: {
        verbs: ['spawn', 'send', 'get_capabilities'],
        agent_runtimes: [
          {
            id: 'codex',
            spawn: { agent_runtime: 'codex' },
            runtime_available: true,
            resume: { supported: true, checkpoint: 'codexThread' },
            steer: { supported: true },
            events: { kind: 'push' },
            last: { supported: true },
            context: { supported: true },
            unsupported_reason: null,
          },
        ],
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
        params: { name: 'get_capabilities', arguments: {} },
      });

      const response = (await reader.next()) as {
        result: { structuredContent: unknown };
      };
      expect(response.result.structuredContent).toMatchObject({
        agent_runtimes: [
          { id: 'codex', spawn: { agent_runtime: 'codex' } },
        ],
      });
      expect(JSON.stringify(response.result.structuredContent)).not.toContain(
        'provider_ref',
      );
      expect(JSON.stringify(response.result.structuredContent)).not.toContain(
        'builtin:codex',
      );

      input.end();
      await run;
    } finally {
      await admin.close();
    }
  });

  it('forwards history ledger queries and last(turns) reads (#188)', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: { ok: true },
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
          name: 'history',
          arguments: {
            grep: 'review',
            limit: 5,
            close_status: 'open',
          },
        },
      });
      expect(await reader.next()).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: { structuredContent: { ok: true } },
      });

      // last without turns forwards just the name; last with turns forwards both.
      writeJson(input, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'last', arguments: { name: 'reviewer' } },
      });
      expect(await reader.next()).toMatchObject({
        jsonrpc: '2.0',
        id: 2,
        result: { structuredContent: { ok: true } },
      });

      writeJson(input, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'last', arguments: { name: 'reviewer', turns: 3 } },
      });
      expect(await reader.next()).toMatchObject({
        jsonrpc: '2.0',
        id: 3,
        result: { structuredContent: { ok: true } },
      });

      expect(admin.requests.map((request) => request.method)).toEqual([
        'mcp.teammate.history',
        'mcp.teammate.last',
        'mcp.teammate.last',
      ]);
      expect(admin.requests.map((request) => request.params)).toEqual([
        {
          dispatcher_id: 'dispatcher-a',
          caller_kind: 'teammate',
          grep: 'review',
          limit: 5,
          close_status: 'open',
        },
        { dispatcher_id: 'dispatcher-a', caller_kind: 'teammate', name: 'reviewer' },
        {
          dispatcher_id: 'dispatcher-a',
          caller_kind: 'teammate',
          name: 'reviewer',
          turns: 3,
        },
      ]);

      input.end();
      await run;
    } finally {
      await admin.close();
    }
  });
});
