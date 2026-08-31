/**
 * Collaboration Space policy snapshot semantics (COVERAGE CELL F; TeamLeader
 * failure ledger item 17): `generation` names a policy revision, not a
 * cancellation token. A Team creation accepted before a policy update keeps
 * running under the snapshot it captured; a creation accepted after uses the
 * new snapshot; existing Teams are never rewritten; `unbind_collaboration_space`
 * stops only *future* provisioning and cancels nothing already accepted.
 *
 * The plan-time snapshot (`FeishuRoutingPlan.kind === 'provision'`) is what
 * `FeishuProvisioning` actually runs against, so these tests prove the
 * snapshot is captured at plan time and stays that exact object thereafter —
 * never re-read from the store mid-run.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DreamuxLogger, JsonValue } from '@excitedjs/dreamux-types';

import { FeishuProvisioning } from '../src/feishu-provisioning.js';
import { FeishuRouting } from '../src/routing/index.js';
import { FeishuRoutingStore } from '../src/routing/store.js';
import { topicTarget } from '../src/routing/target.js';
import type { FeishuSubmission, FeishuSubmitOutcome } from '../src/feishu-submit.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-space-policy-'));
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

async function makeRouting(): Promise<FeishuRouting> {
  const store = new FeishuRoutingStore({
    dispatcherId: 'disp-1',
    channelId: 'chan-1',
    stateDir: dir,
  });
  await store.load();
  return new FeishuRouting({ dispatcherId: 'disp-1', channelId: 'chan-1', store });
}

function submission(sourceId: string): FeishuSubmission {
  return {
    attrs: {},
    text: 'hi',
    reminder: '',
    sourceId,
    anchor: { chatId: 'oc_c', messageId: `m-${sourceId}`, target: topicTarget('oc_c', 't') },
  };
}

describe('bindSpace — generation advances only on creation-fact changes', () => {
  it('a display-only rename does not advance the generation', async () => {
    const routing = await makeRouting();
    const created = await routing.bindSpace({
      spaceName: 'space-a',
      containerChatId: 'oc_c',
      display: null,
      leaderAgentRuntime: 'codex',
      identity: null,
      repo: null,
    });
    expect(created.generation).toBe(1);

    const renamed = await routing.bindSpace({
      spaceName: 'space-a',
      containerChatId: 'oc_c',
      display: 'New display',
      leaderAgentRuntime: 'codex',
      identity: null,
      repo: null,
    });
    expect(renamed.generation).toBe(1);
  });

  it('changing the leader_agent_runtime advances the generation', async () => {
    const routing = await makeRouting();
    await routing.bindSpace({
      spaceName: 'space-a',
      containerChatId: 'oc_c',
      display: null,
      leaderAgentRuntime: 'codex',
      identity: null,
      repo: null,
    });
    const rebound = await routing.bindSpace({
      spaceName: 'space-a',
      containerChatId: 'oc_c',
      display: null,
      leaderAgentRuntime: 'claude-code',
      identity: null,
      repo: null,
    });
    expect(rebound.generation).toBe(2);
  });
});

describe('Provisioning snapshot immutability', () => {
  it('a run holding the old snapshot keeps its captured leader_agent_runtime even after the policy is rebound mid-run', async () => {
    const routing = await makeRouting();
    const original = await routing.bindSpace({
      spaceName: 'space-a',
      containerChatId: 'oc_c',
      display: null,
      leaderAgentRuntime: 'codex',
      identity: null,
      repo: null,
    });

    const invokeCalls: JsonValue[] = [];
    let resolveCreate!: (v: JsonValue) => void;
    const provisioning = new FeishuProvisioning({
      dispatcherId: 'disp-1',
      channelId: 'chan-1',
      log: silentLog,
      routing,
      submitter: {
        submit: async (): Promise<FeishuSubmitOutcome> => ({
          status: 'submitted',
          turnId: 't1',
        }),
      },
      invoke: async (command, payload) => {
        if (command !== 'team.create') throw new Error(`unexpected ${command}`);
        invokeCalls.push(payload);
        return new Promise<JsonValue>((resolve) => {
          resolveCreate = resolve;
        });
      },
      announce: () => undefined,
    });

    const run = provisioning.provisionForInbound({
      space: original, // the plan-time snapshot, captured before the rebind below
      target: topicTarget('oc_c', 'thread-in-flight'),
      display: null,
      submission: submission('in-flight'),
    });
    await Promise.resolve();

    // The policy is rebound *while the run above is still in flight*.
    await routing.bindSpace({
      spaceName: 'space-a',
      containerChatId: 'oc_c',
      display: null,
      leaderAgentRuntime: 'claude-code',
      identity: null,
      repo: null,
    });

    resolveCreate({ status: 'created', team_name: 'old-snapshot-team', leader_name: 'l1' } as unknown as JsonValue);
    await run;

    const createPayload = invokeCalls[0] as Record<string, unknown>;
    const leader = createPayload['leader'] as Record<string, unknown>;
    expect(leader['agent_runtime']).toBe('codex');
  });

  it('a run started after the rebind uses the new snapshot', async () => {
    const routing = await makeRouting();
    await routing.bindSpace({
      spaceName: 'space-a',
      containerChatId: 'oc_c',
      display: null,
      leaderAgentRuntime: 'codex',
      identity: null,
      repo: null,
    });
    const rebound = await routing.bindSpace({
      spaceName: 'space-a',
      containerChatId: 'oc_c',
      display: null,
      leaderAgentRuntime: 'claude-code',
      identity: null,
      repo: null,
    });

    const invokeCalls: JsonValue[] = [];
    const provisioning = new FeishuProvisioning({
      dispatcherId: 'disp-1',
      channelId: 'chan-1',
      log: silentLog,
      routing,
      submitter: {
        submit: async (): Promise<FeishuSubmitOutcome> => ({ status: 'submitted', turnId: 't2' }),
      },
      invoke: async (command, payload) => {
        invokeCalls.push(payload);
        return { status: 'created', team_name: 'new-snapshot-team', leader_name: 'l2' } as unknown as JsonValue;
      },
      announce: () => undefined,
    });

    // `plan()` is what actually hands the current record to a fresh run; the
    // routing service's own read confirms which snapshot a *new* plan sees.
    const planned = routing.plan(topicTarget('oc_c', 'thread-new'), 'oc_c');
    expect(planned.kind).toBe('provision');
    if (planned.kind !== 'provision') throw new Error('unreachable');
    expect(planned.space.leader_agent_runtime).toBe('claude-code');
    expect(planned.space).toBe(rebound);

    await provisioning.provisionForInbound({
      space: planned.space,
      target: topicTarget('oc_c', 'thread-new'),
      display: null,
      submission: submission('after-rebind'),
    });
    const createPayload = invokeCalls[0] as Record<string, unknown>;
    const leader = createPayload['leader'] as Record<string, unknown>;
    expect(leader['agent_runtime']).toBe('claude-code');
  });
});

describe('unbindSpace — stops future provisioning only', () => {
  it('does not cancel a provisioning run already holding its captured snapshot', async () => {
    const routing = await makeRouting();
    const original = await routing.bindSpace({
      spaceName: 'space-a',
      containerChatId: 'oc_c',
      display: null,
      leaderAgentRuntime: 'codex',
      identity: null,
      repo: null,
    });

    let resolveCreate!: (v: JsonValue) => void;
    const provisioning = new FeishuProvisioning({
      dispatcherId: 'disp-1',
      channelId: 'chan-1',
      log: silentLog,
      routing,
      submitter: {
        submit: async (): Promise<FeishuSubmitOutcome> => ({ status: 'submitted', turnId: 't3' }),
      },
      invoke: async () =>
        new Promise<JsonValue>((resolve) => {
          resolveCreate = resolve;
        }),
      announce: () => undefined,
    });

    const run = provisioning.provisionForInbound({
      space: original,
      target: topicTarget('oc_c', 'thread-surviving'),
      display: null,
      submission: submission('surviving'),
    });
    await Promise.resolve();

    const removed = await routing.unbindSpace('space-a');
    expect(removed?.space_name).toBe('space-a');
    // No new provisioning will start (no policy left to provision under), but
    // the in-flight run is untouched and still completes.
    resolveCreate({ status: 'created', team_name: 'surviving-team', leader_name: 'l3' } as unknown as JsonValue);
    const outcome = await run;
    expect(outcome).toEqual({ status: 'submitted', turnId: 't3' });
    expect(routing.bindingFor(topicTarget('oc_c', 'thread-surviving'))?.team_name).toBe(
      'surviving-team',
    );

    // And the next inbound message to the same container no longer provisions.
    const plan = routing.plan(topicTarget('oc_c', 'thread-after-unbind'), 'oc_c');
    expect(plan.kind).toBe('dispatcher');
  });
});
