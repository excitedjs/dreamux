/**
 * Collaboration Space policy snapshot semantics (COVERAGE CELL F; TeamLeader
 * failure ledger item 17): policy revisions never cancel admitted work. A Team creation accepted before a policy update keeps
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DreamuxLogger, JsonValue } from '@excitedjs/dreamux-types';

import { teamSummary } from './helpers/team-status.js';

import { FeishuProvisioning } from '../src/feishu-provisioning.js';
import { FeishuRouting } from '../src/routing/index.js';
import { FeishuCoreCommands } from '../src/feishu-core-commands.js';
import { FeishuTeamSubmitter } from '../src/session/submitter.js';
import { FeishuCotAdapter } from '../src/cot/adapter.js';
import { createFeishuLifecycle } from '../src/session/lifecycle.js';
import { topicTarget } from '../src/routing/target.js';
import type {
  FeishuChatSubmission,
  FeishuSubmitOutcome,
} from '../src/feishu-submit.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-space-policy-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const silentLog: DreamuxLogger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  child: () => silentLog,
};

async function makeRouting(): Promise<FeishuRouting> {
  const routing = new FeishuRouting({
    dispatcherId: 'disp-1',
    channelId: 'chan-1',
    stateDir: dir,
  });
  await routing.initialize();
  return routing;
}
function fixtureProvisioning(opts: {
  dispatcherId: string;
  channelId: string;
  log: DreamuxLogger;
  routing: FeishuRouting;
  submitter: { submit(): Promise<FeishuSubmitOutcome> };
  invoke(command: string, payload: JsonValue): Promise<JsonValue>;
  announce(): void;
}): FeishuProvisioning {
  const commands = new FeishuCoreCommands();
  commands.initialize({ invoke: opts.invoke });
  const lifecycle = createFeishuLifecycle();
  const cot = new FeishuCotAdapter({
    dispatcherId: opts.dispatcherId,
    channelId: opts.channelId,
    log: opts.log,
    lifecycle,
    cotClient: undefined,
  });
  const submitter = new FeishuTeamSubmitter({ lifecycle, cot, commands });
  vi.spyOn(submitter, 'submit').mockImplementation(() =>
    opts.submitter.submit(),
  );
  return new FeishuProvisioning({
    dispatcherId: opts.dispatcherId,
    channelId: opts.channelId,
    log: opts.log,
    routing: opts.routing,
    commands,
    submitter,
    bindings: { presentCommittedBind: opts.announce },
  });
}

function submission(sourceId: string): FeishuChatSubmission {
  return {
    kind: 'chat',
    attrs: {},
    text: 'hi',
    reminder: '',
    sourceId,
    anchor: {
      chatId: 'oc_c',
      messageId: `m-${sourceId}`,
      target: topicTarget('oc_c', 't'),
    },
  };
}

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
    const provisioning = fixtureProvisioning({
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

    resolveCreate(teamSummary('old-snapshot-team') as unknown as JsonValue);
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
    const provisioning = fixtureProvisioning({
      dispatcherId: 'disp-1',
      channelId: 'chan-1',
      log: silentLog,
      routing,
      submitter: {
        submit: async (): Promise<FeishuSubmitOutcome> => ({
          status: 'submitted',
          turnId: 't2',
        }),
      },
      invoke: async (_command, payload) => {
        invokeCalls.push(payload);
        return teamSummary('new-snapshot-team') as unknown as JsonValue;
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
    const provisioning = fixtureProvisioning({
      dispatcherId: 'disp-1',
      channelId: 'chan-1',
      log: silentLog,
      routing,
      submitter: {
        submit: async (): Promise<FeishuSubmitOutcome> => ({
          status: 'submitted',
          turnId: 't3',
        }),
      },
      invoke: async () => {
        return new Promise<JsonValue>((resolve) => {
          resolveCreate = resolve;
        });
      },
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
    resolveCreate(teamSummary('surviving-team') as unknown as JsonValue);
    const outcome = await run;
    expect(outcome).toEqual({ status: 'submitted', turnId: 't3' });
    expect(
      routing.bindingFor(topicTarget('oc_c', 'thread-surviving'))?.team_name,
    ).toBe('surviving-team');

    // And the next inbound message to the same container no longer provisions.
    const plan = routing.plan(
      topicTarget('oc_c', 'thread-after-unbind'),
      'oc_c',
    );
    expect(plan.kind).toBe('dispatcher');
  });
});
