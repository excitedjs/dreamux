import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentRuntimeSubmissionInput,
  RuntimeAdmission,
} from '@excitedjs/dreamux-types';
import type { PreparedCompletionFact } from '../src/service/completion-router/index.js';
import { TeammateCollection } from '../src/service/agent/index.js';
import { dispatcherFixture } from './helpers/real-dispatcher.js';
import { deferred } from './helpers/controlled-runtime-provider.js';
import { controllableRuntimeSubmission } from './helpers/runtime-submission.js';
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const f = await dispatcherFixture({ channel: true });
  const order: string[] = [];
  const inputs: AgentRuntimeSubmissionInput[] = [];
  const control: {
    startError: Error | null;
    refusal: RuntimeAdmission | null;
  } = { startError: null, refusal: null };
  const create = f.provider.createRuntime.bind(f.provider);
  vi.spyOn(f.provider, 'createRuntime').mockImplementation(async (context) => {
    const runtime = await create(context);
    const start = runtime.start.bind(runtime),
      submit = runtime.submit.bind(runtime);
    vi.spyOn(runtime, 'start').mockImplementation(async () => {
      order.push('start');
      if (control.startError !== null) throw control.startError;
      return start();
    });
    vi.spyOn(runtime, 'submit').mockImplementation(async (input) => {
      order.push('submit');
      inputs.push(input);
      return control.refusal ?? submit(input);
    });
    return runtime;
  });
  await f.host.start();
  const service = f.host.dispatcherAgent.current;
  if (service === null) throw new Error('missing actual Dispatcher Agent');
  const events = () =>
    f.channel.sessions.get('fixture-channel')!.receivedEvents;
  const projected = () =>
    events().filter((event) => event.kind === 'teammate.input');
  const activities = () =>
    events()
      .filter((event) => event.kind === 'teammate.activity')
      .map((event) => event.activity);
  return {
    ...f,
    service,
    order,
    inputs,
    control,
    events,
    projected,
    activities,
  };
}
const completion: PreparedCompletionFact = {
  kind: 'teammate',
  role: 'teammate',
  source: 'reporter-agent',
  status: 'completed',
  result: 'the work is done',
};

