import { describe, expect, it, vi } from 'vitest';

import type {
  AgentRuntimeSkillSource,
  ChannelOrigin,
  ChannelTurnSettledEvent,
  DreamuxLogger,
  RuntimeActivity,
  RuntimeActivityEvent,
  RuntimeAdmission,
} from '@excitedjs/dreamux-types';

import type {
  ConversationProjection,
  ConversationTurnSettlement,
} from '../src/channel/conversation-projection.js';
import { createConversationProjection } from '../src/channel/conversation-projection.js';
import type { AgentEntityIdentity } from '../src/service/agent-entity/types.js';
import { DispatcherCoreEventBus } from '../src/service/dispatcher-core-events/index.js';
import {
  EARLY_ACTIVITY_EVENTS_MAX,
  EntityTurnCoordinator,
} from '../src/service/teammate-service/turn-coordinator.js';
import {
  controllableRuntimeSubmission,
  foldSubmissions,
} from './helpers/runtime-submission.js';

type EntryPoint = 'submitted' | 'activity' | 'settled';

class RecordingProjection implements ConversationProjection {
  readonly attempts: EntryPoint[] = [];
  readonly submitted: Array<{ turnId: string; prompt: string | null }> = [];
  readonly activity: Array<{ turnId: string; activity: RuntimeActivity }> = [];
  readonly settled: Array<{ turnId: string; settlement: ConversationTurnSettlement }> = [];

  constructor(private readonly throws = new Set<EntryPoint>()) {}

  projectSubmitted(
    _identity: AgentEntityIdentity,
    turn: { id: string; prompt: string | null },
  ): void {
    this.attempts.push('submitted');
    if (this.throws.has('submitted')) throw new Error('submitted projection failed');
    this.submitted.push({ turnId: turn.id, prompt: turn.prompt });
  }

  projectActivity(
    _identity: AgentEntityIdentity,
    turn: { id: string },
    event: RuntimeActivityEvent,
  ): void {
    this.attempts.push('activity');
    if (this.throws.has('activity')) throw new Error('activity projection failed');
    this.activity.push({ turnId: turn.id, activity: event.activity });
  }

  projectSettled(input: {
    identity: AgentEntityIdentity;
    turn: { id: string };
    settlement: ConversationTurnSettlement;
  }): void {
    this.attempts.push('settled');
    if (this.throws.has('settled')) throw new Error('settled projection failed');
    this.settled.push({ turnId: input.turn.id, settlement: input.settlement });
  }
}

function identity(): AgentEntityIdentity {
  return {
    version: 1,
    dispatcher_id: 'flow',
    name: 'dispatcher',
    role: 'dispatcher',
    team_id: null,
    agent_runtime: 'agent-a',
    session_id: null,
    transcript_locator: null,
    source_cwd: '/workspace',
    source_repo: null,
    cwd: '/workspace',
    runtime_cwd: '/workspace',
    worktree: {
      mode: 'reuse-cwd',
      slug: null,
      path: '/workspace',
      branch: null,
      base_ref: null,
      cleanup: 'keep',
      cleanup_state: 'not-managed',
      cleanup_error: null,
    },
    intent: null,
    identity_prompt: null,
    skill_sources: [] as readonly AgentRuntimeSkillSource[],
    created_at: 0,
    updated_at: 0,
    status: 'running',
    last_error: null,
    closed_at: null,
    close_note: null,
  };
}

function recordingLogger(warnings: Array<Record<string, unknown>>): DreamuxLogger {
  const noop = () => undefined;
  return {
    trace: noop,
    debug: noop,
    info: noop,
    warn: (fields: Record<string, unknown> | string) => {
      if (typeof fields !== 'string') warnings.push(fields);
    },
    error: noop,
    fatal: noop,
    child: () => recordingLogger(warnings),
  } as unknown as DreamuxLogger;
}

function coordinator(
  projection: ConversationProjection,
  options: {
    identity?: () => AgentEntityIdentity;
    log?: DreamuxLogger;
    warnings?: Array<Record<string, unknown>>;
  } = {},
): EntityTurnCoordinator {
  return new EntityTurnCoordinator({
    identity: options.identity ?? identity,
    intent: () => null,
    isActive: () => true,
    conversationProjection: projection,
    log: options.log ?? recordingLogger(options.warnings ?? []),
  });
}

