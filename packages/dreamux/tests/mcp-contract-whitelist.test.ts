import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { runTeamMateMcp } from '../src/mcp/teammate-mcp.js';
import { runTeamMcp } from '../src/mcp/team-mcp.js';

// Issue #199 Slice 1 — public MCP contract/schema closeout. These are the
// authoritative whitelists for the trimmed teammate.* / team.* tool input
// schemas. They fail loudly if a removed legacy field is reintroduced or an
// unexpected field is added, so the public surface cannot drift back.

interface ToolSchema {
  required: string[];
  properties: Record<string, unknown>;
}

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
    return new Promise((resolve) => this.waiters.push(resolve));
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

async function teammateTools(
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
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
  const response = (await reader.next()) as {
    result: { tools: Array<Record<string, unknown>> };
  };
  input.end();
  await run;
  return response.result.tools;
}

async function teamTools(): Promise<Array<Record<string, unknown>>> {
  const input = new PassThrough();
  const output = new PassThrough();
  const reader = new JsonLineReader(output);
  const run = runTeamMcp({
    dispatcherId: 'dispatcher-a',
    adminSocketPath: '/tmp/not-used.sock',
    input,
    output,
    log: () => {},
  });
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
  const response = (await reader.next()) as {
    result: { tools: Array<Record<string, unknown>> };
  };
  input.end();
  await run;
  return response.result.tools;
}

function schemaOf(tools: Array<Record<string, unknown>>, name: string): ToolSchema {
  const entry = tools.find((tool) => tool['name'] === name);
  if (entry === undefined) throw new Error(`tool '${name}' not found`);
  return (entry as { inputSchema: ToolSchema }).inputSchema;
}

// The retired legacy filters. `status` stays a supported lifecycle filter and is
// therefore NOT forbidden — only the legacy `state` / `close_status` names go.
const FORBIDDEN_TEAMMATE_HISTORY_PARAMS = [
  'id',
  'state',
  'close_status',
  'source_cwd',
  'runtime_cwd',
  'display_name',
  'session_id',
  'team_id',
  'role',
  'checkpoint',
];
const FORBIDDEN_TEAM_HISTORY_PARAMS = [
  'close_status',
  'team_id',
  'display_name',
  'checkpoint',
  'name',
];

// The intended Slice 1 recovery filter sets (#199): lifecycle `status` kept,
// `repo` / `since` / `until` recovery dimensions aligned across both surfaces.
const TEAMMATE_HISTORY_PARAMS = [
  'name',
  'status',
  'agent_runtime',
  'repo',
  'grep',
  'since',
  'until',
  'limit',
  'cursor',
];
const TEAM_HISTORY_PARAMS = [
  'team_name',
  'status',
  'repo',
  'grep',
  'since',
  'until',
  'limit',
  'cursor',
];

describe('issue #199 Slice 1 — public MCP contract whitelist', () => {
  it('teammate.spawn requests by name_prefix, never the concrete name', async () => {
    for (const callerKind of ['dispatcher', 'team_leader'] as const) {
      const spawn = schemaOf(await teammateTools(callerKind), 'spawn');
      expect(spawn.properties).toHaveProperty('name_prefix');
      expect(spawn.properties).not.toHaveProperty('name');
      expect(spawn.required).toContain('name_prefix');
      expect(spawn.required).not.toContain('name');
    }
  });

  it('teammate.history params are exactly the trimmed recovery set', async () => {
    const history = schemaOf(await teammateTools('dispatcher'), 'history');
    expect(Object.keys(history.properties).sort()).toEqual(
      [...TEAMMATE_HISTORY_PARAMS].sort(),
    );
    for (const forbidden of FORBIDDEN_TEAMMATE_HISTORY_PARAMS) {
      expect(history.properties).not.toHaveProperty(forbidden);
    }
    // The lifecycle `status` filter survives; the legacy `state` is gone.
    expect(history.properties).toHaveProperty('status');
    expect(history.required).toEqual([]);
  });

  it('teammate.send/status/last/close still address by the concrete name', async () => {
    const tools = await teammateTools('dispatcher');
    for (const verb of ['send', 'status', 'last', 'close']) {
      expect(schemaOf(tools, verb).properties).toHaveProperty('name');
      expect(schemaOf(tools, verb).properties).not.toHaveProperty('name_prefix');
    }
  });

  it('team verbs address by team_name, never the legacy name/team_id', async () => {
    const tools = await teamTools();
    for (const verb of ['create', 'status', 'bind_group', 'dissolve']) {
      expect(schemaOf(tools, verb).properties).toHaveProperty('team_name');
      expect(schemaOf(tools, verb).properties).not.toHaveProperty('name');
      expect(schemaOf(tools, verb).properties).not.toHaveProperty('team_id');
    }
  });

  it('team.history params are exactly the trimmed recovery set', async () => {
    const history = schemaOf(await teamTools(), 'history');
    expect(Object.keys(history.properties).sort()).toEqual(
      [...TEAM_HISTORY_PARAMS].sort(),
    );
    for (const forbidden of FORBIDDEN_TEAM_HISTORY_PARAMS) {
      expect(history.properties).not.toHaveProperty(forbidden);
    }
    // The lifecycle `status` filter survives; the legacy `close_status` is gone.
    expect(history.properties).toHaveProperty('status');
    expect(history.required).toEqual([]);
  });
});

describe('issue #199 Slice 2 — repo input + field-collapse whitelist', () => {
  it('teammate.spawn takes an optional repo object, not the legacy cwd/worktree', async () => {
    const spawn = schemaOf(await teammateTools('dispatcher'), 'spawn');
    expect(spawn.properties).toHaveProperty('repo');
    expect(spawn.properties).not.toHaveProperty('cwd');
    expect(spawn.properties).not.toHaveProperty('worktree');
    expect(spawn.required).not.toContain('cwd');
    const repo = JSON.stringify(spawn.properties['repo']);
    for (const token of ['reuse-cwd', 'managed', 'path', 'cleanup']) {
      expect(repo).toContain(token);
    }
  });

  it('team.create takes an optional repo object, not the legacy repo_cwd', async () => {
    const create = schemaOf(await teamTools(), 'create');
    expect(create.properties).toHaveProperty('repo');
    expect(create.properties).not.toHaveProperty('repo_cwd');
    expect(create.properties).not.toHaveProperty('worktree');
    expect(create.required).not.toContain('repo_cwd');
    expect(create.required).toEqual(['team_name', 'leader_agent_runtime', 'intent']);
  });
});
