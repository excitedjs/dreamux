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

import type { RuntimeActivity } from '../src/agent-runtime.js';
import type {
  SubmitCommand,
  TeamCreateCommand,
  TeamCreateRepoRequest,
  TeamStatus,
  TeamSummary,
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
  TeammateInputNotice,
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

  it('TeamSummary carries lifecycle status and the stable runtime context', () => {
    assertType<Equal<TeamStatus, 'starting' | 'running' | 'closed'>>();
    assertType<Equal<TeamSummary['status'], TeamStatus>>();
    assertType<Equal<TeamSummary['leader_agent_runtime'], string>>();
    assertType<Equal<TeamSummary['runtime_cwd'], string>>();
    assertType<Equal<TeamSummary['leader_state'], import('../src/teammate.js').TeammateStatus | null>>();
  });
});

describe('SubmitCommand / TeamSubmitCommand / TeamSubmitResult: one shared payload, Team name only on the Team Command', () => {
  it('a Dispatcher-bound submission needs only text and carries no team_name field', () => {
    const toDispatcher: SubmitCommand = { text: 'dispatcher-bound text' };
    expect(toDispatcher.text).toBe('dispatcher-bound text');
    // @ts-expect-error the Dispatcher Command has no team_name: a turn meant for
    // a Team uses team.submit, which requires it.
    toDispatcher.team_name;
  });

  it('a Team-bound submission requires team_name, sharing the other fields verbatim', () => {
    // @ts-expect-error team_name is required on team.submit; omitting it is the
    // BAD_REQUEST the schema gate enforces before the handler runs.
    const missingName: TeamSubmitCommand = { text: 'team-bound text' };
    // The other fields are still carried; only the absent name makes this an
    // unconstructable Team Command (compile-time, asserted above).
    expect(missingName.text).toBe('team-bound text');

    const shared: Pick<TeamSubmitCommand, 'attrs' | 'text' | 'reminder' | 'source_id' | 'intent'> = {
      attrs: { chat_id: 'chat-1' },
      text: 'team-bound text',
      reminder: 'stand up a review',
      source_id: 'msg-1',
      intent: 'review this',
    };
    const toTeam: TeamSubmitCommand = { team_name: 'team-a', ...shared };
    expect(toTeam.team_name).toBe('team-a');
    expect(toTeam.attrs).toEqual({ chat_id: 'chat-1' });
    expect(toTeam.source_id).toBe('msg-1');
    expect(toTeam.intent).toBe('review this');

    // The shared fields are SubmitCommand's own fields, so a Team Command is
    // assignable wherever the shared shape is read.
    const sharedView: SubmitCommand = toTeam;
    expect(sharedView.text).toBe('team-bound text');
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
      teammateName: 'agent-1',
      role: 'team_leader',
      status: 'running',
    };
    const event: TeamStateEvent = {
      schemaVersion: 1,
      kind: 'team.state',
      occurredAt: 1,
      teamName: 'team-a',
      leaderName: 'agent-1',
      status: 'running',
      teammates: [summary],
    };
    expect(event.teammates[0]?.role).toBe('team_leader');
  });
});