function channelOrigin(): ChannelOrigin {
  return {
    provider: 'builtin:feishu',
    channel_id: 'primary',
    message_id: 'message-1',
    target: {
      target_type: 'group',
      target_key: 'chat-1',
      bindable: true,
      meta: { chat_id: 'chat-1' },
    },
    binding: null,
  };
}

function realProjectionCoordinator(): {
  coord: EntityTurnCoordinator;
  events: ChannelTurnSettledEvent[];
  revoke(): void;
} {
  const log = recordingLogger([]);
  const bus = new DispatcherCoreEventBus({
    dispatcherId: 'flow',
    log,
    maxSources: 1,
  });
  const lease = bus.createSource('primary');
  const events: ChannelTurnSettledEvent[] = [];
  lease.source.on('turn.settled', (event) => {
    events.push(event);
  });
  const projection = createConversationProjection({
    coreEvents: bus.publisher,
    log,
  });
  return { coord: coordinator(projection), events, revoke: lease.revoke };
}

function retainedTurnCount(coord: EntityTurnCoordinator): number {
  return (coord as unknown as { retainedTurns: Set<unknown> }).retainedTurns.size;
}

function assistantMessage(id: string): RuntimeActivity {
  return { kind: 'assistant.message', id, text: id, truncated: false };
}

describe('EntityTurnCoordinator display lifecycle', () => {
  it('flushes early activity in order after projecting the submitted turn', async () => {
    const projection = new RecordingProjection();
    const coord = coordinator(projection);
    const pending = controllableRuntimeSubmission();

    const result = await coord.submitRuntimeTurn(
      async (): Promise<RuntimeAdmission> => {
        coord.activitySink({
          submission: pending.submission,
          activity: assistantMessage('early-1'),
          occurredAt: 1,
        });
        coord.activitySink({
          submission: pending.submission,
          activity: assistantMessage('early-2'),
          occurredAt: 2,
        });
        return { status: 'submitted', submission: pending.submission };
      },
      { turnOrigin: null, prompt: 'go' },
    );

    expect(result.status).toBe('submitted');
    expect(projection.submitted).toHaveLength(1);
    expect(projection.activity.map(({ activity }) => activity.id)).toEqual([
      'early-1',
      'early-2',
    ]);
    expect(projection.activity.every(({ turnId }) =>
      turnId === projection.submitted[0]?.turnId)).toBe(true);
  });

  it('drops newest early activity at 512 and warns once', async () => {
    const projection = new RecordingProjection();
    const warnings: Array<Record<string, unknown>> = [];
    const coord = coordinator(projection, { warnings });
    const pending = controllableRuntimeSubmission();

    await coord.submitRuntimeTurn(
      async (): Promise<RuntimeAdmission> => {
        for (let index = 0; index < EARLY_ACTIVITY_EVENTS_MAX + 20; index += 1) {
          coord.activitySink({
            submission: pending.submission,
            activity: assistantMessage(`activity-${index}`),
            occurredAt: index,
          });
        }
        return { status: 'submitted', submission: pending.submission };
      },
      { turnOrigin: null, prompt: 'go' },
    );

    expect(projection.activity).toHaveLength(EARLY_ACTIVITY_EVENTS_MAX);
    expect(projection.activity.at(-1)?.activity.id).toBe('activity-511');
    expect(warnings.filter(({ maximum }) =>
      maximum === EARLY_ACTIVITY_EVENTS_MAX)).toHaveLength(1);
  });

  it('publishes one settlement for every folded submission on its own turn id', async () => {
    const projection = new RecordingProjection();
    const coord = coordinator(projection);
    const submissions = [
      controllableRuntimeSubmission(),
      controllableRuntimeSubmission(),
      controllableRuntimeSubmission(),
    ];

    for (const [index, pending] of submissions.entries()) {
      await coord.submitRuntimeTurn(
        async () => ({ status: 'submitted', submission: pending.submission }),
        { turnOrigin: null, prompt: `prompt-${index}` },
      );
    }
    foldSubmissions(submissions, 'folded result');
    await settleTicks();

    expect(projection.settled).toHaveLength(3);
    expect(projection.settled.map(({ turnId }) => turnId)).toEqual(
      projection.submitted.map(({ turnId }) => turnId),
    );
    expect(projection.settled.map(({ settlement }) => settlement)).toEqual([
      { status: 'completed', resultText: 'folded result', truncated: false },
      { status: 'completed', resultText: 'folded result', truncated: false },
      { status: 'completed', resultText: 'folded result', truncated: false },
    ]);
  });

  it('publishes failed and stopped submission settlements', async () => {
    const projection = new RecordingProjection();
    const coord = coordinator(projection);
    const failed = controllableRuntimeSubmission();
    const stopped = controllableRuntimeSubmission();
    for (const pending of [failed, stopped]) {
      await coord.submitRuntimeTurn(
        async () => ({ status: 'submitted', submission: pending.submission }),
        { turnOrigin: null, prompt: 'go' },
      );
    }

    failed.fail(new Error('runtime failed'));
    stopped.stop();
    await settleTicks();

    expect(projection.settled.map(({ settlement }) => settlement.status)).toEqual([
      'failed',
      'stopped',
    ]);
  });

  it('drops activity after the turn has settled', async () => {
    const projection = new RecordingProjection();
    const coord = coordinator(projection);
    const pending = controllableRuntimeSubmission();
    await coord.submitRuntimeTurn(
      async () => ({ status: 'submitted', submission: pending.submission }),
      { turnOrigin: null, prompt: 'go' },
    );

    pending.complete('done');
    await settleTicks();
    coord.activitySink({
      submission: pending.submission,
      activity: assistantMessage('late'),
      occurredAt: 2,
    });

    expect(projection.settled).toHaveLength(1);
    expect(projection.activity).toEqual([]);
  });
});

