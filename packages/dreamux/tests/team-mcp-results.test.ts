import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { validateMcpToolCatalog } from '../src/service/mcp/catalog.js';
import { TEAM_DISPATCH_SUCCESS_REMINDER } from '../src/service/mcp/dispatch-reminders.js';
import { createLeaderTeamMcpDelegate } from '../src/service/team/leader-mcp.js';
import { createTeamMcpDelegate } from '../src/service/team/mcp.js';
import { TeamService } from '../src/service/team/service.js';
import { deferred } from './helpers/controlled-runtime-provider.js';
import { dispatcherFixture, teamRequest } from './helpers/real-dispatcher.js';

describe('Team MCP result projections', () => {
  it.each(['reuse-cwd', 'managed'] as const)(
    'states the actual names, runtime and %s workspace in the prompt-bearing create text',
    async (mode) => {
      const fixture = await dispatcherFixture();
      await fixture.host.start();
      const repo = join(fixture.host.cwd, 'selected-repository');
      await mkdir(repo);
      if (mode === 'managed') {
        for (const args of [
          ['init', '-q'],
          ['config', 'user.name', 'Test'],
          ['config', 'user.email', 'test@example.com'],
          ['commit', '--allow-empty', '-q', '-m', 'initial'],
        ])
          await promisify(execFile)('git', args, { cwd: repo });
      }
      const result = await createTeamMcpDelegate({ teams: fixture.teams }).call(
        {
          name: 'create',
          arguments: {
            name_prefix: 'receipt',
            intent: 'Inspect the workspace',
            leader_agent_runtime: 'controlled',
            prompt: 'Start review',
            repo: {
              mode,
              path: repo,
              ...(mode === 'managed' ? { cleanup: 'delete-on-close' } : {}),
            },
          },
        },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      const [row] = await fixture.teams.list();
      const actual = await fixture.teams.summary(row!.team_name);
      expect(actual.team_name).not.toBe('receipt');
      expect(result.text).toContain(
        `Created Team ${actual.team_name} (status: running).`,
      );
      expect(result.text).toContain(
        `Leader: ${actual.leader_name} (controlled).`,
      );
      expect(result.text).toContain(
        `Workspace: ${actual.runtime_cwd} (${mode}; cleanup: ${mode === 'managed' ? 'delete-on-close' : 'keep'}).`,
      );
      if (mode === 'managed') {
        expect(actual.runtime_cwd).not.toBe(repo);
        expect(actual.source_repo).not.toBeNull();
        expect(result.text).toContain(
          `Source repository: ${actual.source_repo}.`,
        );
      } else {
        expect(actual.runtime_cwd).toBe(repo);
        expect(result.text).not.toContain('Source repository:');
      }
      expect(result.text).toContain(TEAM_DISPATCH_SUCCESS_REMINDER);
      expect(result.text).not.toMatch(/^\s*\{/);
    },
  );

  it('reports closed in create text when the initial leader dissolves before creation returns', async () => {
    const fixture = await dispatcherFixture();
    await fixture.host.start();
    const start = TeamService.prototype.startCreated;
    const starting = vi
      .spyOn(TeamService.prototype, 'startCreated')
      .mockImplementation(async function (this: TeamService, input) {
        await start.call(this, input);
        await createLeaderTeamMcpDelegate(this).call({
          name: 'dissolve',
          arguments: { note: 'Initial task complete' },
        });
        await this.closed;
      });
    try {
      const result = await createTeamMcpDelegate({ teams: fixture.teams }).call(
        {
          name: 'create',
          arguments: {
            name_prefix: 'quick',
            intent: 'Finish during the initial turn',
            leader_agent_runtime: 'controlled',
            prompt: 'Complete the task',
          },
        },
      );
      const [team] = await fixture.teams.list();
      expect(result).toMatchObject({
        ok: true,
        structured: { team_name: team!.team_name, status: 'closed' },
        text: expect.stringContaining(
          `Created Team ${team!.team_name} (status: closed).`,
        ),
      });
      expect(result).toMatchObject({
        text: expect.stringContaining(TEAM_DISPATCH_SUCCESS_REMINDER),
      });
    } finally {
      starting.mockRestore();
    }
  });

  it('returns the allocated names and actual workspace while status retains the full detail', async () => {
    const fixture = await dispatcherFixture();
    const cwd = join(fixture.host.cwd, 'selected-workspace');
    await mkdir(cwd);
    const delegate = createTeamMcpDelegate({ teams: fixture.teams });
    const created = await delegate.call({
      name: 'create',
      arguments: {
        name_prefix: 'compact',
        intent: 'Review the compact MCP results',
        leader_agent_runtime: 'controlled',
        repo: { mode: 'reuse-cwd', path: cwd },
      },
    });
    const [team] = await fixture.teams.list();
    expect(team).toBeDefined();
    expect(team!.team_name).not.toBe('compact');
    expect(created).toEqual({
      ok: true,
      structured: {
        team_name: team!.team_name,
        status: team!.status,
        leader_name: team!.leader_name,
        leader_agent_runtime: 'controlled',
        source_repo: null,
        runtime_cwd: cwd,
        worktree_mode: 'reuse-cwd',
        worktree_cleanup_mode: 'keep',
      },
    });
    expect(await delegate.call({ name: 'list', arguments: {} })).toEqual({
      ok: true,
      structured: {
        teams: [
          {
            team_name: team!.team_name,
            status: team!.status,
            intent: 'Review the compact MCP results',
            source_repo: null,
            leader_state: team!.leader_state,
            member_count: 0,
            worktree_cleanup: 'not-managed',
          },
        ],
      },
    });
    const detail = await fixture.teams.summary(team!.team_name);
    expect(
      await delegate.call({
        name: 'status',
        arguments: { team_name: team!.team_name },
      }),
    ).toEqual({ ok: true, structured: detail });
    expect(detail).toMatchObject({
      intent: 'Review the compact MCP results',
      runtime_cwd: cwd,
      leader_session_id: null,
      closed_at: null,
      close_note: null,
    });
    expect(fixture.provider.runtimes).toHaveLength(0);
  });

  it('preserves recovery search and pagination while returning only a close-note preview', async () => {
    const fixture = await dispatcherFixture();
    const closed = await fixture.teams.createFromRequest(teamRequest('closed'));
    await fixture.teams.createFromRequest(teamRequest('open'));
    const service = await fixture.teams.open(closed.team_name);
    const note = `${'Finished the implementation. '.repeat(30)}recoverable-only-tail`;
    await fixture.teams.dissolve(closed.team_name, { note, force: false });
    await service.closed;
    const delegate = createTeamMcpDelegate({ teams: fixture.teams });
    const domain = await fixture.teams.history({ limit: 1 });
    const first = domain.items[0]!;
    expect(first.team_name).toBe(closed.team_name);
    expect(first.close_note).toBe(note);
    expect(first.close_note_preview).not.toContain('recoverable-only-tail');
    const page = await delegate.call({
      name: 'history',
      arguments: { limit: 1 },
    });
    expect(page).toEqual({
      ok: true,
      structured: {
        items: [
          {
            team_name: closed.team_name,
            status: 'closed',
            intent: 'Review the implementation',
            source_repo: null,
            updated_at: first.updated_at,
            closed_at: first.closed_at,
            close_note_preview: first.close_note_preview,
            worktree_cleanup: first.worktree_cleanup,
          },
        ],
        next_cursor: domain.next_cursor,
      },
    });
    expect(domain.next_cursor).not.toBeNull();
    const next = await delegate.call({
      name: 'history',
      arguments: { limit: 1, cursor: domain.next_cursor },
    });
    expect(next).toMatchObject({
      ok: true,
      structured: {
        items: [expect.objectContaining({ status: 'running' })],
        next_cursor: null,
      },
    });
    expect(
      await delegate.call({
        name: 'history',
        arguments: { grep: 'recoverable-only-tail' },
      }),
    ).toMatchObject({
      ok: true,
      structured: {
        items: [expect.objectContaining({ team_name: closed.team_name })],
        next_cursor: null,
      },
    });
    expect(
      await delegate.call({
        name: 'status',
        arguments: { team_name: closed.team_name },
      }),
    ).toMatchObject({
      ok: true,
      structured: { close_note: note, closed_at: first.closed_at },
    });
  });

  it.each(['dispatcher', 'team_leader'] as const)(
    '%s dissolve returns only submission before the runtime stops',
    async (caller) => {
      const fixture = await dispatcherFixture();
      const stopping = deferred<void>();
      fixture.releases.push(() => stopping.resolve());
      fixture.provider.planNext({ stopBarrier: stopping.promise });
      const created = await fixture.teams.createFromRequest(
        teamRequest('close', 'Work'),
      );
      const service = await fixture.teams.open(created.team_name);
      const delegate =
        caller === 'dispatcher'
          ? createTeamMcpDelegate({ teams: fixture.teams })
          : createLeaderTeamMcpDelegate(service);
      const result = await delegate.call({
        name: 'dissolve',
        arguments:
          caller === 'dispatcher'
            ? { team_name: created.team_name, note: 'Finished' }
            : { note: 'Finished' },
      });
      expect(result).toEqual({ ok: true, structured: { status: 'submitted' } });
      await fixture.provider.runtimes[0]!.stopStarted.promise;
      expect(await fixture.teams.summary(created.team_name)).toMatchObject({
        status: 'closed',
        close_note: 'Finished',
      });
      stopping.resolve();
      await service.closed;
    },
  );

  it('omits schemas for both reminder-capable tools while reads keep their schemas', async () => {
    const fixture = await dispatcherFixture();
    const tools = validateMcpToolCatalog(
      createTeamMcpDelegate({ teams: fixture.teams }).describe().tools,
      'Team MCP catalog',
    );
    for (const name of ['create', 'send']) {
      const descriptor = tools.find((tool) => tool.name === name);
      expect(descriptor).toBeDefined();
      expect(descriptor).not.toHaveProperty('outputSchema');
    }
    for (const name of ['list', 'status', 'history', 'dissolve']) {
      expect(tools.find((tool) => tool.name === name)).toHaveProperty(
        'outputSchema',
      );
    }
  });
});
