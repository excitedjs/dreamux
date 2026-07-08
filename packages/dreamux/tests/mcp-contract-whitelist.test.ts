import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { collaborationSpaceTools } from '../src/mcp/collaboration-space-mcp.js';
import { cronTools } from '../src/mcp/cron-mcp.js';
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
  callerKind: 'dispatcher' | 'team_leader',
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

async function teamLeaderTeamTools(): Promise<Array<Record<string, unknown>>> {
  const input = new PassThrough();
  const output = new PassThrough();
  const reader = new JsonLineReader(output);
  const run = runTeamMcp({
    dispatcherId: 'dispatcher-a',
    callerKind: 'team_leader',
    teamId: 'alpha',
    leaderName: 'alpha-leader',
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
  return (toolOf(tools, name) as { inputSchema: ToolSchema }).inputSchema;
}

function toolOf(tools: Array<Record<string, unknown>>, name: string): Record<string, unknown> {
  const entry = tools.find((tool) => tool['name'] === name);
  if (entry === undefined) throw new Error(`tool '${name}' not found`);
  return entry;
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
const COLLABORATION_SPACE_TOOLS = [
  'bind',
  'dissolve',
  'status',
  'list',
];

describe('issue #199 Slice 1 — public MCP contract whitelist', () => {
  it('teammate.spawn requests by name_prefix, never the concrete name', async () => {
    for (const callerKind of ['dispatcher', 'team_leader'] as const) {
      const spawn = schemaOf(await teammateTools(callerKind), 'spawn');
      expect(spawn.properties).toHaveProperty('name_prefix');
      expect(spawn.properties).toHaveProperty('identity');
      expect(spawn.properties).not.toHaveProperty('name');
      expect(spawn.required).toContain('name_prefix');
      expect(spawn.required).not.toContain('identity');
      expect(spawn.required).not.toContain('name');
    }
  });

  it('TeamLeader teammate.spawn has no repo input or dispatcher repo wording', async () => {
    const spawn = toolOf(await teammateTools('team_leader'), 'spawn');
    expect((spawn.inputSchema as ToolSchema).properties).not.toHaveProperty('repo');
    expect(spawn['description']).toMatch(/TeamMate agent.*shared workspace/);
    expect(spawn['description']).toMatch(/does not accept.*repo/);
    expect(spawn['description']).toMatch(/only one TeamMate writes/);
    expect(spawn['description']).not.toContain('repo is optional');
    expect(spawn['description']).not.toContain('Dispatcher');
    expect(spawn['description']).not.toContain('TeamLeader-scoped');
  });

  it('dispatcher teammate.spawn description avoids internal path layout and migration prose', async () => {
    const spawn = toolOf(await teammateTools('dispatcher'), 'spawn');
    expect((spawn.inputSchema as ToolSchema).properties).toHaveProperty('repo');
    expect(spawn['description']).toMatch(/concrete, never-reused name/);
    expect(spawn['description']).toMatch(/Dreamux allocate.*work directory/);
    expect(spawn['description']).not.toContain('.workspace/work/');
    expect(spawn['description']).not.toContain('dispatcher cwd');
    expect(spawn['description']).not.toContain('does NOT');
    expect(spawn['description']).not.toContain('core-owned');
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
    for (const verb of ['create', 'send', 'status', 'dissolve']) {
      expect(schemaOf(tools, verb).properties).toHaveProperty('team_name');
      expect(schemaOf(tools, verb).properties).not.toHaveProperty('name');
      expect(schemaOf(tools, verb).properties).not.toHaveProperty('team_id');
    }
  });

  it('the Feishu binding verbs left the Team MCP (#209 slice 8)', async () => {
    const names = (await teamTools()).map((tool) => tool['name']);
    expect(names).not.toContain('bind_group');
    expect(names).not.toContain('transfer_channel_back');
  });

  it('TeamLeader Team MCP exposes only explicit transfer_back', async () => {
    const tools = await teamLeaderTeamTools();
    expect(tools.map((tool) => tool['name'])).toEqual(['transfer_back']);
    const transferTool = toolOf(tools, 'transfer_back');
    const transfer = schemaOf(tools, 'transfer_back');
    expect(transfer.required).toEqual(['meta']);
    expect(transfer.properties).toHaveProperty('channel_id');
    expect(transfer.properties).toHaveProperty('meta');
    const description = String(transferTool['description'] ?? '');
    expect(description).toMatch(/routing[- ]only/i);
    expect(description).toMatch(/no .*channel[- ]message .*side effect/i);
    expect(description).toMatch(/bind(?:ing)?[\s\S]{0,80}channel target/i);
    expect(description).not.toContain('Dispatcher');
    expect(description).not.toContain('dispatcher routing');
    expect(description).not.toContain('report');
    expect(description).not.toContain('Feishu');
    expect(description).not.toContain('chat_id');
  });

  it('Team MCP descriptions keep channel selectors provider-owned', async () => {
    const descriptions = (await teamTools())
      .map((tool) => String(tool['description'] ?? ''))
      .join('\n');
    expect(descriptions).toMatch(/provider-defined .*target selector/);
    expect(descriptions).not.toContain('Feishu');
    expect(descriptions).not.toContain('chat_id');
    expect(descriptions).not.toContain('group chat');
    expect(descriptions).not.toContain('bound group');
    expect(descriptions).not.toContain('{ "chat_id"');
    expect(descriptions).not.toContain('core-owned');
    expect(descriptions).not.toContain('.workspace/work/');
    expect(descriptions).not.toContain('dispatcher cwd');
    expect(descriptions).not.toContain('does NOT');
  });

  it('collaboration_space surface is bind/dissolve/status/list only', () => {
    const tools = collaborationSpaceTools();
    expect(tools.map((tool) => tool['name'])).toEqual(COLLABORATION_SPACE_TOOLS);
    expect(tools.map((tool) => tool['name'])).not.toContain('create');
    expect(tools.map((tool) => tool['name'])).not.toContain('history');
    const bind = schemaOf(tools, 'bind');
    expect(bind.required).toEqual(['space_name', 'repo', 'leader_agent_runtime']);
    expect(bind.properties).toHaveProperty('container');
    expect(bind.properties).toHaveProperty('identity');
    expect(bind.properties).not.toHaveProperty('provider');
    expect(JSON.stringify(bind.properties['repo'])).toContain('cwd');
    const dissolve = schemaOf(tools, 'dissolve');
    expect(dissolve.required).toEqual(['space_name', 'note']);
  });

  it('cron MCP descriptions describe product behavior, not release milestones', () => {
    const descriptions = cronTools()
      .map((tool) => String(tool['description'] ?? ''))
      .join('\n');
    expect(descriptions).toMatch(/cron jobs?[\s\S]{0,80}inject prompts? back into this agent/i);
    expect(descriptions).toMatch(/do not[\s\S]{0,80}channel messages?/i);
    expect(descriptions).toMatch(/do not[\s\S]{0,80}spawn agents?/i);
    expect(descriptions).not.toContain('this milestone');
    expect(descriptions).not.toContain('deliver or spawn target');
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
    expect(create.properties).toHaveProperty('identity');
    expect(create.properties).not.toHaveProperty('repo_cwd');
    expect(create.properties).not.toHaveProperty('worktree');
    expect(create.required).not.toContain('repo_cwd');
    expect(create.required).not.toContain('identity');
    expect(create.required).toEqual(['team_name', 'leader_agent_runtime', 'intent']);
  });
});
