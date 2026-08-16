import { createServer, type Server as NetServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CallToolResult, Tool } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';

import type { AdminRequest, AdminResponse } from '../src/admin/protocol.js';
import { SANITIZED_TOOL_ERROR } from '../src/mcp/server.js';
import {
  TEAMMATE_DISPATCH_SUCCESS_REMINDER,
  WORKFLOW_RUN_SUCCESS_REMINDER,
} from '../src/mcp/task-dispatch-reminder.js';
import {
  runTeamMateMcp,
  type TeamMateMcpCallerKind,
} from '../src/mcp/teammate-mcp.js';
import {
  callTool,
  connectMcpClient,
  listedTools,
  type ConnectedMcpClient,
} from './helpers/mcp-client.js';

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

async function openTeammateMcp(
  callerKind: TeamMateMcpCallerKind,
  adminSocketPath = '/tmp/not-used.sock',
): Promise<ConnectedMcpClient> {
  return connectMcpClient((transport) =>
    runTeamMateMcp({
      dispatcherId: 'dispatcher-a',
      callerKind,
      ...(callerKind === 'team_leader' ? { teamId: 'alpha' } : {}),
      adminSocketPath,
      transport,
      log: () => {},
    }),
  );
}

async function toolSchemas(callerKind: TeamMateMcpCallerKind): Promise<Tool[]> {
  const mcp = await openTeammateMcp(callerKind);
  try {
    return await listedTools(mcp.client);
  } finally {
    await mcp.close();
  }
}

function schemaOf(tools: Tool[], name: string): {
  required: string[];
  properties: Record<string, Record<string, unknown>>;
} {
  const tool = tools.find((entry) => entry.name === name);
  if (tool === undefined) throw new Error(`tool '${name}' not found`);
  return tool.inputSchema as {
    required: string[];
    properties: Record<string, Record<string, unknown>>;
  };
}

function expectOrdinarySuccess(
  result: CallToolResult,
  value: Record<string, unknown>,
): void {
  expect(result).toEqual({ content: [], structuredContent: value });
}

function expectReminderSuccess(
  result: CallToolResult,
  value: Record<string, unknown>,
  reminder: string,
): void {
  expect(result).toEqual({
    content: [{ type: 'text', text: reminder }],
    structuredContent: value,
  });
}

