/**
 * Team / TeamMate catalog contracts (issue #209 minimize-provider-boundaries).
 *
 * Covers the Team-owned Commands whose contracts changed materially for
 * Channel use (`TeamCreateCommand`, `TeamSubmitCommand`), the aggregate
 * `TeamStateEvent`, and the actor-keyed TeamMate facts every Channel consumes
 * through {@link ChannelCoreEvent}. `TeammateRole`/`TeamContainedRole` use
 * `team_leader` and `teammate` — the pre-refactor `team_member` vocabulary is
 * gone.
 */
import { describe, expect, it } from 'vitest';

import type {
  TeamCreateCommand,
  TeamCreateRepoRequest,
  TeamCreateResult,
  TeamStateEvent,
  TeamStateTeammateSummary,
  TeamSubmitCommand,
  TeamSubmitResult,
} from '../src/team.js';
import type {
  TeamContainedRole,
  TeammateRole,
  TeammateActivityEvent,
  TeammateActorScope,
  TeammateInputEvent,
  TeammateStateEvent,
} from '../src/teammate.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 0) extends <T>() => T extends B
  ? 1
  : 0
  ? true
  : false;

function assertType<T extends true>(_proof?: T): void {
  // Compile-time-only: see agent-runtime-handle-contract.test.ts for the pattern's rationale.
}

function assertNever(value: never): never {
  throw new Error(`unreachable union member: ${JSON.stringify(value)}`);
}

describe('TeammateRole / TeamContainedRole carry no team_member vocabulary', () => {
  it('TeammateRole is exactly dispatcher | teammate | team_leader', () => {
    assertType<Equal<TeammateRole, 'dispatcher' | 'teammate' | 'team_leader'>>();
  });

  it('TeamContainedRole excludes dispatcher and is exactly teammate | team_leader', () => {
    assertType<Equal<TeamContainedRole, 'teammate' | 'team_leader'>>();
  });

  it('every role renders through an exhaustive switch with no team_member case', () => {
    function label(role: TeammateRole): string {
      switch (role) {
        case 'dispatcher':
          return 'Dispatcher';
        case 'teammate':
          return 'TeamMate';
        case 'team_leader':
          return 'TeamLeader';
        default:
          return assertNever(role);
      }
    }
    expect(label('dispatcher')).toBe('Dispatcher');
    expect(label('teammate')).toBe('TeamMate');
    expect(label('team_leader')).toBe('TeamLeader');
  });
});

describe('TeamCreateRepoRequest is the complete existing Team-creation repo policy', () => {
  it('reuse-cwd carries only mode + optional path', () => {
    assertType<
      Equal<Extract<TeamCreateRepoRequest, { mode: 'reuse-cwd' }>['path'], string | undefined>
    >();
    const reuseCwd: TeamCreateRepoRequest = { mode: 'reuse-cwd' };
    const reuseCwdWithPath: TeamCreateRepoRequest = { mode: 'reuse-cwd', path: '/work/dir' };
    expect(reuseCwd.mode).toBe('reuse-cwd');
    expect(reuseCwdWithPath.path).toBe('/work/dir');
  });

  it('managed carries the full existing worktree policy: path/base_ref/branch/slug/cleanup', () => {
    const managed: TeamCreateRepoRequest = {
      mode: 'managed',
      path: '/repo',
      base_ref: 'next',
      branch: 'feature/x',
      slug: 'feature-x',
      cleanup: 'delete-on-close',
    };
    expect(managed).toEqual({
      mode: 'managed',
      path: '/repo',
      base_ref: 'next',
      branch: 'feature/x',
      slug: 'feature-x',
      cleanup: 'delete-on-close',
    });
  });

  it('cleanup is exactly keep | delete-on-close', () => {
    assertType<
      Equal<
        NonNullable<Extract<TeamCreateRepoRequest, { mode: 'managed' }>['cleanup']>,
        'keep' | 'delete-on-close'
      >
    >();
  });

  it('the union is discriminated by mode with no third branch', () => {
    function describeRepoRequest(request: TeamCreateRepoRequest): string {
      switch (request.mode) {
        case 'reuse-cwd':
          return `reuse-cwd:${request.path ?? 'default'}`;
        case 'managed':
          return `managed:${request.slug ?? 'unnamed'}`;
        default:
          return assertNever(request);
      }
    }
    expect(describeRepoRequest({ mode: 'reuse-cwd' })).toBe('reuse-cwd:default');
    expect(describeRepoRequest({ mode: 'managed', slug: 's1' })).toBe('managed:s1');
  });
});

describe('TeamCreateCommand carries restart-durable request identity and leader launch facts', () => {
  it('a minimal command needs only request_id/name_prefix/intent/leader.agent_runtime', () => {
    const command: TeamCreateCommand = {
      request_id: 'req-1',
      name_prefix: 'feature',
      intent: 'ship the thing',
      leader: { agent_runtime: 'builtin:codex' },
    };
    expect(command.repo).toBeUndefined();
    expect(command.leader.identity).toBeUndefined();
  });

  it('TeamCreateResult status is exactly created | existing | closed', () => {
    assertType<Equal<TeamCreateResult['status'], 'created' | 'existing' | 'closed'>>();
  });
});