describe('EntityTurnCoordinator public settlement projection', () => {
  it('publishes one public settled event per folded submission and turn id', async () => {
    const { coord, events, revoke } = realProjectionCoordinator();
    const pending = [
      controllableRuntimeSubmission(),
      controllableRuntimeSubmission(),
      controllableRuntimeSubmission(),
    ];
    const turnIds: string[] = [];
    for (const [index, submission] of pending.entries()) {
      const admission = await coord.submitRuntimeTurn(
        async () => ({ status: 'submitted', submission: submission.submission }),
        {
          turnOrigin: { kind: 'channel', channel_origin: channelOrigin() },
          prompt: `prompt-${index}`,
        },
      );
      if (admission.status !== 'submitted') throw new Error('turn was not admitted');
      turnIds.push(admission.turn.id);
    }

    foldSubmissions(pending, 'folded result');
    await settleTicks();

    expect(events).toHaveLength(turnIds.length);
    expect(events.map((event) => ({
      turn_id: event.turn_id,
      status: event.status,
    }))).toEqual(turnIds.map((turnId) => ({
      turn_id: turnId,
      status: 'completed',
    })));
    expect(new Set(events.map((event) => event.turn_id))).toEqual(new Set(turnIds));
    revoke();
  });

  it.each(['failed', 'stopped'] as const)(
    'publishes one public %s settlement for its exact turn',
    async (status) => {
      const { coord, events, revoke } = realProjectionCoordinator();
      const pending = controllableRuntimeSubmission();
      const admission = await coord.submitRuntimeTurn(
        async () => ({ status: 'submitted', submission: pending.submission }),
        {
          turnOrigin: { kind: 'channel', channel_origin: channelOrigin() },
          prompt: 'go',
        },
      );
      if (admission.status !== 'submitted') throw new Error('turn was not admitted');

      if (status === 'failed') pending.fail(new Error('runtime failed'));
      else pending.stop();
      await settleTicks();

      expect(events).toEqual([
        expect.objectContaining({
          kind: 'turn.settled',
          turn_id: admission.turn.id,
          status,
        }),
      ]);
      revoke();
    },
  );
});

