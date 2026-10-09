import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  workflowRunDir,
  workflowRunJournalPath,
  workflowRunRecordPath,
} from '../src/platform/paths.js';
import { WorkflowService } from '../src/service/workflow-service/index.js';
import {
  WorkflowRun,
  WORKFLOW_AGENT_SYSTEM_PROMPT,
} from '../src/service/workflow-service/run.js';
import type { WorkflowRunRecord } from '../src/service/workflow-service/types.js';
import type { WorkflowRunnerHandlers } from '../src/service/workflow-service/runner-process.js';
import type { WorkflowRunnerParentMessage } from '../src/service/workflow-service/protocol.js';
import { CompletionDeliveryPolicy } from '../src/service/completion-router/index.js';
import { AgentService } from '../src/service/agent/service.js';
import { TeammateCollection } from '../src/service/agent/index.js';
import { deferred } from './helpers/controlled-runtime-provider.js';
import { AgentNameRegistry } from '../src/service/agent/store.js';
import { AgentServiceFactory } from '../src/service/agent/factory.js';
import { dispatcherFixture, teamRequest } from './helpers/real-dispatcher.js';
interface RunnerProbe {
  started: boolean;
  stopped: boolean;
  sent: WorkflowRunnerParentMessage[];
  beforeStop: (() => Promise<void>) | null;
  emit(message: unknown): void;
}
const controls = vi.hoisted(() => ({
  runners: [] as RunnerProbe[],
  ids: [] as string[],
}));
vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:crypto')>();
  return {
    ...real,
    randomUUID: () => controls.ids.shift() ?? real.randomUUID(),
  };
});
vi.mock('../src/service/workflow-service/runner-process.js', () => ({
  ForkedWorkflowRunner: class implements RunnerProbe {
    started = false;
    stopped = false;
    sent: WorkflowRunnerParentMessage[] = [];
    beforeStop: (() => Promise<void>) | null = null;
    constructor(
      _entry: string,
      private readonly handlers: WorkflowRunnerHandlers,
    ) {
      controls.runners.push(this);
    }
    async start() {
      this.started = true;
    }
    async send(message: WorkflowRunnerParentMessage) {
      this.sent.push(message);
    }
    async stop() {
      await this.beforeStop?.();
      this.stopped = true;
    }
    emit(message: unknown) {
      this.handlers.onMessage(message);
    }
  },
}));
afterEach(() => {
  controls.runners.length = 0;
  controls.ids.length = 0;
  vi.restoreAllMocks();
});
const scope = { dispatcherId: 'test', teamId: null };
const paths = (runId: string) => ({
  record: workflowRunRecordPath({ ...scope, runId }),
  journal: workflowRunJournalPath({ ...scope, runId }),
});
async function json(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}
async function journal(path: string, rows: unknown[]) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    rows.map((row) => JSON.stringify(row)).join('\n') + '\n',
  );
}
function baseRecord(
  overrides: Partial<WorkflowRunRecord> = {},
): WorkflowRunRecord {
  return {
    version: 1,
    run_id: 'run-a',
    dispatcher_id: 'test',
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
    ...overrides,
  };
}
const header = {
  kind: 'run',
  version: 1,
  run_id: 'run-a',
  script_hash: 'hash',
  caller: { kind: 'dispatcher' },
  dispatcher_id: 'test',
  team_id: null,
  created_at: 1,
};
async function workflowFixture(activate = true) {
  const f = await dispatcherFixture();
  const workflows = f.host.workflows;
  if (!(workflows instanceof WorkflowService))
    throw new Error('expected real WorkflowService');
  if (activate) {
    await f.host.start();
    const ready = await f.host.submitToAgent({
      source: 'channel',
      text: 'fixture-ready',
    });
    if (ready.status !== 'submitted')
      throw new Error('fixture runtime not admitted');
    f.provider.runtimes[0]!.submissions[0]!.complete(null);
    await ready.turn.settled;
  }
  return { ...f, workflows };
}
type Fixture = Awaited<ReturnType<typeof workflowFixture>>;
const notices = (f: Fixture) =>
  f.provider.runtimes.flatMap((runtime) =>
    runtime.inputs.filter((text) => text.startsWith('<task-notification>')),
  );