describe('TeamSubmitCommand / TeamSubmitResult: the flat, provenance-free submit payload', () => {
  it('omitting team_name targets the Dispatcher Agent; supplying it targets that Team only', () => {
    const toDispatcher: TeamSubmitCommand = { text: 'dispatcher-bound text' };
    const toTeam: TeamSubmitCommand = { team_name: 'team-a', text: 'team-bound text' };
    expect(toDispatcher.team_name).toBeUndefined();
    expect(toTeam.team_name).toBe('team-a');
  });

  it('TeamSubmitResult status is exactly submitted | duplicate | stopped | failed | ambiguous', () => {
    assertType<
      Equal<
        TeamSubmitResult['status'],
        'submitted' | 'duplicate' | 'stopped' | 'failed' | 'ambiguous'
      >
    >();
  });

  it('every submit result renders through an exhaustive switch', () => {
    function summarize(result: TeamSubmitResult): string {
      switch (result.status) {
        case 'submitted':
          return `submitted:${result.turn_id ?? 'unknown'}`;
        case 'duplicate':
          return 'duplicate';
        case 'stopped':
          return 'stopped';
        case 'failed':
          return `failed:${result.error?.code ?? 'unknown'}`;
        case 'ambiguous':
          return 'ambiguous';
        default:
          // `status` is a union-typed FIELD on one flat interface here (unlike
          // e.g. RuntimeAdmission's true discriminated union of object
          // branches), so exhaustiveness narrows `result.status` to `never`,
          // not `result` itself.
          return assertNever(result.status);
      }
    }
    expect(summarize({ status: 'submitted', turn_id: 't1' })).toBe('submitted:t1');
    expect(summarize({ status: 'duplicate' })).toBe('duplicate');
    expect(
      summarize({ status: 'failed', error: { code: 'TEAM_NOT_FOUND', message: 'gone' } }),
    ).toBe('failed:TEAM_NOT_FOUND');
  });
});

describe('TeamStateEvent republishes an aggregate with a bounded teammate summary', () => {
  it('status is exactly starting | running | closed', () => {
    assertType<Equal<TeamStateEvent['status'], 'starting' | 'running' | 'closed'>>();
  });

  it('TeamStateTeammateSummary.role is the Team-contained subset (no dispatcher row in a Team)', () => {
    assertType<Equal<TeamStateTeammateSummary['role'], TeamContainedRole>>();

    const summary: TeamStateTeammateSummary = {
      teammate_name: 'agent-1',
      role: 'team_leader',
      status: 'running',
    };
    const event: TeamStateEvent = {
      schema_version: 1,
      kind: 'team.state',
      occurred_at: 1,
      team_name: 'team-a',
      leader_name: 'agent-1',
      status: 'running',
      teammates: [summary],
    };
    expect(event.teammates[0]?.role).toBe('team_leader');
  });
});

describe('TeammateStateEvent, teammate.input, and teammate.activity', () => {
  it('TeammateStateEvent.team_name is null only for a Dispatcher, which never joins a Team', () => {
    const dispatcherEvent: TeammateStateEvent = {
      schema_version: 1,
      kind: 'teammate.state',
      occurred_at: 1,
      teammate_name: 'dispatcher-1',
      role: 'dispatcher',
      team_name: null,
      status: 'running',
    };
    const teamEvent: TeammateStateEvent = {
      schema_version: 1,
      kind: 'teammate.state',
      occurred_at: 2,
      teammate_name: 'agent-2',
      role: 'teammate',
      team_name: 'team-a',
      status: 'running',
    };
    expect(dispatcherEvent.team_name).toBeNull();
    expect(teamEvent.team_name).toBe('team-a');
  });

  it('teammate.input carries source provenance and the caller id, and no turn identity', () => {
    assertType<
      Equal<
        keyof TeammateInputEvent,
        | keyof TeammateActorScope
        | 'kind'
        | 'source'
        | 'source_id'
        | 'content'
        | 'redacted'
      >
    >();

    const input: TeammateInputEvent = {
      schema_version: 1,
      occurred_at: 1,
      teammate_name: 'agent-1',
      role: 'teammate',
      team_name: 'team-a',
      kind: 'teammate.input',
      source: 'feishu',
      source_id: 'message-fixture',
      content: 'hello',
      redacted: false,
    };

    expect(input.source_id).toBe('message-fixture');
    // A caller recognizes its own submission by comparing this against ids it
    // issued. Presence proves nothing: cron fires, task push-backs, and restart
    // notices carry a source id too.
    expect(Object.keys(input)).not.toContain('turn_id');
  });

  it('teammate.activity nests the whole runtime vocabulary under one kind, addressed by the actor alone', () => {
    assertType<
      Equal<keyof TeammateActivityEvent, keyof TeammateActorScope | 'kind' | 'activity'>
    >();

    const scope: TeammateActorScope = {
      schema_version: 1,
      occurred_at: 1,
      teammate_name: 'agent-1',
      role: 'teammate',
      team_name: 'team-a',
    };
    const message: TeammateActivityEvent = {
      ...scope,
      kind: 'teammate.activity',
      activity: {
        kind: 'assistant.message',
        event_id: 'evt-1',
        content: 'hello',
        redacted: false,
      },
    };
    const toolCall: TeammateActivityEvent = {
      ...scope,
      kind: 'teammate.activity',
      activity: {
        kind: 'tool.call',
        event_id: 'evt-2',
        call_id: 'call-1',
        tool_name: 'search',
        tool_action: 'search',
        summary: null,
        invocation: null,
        items: [],
        status: 'completed',
        arguments_json: '{}',
        result_json: '{}',
        redacted: false,
      },
    };
    const ended: TeammateActivityEvent = {
      ...scope,
      kind: 'teammate.activity',
      activity: {
        kind: 'turn.ended',
        status: 'failed',
        reason: 'the agent runtime is not running',
        redacted: false,
      },
    };

    // Every member is addressed by the same actor scope; none carries a turn or
    // submission identity a consumer would have to correlate on.
    for (const event of [message, toolCall, ended]) {
      expect(event.teammate_name).toBe('agent-1');
      expect(Object.keys(event.activity)).not.toContain('turn_id');
    }
  });
});
