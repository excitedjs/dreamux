import { describe, expect, it, vi } from 'vitest';
import { createTeamMateMcpDelegate } from '../src/service/agent/mcp.js';
import type { AgentEntityRuntimeStatus } from '../src/service/agent/identity.js';
import { createTeamMcpDelegate } from '../src/service/team/mcp.js';
import type { TeamListRow } from '../src/service/team/types.js';
import type { McpServerDelegate } from '../src/service/mcp/types.js';
import { dispatcherFixture } from './helpers/real-dispatcher.js';

function mate(
  index: number,
  status: AgentEntityRuntimeStatus['status'],
): AgentEntityRuntimeStatus {
  return {
    name: `mate-${String(index).padStart(4, '0')}`,
    status,
    session_id: null,
    agent_runtime: 'controlled',
    created_at: 1,
    updated_at: 1,
    intent: 'work',
    runtime_status: null,
    last_error: null,
    closed_at: status === 'closed' ? 2 : null,
    close_note: null,
    repo: {
      mode: 'reuse-cwd',
      path: '/workspace',
      source_repo: null,
      branch: null,
      base_ref: null,
      cleanup: 'keep',
      cleanup_state: 'not-managed',
    },
  };
}

function team(index: number, status: TeamListRow['status']): TeamListRow {
  return {
    team_name: `team-${String(index).padStart(4, '0')}`,
    status,
    intent: 'work',
    source_repo: null,
    leader_name: `leader-${index}`,
    leader_agent_runtime: 'controlled',
    leader_state: status,
    member_count: 0,
    created_at: 1,
    updated_at: 1,
    closed_at: status === 'closed' ? 2 : null,
    worktree_cleanup: 'not-managed',
  };
}

async function read(
  delegate: McpServerDelegate,
  args: Record<string, unknown> = {},
) {
  const result = await delegate.call({ name: 'list', arguments: args });
  if (!result.ok) throw new Error(result.message);
  const value = result.structured;
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object result');
  return value as Record<string, unknown>;
}

function next(page: Record<string, unknown>): string {
  if (typeof page['next_cursor'] !== 'string')
    throw new Error('Expected another page');
  return page['next_cursor'];
}

describe('bounded MCP lists', () => {
  it('pages the reported 998-member roster after status filtering', async () => {
    const f = await dispatcherFixture();
    const rows = Array.from({ length: 998 }, (_, i) =>
      mate(i, i < 976 ? 'closed' : 'stopped'),
    );
    vi.spyOn(f.host.teammates, 'list').mockResolvedValue(rows);
    const delegate = createTeamMateMcpDelegate({
      kind: 'dispatcher',
      dispatcher: f.host,
    });
    const first = await read(delegate);
    expect(first).toMatchObject({ total: 22 });
    expect(first['teammates']).toHaveLength(20);
    const second = await read(delegate, { cursor: next(first) });
    expect(second).toMatchObject({ total: 22, next_cursor: null });
    expect(second['teammates']).toEqual(
      rows.slice(996).map(({ name, status, agent_runtime, intent }) => ({
        name,
        status,
        agent_runtime,
        intent,
      })),
    );
    expect(await read(delegate, { status: 'running' })).toEqual({
      teammates: [],
      total: 0,
      next_cursor: null,
    });
    expect(await read(delegate, { status: 'closed', limit: 1 })).toMatchObject({
      total: 976,
      teammates: [{ name: rows[0]!.name, status: 'closed' }],
    });
    expect(await read(delegate, { status: 'all', limit: 100 })).toMatchObject({
      total: 998,
    });
    // The Command/internal collection is still complete, including closed rows.
    expect(await f.host.teammates.list()).toHaveLength(998);
  });

  it('pages Team results while preserving the complete domain list', async () => {
    const f = await dispatcherFixture();
    const rows = Array.from({ length: 420 }, (_, i) =>
      team(i, i < 394 ? 'closed' : 'running'),
    );
    vi.spyOn(f.teams, 'list').mockResolvedValue(rows);
    const delegate = createTeamMcpDelegate({ teams: f.teams });
    const first = await read(delegate);
    expect(first).toMatchObject({ total: 26 });
    expect(first['teams']).toHaveLength(20);
    const second = await read(delegate, { cursor: next(first) });
    expect(second).toMatchObject({ total: 26, next_cursor: null });
    expect(second['teams']).toHaveLength(6);
    expect(await read(delegate, { status: 'closed', limit: 1 })).toMatchObject({
      total: 394,
      teams: [{ team_name: rows[0]!.team_name, status: 'closed' }],
    });
    expect(await f.teams.list()).toHaveLength(420);
  });

  it('excludes a member before totals and paging, without hiding its owner', async () => {
    const f = await dispatcherFixture();
    await f.host.start();
    const rows = [
      mate(0, 'running'),
      mate(1, 'closed'),
      mate(2, 'running'),
      mate(3, 'degraded'),
    ];
    vi.spyOn(f.host.teammates, 'list').mockResolvedValue(rows);
    const delegate = createTeamMateMcpDelegate({
      kind: 'member',
      name: rows[0]!.name,
      owner: f.host,
    });
    const first = await read(delegate, { limit: 1 });
    expect(first).toMatchObject({
      owner: { name: f.host.memberOwner().name },
      total: 2,
      teammates: [{ name: rows[2]!.name }],
    });
    expect(
      await read(delegate, { limit: 1, cursor: next(first) }),
    ).toMatchObject({
      total: 2,
      next_cursor: null,
      teammates: [{ name: rows[3]!.name }],
    });
    expect(await read(delegate, { status: 'closed' })).toMatchObject({
      total: 1,
      next_cursor: null,
      teammates: [{ name: rows[1]!.name }],
    });
  });

  it('keeps all non-closed lifecycle states and exposes bounded all-status pages', async () => {
    const f = await dispatcherFixture();
    const rows = (
      ['starting', 'running', 'degraded', 'stopped', 'closed'] as const
    ).map((state, i) => mate(i, state));
    vi.spyOn(f.host.teammates, 'list').mockResolvedValue(rows);
    const delegate = createTeamMateMcpDelegate({
      kind: 'dispatcher',
      dispatcher: f.host,
    });
    expect(await read(delegate)).toMatchObject({ total: 4, next_cursor: null });
    const all = await read(delegate, { status: 'all', limit: 2 });
    expect(all).toMatchObject({ total: 5 });
    expect(all['teammates']).toHaveLength(2);
    for (const args of [
      { limit: 0 },
      { cursor: 'not-a-cursor' },
      { status: 'unknown' },
    ]) {
      await expect(read(delegate, args)).rejects.toThrow();
    }
  });
});