describe('EntityTurnCoordinator fail-open display boundary', () => {
  it('keeps admission, activity, settlement, and delivery alive when projection throws', async () => {
    const warnings: Array<Record<string, unknown>> = [];
    const projection = new RecordingProjection(
      new Set(['submitted', 'activity', 'settled']),
    );
    const coord = coordinator(projection, { warnings });
    const pending = controllableRuntimeSubmission();
    const delivered = vi.fn(async () => undefined);

    const admission = await coord.submitRuntimeTurn(
      async (): Promise<RuntimeAdmission> => {
        coord.activitySink({
          submission: pending.submission,
          activity: assistantMessage('early'),
          occurredAt: 1,
        });
        return { status: 'submitted', submission: pending.submission };
      },
      { turnOrigin: null, prompt: 'go', deliverCompletion: delivered },
    );
    expect(admission.status).toBe('submitted');

    coord.activitySink({
      submission: pending.submission,
      activity: assistantMessage('live'),
      occurredAt: 2,
    });
    pending.complete('done');
    await settleTicks();
    if (admission.status === 'submitted') await admission.turn.delivery;
    await coord.drainAdmissions();
    await settleTicks();

    expect(delivered).toHaveBeenCalledTimes(1);
    expect(coord.hasUnsettledCurrent()).toBe(false);
    expect(retainedTurnCount(coord)).toBe(0);
    expect(warnings.map(({ entry_point }) => entry_point)).toEqual([
      'submitted',
      'early_activity',
      'live_activity',
      'settled',
    ]);
  });

  it('keeps all four display entry points fail-open when warning also throws', async () => {
    const projection = new RecordingProjection(
      new Set(['submitted', 'activity', 'settled']),
    );
    const throwingLog = {
      ...recordingLogger([]),
      warn: () => {
        throw new Error('logger unavailable');
      },
    } as DreamuxLogger;
    const coord = coordinator(projection, { log: throwingLog });
    const pending = controllableRuntimeSubmission();
    const delivered = vi.fn(async () => undefined);

    const admission = await coord.submitRuntimeTurn(
      async (): Promise<RuntimeAdmission> => {
        coord.activitySink({
          submission: pending.submission,
          activity: assistantMessage('early'),
          occurredAt: 1,
        });
        return { status: 'submitted', submission: pending.submission };
      },
      { turnOrigin: null, prompt: 'go', deliverCompletion: delivered },
    );
    expect(admission.status).toBe('submitted');

    coord.activitySink({
      submission: pending.submission,
      activity: assistantMessage('live'),
      occurredAt: 2,
    });
    pending.complete('done');
    if (admission.status === 'submitted') await admission.turn.delivery;
    await coord.drainAdmissions();
    await settleTicks();

    expect(projection.attempts).toEqual([
      'submitted',
      'activity',
      'activity',
      'settled',
    ]);
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(coord.hasUnsettledCurrent()).toBe(false);
    expect(retainedTurnCount(coord)).toBe(0);
  });

  it('logs fallback context when projection-time identity lookup throws', async () => {
    const warnings: Array<Record<string, unknown>> = [];
    let calls = 0;
    const coord = coordinator(new RecordingProjection(), {
      warnings,
      identity: () => {
        calls += 1;
        if (calls === 1) return identity();
        throw new Error('identity unavailable');
      },
    });
    const pending = controllableRuntimeSubmission();

    const admission = await coord.submitRuntimeTurn(
      async () => ({ status: 'submitted', submission: pending.submission }),
      { turnOrigin: null, prompt: 'go' },
    );

    expect(admission.status).toBe('submitted');
    expect(warnings[0]).toMatchObject({
      entry_point: 'submitted',
      turn_id: expect.any(String),
    });
    expect(warnings[0]).not.toHaveProperty('agent_name');
  });

  it('captures identity before invoking the runtime operation', () => {
    const operation = vi.fn(async (): Promise<RuntimeAdmission> => ({
      status: 'stopped',
    }));
    const coord = coordinator(new RecordingProjection(), {
      identity: () => {
        throw new Error('capture failed');
      },
    });

    expect(() => coord.submitRuntimeTurn(
      operation,
      { turnOrigin: null, prompt: 'go' },
    )).toThrow('capture failed');
    expect(operation).not.toHaveBeenCalled();
  });
});

async function settleTicks(times = 10): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}