async function terminal(f: Fixture, id: string, status: string) {
  await vi.waitFor(async () =>
    expect(await f.workflows.status({ run_id: id })).toMatchObject({ status }),
  );
}
async function terminalRows(id: string) {
  return (await readFile(paths(id).journal, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { kind: string; status: string })
    .filter((row) => row.kind === 'end');
}
function holdStop(f: Fixture, runner: RunnerProbe) {
  const entered = deferred<void>(),
    release = deferred<void>();
  f.releases.push(() => release.resolve());
  runner.beforeStop = async () => {
    entered.resolve();
    await release.promise;
  };
  return { entered, release };
}
function captureAgents() {
  const held: AgentService[] = [];
  const original = AgentService.prototype.lock;
  vi.spyOn(AgentService.prototype, 'lock').mockImplementation(function (
    this: AgentService,
  ) {
    held.push(this);
    return original.call(this);
  });
  return held;
}
it('converges a running record with no committed terminal journal to stopped, backfilling the journal, without creating a runner', async () => {
  const f = await workflowFixture(false);
  await json(
    paths('run-a').record,
    baseRecord({
      agents: [
        {
          index: 0,
          name: 'agent-1',
          label: null,
          phase: null,
          status: 'running',
          result: null,
          error: null,
          created_at: 1,
          settled_at: null,
        },
      ],
    }),
  );
  await journal(paths('run-a').journal, [header]);
  const before = Date.now();
  await f.host.start();
  const recovered = await f.workflows.status({ run_id: 'run-a' });
  expect(recovered).toMatchObject({
    status: 'stopped',
    error: expect.stringContaining(
      'Dreamux stopped before the workflow reached a terminal result',
    ),
  });
  expect(recovered.ended_at).toBeGreaterThanOrEqual(before);
  expect(recovered.ended_at).toBeLessThanOrEqual(Date.now());
  expect(recovered.agents[0]).toMatchObject({
    status: 'stopped',
    settled_at: recovered.ended_at,
  });
  expect(
    JSON.parse(await readFile(paths('run-a').record, 'utf8')),
  ).toMatchObject({ status: 'stopped' });
  const rows = (await readFile(paths('run-a').journal, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(rows.filter((row) => row.kind === 'result')).toEqual([
    expect.objectContaining({ index: 0, status: 'stopped' }),
  ]);
  expect(rows.filter((row) => row.kind === 'end')).toEqual([
    expect.objectContaining({ status: 'stopped' }),
  ]);
  expect(controls.runners).toHaveLength(0);
  expect(f.provider.runtimes).toHaveLength(0);
});
it('converges a running record whose journal already committed a terminal event, without creating a runner', async () => {
  const f = await workflowFixture(false);
  await json(
    paths('run-a').record,
    baseRecord({
      agents: [
        {
          index: 0,
          name: 'agent-1',
          label: null,
          phase: null,
          status: 'completed',
          result: { answer: 42 },
          error: null,
          created_at: 1,
          settled_at: 2,
        },
      ],
    }),
  );
  await journal(paths('run-a').journal, [
    header,
    {
      kind: 'result',
      index: 0,
      status: 'completed',
      result: { answer: 42 },
      error: null,
      settled_at: 2,
    },
    {
      kind: 'end',
      status: 'completed',
      result: { answer: 42 },
      error: null,
      ended_at: 3,
    },
  ]);
  await f.host.start();
  expect(await f.workflows.status({ run_id: 'run-a' })).toMatchObject({
    status: 'completed',
    result: { answer: 42 },
    ended_at: 3,
    updated_at: 3,
  });
  expect(
    JSON.parse(await readFile(paths('run-a').record, 'utf8')),
  ).toMatchObject({ status: 'completed', ended_at: 3 });
  expect(
    (await f.workflows.status({ run_id: 'run-a' })).agents[0],
  ).toMatchObject({
    status: 'completed',
    result: { answer: 42 },
    settled_at: 2,
  });
  expect(await terminalRows('run-a')).toHaveLength(1);
  expect(controls.runners).toHaveLength(0);
  expect(f.provider.runtimes).toHaveLength(0);
});
it('needs no synthesis for an empty scope: start() succeeds and list() is empty, without creating a runner', async () => {
  const f = await workflowFixture(false);
  await f.host.start();
  expect(await f.workflows.list()).toEqual({ runs: [] });
  expect(controls.runners).toHaveLength(0);
  expect(f.provider.runtimes).toHaveLength(0);
});
it('ignores a runner message that arrives after the run is already durably terminal', async () => {
  const f = await workflowFixture();
  const { run_id } = await f.workflows.run({ script: 'noop' });
  expect(await f.workflows.stop({ run_id })).toEqual({
    run_id,
    status: 'stopped',
  });
  controls.runners[0]!.emit({
    type: 'run_result',
    status: 'completed',
    result: { late: true },
  });
  expect(await f.workflows.status({ run_id })).toMatchObject({
    status: 'stopped',
    result: null,
  });
  expect(await terminalRows(run_id)).toEqual([
    expect.objectContaining({ status: 'stopped' }),
  ]);
  expect(notices(f)).toEqual([]);
});
it('a stale run instance settling late cannot evict a newer live replacement of the same id', async () => {
  const f = await workflowFixture();
  const runs: WorkflowRun[] = [];
  const initialize = WorkflowRun.prototype.initialize;
  vi.spyOn(WorkflowRun.prototype, 'initialize').mockImplementation(
    async function (this: WorkflowRun) {
      runs.push(this);
      await initialize.call(this);
    },
  );
  const entered = deferred<void>(),
    release = deferred<void>();
  f.releases.push(() => release.resolve());
  const prepare = AgentService.prototype.prepareCompletion;
  vi.spyOn(AgentService.prototype, 'prepareCompletion').mockImplementationOnce(
    async function (this: AgentService, fact) {
      entered.resolve();
      await release.promise;
      return prepare.call(this, fact);
    },
  );
  const uuid = '00000000-0000-4000-8000-000000000001';
  controls.ids.push(uuid);
  const first = await f.workflows.run({ script: 'noop' });
  controls.runners[0]!.emit({
    type: 'run_result',
    status: 'completed',
    result: null,
  });
  await entered.promise;
  await rm(workflowRunDir({ ...scope, runId: first.run_id }), {
    recursive: true,
    force: true,
  });
  controls.ids.push(uuid);
  const second = await f.workflows.run({ script: 'noop' });
  expect(second.run_id).toBe(first.run_id);
  await rm(paths(second.run_id).record);
  release.resolve();
  await runs[0]!.settled;
  expect(await f.workflows.status(second)).toMatchObject({ status: 'running' });
  await f.workflows.stop(second);
});
it('stop() converges already-accepted work: it waits for a submitted turn to settle before finalizing', async () => {
  const f = await workflowFixture();
  const release = deferred<void>();
  f.releases.push(() => release.resolve());
  f.provider.planNext({ stopBarrier: release.promise });
  const accepted = await f.workflows.run({ script: 'noop' });
  controls.runners[0]!.emit({
    type: 'agent_start',
    index: 0,
    prompt: 'work',
    options: {},
  });
  await vi.waitFor(() =>
    expect(f.provider.runtimes[1]?.submissions).toHaveLength(1),
  );
  const runtime = f.provider.runtimes[1]!;
  const stopping = f.workflows.stop(accepted);
  await runtime.stopStarted.promise;
  expect(runtime.submissions[0]!.isSettled()).toBe(false);
  expect(await f.workflows.status(accepted)).toMatchObject({
    status: 'running',
  });
  release.resolve();
  expect(await stopping).toEqual({ ...accepted, status: 'stopped' });
  expect(runtime.submissions[0]!.isSettled()).toBe(true);
  expect((await f.workflows.status(accepted)).agents[0]).toMatchObject({
    status: 'stopped',
  });
  expect(notices(f)).toEqual([]);
});
it('a failed run delivers its failure through the null-completion-token entry point', async () => {
  const f = await workflowFixture();
  const delivery = vi.spyOn(
    CompletionDeliveryPolicy.prototype,
    'deliverRuntime',
  );
  const accepted = await f.workflows.run({ script: 'noop' });
  controls.runners[0]!.emit({
    type: 'run_result',
    status: 'failed',
    error: 'boom',
  });
  await vi.waitFor(() => expect(notices(f)).toHaveLength(1));
  expect(notices(f)[0]).toContain('boom');
  const calls = delivery.mock.calls.filter(
    (call) => call[2].kind === 'workflow',
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]![1]).toBeNull();
  expect(calls[0]![2]).toMatchObject({ kind: 'workflow', status: 'failed' });
  await terminal(f, accepted.run_id, 'failed');
});
it('keeps completed delivery when its intent wins before explicit stop', async () => {
  const f = await workflowFixture();
  const accepted = await f.workflows.run({ script: 'noop' });
  const held = holdStop(f, controls.runners[0]!);
  controls.runners[0]!.emit({
    type: 'run_result',
    status: 'completed',
    result: { answer: 42 },
  });
  await held.entered.promise;
  const stopping = f.workflows.stop(accepted);
  held.release.resolve();
  expect(await stopping).toEqual({ ...accepted, status: 'completed' });
  expect(notices(f)).toHaveLength(1);
  expect(notices(f)[0]).toContain('42');
  expect(await terminalRows(accepted.run_id)).toEqual([
    expect.objectContaining({ status: 'completed' }),
  ]);
});
it('keeps failed delivery when its intent wins before stopAll', async () => {
  const f = await workflowFixture();
  const accepted = await f.workflows.run({ script: 'noop' });
  const held = holdStop(f, controls.runners[0]!);
  controls.runners[0]!.emit({
    type: 'run_result',
    status: 'failed',
    error: 'natural failure',
  });
  await held.entered.promise;
  const stopping = f.workflows.stopAll();
  held.release.resolve();
  await stopping;
  expect(await f.workflows.status(accepted)).toMatchObject({
    status: 'failed',
    error: 'natural failure',
  });
  expect(notices(f)).toHaveLength(1);
  expect(notices(f)[0]).toContain('natural failure');
});
it('does not retract terminal delivery that already started before stop', async () => {
  const f = await workflowFixture();
  const entered = deferred<void>(),
    release = deferred<void>();
  f.releases.push(() => release.resolve());
  const prepare = AgentService.prototype.prepareCompletion;
  const preparing = vi
    .spyOn(AgentService.prototype, 'prepareCompletion')
    .mockImplementationOnce(async function (this: AgentService, fact) {
      entered.resolve();
      await release.promise;
      return prepare.call(this, fact);
    });
  const accepted = await f.workflows.run({ script: 'noop' });
  controls.runners[0]!.emit({
    type: 'run_result',
    status: 'completed',
    result: 'done',
  });
  await entered.promise;
  const stopping = f.workflows.stop(accepted);
  expect(preparing).toHaveBeenCalledTimes(1);
  release.resolve();
  expect(await stopping).toEqual({ ...accepted, status: 'completed' });
  expect(preparing).toHaveBeenCalledTimes(1);
  expect(notices(f)).toHaveLength(1);
});
it('reaches only createLocked on the teammates dependency and holds the lock until terminal cleanup releases it', async () => {
  const f = await workflowFixture();
  const held = captureAgents();
  const locked = vi.spyOn(TeammateCollection.prototype, 'createLocked');
  const spawn = vi.spyOn(TeammateCollection.prototype, 'spawn');
  const send = vi.spyOn(TeammateCollection.prototype, 'send');
  const accepted = await f.workflows.run({ script: 'noop' });
  controls.runners[0]!.emit({
    type: 'agent_start',
    index: 0,
    prompt: 'do it',
    options: { schema: { type: 'object' } },
  });
  await vi.waitFor(() =>
    expect(f.provider.runtimes[1]?.submissions).toHaveLength(1),
  );
  expect(held).toHaveLength(1);
  const agent = held[0]!;
  await expect(
    agent.close({ note: 'unauthorized ordinary close' }),
  ).rejects.toThrow(/is locked/);
  expect(locked).toHaveBeenCalledTimes(1);
  expect(locked.mock.calls[0]![1]).toMatchObject({
    systemPromptAppend: [WORKFLOW_AGENT_SYSTEM_PROMPT],
    outputSchema: { type: 'object' },
  });
  expect(spawn).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  expect(f.provider.runtimes[1]!.inputs).toEqual(['<task>do it</task>']);
  f.provider.runtimes[1]!.submissions[0]!.complete('{"ok":true}');
  await vi.waitFor(() =>
    expect(controls.runners[0]!.sent).toContainEqual({
      type: 'agent_result',
      index: 0,
      result: { ok: true },
    }),
  );
  await expect(
    agent.close({ note: 'still owned before terminal' }),
  ).rejects.toThrow(/is locked/);
  controls.runners[0]!.emit({
    type: 'run_result',
    status: 'completed',
    result: null,
  });
  await agent.closed;
  expect(agent.isRetired()).toBe(true);
  expect(agent.current()).toMatchObject({
    status: 'closed',
    close_note: `Workflow ${accepted.run_id} completed`,
  });
  await vi.waitFor(() => expect(notices(f)).toHaveLength(1));
});
it('contributes the schema and the system-prompt fragment identically across different agentType steps', async () => {
  const f = await workflowFixture();
  f.config.agents['alternate'] = {
    provider: 'builtin:controlled',
    config: { model: 'alternate' },
  };
  const locked = vi.spyOn(TeammateCollection.prototype, 'createLocked');
  await f.workflows.run({ script: 'noop', max_concurrency: 4 });
  const schema = { type: 'object', properties: {} };
  for (const [index, agentType] of [
    'controlled',
    'alternate',
    undefined,
  ].entries())
    controls.runners[0]!.emit({
      type: 'agent_start',
      index,
      prompt: `p${index}`,
      options: { schema, ...(agentType === undefined ? {} : { agentType }) },
    });
  await vi.waitFor(() => expect(f.provider.runtimes).toHaveLength(4));
  expect(locked).toHaveBeenCalledTimes(3);
  expect(locked.mock.calls.map((call) => call[0].agentRuntime)).toEqual([
    'controlled',
    'alternate',
    undefined,
  ]);
  for (const call of locked.mock.calls)
    expect(call[1]).toMatchObject({
      outputSchema: schema,
      systemPromptAppend: [WORKFLOW_AGENT_SYSTEM_PROMPT],
    });
  for (const runtime of f.provider.runtimes.slice(1)) {
    expect(runtime.context.outputSchema).toEqual(schema);
    expect(runtime.context.systemPrompt?.append).toContain(
      WORKFLOW_AGENT_SYSTEM_PROMPT,
    );
  }
  expect(
    f.provider.runtimes.slice(1).map((runtime) => runtime.context.config),
  ).toContainEqual({ model: 'alternate' });
  await f.workflows.stopAll();
});
it('resolves only once every live run has reached a terminal record', async () => {
  const f = await workflowFixture();
  const one = await f.workflows.run({ script: 'noop' });
  const two = await f.workflows.run({ script: 'noop' });
  const held = holdStop(f, controls.runners[1]!);
  const stopping = f.workflows.stopAll();
  await held.entered.promise;
  expect(await f.workflows.status(two)).toMatchObject({ status: 'running' });
  held.release.resolve();
  await stopping;
  expect((await f.workflows.list()).runs.map((run) => run.status)).toEqual([
    'stopped',
    'stopped',
  ]);
  for (const accepted of [one, two]) {
    expect(
      JSON.parse(await readFile(paths(accepted.run_id).record, 'utf8')),
    ).toMatchObject({ status: 'stopped' });
    expect(await terminalRows(accepted.run_id)).toEqual([
      expect.objectContaining({ status: 'stopped' }),
    ]);
  }
  expect(controls.runners.every((runner) => runner.stopped)).toBe(true);
  expect(notices(f)).toEqual([]);
});
it('stops a run whose creation crosses requestStopAll without owner delivery', async () => {
  const f = await workflowFixture();
  const entered = deferred<void>(),
    release = deferred<void>();
  f.releases.push(() => release.resolve());
  const initialize = WorkflowRun.prototype.initialize;
  vi.spyOn(WorkflowRun.prototype, 'initialize').mockImplementationOnce(
    async function (this: WorkflowRun) {
      entered.resolve();
      await release.promise;
      await initialize.call(this);
    },
  );
  const creating = f.workflows.run({ script: 'noop' });
  await entered.promise;
  f.workflows.requestStopAll();
  const converging = f.workflows.stopAll();
  release.resolve();
  const accepted = await creating;
  await converging;
  expect(await f.workflows.status(accepted)).toMatchObject({
    status: 'stopped',
  });
  expect(controls.runners[0]).toMatchObject({ started: false, stopped: true });
  expect(notices(f)).toEqual([]);
});

function realMembers(value: unknown): TeammateCollection {
  if (!(value instanceof TeammateCollection))
    throw new Error('expected real TeamMate collection');
  return value;
}
const memberInput = {
  name: 'workflow-member',
  prompt: 'do work',
  intent: 'Test Workflow member admission',
  agentRuntime: 'controlled',
};
it.each(['dispatcher', 'team', 'team-parent'] as const)(
  'R73 rejects createLocked behind the %s fence before allocation or identity writes',
  async (scopeKind) => {
    const f = await workflowFixture(false);
    const created =
      scopeKind === 'dispatcher'
        ? null
        : await f.teams.createFromRequest(teamRequest('fenced-team'));
    const team =
      created === null ? null : await f.teams.open(created.team_name);
    const members = realMembers(team?.teammates ?? f.host.teammates);
    const allocate = vi.spyOn(AgentNameRegistry.prototype, 'allocate');
    const create = vi.spyOn(AgentServiceFactory.prototype, 'create');
    const lock = vi.spyOn(AgentService.prototype, 'lock');
    if (scopeKind === 'team') {
      await team!.dissolve({ note: 'Close Team admission', force: true });
      await team!.closed;
    } else {
      await f.host.close();
    }
    await expect(members.createLocked(memberInput)).rejects.toMatchObject({
      code: scopeKind === 'team' ? 'TEAM_CLOSED' : 'SERVER_SHUTTING_DOWN',
    });
    expect(allocate).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(lock).not.toHaveBeenCalled();
    expect(f.provider.runtimes).toHaveLength(0);
  },
);
it.each(['dispatcher', 'team'] as const)(
  'R73 undoes a late Workflow lock before the %s close sweep completes',
  async (scopeKind) => {
    const f = await workflowFixture(false);
    const created =
      scopeKind === 'team'
        ? await f.teams.createFromRequest(teamRequest('late-team'))
        : null;
    const team =
      created === null ? null : await f.teams.open(created.team_name);
    const members = realMembers(team?.teammates ?? f.host.teammates);
    const agents = captureAgents();
    const entered = deferred<void>(),
      release = deferred<void>();
    f.releases.push(() => release.resolve());
    f.host.hooks.teammateLaunch.tapPromise(
      'hold-admitted-construction',
      async () => {
        entered.resolve();
        await release.promise;
      },
    );
    const rejected = expect(
      members.createLocked(memberInput),
    ).rejects.toMatchObject({ code: 'SERVER_SHUTTING_DOWN' });
    await entered.promise;
    const closing =
      team === null
        ? f.host.close()
        : team
            .dissolve({ note: 'Close during member construction', force: true })
            .then(() => team.closed);
    expect(team?.isClosing() ?? f.host.fence.isClosing()).toBe(true);
    release.resolve();
    await rejected;
    await closing;
    expect(agents).toHaveLength(1);
    expect(f.provider.runtimes).toHaveLength(0);
    if (team === null) {
      await expect(
        agents[0]!.close({ note: 'Prove late lock was released' }),
      ).resolves.toMatchObject({ teammate: { status: 'closed' } });
    }
    await agents[0]!.closed;
    expect(agents[0]!.isRetired()).toBe(true);
    expect(agents[0]!.current().status).toBe('closed');
  },
);