describe('teammate MCP', () => {
  it('exposes agent-centric lifecycle tools to dispatcher and TeamLeader callers', async () => {
    const expected = [
      'spawn',
      'send',
      'close',
      'history',
      'list',
      'status',
      'last',
      'get_capabilities',
      'workflow_run',
      'workflow_status',
      'workflow_stop',
      'workflow_list',
    ];
    for (const callerKind of ['dispatcher', 'team_leader'] as const) {
      expect((await toolSchemas(callerKind)).map((tool) => tool.name)).toEqual(expected);
    }
  });

  it('advertises the workflow contract through the bundled workflow skill', async () => {
    for (const callerKind of ['dispatcher', 'team_leader'] as const) {
      const tools = await toolSchemas(callerKind);
      const workflowTools = tools.filter((entry) => entry.name.startsWith('workflow_'));
      expect(workflowTools.map((tool) => tool.name)).toEqual([
        'workflow_run',
        'workflow_status',
        'workflow_stop',
        'workflow_list',
      ]);
      expect(workflowTools.every((tool) =>
        tool.description?.includes('bundled `workflow` skill') === true
      )).toBe(true);
      const run = schemaOf(tools, 'workflow_run');
      expect(run.required).toEqual([]);
      expect(run.properties['script']).toMatchObject({ type: 'string', minLength: 1 });
      expect(run.properties['scriptPath']).toMatchObject({ type: 'string', minLength: 1 });
      expect(run.properties['args']).toEqual({
        type: ['object', 'array', 'string', 'number', 'boolean', 'null'],
        description:
          'Optional direct JSON value available as the script-global args. ' +
          'Pass objects and arrays directly; do not JSON.stringify them.',
      });
      expect(run.properties['max_concurrency']).toMatchObject({
        type: 'integer',
        minimum: 1,
        maximum: 16,
      });
      for (const name of ['workflow_status', 'workflow_stop']) {
        expect(schemaOf(tools, name)).toMatchObject({
          required: ['run_id'],
          properties: { run_id: { type: 'string', pattern: '^[a-z0-9-]+$' } },
        });
      }
      expect(schemaOf(tools, 'workflow_list')).toEqual({
        type: 'object',
        additionalProperties: false,
        properties: {},
        required: [],
      });
    }
  });

  it('maps workflow tools onto TeamLeader-scoped admin methods', async () => {
    const workflowRecord = {
      version: 1,
      run_id: 'run-1',
      dispatcher_id: 'dispatcher-a',
      team_id: 'alpha',
      caller_kind: 'team_leader',
      script_hash: 'abc123',
      status: 'running',
      max_concurrency: 4,
      phase: null,
      last_log: null,
      agents: [
        {
          index: 0,
          name: 'reviewer',
          label: 'review',
          phase: 'review',
          status: 'completed',
          result: { answer: 42 },
          error: null,
          created_at: 1,
          settled_at: 2,
        },
      ],
      result: null,
      error: null,
      created_at: 1,
      updated_at: 1,
      ended_at: null,
    };
    const results: Record<string, unknown> = {
      'workflow.run': { run_id: 'run-1' },
      'workflow.status': workflowRecord,
      'workflow.stop': { run_id: 'run-1', status: 'stopped' },
      'workflow.list': { runs: [workflowRecord] },
    };
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: results[request.method] ?? {},
    }));
    const mcp = await openTeammateMcp('team_leader', admin.socketPath);
    try {
      const script = 'export const meta = { name: "x", description: "x" }; return args;';
      const run = await callTool(mcp.client, 'workflow_run', {
        script,
        args: { targets: ['api', { area: 'lifecycle' }] },
        max_concurrency: 4,
      });
      const status = await callTool(mcp.client, 'workflow_status', { run_id: 'run-1' });
      const stop = await callTool(mcp.client, 'workflow_stop', { run_id: 'run-1' });
      const list = await callTool(mcp.client, 'workflow_list', {});
      expectReminderSuccess(run, { run_id: 'run-1' }, WORKFLOW_RUN_SUCCESS_REMINDER);
      expectOrdinarySuccess(status, workflowRecord);
      expectOrdinarySuccess(stop, { run_id: 'run-1', status: 'stopped' });
      expectOrdinarySuccess(list, { runs: [workflowRecord] });
      expect(admin.requests.map((request) => request.method)).toEqual([
        'workflow.run',
        'workflow.status',
        'workflow.stop',
        'workflow.list',
      ]);
      for (const request of admin.requests) {
        expect(request.params).toMatchObject({
          dispatcher_id: 'dispatcher-a',
          caller_kind: 'team_leader',
          team_id: 'alpha',
        });
      }
      expect(admin.requests[0]?.params).toMatchObject({
        script,
        args: { targets: ['api', { area: 'lifecycle' }] },
        max_concurrency: 4,
      });
    } finally {
      await mcp.close();
      await admin.close();
    }
  });

  it('sanitizes an unmapped workflow_run admin error without structured content', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: false,
      error: { code: 'WORKFLOW_START_FAILED', message: 'private workflow detail' },
    }));
    const logs: string[] = [];
    const mcp = await connectMcpClient((transport) =>
      runTeamMateMcp({
        dispatcherId: 'dispatcher-a',
        callerKind: 'dispatcher',
        adminSocketPath: admin.socketPath,
        transport,
        log: (message) => logs.push(message),
      }),
    );
    try {
      const result = await callTool(mcp.client, 'workflow_run', {
        script: 'export const meta = { name: "x", description: "x" }; return null;',
      });
      expect(result).toMatchObject({
        isError: true,
        content: [{ type: 'text', text: SANITIZED_TOOL_ERROR }],
      });
      expect(result).not.toHaveProperty('structuredContent');
      expect(JSON.stringify(result)).not.toContain('private workflow detail');
      expect(logs.join('\n')).toContain('private workflow detail');
    } finally {
      await mcp.close();
      await admin.close();
    }
  });

  it('accepts workflow concurrency 16 and rejects invalid values before admin', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: { run_id: 'run-16' },
    }));
    const mcp = await openTeammateMcp('dispatcher', admin.socketPath);
    try {
      const script = 'export const meta = { name: "x", description: "x" }; return null;';
      expectReminderSuccess(
        await callTool(mcp.client, 'workflow_run', { script, max_concurrency: 16 }),
        { run_id: 'run-16' },
        WORKFLOW_RUN_SUCCESS_REMINDER,
      );
      for (const maxConcurrency of [0, 17, 1.5, null]) {
        await expect(
          callTool(mcp.client, 'workflow_run', {
            script,
            max_concurrency: maxConcurrency,
          }),
        ).resolves.toMatchObject({ isError: true });
      }
      expect(admin.requests).toHaveLength(1);
      expect(admin.requests[0]?.params).toMatchObject({ max_concurrency: 16 });
    } finally {
      await mcp.close();
      await admin.close();
    }
  });

  it('does not add workflow success text for an empty projected run id', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: { run_id: '' },
    }));
    const mcp = await openTeammateMcp('dispatcher', admin.socketPath);
    try {
      expectOrdinarySuccess(
        await callTool(mcp.client, 'workflow_run', {
          script: 'export const meta = { name: "x", description: "x" }; return null;',
        }),
        { run_id: '' },
      );
    } finally {
      await mcp.close();
      await admin.close();
    }
  });

  it('takes an optional repo input and no longer requires cwd/worktree (#199 Slice 2)', async () => {
    const tools = await toolSchemas('dispatcher');
    const spawn = schemaOf(tools, 'spawn');
    expect(spawn.required).toEqual(['name_prefix', 'prompt', 'intent']);
    expect(spawn.properties).toHaveProperty('name_prefix');
    expect(spawn.properties).toHaveProperty('repo');
    expect(spawn.properties).not.toHaveProperty('cwd');
    expect(spawn.properties).not.toHaveProperty('worktree');
    expect(spawn.properties).not.toHaveProperty('skill_sources');
    const repo = JSON.stringify(spawn.properties['repo']);
    expect(repo).toContain('reuse-cwd');
    expect(repo).toContain('managed');
    expect(repo).toContain('delete-on-close');
  });

  it('marks spawn.intent and close.note required, and send.intent optional (#182 PR-3)', async () => {
    for (const callerKind of ['dispatcher', 'team_leader'] as const) {
      const tools = await toolSchemas(callerKind);
      expect(schemaOf(tools, 'spawn').required).toContain('intent');
      expect(schemaOf(tools, 'send')).toMatchObject({
        required: ['name', 'prompt'],
        properties: { intent: expect.any(Object) },
      });
      expect(schemaOf(tools, 'close').required).toEqual(['name', 'note']);
    }
  });

  it('advertises history as the session-ledger search surface and last with turns (#188)', async () => {
    const tools = await toolSchemas('dispatcher');
    const history = schemaOf(tools, 'history');
    expect(history.required).toEqual([]);
    for (const key of ['limit', 'cursor', 'name', 'agent_runtime', 'grep']) {
      expect(history.properties).toHaveProperty(key);
    }
    for (const key of ['id', 'state', 'close_status', 'source_cwd', 'runtime_cwd']) {
      expect(history.properties).not.toHaveProperty(key);
    }
    expect(schemaOf(tools, 'last')).toMatchObject({
      required: ['name'],
      properties: { turns: { type: 'integer', minimum: 1, maximum: 5 } },
    });
    expect(tools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining(['ctx', 'history_events']),
    );
  });

  it('forwards spawn to the dispatcher-scoped admin method with a pure receipt', async () => {
    const receipt = {
      teammate: { name: 'reviewer', status: 'running' },
      status: 'submitted',
    };
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: receipt,
    }));
    const mcp = await openTeammateMcp('dispatcher', admin.socketPath);
    try {
      const repo = {
        mode: 'managed',
        path: '/workspace',
        slug: 'reviewer',
        base_ref: 'origin/main',
        branch: 'dreamux/reviewer',
        cleanup: 'delete-on-close',
      };
      expectReminderSuccess(
        await callTool(mcp.client, 'spawn', {
          name_prefix: 'reviewer',
          prompt: 'Review the change.',
          agent_runtime: 'codex',
          repo,
          intent: 'review',
          identity: 'architecture reviewer',
        }),
        receipt,
        TEAMMATE_DISPATCH_SUCCESS_REMINDER,
      );
      expect(admin.requests[0]).toMatchObject({
        method: 'teammate.spawn',
        params: {
          dispatcher_id: 'dispatcher-a',
          caller_kind: 'dispatcher',
          name_prefix: 'reviewer',
          prompt: 'Review the change.',
          agent_runtime: 'codex',
          repo,
          intent: 'review',
          identity: 'architecture reviewer',
        },
      });
      await expect(
        callTool(mcp.client, 'spawn', {
          name_prefix: 'bad',
          prompt: 'bad',
          intent: 'bad',
          skill_sources: [{ path: '/untrusted' }],
        }),
      ).resolves.toMatchObject({ isError: true });
      expect(admin.requests).toHaveLength(1);
    } finally {
      await mcp.close();
      await admin.close();
    }
  });

  it('adds TeamMate success text only to a submitted send receipt', async () => {
    const receipt = {
      teammate: { name: 'reviewer', status: 'running' },
      status: 'submitted',
    };
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: receipt,
    }));
    const mcp = await openTeammateMcp('dispatcher', admin.socketPath);
    try {
      expectReminderSuccess(
        await callTool(mcp.client, 'send', {
          name: 'reviewer',
          prompt: 'Continue.',
        }),
        receipt,
        TEAMMATE_DISPATCH_SUCCESS_REMINDER,
      );
    } finally {
      await mcp.close();
      await admin.close();
    }
  });

  it('returns failed send and close domain results without model guidance', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result:
        request.method === 'teammate.send'
          ? {
              teammate: { name: 'reviewer', status: 'degraded' },
              status: 'failed',
              error: 'runtime unavailable',
            }
          : { teammate: { name: 'reviewer', status: 'closed' } },
    }));
    const mcp = await openTeammateMcp('dispatcher', admin.socketPath);
    try {
      expectOrdinarySuccess(
        await callTool(mcp.client, 'send', {
          name: 'reviewer',
          prompt: 'Continue.',
        }),
        {
          teammate: { name: 'reviewer', status: 'degraded' },
          status: 'failed',
          error: 'runtime unavailable',
        },
      );
      expectOrdinarySuccess(
        await callTool(mcp.client, 'close', { name: 'reviewer', note: 'done' }),
        { teammate: { name: 'reviewer', status: 'closed' } },
      );
    } finally {
      await mcp.close();
      await admin.close();
    }
  });

  it('rejects invalid repo and missing required fields before admin IPC', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: {},
    }));
    const mcp = await openTeammateMcp('dispatcher', admin.socketPath);
    try {
      for (const [name, args] of [
        ['spawn', { name_prefix: 'reviewer', prompt: 'Review.', intent: 'review', repo: { mode: 'invalid' } }],
        ['spawn', { name_prefix: 'reviewer', prompt: 'Review.' }],
        ['close', { name: 'reviewer' }],
      ] as const) {
        const result = await callTool(mcp.client, name, args);
        expect(result).toMatchObject({ isError: true });
        expect(result).not.toHaveProperty('structuredContent');
      }
      expect(admin.requests).toEqual([]);
    } finally {
      await mcp.close();
      await admin.close();
    }
  });

  it('rejects teammate caller kind at startup', async () => {
    await expect(
      runTeamMateMcp({
        dispatcherId: 'dispatcher-a',
        callerKind: 'invalid' as TeamMateMcpCallerKind,
        adminSocketPath: '/tmp/not-used.sock',
        log: () => {},
      }),
    ).rejects.toThrow("caller kind must be 'dispatcher' or 'team_leader'");
  });

  it('forwards TeamLeader spawn without caller cwd, worktree, repo, or overridable scope', async () => {
    const receipt = {
      teammate: { name: 'worker', status: 'running' },
      status: 'submitted',
    };
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: receipt,
    }));
    const mcp = await openTeammateMcp('team_leader', admin.socketPath);
    try {
      const args = {
        name_prefix: 'worker',
        prompt: 'Implement.',
        intent: 'implementation',
        identity: 'developer',
      };
      expectReminderSuccess(
        await callTool(mcp.client, 'spawn', args),
        receipt,
        TEAMMATE_DISPATCH_SUCCESS_REMINDER,
      );
      expect(admin.requests[0]).toMatchObject({
        method: 'teammate.spawn',
        params: {
          ...args,
          dispatcher_id: 'dispatcher-a',
          caller_kind: 'team_leader',
          team_id: 'alpha',
        },
      });
      for (const key of ['cwd', 'worktree', 'repo', 'dispatcher_id', 'team_id']) {
        await expect(
          callTool(mcp.client, 'spawn', { ...args, [key]: 'evil' }),
        ).resolves.toMatchObject({ isError: true });
      }
      expect(admin.requests).toHaveLength(1);
    } finally {
      await mcp.close();
      await admin.close();
    }
  });

  it('forwards get_capabilities with spawnable agent runtime ids only', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result: {
        verbs: ['spawn', 'send'],
        agent_runtimes: [{ id: 'codex' }, { id: 'claude-code' }],
        private_runtime_config: { token: 'secret' },
      },
    }));
    const mcp = await openTeammateMcp('dispatcher', admin.socketPath);
    try {
      const expected = {
        verbs: ['spawn', 'send'],
        agent_runtimes: [{ id: 'codex' }, { id: 'claude-code' }],
      };
      expectOrdinarySuccess(
        await callTool(mcp.client, 'get_capabilities', {}),
        expected,
      );
      expect(admin.requests[0]).toMatchObject({
        method: 'teammate.capabilities',
        params: {
          dispatcher_id: 'dispatcher-a',
          caller_kind: 'dispatcher',
        },
      });
      expect(JSON.stringify(expected)).not.toContain('private_runtime_config');
    } finally {
      await mcp.close();
      await admin.close();
    }
  });

  it('forwards history ledger queries and last(turns) reads (#188)', async () => {
    const admin = await startFakeAdminServer((request) => ({
      id: request.id,
      ok: true,
      result:
        request.method === 'teammate.history'
          ? { items: [], next_cursor: null, private: 'omit' }
          : {
              teammate: { name: 'reviewer' },
              requested_turns: request.params?.['turns'] ?? 1,
              returned_turns: 0,
              turns: [],
              private: 'omit',
            },
    }));
    const mcp = await openTeammateMcp('dispatcher', admin.socketPath);
    try {
      expectOrdinarySuccess(
        await callTool(mcp.client, 'history', {
          name: 'reviewer',
          status: 'closed',
          agent_runtime: 'codex',
          repo: '/repo',
          grep: 'auth',
          since: 1,
          until: 2,
          limit: 5,
          cursor: 'next',
        }),
        { items: [], next_cursor: null },
      );
      expectOrdinarySuccess(
        await callTool(mcp.client, 'last', { name: 'reviewer' }),
        {
          teammate: { name: 'reviewer' },
          requested_turns: 1,
          returned_turns: 0,
          turns: [],
        },
      );
      expectOrdinarySuccess(
        await callTool(mcp.client, 'last', { name: 'reviewer', turns: 5 }),
        {
          teammate: { name: 'reviewer' },
          requested_turns: 5,
          returned_turns: 0,
          turns: [],
        },
      );
      expect(admin.requests.map((request) => request.method)).toEqual([
        'teammate.history',
        'teammate.last',
        'teammate.last',
      ]);
      expect(admin.requests[0]?.params).toMatchObject({
        dispatcher_id: 'dispatcher-a',
        caller_kind: 'dispatcher',
        name: 'reviewer',
        status: 'closed',
        agent_runtime: 'codex',
        repo: '/repo',
        grep: 'auth',
        since: 1,
        until: 2,
        limit: 5,
        cursor: 'next',
      });
      expect(admin.requests[2]?.params).toMatchObject({ name: 'reviewer', turns: 5 });
    } finally {
      await mcp.close();
      await admin.close();
    }
  });
});
