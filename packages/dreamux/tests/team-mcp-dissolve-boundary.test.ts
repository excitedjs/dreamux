import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAdminSocketServer } from '../src/admin/socket.js';
import { runTeamMcp } from '../src/mcp/team-mcp.js';
import type { Server } from '../src/server.js';
import { DispatcherStore } from '../src/state/dispatcher-store.js';
import { TeamStore } from '../src/service/team-collection/store.js';
import type {
  AcceptedTeamDissolve,
  TeamDissolveInput,
  TeamRecord,
} from '../src/service/team-collection/types.js';
import { WorktreeManager } from '../src/service/worktree/manager.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';
import {
  createTeamDissolveFixture,
} from './helpers/team-dissolve-fixture.js';
import {
  deferred,
  FakeRuntime,
  FAKE_RUNTIME_REF,
} from './helpers/fake-team-runtime.js';

const execFileAsync = promisify(execFile);
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('Team MCP dissolve pre-acceptance boundary', () => {
  it('persists scalable clean-worktree acceptance before structuredContent', async () => {
    const idle = deferred<void>();
    const responseGate = deferred<void>();
    const acceptedRecord = deferred<TeamRecord>();
    const harness = await createManagedTeamHarness(
      () => new FakeRuntime({ waitIdle: () => idle.promise }),
    );
    const team = await new TeamStore().get('dispatcher-a', 'alpha');
    expect(team).not.toBeNull();
    expect(await harness.git(harness.repo, ['rev-parse', 'HEAD']))
      .toBe(await harness.git(team!.worktree.path, ['rev-parse', 'HEAD']));

    let accepted: AcceptedTeamDissolve | null = null;
    const socket = await startRealAdminSocket(harness, {
      async dissolveTeam(input) {
        accepted = await acceptAndStart(harness, input);
        acceptedRecord.resolve(
          (await new TeamStore().get('dispatcher-a', input.teamId))!,
        );
        await responseGate.promise;
        return accepted.receipt;
      },
    });
    const call = beginDissolveMcpCall(socket.socketPath);
    const durable = await acceptedRecord.promise;
    try {
      expect(durable).toMatchObject({
        status: 'running',
        dissolve: {
          operation_id: accepted!.operationId,
          phase: 'waiting_for_team_idle',
          note: 'finish alpha safely',
        },
      });
      expect(call.output()).toBe('');
    } finally {
      responseGate.resolve();
    }

    const response = await call.response;
    idle.resolve();
    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        structuredContent: {
          accepted: true,
          team_name: 'alpha',
          status: 'closing',
          bound_target: null,
          bound_targets: [],
        },
      },
    });
    await vi.waitFor(async () => {
      expect(await new TeamStore().get('dispatcher-a', 'alpha')).toMatchObject({
        status: 'closed',
        worktree: { cleanup_state: 'deleted' },
        dissolve: {
          operation_id: accepted!.operationId,
          phase: 'complete',
        },
      });
    }, { timeout: 5_000 });
  });

  it('maps a real assessment exception before acceptance without structuredContent', async () => {
    const harness = await createManagedTeamHarness(() => new FakeRuntime());
    const team = await new TeamStore().get('dispatcher-a', 'alpha');
    expect(team).not.toBeNull();
    const worktreeGitFile = join(team!.worktree.path, '.git');
    expect(existsSync(worktreeGitFile)).toBe(true);
    unlinkSync(worktreeGitFile);

    const socket = await startRealAdminSocket(harness, {
      async dissolveTeam(input) {
        return (await acceptAndStart(harness, input)).receipt;
      },
    });
    const response = await beginDissolveMcpCall(socket.socketPath).response;

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        isError: true,
        content: [{
          type: 'text',
          text: expect.stringContaining('[TEAM_DISSOLVE_FAILED]'),
        }],
      },
    });
    expect(response.result).not.toHaveProperty('structuredContent');
    expect(await new TeamStore().get('dispatcher-a', 'alpha')).toMatchObject({
      status: 'running',
      dissolve: null,
    });
  });
});

