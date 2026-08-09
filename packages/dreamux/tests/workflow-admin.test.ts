import { describe, expect, it, vi } from 'vitest';

import { adminMethods } from '../src/admin/methods.js';
import type { Server } from '../src/server.js';
import type { WorkflowOps } from '../src/service/workflow-service/index.js';
import type { WorkflowRunRecord } from '../src/service/workflow-service/types.js';

function runningRecord(runId = 'run-1'): WorkflowRunRecord {
  return {
    version: 1,
    run_id: runId,
    dispatcher_id: 'dispatcher-a',
    team_id: null,
    caller_kind: 'dispatcher',
    script_hash: 'hash',
    status: 'running',
    max_concurrency: 4,
    phase: null,
    last_log: null,
    agents: [],
    result: null,
    error: null,
    created_at: 1,
    updated_at: 1,
    ended_at: null,
  };
}

function workflowOps(): WorkflowOps & {
  run: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
} {
  const record = runningRecord();
  return {
    run: vi.fn(async () => ({ run_id: record.run_id })),
    status: vi.fn(async () => record),
    stop: vi.fn(async () => ({ run_id: record.run_id, status: 'stopped' as const })),
    list: vi.fn(async () => ({ runs: [record] })),
  };
}

function serverWith(input: {
  dispatcherWorkflows: WorkflowOps;
  teamWorkflows?: WorkflowOps;
}) {
  const team = vi.fn(async () => ({
    workflows: input.teamWorkflows ?? input.dispatcherWorkflows,
  }));
  const dispatcher = {
    workflows: input.dispatcherWorkflows,
    team,
  };
  return {
    server: {
      repos: {
        dispatchers: {
          get: () => ({ dispatcher_id: 'dispatcher-a' }),
        },
      },
      getDispatcher: () => dispatcher,
    } as unknown as Server,
    team,
  };
}

describe('workflow admin methods', () => {
  it('maps run, status, stop, and list into dispatcher-scoped WorkflowOps', async () => {
    const workflows = workflowOps();
    const { server, team } = serverWith({ dispatcherWorkflows: workflows });

    await expect(adminMethods['workflow.run']!(server, {
      dispatcher_id: 'dispatcher-a',
      script: 'export default async function run() { return args; }',
      args: { targets: ['api', 'lifecycle'] },
      max_concurrency: 4,
    })).resolves.toEqual({ run_id: 'run-1' });
    await expect(adminMethods['workflow.status']!(server, {
      dispatcher_id: 'dispatcher-a',
      run_id: 'run-1',
    })).resolves.toMatchObject({ run_id: 'run-1', status: 'running' });
    await expect(adminMethods['workflow.stop']!(server, {
      dispatcher_id: 'dispatcher-a',
      run_id: 'run-1',
    })).resolves.toEqual({ run_id: 'run-1', status: 'stopped' });
    await expect(adminMethods['workflow.list']!(server, {
      dispatcher_id: 'dispatcher-a',
    })).resolves.toMatchObject({ runs: [{ run_id: 'run-1' }] });

    expect(workflows.run).toHaveBeenCalledWith({
      script: 'export default async function run() { return args; }',
      args: { targets: ['api', 'lifecycle'] },
      max_concurrency: 4,
    });
    expect(workflows.status).toHaveBeenCalledWith({ run_id: 'run-1' });
    expect(workflows.stop).toHaveBeenCalledWith({ run_id: 'run-1' });
    expect(workflows.list).toHaveBeenCalledWith();
    expect(team).not.toHaveBeenCalled();
  });

  it('reuses the TeamLeader target route for Team-scoped workflows', async () => {
    const dispatcherWorkflows = workflowOps();
    const teamWorkflows = workflowOps();
    const { server, team } = serverWith({ dispatcherWorkflows, teamWorkflows });

    await expect(adminMethods['workflow.run']!(server, {
      dispatcher_id: 'dispatcher-a',
      caller_kind: 'team_leader',
      team_id: 'alpha',
      script: 'export default async function run() { return "done"; }',
    })).resolves.toEqual({ run_id: 'run-1' });

    expect(team).toHaveBeenCalledWith('alpha');
    expect(teamWorkflows.run).toHaveBeenCalledWith({
      script: 'export default async function run() { return "done"; }',
    });
    expect(dispatcherWorkflows.run).not.toHaveBeenCalled();
  });

  it('rejects malformed inputs before invoking WorkflowOps', async () => {
    const workflows = workflowOps();
    const { server } = serverWith({ dispatcherWorkflows: workflows });

    await expect(adminMethods['workflow.run']!(server, {
      dispatcher_id: 'dispatcher-a',
      script: '',
    })).rejects.toMatchObject({ name: 'AdminError', code: 'BAD_REQUEST' });
    for (const maxConcurrency of [0, 17, 1.5, null]) {
      await expect(adminMethods['workflow.run']!(server, {
        dispatcher_id: 'dispatcher-a',
        script: 'export default async function run() {}',
        max_concurrency: maxConcurrency,
      })).rejects.toMatchObject({
        name: 'AdminError',
        code: 'BAD_REQUEST',
        message:
          'workflow max_concurrency must be an integer between 1 and 16',
      });
    }
    await expect(adminMethods['workflow.status']!(server, {
      dispatcher_id: 'dispatcher-a',
      run_id: '',
    })).rejects.toMatchObject({ name: 'AdminError', code: 'BAD_REQUEST' });
    await expect(adminMethods['workflow.list']!(server, {
      dispatcher_id: 'dispatcher-a',
      caller_kind: 'teammate',
    })).rejects.toMatchObject({ name: 'AdminError', code: 'BAD_REQUEST' });

    expect(workflows.run).not.toHaveBeenCalled();
    expect(workflows.status).not.toHaveBeenCalled();
    expect(workflows.stop).not.toHaveBeenCalled();
    expect(workflows.list).not.toHaveBeenCalled();
  });
});
