/**
 * The model-facing result projections of the TeamMate server and the Workflow
 * tools it carries.
 *
 * These tests drive the real delegate with the real command-level fixture, so
 * what they assert is exactly what `mcp.toolcall` publishes. The transport's
 * structured/content split is covered separately in
 * `mcp-protocol-conformance.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';

import { createTeamMateMcpDelegate } from '../src/service/agent/mcp.js';
import type { TeamMateMessagingOwner } from '../src/service/agent/member-mcp.js';
import type {
  AgentEntityCapabilities,
  AgentEntityLastResult,
  AgentEntityRecordRow,
  AgentEntityRuntimeStatus,
} from '../src/service/agent/identity.js';
import type { WorkflowRunRecord } from '../src/service/workflow-service/types.js';
import { dispatcherFixture } from './helpers/real-dispatcher.js';

const REPO: AgentEntityRuntimeStatus['repo'] = {
  mode: 'reuse-cwd',
  path: '/workspace/mate-1',
  source_repo: '/repo',
  branch: 'main',
  base_ref: null,
  cleanup: 'keep',
  cleanup_state: 'not-managed',
};

function teammateStatus(
  overrides: Partial<AgentEntityRuntimeStatus> = {},
): AgentEntityRuntimeStatus {
  return {
    name: 'mate-1',
    session_id: 'session-1',
    agent_runtime: 'controlled',
    created_at: 1,
    updated_at: 2,
    repo: REPO,
    intent: 'review',
    status: 'running',
    runtime_status: 'ready',
    last_error: null,
    closed_at: null,
    close_note: null,
    ...overrides,
  };
}

function recordRow(
  overrides: Partial<AgentEntityRecordRow> = {},
): AgentEntityRecordRow {
  return {
    name: 'mate-1',
    agent_runtime: 'controlled',
    source_repo: '/repo',
    created_at: 1,
    updated_at: 2,
    status: 'closed',
    runtime_status: null,
    intent: 'review',
    closed_at: 3,
    close_note: 'review finished',
    close_note_preview: 'review finished',
    cleanup_state: 'not-managed',
    resume: { tool: 'send', name: 'mate-1' },
    ...overrides,
  };
}

function workflowRecord(
  overrides: Partial<WorkflowRunRecord> = {},
): WorkflowRunRecord {
  return {
    version: 1,
    run_id: 'wf-1',
    dispatcher_id: 'test',
    team_id: null,
    caller_kind: 'dispatcher',
    script_hash: 'hash',
    status: 'running',
    max_concurrency: 2,
    phase: 'build',
    last_log: 'built 3 of 5',
    agents: [
      {
        index: 0,
        name: 'agent-0',
        label: 'finder',
        phase: 'build',
        status: 'running',
        result: null,
        error: null,
        created_at: 1,
        settled_at: null,
      },
    ],
    result: null,
    error: null,
    created_at: 1,
    updated_at: 2,
    ended_at: null,
    ...overrides,
  };
}

function dispatcherDelegate(
  host: Awaited<ReturnType<typeof dispatcherFixture>>['host'],
) {
  return createTeamMateMcpDelegate({ kind: 'dispatcher', dispatcher: host });
}

function leaderDelegate(
  host: Awaited<ReturnType<typeof dispatcherFixture>>['host'],
) {
  return createTeamMateMcpDelegate({
    kind: 'team_leader',
    team: {
      teammates: host.teammates,
      workflows: host.workflows,
      admitLeaderTools: async <T>(operation: () => Promise<T>) => operation(),
    },
  });
}

function memberDelegate() {
  const owner = {
    teammates: {
      send: vi.fn(async () => ({ status: 'submitted' as const })),
      list: vi.fn(async () => []),
    },
    memberOwner: () => ({
      name: 'owner-1',
      role: 'dispatcher',
      status: 'running',
    }),
    submitInput: vi.fn(),
  } as unknown as TeamMateMessagingOwner;
  return {
    owner,
    delegate: createTeamMateMcpDelegate({
      kind: 'member',
      name: 'mate-1',
      owner,
    }),
  };
}

describe('get_capabilities projection', () => {
  it('projects capability rows to id, description and tags', async () => {
    const f = await dispatcherFixture();
    const capabilities = {
      verbs: ['spawn'],
      agent_runtimes: [
        {
          id: 'codex-a',
          description: 'Fast read-only exploration',
          tags: ['explorer', 'fast'],
          spawn: { agent_runtime: 'codex-a' },
          runtime_available: true,
          unsupported_reason: null,
          public_config: { model: 'hidden' },
        },
        {
          id: 'claude-b',
          tags: [],
          spawn: { agent_runtime: 'claude-b' },
          runtime_available: false,
          unsupported_reason: 'missing binary',
          public_config: null,
        },
      ],
    } as unknown as AgentEntityCapabilities;
    vi.spyOn(f.host.teammates, 'getCapabilities').mockResolvedValue(
      capabilities,
    );

    const result = await dispatcherDelegate(f.host).call({
      name: 'get_capabilities',
      arguments: {},
    });

    expect(result).toEqual({
      ok: true,
      structured: {
        agent_runtimes: [
          {
            id: 'codex-a',
            description: 'Fast read-only exploration',
            tags: ['explorer', 'fast'],
          },
          { id: 'claude-b' },
        ],
      },
    });
  });
});

describe.each(['dispatcher', 'team_leader'] as const)(
  '%s spawn receipt',
  (kind) => {
    it('projects the receipt and scopes repo by caller', async () => {
      const f = await dispatcherFixture();
      const spawn = vi
        .spyOn(f.host.teammates, 'spawn')
        .mockResolvedValue({ status: 'submitted', teammate: teammateStatus() });
      const delegate =
        kind === 'dispatcher'
          ? dispatcherDelegate(f.host)
          : leaderDelegate(f.host);

      const result = await delegate.call({
        name: 'spawn',
        arguments: { name_prefix: 'mate', prompt: 'go', intent: 'review' },
      });

      expect(spawn).toHaveBeenCalled();
      expect(result).toMatchObject({
        ok: true,
        structured: {
          name: 'mate-1',
          status: 'submitted',
          ...(kind === 'dispatcher'
            ? { repo: { path: '/workspace/mate-1', branch: 'main' } }
            : {}),
        },
        text: expect.stringMatching(/TeamMate task was submitted/),
      });
      if (kind === 'team_leader') {
        expect(result).not.toMatchObject({
          structured: expect.objectContaining({ repo: expect.anything() }),
        });
      }
    });
  },
);

describe('owner send receipt', () => {
  it('projects submit status and failure reason', async () => {
    const f = await dispatcherFixture();
    vi.spyOn(f.host.teammates, 'send').mockResolvedValue({
      status: 'failed',
      error: 'runtime refused the turn',
      teammate: teammateStatus(),
    });

    const result = await dispatcherDelegate(f.host).call({
      name: 'send',
      arguments: { name: 'mate-1', prompt: 'continue' },
    });

    expect(result).toEqual({
      ok: true,
      structured: { status: 'failed', error: 'runtime refused the turn' },
    });
  });
});

describe('member send receipt', () => {
  it('drops the name echo but keeps the member reminder', async () => {
    const { owner, delegate } = memberDelegate();

    const result = await delegate.call({
      name: 'send',
      arguments: { name: 'peer-1', prompt: 'hello' },
    });

    expect(owner.teammates.send).toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      structured: { status: 'submitted' },
      text: expect.stringMatching(/admission receipt/),
    });
  });
});

describe('close projection', () => {
  it('keeps status and cleanup outcome', async () => {
    const f = await dispatcherFixture();
    vi.spyOn(f.host.teammates, 'close').mockResolvedValue({
      teammate: teammateStatus({
        status: 'closed',
        repo: { ...REPO, cleanup_state: 'retained-dirty' },
      }),
    });

    const result = await dispatcherDelegate(f.host).call({
      name: 'close',
      arguments: { name: 'mate-1', note: 'review finished' },
    });

    expect(result).toEqual({
      ok: true,
      structured: {
        status: 'closed',
        repo: { path: '/workspace/mate-1', cleanup_state: 'retained-dirty' },
      },
    });
  });
});

describe('list projection', () => {
  it('keeps only roster scan fields', async () => {
    const f = await dispatcherFixture();
    vi.spyOn(f.host.teammates, 'list').mockResolvedValue([
      teammateStatus(),
      teammateStatus({ name: 'mate-2', status: 'closed', intent: null }),
    ]);

    const result = await dispatcherDelegate(f.host).call({
      name: 'list',
      arguments: {},
    });

    expect(result).toEqual({
      ok: true,
      structured: {
        teammates: [
          {
            name: 'mate-1',
            status: 'running',
            agent_runtime: 'controlled',
            intent: 'review',
          },
          {
            name: 'mate-2',
            status: 'closed',
            agent_runtime: 'controlled',
            intent: null,
          },
        ],
      },
    });
  });
});

describe('history projection', () => {
  it('keeps the recovery row and pagination', async () => {
    const f = await dispatcherFixture();
    vi.spyOn(f.host.teammates, 'history').mockResolvedValue({
      items: [recordRow()],
      next_cursor: 'cursor-2',
    });

    const result = await dispatcherDelegate(f.host).call({
      name: 'history',
      arguments: {},
    });

    expect(result).toEqual({
      ok: true,
      structured: {
        items: [
          {
            name: 'mate-1',
            status: 'closed',
            agent_runtime: 'controlled',
            intent: 'review',
            source_repo: '/repo',
            updated_at: 2,
            close_note_preview: 'review finished',
          },
        ],
        next_cursor: 'cursor-2',
      },
    });
  });
});

describe('last projection', () => {
  it('keeps activity, status and pagination', async () => {
    const f = await dispatcherFixture();
    const observation: AgentEntityLastResult = {
      teammate: teammateStatus({
        status: 'closed',
        runtime_status: null,
        last_error: 'runtime exited',
      }),
      requested_records: 20,
      returned_records: 1,
      records: [{ kind: 'assistant_message', text: 'done', occurred_at: null }],
      next_cursor: 'cursor-3',
      truncated: true,
    };
    vi.spyOn(f.host.teammates, 'last').mockResolvedValue(observation);

    const result = await dispatcherDelegate(f.host).call({
      name: 'last',
      arguments: { name: 'mate-1', limit: 20 },
    });

    expect(result).toEqual({
      ok: true,
      structured: {
        status: 'closed',
        runtime_status: null,
        last_error: 'runtime exited',
        records: [
          { kind: 'assistant_message', text: 'done', occurred_at: null },
        ],
        next_cursor: 'cursor-3',
        truncated: true,
      },
    });
  });
});

describe('workflow projections', () => {
  it('keeps run_id and the reminder for workflow_run', async () => {
    const f = await dispatcherFixture();
    vi.spyOn(f.host.workflows, 'run').mockResolvedValue({
      run_id: 'wf-1',
    });

    const result = await dispatcherDelegate(f.host).call({
      name: 'workflow_run',
      arguments: { script: 'return null;' },
    });

    expect(result).toEqual({
      ok: true,
      structured: { run_id: 'wf-1' },
      text: expect.stringMatching(/do not call or poll/),
    });
  });

  it('keeps only the resulting status for workflow_stop', async () => {
    const f = await dispatcherFixture();
    vi.spyOn(f.host.workflows, 'stop').mockResolvedValue({
      run_id: 'wf-1',
      status: 'stopped',
    });

    const result = await dispatcherDelegate(f.host).call({
      name: 'workflow_stop',
      arguments: { run_id: 'wf-1' },
    });

    expect(result).toEqual({
      ok: true,
      structured: { status: 'stopped' },
    });
  });

  it('keeps only identification fields in list rows', async () => {
    const f = await dispatcherFixture();
    vi.spyOn(f.host.workflows, 'list').mockResolvedValue({
      runs: [workflowRecord()],
    });

    const result = await dispatcherDelegate(f.host).call({
      name: 'workflow_list',
      arguments: {},
    });

    expect(result).toEqual({
      ok: true,
      structured: {
        runs: [
          {
            run_id: 'wf-1',
            status: 'running',
            phase: 'build',
            created_at: 1,
          },
        ],
      },
    });
  });

  it('keeps progress and terminal facts', async () => {
    const f = await dispatcherFixture();
    vi.spyOn(f.host.workflows, 'status').mockResolvedValue(workflowRecord());

    const result = await dispatcherDelegate(f.host).call({
      name: 'workflow_status',
      arguments: { run_id: 'wf-1' },
    });

    expect(result).toEqual({
      ok: true,
      structured: {
        run_id: 'wf-1',
        status: 'running',
        phase: 'build',
        last_log: 'built 3 of 5',
        result: null,
        error: null,
        created_at: 1,
        updated_at: 2,
        ended_at: null,
        agents: [
          {
            index: 0,
            name: 'agent-0',
            label: 'finder',
            status: 'running',
            phase: 'build',
            result: null,
            error: null,
          },
        ],
      },
    });
  });
});

describe('text-capable tool descriptors', () => {
  it('omits output schema from text-capable tools', async () => {
    const f = await dispatcherFixture();
    const { delegate: member } = memberDelegate();
    const tools = [
      ...dispatcherDelegate(f.host).describe().tools,
      ...member.describe().tools,
    ] as { name: string; outputSchema?: unknown }[];

    for (const name of ['spawn', 'send', 'workflow_run']) {
      const matches = tools.filter((candidate) => candidate.name === name);
      expect(matches).toHaveLength(name === 'send' ? 2 : 1);
      for (const tool of matches)
        expect(tool).not.toHaveProperty('outputSchema');
    }
    const capabilitiesTool = tools.find(
      (candidate) => candidate.name === 'get_capabilities',
    );
    expect(capabilitiesTool).toHaveProperty('outputSchema');
    const closeTool = tools.find((candidate) => candidate.name === 'close');
    expect(closeTool).toHaveProperty('outputSchema');
  });
});