interface ManagedTeamHarness {
  repo: string;
  teams: ReturnType<ReturnType<typeof createTeamDissolveFixture>['makeTeams']>;
  dispatchers: DispatcherStore;
  git(cwd: string, args: string[]): Promise<string>;
}

async function createManagedTeamHarness(
  createRuntime: () => FakeRuntime,
): Promise<ManagedTeamHarness> {
  const fixture = createTeamDissolveFixture();
  const repositoryRoot = mkdtempSync(join(tmpdir(), 'dreamux-mcp-dissolve-'));
  const repo = join(repositoryRoot, 'source');
  mkdirSync(repo, { recursive: true });
  const git = async (cwd: string, args: string[]) =>
    (await execFileAsync('git', args, { cwd })).stdout.trim();
  await git(repo, ['init', '-q']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'tracked.txt'), 'base\n');
  await git(repo, ['add', 'tracked.txt']);
  await git(repo, ['commit', '-qm', 'base']);

  const worktrees = new WorktreeManager();
  const teams = fixture.makeTeams({
    runtimes: [],
    worktrees,
    createRuntime,
  });
  await teams.create({
    name: 'alpha',
    leaderAgentRuntime: 'agent-a',
    intent: 'exercise the real dissolve acceptance boundary',
    repoCwd: repo,
    worktree: {
      mode: 'managed',
      slug: 'team-alpha',
      branch: 'dreamux/team-alpha',
      cleanup: 'delete-on-close',
    },
  });
  const config = testDreamuxConfig([
    testDispatcherConfig({
      id: 'dispatcher-a',
      channels: [],
      agentRuntime: 'agent-a',
      runtimeProvider: FAKE_RUNTIME_REF,
    }),
  ]);
  const harness = {
    repo,
    teams,
    dispatchers: new DispatcherStore(config),
    git,
  };
  cleanups.push(async () => {
    try {
      await teams.stopAll();
    } finally {
      fixture.cleanup();
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });
  return harness;
}

async function acceptAndStart(
  harness: ManagedTeamHarness,
  input: TeamDissolveInput,
): Promise<AcceptedTeamDissolve> {
  const accepted = await harness.teams.acceptDissolve({
    ...input,
    requester: { kind: 'dispatcher' },
    decisionDeadlineAt: Date.now() + 9_000,
  });
  harness.teams.startAcceptedDissolve(
    accepted,
    (close) => harness.teams.closeAcceptedResources(close),
  );
  return accepted;
}

async function startRealAdminSocket(
  harness: ManagedTeamHarness,
  dispatcher: {
    dissolveTeam(input: TeamDissolveInput): Promise<unknown>;
  },
) {
  const socketPath = join(
    mkdtempSync(join(tmpdir(), 'dreamux-real-admin-')),
    'admin.sock',
  );
  const socketRoot = dirname(socketPath);
  const server = {
    repos: { dispatchers: harness.dispatchers },
    getDispatcher: () => dispatcher,
    admitAdminRequest<T>(task: () => T | Promise<T>): Promise<T> {
      return Promise.resolve().then(task);
    },
  } as unknown as Server;
  const socket = createAdminSocketServer(server, socketPath);
  await socket.start();
  cleanups.push(async () => {
    await socket.close();
    rmSync(socketRoot, { recursive: true, force: true });
  });
  return socket;
}

function beginDissolveMcpCall(socketPath: string): {
  output(): string;
  response: Promise<{
    jsonrpc: string;
    id: number;
    result: Record<string, unknown>;
  }>;
} {
  const input = new PassThrough();
  const output = new PassThrough();
  let responseText = '';
  output.setEncoding('utf8');
  output.on('data', (chunk: string) => {
    responseText += chunk;
  });
  const run = runTeamMcp({
    dispatcherId: 'dispatcher-a',
    adminSocketPath: socketPath,
    input,
    output,
    log: () => undefined,
  });
  input.end(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'dissolve',
      arguments: {
        team_name: 'alpha',
        note: 'finish alpha safely',
      },
    },
  })}\n`);
  return {
    output: () => responseText,
    response: run.then(() => JSON.parse(responseText) as {
      jsonrpc: string;
      id: number;
      result: Record<string, unknown>;
    }),
  };
}