describe('real AgentService admission owner', () => {
  it('reopens a closed target and starts its runtime before the runtime ever sees a submission', async () => {
    const f = await fixture();
    const first = await f.host.teammates.spawn({
      name: 'reopen',
      prompt: 'first',
      intent: 'first intent',
    });
    await f.host.teammates.close({
      name: first.teammate.name,
      note: 'close first generation',
    });
    const before = f.order.length;
    await expect(
      f.host.teammates.send({
        name: first.teammate.name,
        prompt: 'second',
        intent: 'second intent',
      }),
    ).resolves.toMatchObject({
      status: 'submitted',
      teammate: { status: 'starting' },
    });
    expect(f.order.slice(before)).toEqual(['start', 'submit']);
    expect(f.provider.runtimes).toHaveLength(2);
  });
  it('starts the runtime before submitting for an already-running (non-closed) target too', async () => {
    const f = await fixture();
    await f.service.submitInput({ source: 'channel', text: 'first' });
    await f.service.stopForHost();
    const before = f.order.length;
    await expect(
      f.service.submitInput({ source: 'channel', text: 'second' }),
    ).resolves.toMatchObject({ status: 'submitted' });
    expect(f.order.slice(before)).toEqual(['start', 'submit']);
  });
  it('hands the runtime exactly { text } — sourceId and intent never appear on the submit payload', async () => {
    const f = await fixture();
    await f.service.submitInput({
      source: 'channel',
      text: 'body',
      sourceId: 'source-one',
      intent: 'recovery intent',
    });
    expect(f.inputs).toEqual([{ text: '<channel>body</channel>' }]);
  });
  it('records intent on a fresh admission, and a later duplicate never rewrites it', async () => {
    const f = await fixture();
    await f.service.submitInput({
      source: 'channel',
      text: 'first',
      sourceId: 'same',
      intent: 'original intent',
    });
    await expect(
      f.service.submitInput({
        source: 'channel',
        text: 'repeated',
        sourceId: 'same',
        intent: 'unaccepted intent',
      }),
    ).resolves.toEqual({ status: 'duplicate' });
    expect(f.service.current().intent).toBe('original intent');
    expect(f.inputs).toHaveLength(1);
  });
  it('reaches the runtime every time when sourceId is omitted', async () => {
    const f = await fixture();
    await f.service.submitInput({ source: 'channel', text: 'same' });
    await f.service.submitInput({ source: 'channel', text: 'same' });
    expect(f.inputs).toHaveLength(2);
  });
  it('joins a concurrent repeat into one admission — the runtime is asked once and both callers observe the same turn', async () => {
    const f = await fixture();
    const pending = deferred<RuntimeAdmission>();
    const submission = controllableRuntimeSubmission();
    f.releases.push(() => {
      pending.resolve({
        status: 'submitted',
        submission: submission.submission,
      });
      submission.stop();
    });
    f.provider.planNext({ delayedAdmission: pending.promise });
    const input = { source: 'channel', text: 'concurrent', sourceId: 'joined' };
    const left = f.service.submitInput(input),
      right = f.service.submitInput(input);
    await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
    pending.resolve({ status: 'submitted', submission: submission.submission });
    const a = await left,
      b = await right;
    expect(a).toBe(b);
    expect(a.status).toBe('submitted');
    expect(f.inputs).toHaveLength(1);
  });
  it('does not dedupe two different entities that happen to reuse the same source id, even sharing one ledger', async () => {
    const f = await fixture();
    await f.host.teammates.spawn({
      name: 'other',
      prompt: 'initialize',
      intent: 'other work',
    });
    if (!(f.host.teammates instanceof TeammateCollection))
      throw new Error('expected actual collection');
    const other = f.host.teammates.materializedEntities()[0]!;
    const input = {
      source: 'channel',
      text: 'shared source',
      sourceId: 'shared-source',
    };
    await expect(f.service.submitInput(input)).resolves.toMatchObject({
      status: 'submitted',
    });
    await expect(other.submitInput(input)).resolves.toMatchObject({
      status: 'submitted',
    });
    expect(
      f.inputs.filter((value) => value.text.includes('shared source')),
    ).toHaveLength(2);
  });
  it('projects the original text and caller id on a fresh admission — no envelope markup, and not the reminder', async () => {
    const f = await fixture();
    await f.service.submitInput({
      source: 'channel',
      attrs: { chat: 'general' },
      text: 'hello there',
      reminder: 'stay on task',
      sourceId: 'message-fixture',
    });
    expect(f.projected()).toEqual([
      expect.objectContaining({
        content: 'hello there',
        source: 'channel',
        sourceId: 'message-fixture',
      }),
    ]);
    expect(f.inputs[0]!.text).toContain('<reminder>stay on task</reminder>');
  });
  it('never re-projects a duplicate: only the first admission of a repeated sourceId is recorded', async () => {
    const f = await fixture();
    await f.service.submitInput({
      source: 'channel',
      text: 'first',
      sourceId: 'dup-2',
    });
    await f.service.submitInput({
      source: 'channel',
      text: 'first, again',
      sourceId: 'dup-2',
    });
    expect(f.projected().map((event) => event.content)).toEqual(['first']);
  });
  it('renders the delivered turn under <task-notification>, never under the reporting teammate name or <channel>', async () => {
    const f = await fixture();
    await f.service.submitInput({ source: 'channel', text: 'get started' });
    await expect(
      (await f.service.prepareCompletion(completion)).submit(),
    ).resolves.toEqual({ status: 'accepted' });
    expect(f.inputs).toHaveLength(2);
    expect(f.inputs[1]!.text).toMatch(/^<task-notification>/);
    expect(f.inputs[1]!.text).not.toMatch(/^<(channel|reporter-agent)>/);
  });
  it.each([
    {
      what: 'a TeamMate',
      fact: completion,
      notice: { kind: 'teammate_completion', producer: 'reporter-agent' },
      says: 'TeamMate reporter-agent has finished its task.',
    },
    {
      what: 'a Workflow',
      fact: {
        kind: 'workflow',
        source: 'workflow',
        runId: 'wf-1',
        status: 'completed',
        result: 'the run is done',
      } as PreparedCompletionFact,
      notice: { kind: 'workflow_completion' },
      says: 'Workflow wf-1 has completed.',
    },
  ])(
    'tells the display which producer reported when $what finished',
    async ({ fact, notice, says }) => {
      const f = await fixture();
      await f.service.submitInput({ source: 'channel', text: 'get started' });
      await (await f.service.prepareCompletion(fact)).submit();
      expect(f.projected()[1]?.notice).toEqual(notice);
      expect(f.projected()[1]?.content).toContain(says);
      expect(f.inputs[1]?.text).toContain(says);
    },
  );
  it('leaves an ordinary submission without a producer notice', async () => {
    const f = await fixture();
    await f.service.submitInput({ source: 'channel', text: 'ordinary work' });
    expect(f.projected()[0]?.notice).toBeNull();
  });
  it('announces a submission the provider refuses, then ends it with the reason', async () => {
    const f = await fixture();
    f.control.refusal = {
      status: 'failed',
      error: new Error('runtime refused the turn'),
    };
    await expect(
      f.service.submitInput({
        source: 'channel',
        text: 'this one fails',
        sourceId: 'msg-fail',
      }),
    ).resolves.toMatchObject({ status: 'failed' });
    expect(f.projected().map((event) => event.content)).toEqual([
      'this one fails',
    ]);
    expect(f.activities()).toEqual([
      expect.objectContaining({
        kind: 'turn.ended',
        status: 'failed',
        reason: 'runtime refused the turn',
      }),
    ]);
    const relevant = f
      .events()
      .filter(
        (event) =>
          event.kind === 'teammate.input' || event.kind === 'teammate.activity',
      );
    expect(relevant.map((event) => event.kind)).toEqual([
      'teammate.input',
      'teammate.activity',
    ]);
  });
  it('announces and ends a submission whose runtime never even started', async () => {
    const f = await fixture();
    f.control.startError = new Error('runtime binary is missing');
    await expect(
      f.service.submitInput({ source: 'channel', text: 'never delivered' }),
    ).rejects.toThrow('runtime binary is missing');
    expect(f.projected().map((event) => event.content)).toEqual([
      'never delivered',
    ]);
    expect(f.activities()).toEqual([
      expect.objectContaining({
        kind: 'turn.ended',
        status: 'failed',
        reason: 'runtime binary is missing',
      }),
    ]);
    expect(f.inputs).toEqual([]);
  });
  it('announces an accepted submission exactly once, and does not end it', async () => {
    const f = await fixture();
    await f.service.submitInput({ source: 'channel', text: 'accepted' });
    expect(f.projected()).toHaveLength(1);
    expect(f.activities()).toEqual([]);
  });
  it('reports unsupported once the host released the runtime, and starts nothing', async () => {
    const f = await fixture();
    await f.service.submitInput({ source: 'channel', text: 'wake up' });
    const prepared = await f.service.prepareCompletion({
      ...completion,
      result: 'the answer',
    });
    await f.service.stopForHost();
    const count = f.provider.runtimes.length,
      steps = f.order.length;
    await expect(prepared.submit()).resolves.toMatchObject({
      status: 'unsupported',
    });
    expect(f.provider.runtimes).toHaveLength(count);
    expect(f.order.slice(steps)).toEqual([]);
    expect(f.projected()).toHaveLength(2);
    expect(f.projected()[1]).toMatchObject({
      source: 'task-notification',
      content: expect.stringContaining('the answer'),
    });
    expect(f.activities()).toEqual([
      expect.objectContaining({
        kind: 'turn.ended',
        status: 'failed',
        reason: 'the agent runtime is not running',
      }),
    ]);
  });
});
