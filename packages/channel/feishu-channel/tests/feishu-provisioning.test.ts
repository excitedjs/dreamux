/**
 * Automatic Collaboration Space provisioning turns one unrouted Feishu topic
 * into a working Team, and nothing about the run itself is durable
 * (COVERAGE CELL F; TeamLeader failure ledger item 16: no persisted
 * provisioning row, phase, saga, outbox, recovery cursor, or restart-resume
 * scan survives; item 22: deterministic non-admission still reaches the
 * Dispatcher Agent exactly once).
 *
 * These tests drive `FeishuProvisioning` against a real `FeishuRouting` +
 * `FeishuRoutingStore` (so "nothing beyond Space policy and completed
 * bindings is persisted" is checked against the actual on-disk document, not
 * a mock) with fakes for the Core `invoke` port and the submitter.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DreamuxLogger, JsonValue, TeamSummary } from '@excitedjs/dreamux-types';

import { teamSummary } from './helpers/team-status.js';

import { FeishuProvisioning } from '../src/feishu-provisioning.js';
import { FeishuRouting } from '../src/routing/index.js';
import { FeishuRoutingStore, routingDocumentFilename } from '../src/routing/store.js';
import { topicTarget } from '../src/routing/target.js';
import type { FeishuSubmission, FeishuSubmitOutcome } from '../src/feishu-submit.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-provisioning-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const silentLog: DreamuxLogger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};

function submission(sourceId: string): FeishuSubmission {
  return {
    attrs: {},
    text: 'hello',
    reminder: '',
    sourceId,
    anchor: { chatId: 'oc_container', messageId: `m-${sourceId}`, target: topicTarget('oc_container', 'thread_1') },
  };
}

interface Harness {
  routing: FeishuRouting;
  provisioning: FeishuProvisioning;
  invokeCalls: Array<{ command: string; payload: JsonValue }>;
  submitCalls: Array<{ teamName: string; sourceId: string }>;
  announceCalls: Array<{
    teamName: string;
    leaderName: string;
    agentRuntime: string;
    runtimeCwd: string;
  }>;
  trace: string[];
  createResult: TeamSummary;
  createImpl?: (payload: JsonValue) => Promise<JsonValue>;
  submitResult: FeishuSubmitOutcome;
}

async function harness(): Promise<Harness> {
  const store = new FeishuRoutingStore({
    dispatcherId: 'disp-1',
    channelId: 'chan-1',
    stateDir: dir,
  });
  await store.load();
  const routing = new FeishuRouting({ dispatcherId: 'disp-1', channelId: 'chan-1', store });

  const state: Harness = {
    routing,
    provisioning: undefined as unknown as FeishuProvisioning,
    invokeCalls: [],
    submitCalls: [],
    announceCalls: [],
    trace: [],
    createResult: teamSummary('space-team-1'),
    submitResult: { status: 'submitted', turnId: 'turn-1' },
  };

  const provisioning = new FeishuProvisioning({
    dispatcherId: 'disp-1',
    channelId: 'chan-1',
    log: silentLog,
    routing,
    submitter: {
      submit: async (teamName, sub) => {
        state.trace.push('team.submit');
        state.submitCalls.push({ teamName, sourceId: sub.sourceId });
        return state.submitResult;
      },
    },
    invoke: async (command, payload) => {
      state.trace.push(command);
      state.invokeCalls.push({ command, payload });
      if (command === 'team.create') {
        if (state.createImpl !== undefined) return state.createImpl(payload);
        return state.createResult as unknown as JsonValue;
      }
      throw new Error(`unexpected command ${command}`);
    },
    announce: (input) => {
      state.trace.push('announce');
      state.announceCalls.push({
        teamName: input.teamName,
        leaderName: input.leaderName,
        agentRuntime: input.agentRuntime,
        runtimeCwd: input.runtimeCwd,
      });
    },
  });
  state.provisioning = provisioning;
  return state;
}

function space(overrides: Partial<Parameters<FeishuRouting['bindSpace']>[0]> = {}) {
  return {
    spaceName: 'space-a',
    containerChatId: 'oc_container',
    display: null,
    leaderAgentRuntime: 'codex',
    identity: null,
    repo: null,
    ...overrides,
  };
}

describe('FeishuProvisioning — happy-path ordering', () => {
  it('creates the Team, commits the route, announces it, and only then submits the message', async () => {
    const h = await harness();
    const spaceRecord = await h.routing.bindSpace(space());
    const target = topicTarget('oc_container', 'thread_new');
    const bind = h.routing.bind.bind(h.routing);
    vi.spyOn(h.routing, 'bind').mockImplementation(async (input) => {
      h.trace.push('bind');
      return bind(input);
    });

    const outcome = await h.provisioning.provisionForInbound({
      space: spaceRecord,
      target,
      display: null,
      submission: submission('msg-1'),
    });

    expect(outcome).toEqual({ status: 'submitted', turnId: 'turn-1' });
    expect(h.invokeCalls.map((call) => call.command)).toEqual(['team.create']);
    expect(h.routing.bindingFor(target)?.team_name).toBe('space-team-1');
    expect(h.announceCalls).toEqual([
      { teamName: 'space-team-1', leaderName: 'space-team-1-leader', agentRuntime: 'trae-gpt', runtimeCwd: '/workspace/space-team-1' },
    ]);
    expect(h.submitCalls).toEqual([{ teamName: 'space-team-1', sourceId: 'msg-1' }]);
    expect(h.trace).toEqual(['team.create', 'bind', 'announce', 'team.submit']);
  });

  it('derives request_id from the inbound message id, so distinct messages get distinct ids', async () => {
    const h = await harness();
    const spaceRecord = await h.routing.bindSpace(space());

    await h.provisioning.provisionForInbound({
      space: spaceRecord,
      target: topicTarget('oc_container', 'thread_1'),
      display: null,
      submission: submission('m1'),
    });
    h.createResult = teamSummary('space-team-2');
    await h.provisioning.provisionForInbound({
      space: spaceRecord,
      target: topicTarget('oc_container', 'thread_2'),
      display: null,
      submission: submission('m2'),
    });

    const requestIds = h.invokeCalls.filter((c) => c.command === 'team.create').map(
      (c) => (c.payload as Record<string, unknown>)['request_id'],
    );
    // Bare message ids, not a composite: a Feishu message id is already
    // globally unique, so nothing is prefixed onto it.
    expect(requestIds).toEqual(['m1', 'm2']);
  });

  it('replays one request_id when the platform redelivers the same message, so Core can answer with the first Team', async () => {
    const h = await harness();
    const spaceRecord = await h.routing.bindSpace(space());
    const target = topicTarget('oc_container', 'thread_1');

    await h.provisioning.provisionForInbound({
      space: spaceRecord,
      target,
      display: null,
      submission: submission('redelivered'),
    });
    // The same message arriving again after the binding was lost — the run
    // reaches team.create a second time and must present the same identity.
    await h.routing.unbind(target);
    h.createResult = teamSummary('space-team-1');
    await h.provisioning.provisionForInbound({
      space: spaceRecord,
      target,
      display: null,
      submission: submission('redelivered'),
    });

    const requestIds = h.invokeCalls.filter((c) => c.command === 'team.create').map(
      (c) => (c.payload as Record<string, unknown>)['request_id'],
    );
    expect(requestIds).toEqual(['redelivered', 'redelivered']);
  });

  it('recovers a half-finished provisioning: an `existing` replay still installs the binding rather than duplicating the Team', async () => {
    const h = await harness();
    const spaceRecord = await h.routing.bindSpace(space());
    const target = topicTarget('oc_container', 'thread_1');

    // The earlier attempt created the Team but died before binding, so Core
    // answers this replay with the Team it already published.
    h.createResult = teamSummary('space-team-1');
    const outcome = await h.provisioning.provisionForInbound({
      space: spaceRecord,
      target,
      display: null,
      submission: submission('redelivered'),
    });

    expect(outcome).toEqual({ status: 'submitted', turnId: 'turn-1' });
    expect(h.routing.bindingFor(target)?.team_name).toBe('space-team-1');
    expect(h.invokeCalls.filter((c) => c.command === 'team.create')).toHaveLength(1);
  });
});

describe('FeishuProvisioning — concurrency: one run per target', () => {
  it('a second inbound message to the same unrouted target waits for the first run and then delivers through the installed binding, without a second team.create', async () => {
    const h = await harness();
    const spaceRecord = await h.routing.bindSpace(space());
    const target = topicTarget('oc_container', 'thread_shared');

    let resolveCreate!: (value: JsonValue) => void;
    h.createImpl = () =>
      new Promise<JsonValue>((resolve) => {
        resolveCreate = resolve;
      });

    const first = h.provisioning.provisionForInbound({
      space: spaceRecord,
      target,
      display: null,
      submission: submission('first'),
    });
    // Give the first run a tick to register itself in the in-flight map.
    await Promise.resolve();
    const second = h.provisioning.provisionForInbound({
      space: spaceRecord,
      target,
      display: null,
      submission: submission('second'),
    });

    resolveCreate(teamSummary('shared-team') as unknown as JsonValue);

    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);
    expect(firstOutcome).toEqual({ status: 'submitted', turnId: 'turn-1' });
    expect(secondOutcome).toEqual({ status: 'submitted', turnId: 'turn-1' });
    expect(h.invokeCalls.filter((c) => c.command === 'team.create')).toHaveLength(1);
    expect(h.submitCalls.map((c) => c.sourceId).sort()).toEqual(['first', 'second']);
    expect(h.routing.bindingFor(target)?.team_name).toBe('shared-team');
  });
});

describe('FeishuProvisioning — interrupted run leaves at most an accepted orphan Team, never resumed', () => {
  it('a run that fails before team.submit answers unsubmitted, installs no binding, and a fresh process finds nothing to resume', async () => {
    const h = await harness();
    const spaceRecord = await h.routing.bindSpace(space());
    const target = topicTarget('oc_container', 'thread_fail');
    h.createImpl = async () => {
      throw new Error('platform outage before team.create returned');
    };

    const outcome = await h.provisioning.provisionForInbound({
      space: spaceRecord,
      target,
      display: null,
      submission: submission('lost'),
    });

    expect(outcome.status).toBe('unsubmitted');
    expect(h.submitCalls).toEqual([]);
    expect(h.routing.bindingFor(target)).toBeUndefined();

    // A fresh store/routing instance — standing in for a process restart —
    // sees only the Space policy, no binding and no trace of the failed run.
    const freshStore = new FeishuRoutingStore({
      dispatcherId: 'disp-1',
      channelId: 'chan-1',
      stateDir: dir,
    });
    const freshDoc = await freshStore.load();
    expect(freshDoc.bindings).toEqual([]);
    expect(freshDoc.spaces).toHaveLength(1);
  });

  it('an empty Team name from team.create is treated as no admission, not a crash', async () => {
    const h = await harness();
    const spaceRecord = await h.routing.bindSpace(space());
    h.createResult = { ...teamSummary('space-team-1'), team_name: '' };

    const outcome = await h.provisioning.provisionForInbound({
      space: spaceRecord,
      target: topicTarget('oc_container', 'thread_empty'),
      display: null,
      submission: submission('empty-name'),
    });
    expect(outcome).toEqual({ status: 'unsubmitted', message: 'team.create returned no Team name' });
    expect(h.submitCalls).toEqual([]);
  });

  it('a replayed-closed team.create answer is reported rather than retried', async () => {
    const h = await harness();
    const spaceRecord = await h.routing.bindSpace(space());
    h.createResult = teamSummary('ghost-team', 'closed');

    const outcome = await h.provisioning.provisionForInbound({
      space: spaceRecord,
      target: topicTarget('oc_container', 'thread_closed'),
      display: null,
      submission: submission('closed-replay'),
    });
    expect(outcome.status).toBe('unsubmitted');
    expect(h.submitCalls).toEqual([]);
    expect(h.routing.bindingFor(topicTarget('oc_container', 'thread_closed'))).toBeUndefined();
  });
});

describe('FeishuProvisioning — no persisted saga/outbox/cursor', () => {
  it('the on-disk routing document key set never grows beyond {version, dispatcher_id, channel_id, bindings, spaces, updated_at}', async () => {
    const h = await harness();
    const spaceRecord = await h.routing.bindSpace(space());
    await h.provisioning.provisionForInbound({
      space: spaceRecord,
      target: topicTarget('oc_container', 'thread_keys'),
      display: null,
      submission: submission('keys'),
    });

    const filename = routingDocumentFilename('chan-1');
    const onDisk = JSON.parse(readFileSync(join(dir, filename), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(onDisk).sort()).toEqual(
      ['bindings', 'channel_id', 'dispatcher_id', 'spaces', 'updated_at', 'version'].sort(),
    );
    // And no binding row carries any provisioning-progress field beyond the
    // final product shape.
    const binding = (onDisk['bindings'] as Array<Record<string, unknown>>)[0];
    expect(Object.keys(binding).sort()).toEqual(
      ['created_at', 'display', 'origin', 'space_id', 'target', 'team_name', 'updated_at'].sort(),
    );
  });
});

describe('FeishuProvisioning — creation-time reply address', () => {
  function createdIdentity(h: Harness): string | undefined {
    const create = h.invokeCalls.find((call) => call.command === 'team.create');
    const leader = (create?.payload as Record<string, unknown> | undefined)?.[
      'leader'
    ] as Record<string, unknown> | undefined;
    const identity = leader?.['identity'];
    return typeof identity === 'string' ? identity : undefined;
  }

  it('gives a Team with no configured identity the bound address and the message that triggered it', async () => {
    const h = await harness();
    const spaceRecord = await h.routing.bindSpace(space());

    await h.provisioning.provisionForInbound({
      space: spaceRecord,
      target: topicTarget('oc_container', 'thread_new'),
      display: null,
      submission: submission('msg-1'),
    });

    const identity = createdIdentity(h);
    expect(identity).toContain('chat_id: oc_container');
    // The message that triggered creation, not the dedup source id and not a
    // later announcement.
    expect(identity).toContain('message_id: m-msg-1');
    expect(identity).toContain('Never omit message_id.');
  });

  it('addresses the bound chat the target names, not the anchor that was captured', async () => {
    const h = await harness();
    const spaceRecord = await h.routing.bindSpace(
      space({ containerChatId: 'oc_bound' }),
    );

    await h.provisioning.provisionForInbound({
      space: spaceRecord,
      target: topicTarget('oc_bound', 'thread_new'),
      display: null,
      submission: submission('msg-1'),
    });

    expect(createdIdentity(h)).toContain('chat_id: oc_bound');
  });

  it('preserves a configured identity in full and appends the guidance after it', async () => {
    const h = await harness();
    const configured = 'You are the release captain.\nSpeak plainly.';
    const spaceRecord = await h.routing.bindSpace(space({ identity: configured }));

    await h.provisioning.provisionForInbound({
      space: spaceRecord,
      target: topicTarget('oc_container', 'thread_new'),
      display: null,
      submission: submission('msg-1'),
    });

    const identity = createdIdentity(h) ?? '';
    expect(identity.startsWith(`${configured}\n\n`)).toBe(true);
    expect(identity).toContain('message_id: m-msg-1');
    // The Space policy itself is untouched; only the created Team carries the
    // appended guidance.
    expect(h.routing.spaceByName('space-a')?.identity).toBe(configured);
  });

  it('gives each topic the message that triggered its own Team', async () => {
    const h = await harness();
    const spaceRecord = await h.routing.bindSpace(space());

    await h.provisioning.provisionForInbound({
      space: spaceRecord,
      target: topicTarget('oc_container', 'thread_1'),
      display: null,
      submission: submission('m1'),
    });
    h.createResult = teamSummary('space-team-2');
    await h.provisioning.provisionForInbound({
      space: spaceRecord,
      target: topicTarget('oc_container', 'thread_2'),
      display: null,
      submission: submission('m2'),
    });

    const identities = h.invokeCalls
      .filter((call) => call.command === 'team.create')
      .map((call) => {
        const leader = (call.payload as Record<string, unknown>)['leader'] as
          Record<string, unknown>;
        return String(leader['identity']);
      });
    expect(identities[0]).toContain('message_id: m-m1');
    expect(identities[1]).toContain('message_id: m-m2');
  });

  it('keeps the first arrival as the initial message when a second lands mid-run', async () => {
    const h = await harness();
    const spaceRecord = await h.routing.bindSpace(space());
    const target = topicTarget('oc_container', 'thread_shared');

    let resolveCreate!: (value: JsonValue) => void;
    h.createImpl = () =>
      new Promise<JsonValue>((resolve) => {
        resolveCreate = resolve;
      });

    const first = h.provisioning.provisionForInbound({
      space: spaceRecord,
      target,
      display: null,
      submission: submission('first'),
    });
    await Promise.resolve();
    const second = h.provisioning.provisionForInbound({
      space: spaceRecord,
      target,
      display: null,
      submission: submission('second'),
    });
    resolveCreate(teamSummary('shared-team') as unknown as JsonValue);
    await Promise.all([first, second]);

    expect(createdIdentity(h)).toContain('message_id: m-first');
    expect(createdIdentity(h)).not.toContain('m-second');
  });

  it('replays one redelivered message to the same creation payload', async () => {
    const h = await harness();
    const spaceRecord = await h.routing.bindSpace(space());
    const payloads: JsonValue[] = [];
    h.createImpl = async (payload) => {
      payloads.push(structuredClone(payload));
      return h.createResult as unknown as JsonValue;
    };

    await h.provisioning.provisionForInbound({
      space: spaceRecord,
      target: topicTarget('oc_container', 'thread_1'),
      display: null,
      submission: submission('msg-1'),
    });
    await h.routing.unbind(topicTarget('oc_container', 'thread_1'));
    await h.provisioning.provisionForInbound({
      space: spaceRecord,
      target: topicTarget('oc_container', 'thread_1'),
      display: null,
      submission: submission('msg-1'),
    });

    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toEqual(payloads[1]);
  });
});
