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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DreamuxLogger, JsonValue } from '@excitedjs/dreamux-types';

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
  announceCalls: Array<{ teamName: string; spaceName: string }>;
  createResult: { status: 'created' | 'existing' | 'closed'; team_name: string; leader_name: string };
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
    createResult: { status: 'created', team_name: 'space-team-1', leader_name: 'leader-1' },
    submitResult: { status: 'submitted', turnId: 'turn-1' },
  };

  const provisioning = new FeishuProvisioning({
    dispatcherId: 'disp-1',
    channelId: 'chan-1',
    log: silentLog,
    routing,
    submitter: {
      submit: async (teamName, sub) => {
        state.submitCalls.push({ teamName, sourceId: sub.sourceId });
        return state.submitResult;
      },
    },
    invoke: async (command, payload) => {
      state.invokeCalls.push({ command, payload });
      if (command === 'team.create') {
        if (state.createImpl !== undefined) return state.createImpl(payload);
        return state.createResult as unknown as JsonValue;
      }
      throw new Error(`unexpected command ${command}`);
    },
    announce: (input) => {
      state.announceCalls.push({ teamName: input.teamName, spaceName: input.spaceName });
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

    const outcome = await h.provisioning.provisionForInbound({
      space: spaceRecord,
      target,
      display: null,
      submission: submission('msg-1'),
    });

    expect(outcome).toEqual({ status: 'submitted', turnId: 'turn-1' });
    expect(h.invokeCalls).toHaveLength(1);
    expect(h.invokeCalls[0]?.command).toBe('team.create');
    expect(h.routing.bindingFor(target)?.team_name).toBe('space-team-1');
    expect(h.announceCalls).toEqual([
      { teamName: 'space-team-1', spaceName: 'space-a' },
    ]);
    expect(h.submitCalls).toEqual([{ teamName: 'space-team-1', sourceId: 'msg-1' }]);
  });

  it('generates a fresh request_id per attempt rather than a stable, replayable ledger id', async () => {
    const h = await harness();
    const spaceRecord = await h.routing.bindSpace(space());

    await h.provisioning.provisionForInbound({
      space: spaceRecord,
      target: topicTarget('oc_container', 'thread_1'),
      display: null,
      submission: submission('m1'),
    });
    h.createResult = { status: 'created', team_name: 'space-team-2', leader_name: 'leader-2' };
    await h.provisioning.provisionForInbound({
      space: spaceRecord,
      target: topicTarget('oc_container', 'thread_2'),
      display: null,
      submission: submission('m2'),
    });

    const requestIds = h.invokeCalls.map(
      (c) => (c.payload as Record<string, unknown>)['request_id'],
    );
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).not.toBe(requestIds[1]);
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

    resolveCreate({ status: 'created', team_name: 'shared-team', leader_name: 'leader-x' } as unknown as JsonValue);

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
    h.createResult = { status: 'created', team_name: '', leader_name: '' };

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
    h.createResult = { status: 'closed', team_name: 'ghost-team', leader_name: 'x' };

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