describe('TeammateStateEvent, teammate.input, and teammate.activity', () => {
  it('shares RuntimeActivity and spells every event member in camelCase', () => {
    assertType<Equal<TeammateActivityEvent['activity'], RuntimeActivity>>();
    assertType<Equal<keyof TeammateActorScope,
      'schemaVersion' | 'occurredAt' | 'teammateName' | 'role' | 'teamName'>>();
    assertType<Equal<keyof TeamStateEvent,
      'schemaVersion' | 'kind' | 'occurredAt' | 'teamName' | 'leaderName' | 'status' | 'teammates'>>();
    assertType<Equal<keyof TeamStateTeammateSummary, 'teammateName' | 'role' | 'status'>>();
    assertType<Equal<keyof TeammateStateEvent, keyof TeammateActorScope | 'kind' | 'status'>>();
    assertType<Equal<keyof Exclude<RuntimeActivity, { kind: 'turn.ended' }>, 'kind' | 'occurredAt' | 'id'>>();
    assertType<Equal<keyof Extract<RuntimeActivity, { kind: 'tool.call' }>,
      'kind' | 'occurredAt' | 'id' | 'toolName' | 'action' | 'summary' | 'invocation' | 'items'
      | 'status' | 'arguments' | 'result' | 'error'>>();
    assertType<Equal<keyof Extract<RuntimeActivity, { kind: 'turn.ended' }>,
      'kind' | 'occurredAt' | 'status' | 'reason'>>();
  });

  it('TeammateStateEvent.teamName is null only for a Dispatcher, which never joins a Team', () => {
    const dispatcherEvent: TeammateStateEvent = {
      schemaVersion: 1,
      kind: 'teammate.state',
      occurredAt: 1,
      teammateName: 'dispatcher-1',
      role: 'dispatcher',
      teamName: null,
      status: 'running',
    };
    const teamEvent: TeammateStateEvent = {
      schemaVersion: 1,
      kind: 'teammate.state',
      occurredAt: 2,
      teammateName: 'agent-2',
      role: 'teammate',
      teamName: 'team-a',
      status: 'running',
    };
    expect(dispatcherEvent.teamName).toBeNull();
    expect(teamEvent.teamName).toBe('team-a');
  });

  it('teammate.input carries source provenance and the caller id, and no turn identity', () => {
    assertType<
      Equal<
        keyof TeammateInputEvent,
        | keyof TeammateActorScope
        | 'kind'
        | 'source'
        | 'sourceId'
        | 'content'
        | 'notice'
      >
    >();

    const input: TeammateInputEvent = {
      schemaVersion: 1,
      occurredAt: 1,
      teammateName: 'agent-1',
      role: 'teammate',
      teamName: 'team-a',
      kind: 'teammate.input',
      source: 'feishu',
      sourceId: 'message-fixture',
      content: 'hello',
      notice: null,
    };

    expect(input.sourceId).toBe('message-fixture');
    // A caller recognizes its own submission by comparing this against ids it
    // issued. Presence proves nothing: cron fires, task push-backs, and restart
    // notices carry a source id too.
    expect(Object.keys(input)).not.toContain('turn_id');
  });

  it('names the producer only for the push-backs whose provenance name cannot', () => {
    const callback: TeammateInputEvent = {
      schemaVersion: 1,
      occurredAt: 1,
      teammateName: 'agent-1',
      role: 'teammate',
      teamName: 'team-a',
      kind: 'teammate.input',
      source: 'task-notification',
      sourceId: null,
      content: 'TeamMate tm-1 has finished its task. …',
      notice: { kind: 'teammate_completion', producer: 'tm-1' },
    };

    // The body still carries the whole notification the model reads; the
    // notice is the same fact stated as data, for a display that shows one line.
    expect(callback.notice).toEqual({ kind: 'teammate_completion', producer: 'tm-1' });
    expect(callback.content).toContain('has finished its task');
    // A Workflow push-back names no producer: the operator's display shows none.
    assertType<
      Equal<
        keyof Extract<TeammateInputNotice, { kind: 'workflow_completion' }>,
        'kind'
      >
    >();
  });

  it('teammate.activity nests the whole runtime vocabulary under one kind, addressed by the actor alone', () => {
    assertType<
      Equal<keyof TeammateActivityEvent, keyof TeammateActorScope | 'kind' | 'activity'>
    >();

    const scope: TeammateActorScope = {
      schemaVersion: 1,
      occurredAt: 1,
      teammateName: 'agent-1',
      role: 'teammate',
      teamName: 'team-a',
    };
    const message: TeammateActivityEvent = {
      ...scope,
      kind: 'teammate.activity',
      activity: {
        kind: 'assistant.message',
        occurredAt: 1,
        id: 'evt-1',
        text: 'hello',
      },
    };
    const toolCall: TeammateActivityEvent = {
      ...scope,
      kind: 'teammate.activity',
      activity: {
        kind: 'tool.call',
        occurredAt: 1,
        id: 'call-1',
        toolName: 'search',
        action: 'search',
        summary: null,
        invocation: null,
        items: [],
        status: 'completed',
        arguments: {},
        result: {},
        error: null,
      },
    };
    const ended: TeammateActivityEvent = {
      ...scope,
      kind: 'teammate.activity',
      activity: {
        kind: 'turn.ended',
        occurredAt: 1,
        status: 'failed',
        reason: 'the agent runtime is not running',
      },
    };

    // Every member is addressed by the same actor scope; none carries a turn or
    // submission identity a consumer would have to correlate on.
    for (const event of [message, toolCall, ended]) {
      expect(event.teammateName).toBe('agent-1');
      expect(Object.keys(event.activity)).not.toContain('turn_id');
    }
  });
});
