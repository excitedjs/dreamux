import type { RuntimeCompletion } from '@excitedjs/dreamux-types';
import { describe, expect, it, vi } from 'vitest';
import { TeammateCollection } from '../src/service/agent/index.js';
import { DREAMUX_MCP_LEASE_ENV } from '../src/mcp/launch.js';
import { dispatcherFixture, teamRequest } from './helpers/real-dispatcher.js';
import {
  deferred,
  type ControlledRuntime,
} from './helpers/controlled-runtime-provider.js';

async function setup(
  scope: 'team' | 'dispatcher',
  activeOwner = true,
  channel = false,
) {
  const f = await dispatcherFixture({ channel });
  await f.host.start();
  const owner =
    scope === 'dispatcher'
      ? f.host
      : await f.teams.open(
          (await f.teams.createFromRequest(teamRequest('messaging'))).team_name,
        );
  if (activeOwner) {
    const admission = await owner.submitInput({
      source: 'task',
      text: 'owner ready',
    });
    if (admission.status !== 'submitted')
      throw new Error('owner did not start');
    f.provider.runtimes.at(-1)!.submissions[0]!.complete(null);
    await admission.turn.settled;
  }
  const ownerRuntime = activeOwner ? f.provider.runtimes.at(-1)! : null;
  const spawn = async (name: string) => {
    const receipt = await owner.teammates.spawn({
      name,
      prompt: 'initial work',
      intent: 'collaborate',
    });
    const runtime = f.provider.runtimes.at(-1)!;
    const server = runtime.context.mcpServers.find(
      (server) => server.name === 'teammate',
    );
    const token = server?.env?.[DREAMUX_MCP_LEASE_ENV];
    if (token === undefined) throw new Error('member tools absent');
    const call = (name: string, args: Record<string, unknown> = {}) =>
      f.mcpLeases.invoke(token, { name, arguments: args });
    return { name: receipt.teammate.name, runtime, call, token };
  };
  const members = owner.teammates;
  if (!(members instanceof TeammateCollection))
    throw new Error('expected actual collection');
  const recipient =
    'completionRecipient' in owner
      ? owner.completionRecipient()
      : f.host.dispatcherAgent.completionRecipient();
  return { ...f, owner, ownerRuntime, members, spawn, recipient };
}
const notices = (runtime: ControlledRuntime) =>
  runtime.inputs.filter((input) => input.startsWith('<task-notification>'));
const result = (text: string): RuntimeCompletion =>
  Object.freeze({ status: 'completed', resultText: text });

for (const scope of ['team', 'dispatcher'] as const)
  describe(`${scope} ordinary members`, () => {
    it('advertises exactly send/list, discovers the actual owner and closed peers, and binds sender', async () => {
      const f = await setup(scope, false, true);
      const a = await f.spawn('alice');
      const b = await f.spawn('bob');
      await f.members.close({ name: b.name, note: 'pause' });
      const catalog = f.mcpLeases.catalog(a.token).tools;
      expect(catalog.map((tool) => tool.name)).toEqual(['send', 'list']);
      expect(
        Object.keys(catalog[0]!.inputSchema['properties'] as object),
      ).toEqual(['name', 'prompt']);
      expect(catalog[0]!.inputSchema['additionalProperties']).toBe(false);
      a.runtime.context.events({
        kind: 'turn.result',
        completion: result('owner offline'),
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.provider.runtimes).toHaveLength(2);
      const address = f.owner.memberOwner().name;
      expect(await a.call('list')).toMatchObject({
        ok: true,
        structured: {
          owner: { name: address },
          teammates: [{ name: b.name, status: 'closed' }],
        },
      });
      const receipt = await a.call('send', {
        name: address,
        prompt: 'blocked',
        from: 'forged',
      });
      expect(receipt).toMatchObject({
        ok: true,
        structured: { name: address, status: 'submitted' },
      });
      const ownerRuntime = f.provider.runtimes.at(-1)!;
      expect(ownerRuntime.inputs).toEqual([
        `<task from="${a.name}">blocked</task>`,
      ]);
      const memberInputs = f.channel.sessions
        .get('fixture-channel')!
        .receivedEvents.filter(
          (event) =>
            event.kind === 'teammate.input' &&
            event.notice?.kind === 'teammate_message',
        );
      expect(memberInputs).toEqual([
        expect.objectContaining({
          kind: 'teammate.input',
          role: scope === 'team' ? 'team_leader' : 'dispatcher',
          content: 'blocked',
          notice: { kind: 'teammate_message', producer: a.name },
        }),
      ]);
      ownerRuntime.submissions[0]!.complete('owner response requires send');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(a.runtime.inputs).toEqual(['<task>initial work</task>']);
      expect(
        await a.call('send', { name: a.name, prompt: 'self' }),
      ).toMatchObject({ ok: false });
      expect(
        await a.call('send', { name: 'missing-peer', prompt: 'missing' }),
      ).toMatchObject({ ok: false });
      expect(await a.call('spawn', {})).toMatchObject({ ok: false });
    });

    it('exchanges explicit peer replies across turns, reports folded results only to the owner, and reopens one record', async () => {
      const f = await setup(scope);
      const a = await f.spawn('alice');
      const b = await f.spawn('bob');
      const ownerRuntime = f.ownerRuntime!;
      const native = result('bob answered folded inputs');
      expect(
        await a.call('send', { name: b.name, prompt: 'question' }),
      ).toMatchObject({
        ok: true,
        structured: { name: b.name, status: 'submitted' },
      });
      expect(b.runtime.inputs[1]).toBe(
        `<task from="${a.name}">question</task>`,
      );
      expect(notices(ownerRuntime)).toEqual([]);
      b.runtime.context.events({ kind: 'turn.result', completion: native });
      for (const submission of b.runtime.submissions)
        submission.settle({ kind: 'completion', completion: native });
      await vi.waitFor(() => expect(notices(ownerRuntime)).toHaveLength(1));
      expect(notices(ownerRuntime)[0]).toContain('bob answered folded inputs');
      expect(a.runtime.inputs).toHaveLength(1);
      expect(
        await b.call('send', { name: a.name, prompt: 'explicit answer' }),
      ).toMatchObject({ ok: true });
      expect(a.runtime.inputs.at(-1)).toBe(
        `<task from="${b.name}">explicit answer</task>`,
      );
      const entity = f.members
        .materializedEntities()
        .find((member) => member.name === b.name)!;
      await b.runtime.context.state.publish({
        kind: 'session',
        sessionId: 'retained-session',
      });
      await entity.close({ note: 'pause peer' });
      const before = f.provider.runtimes.length;
      const replies = await Promise.all([
        a.call('send', { name: b.name, prompt: 'resume one' }),
        a.call('send', { name: b.name, prompt: 'resume two' }),
      ]);
      expect(replies).toEqual([
        expect.objectContaining({ ok: true }),
        expect.objectContaining({ ok: true }),
      ]);
      expect(f.provider.runtimes).toHaveLength(before + 1);
      const reopened = f.provider.runtimes.at(-1)!;
      expect(reopened.context.identity.sessionId).toBe('retained-session');
      expect((await f.members.status(b.name)).name).toBe(b.name);
      reopened.context.events({
        kind: 'turn.result',
        completion: result('reopened background'),
      });
      await vi.waitFor(() => expect(notices(ownerRuntime)).toHaveLength(2));
      expect(notices(ownerRuntime)[1]).toContain('reopened background');
      expect(b.runtime.context.mcpServers).toHaveLength(1);
      expect(await b.call('list')).toMatchObject({ ok: false });
    });

    it.each(['close', 'host-stop'] as const)(
      'reports unbound results, joins native delivery on %s, and drops revoked writes',
      async (operation) => {
        const f = await setup(scope);
        const a = await f.spawn('alice');
        const ownerRuntime = f.ownerRuntime!;
        const entity = f.members.materializedEntities()[0]!;
        a.runtime.context.events({
          kind: 'turn.result',
          completion: result('background one'),
        });
        a.runtime.context.events({
          kind: 'turn.result',
          completion: Object.freeze({
            status: 'failed',
            error: new Error('native failed'),
          }),
        });
        await vi.waitFor(() => expect(notices(ownerRuntime)).toHaveLength(2));
        expect(notices(ownerRuntime)[0]).toContain('background one');
        expect(notices(ownerRuntime)[1]).toContain('turn failed.');
        expect(notices(ownerRuntime)[1]).not.toContain('native failed');
        const gate = deferred<void>();
        const original = f.recipient.prepareCompletion.bind(f.recipient);
        const prepared = deferred<void>();
        vi.spyOn(f.recipient, 'prepareCompletion').mockImplementation(
          async (fact) => {
            const delivery = await original(fact);
            return {
              submit: async () => {
                prepared.resolve();
                await gate.promise;
                return delivery.submit();
              },
            };
          },
        );
        a.runtime.context.events({
          kind: 'turn.result',
          completion: result('observed before close'),
        });
        const closing =
          operation === 'close'
            ? entity.close({ note: 'close after terminal' })
            : entity.stopForHost();
        await prepared.promise;
        let closed = false;
        void closing.then(() => {
          closed = true;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(closed).toBe(false);
        gate.resolve();
        await closing;
        expect(notices(ownerRuntime)).toHaveLength(3);
        expect(notices(ownerRuntime)[2]).toContain('observed before close');
        a.runtime.context.events({
          kind: 'turn.result',
          completion: result('revoked result'),
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(notices(ownerRuntime)).toHaveLength(3);
      },
    );

    it('suppresses stop-before-publication but keeps terminal-before-stop even before settlement continuations', async () => {
      const f = await setup(scope);
      const a = await f.spawn('alice');
      const entity = f.members.materializedEntities()[0]!;
      const native = result('terminal before stop');
      a.runtime.context.events({ kind: 'turn.result', completion: native });
      a.runtime.submissions[0]!.settle({
        kind: 'completion',
        completion: native,
      });
      await entity.stopForHost();
      expect(notices(f.ownerRuntime!)).toHaveLength(1);
      expect(notices(f.ownerRuntime!)[0]).toContain('terminal before stop');
      await f.members.send({ name: a.name, prompt: 'new generation' });
      const next = f.provider.runtimes.at(-1)!;
      const stopping = entity.stopForHost();
      next.context.events({
        kind: 'turn.result',
        completion: result('terminal after stop'),
      });
      await stopping;
      expect(notices(f.ownerRuntime!)).toHaveLength(1);
    });

    it('keeps locked Workflow builds unarmed, preserves script results and lock refusal, then arms ordinary reopen', async () => {
      const f = await setup(scope);
      const locked = await f.members.createLocked({
        name: 'workflow',
        prompt: 'script',
        intent: 'script',
      });
      const admission = await locked.submit({
        source: 'task',
        prompt: 'script work',
      });
      if (admission.status !== 'submitted')
        throw new Error('script not admitted');
      const runtime = f.provider.runtimes.at(-1)!;
      expect(runtime.context.mcpServers).toEqual([]);
      const native = result('script result');
      runtime.context.events({ kind: 'turn.result', completion: native });
      runtime.submissions[0]!.settle({
        kind: 'completion',
        completion: native,
      });
      expect(await admission.turn.settled).toEqual({
        status: 'completed',
        resultText: 'script result',
      });
      await expect(
        f.members.send({ name: locked.name, prompt: 'ordinary input' }),
      ).rejects.toThrow(/cannot accept/);
      expect(notices(f.ownerRuntime!)).toEqual([]);
      await locked.close({ note: 'script finished' });
      locked.unlock();
      await f.members.send({ name: locked.name, prompt: 'ordinary reopen' });
      const reopened = f.provider.runtimes.at(-1)!;
      expect(reopened.context.mcpServers.map((server) => server.name)).toEqual([
        'teammate',
      ]);
      reopened.context.events({
        kind: 'turn.result',
        completion: result('ordinary result'),
      });
      await vi.waitFor(() => expect(notices(f.ownerRuntime!)).toHaveLength(1));
    });

    it('refuses other collections and members retained behind the owner fence', async () => {
      const f = await setup(scope);
      const a = await f.spawn('alice');
      const other =
        scope === 'team'
          ? f.host
          : await f.teams.open(
              (await f.teams.createFromRequest(teamRequest('other-scope')))
                .team_name,
            );
      const outsider = await other.teammates.spawn({
        name: 'outsider',
        prompt: 'work',
        intent: 'other',
      });
      expect(
        await a.call('send', {
          name: outsider.teammate.name,
          prompt: 'outside',
        }),
      ).toMatchObject({ ok: false });
      f.host.fence.close();
      expect(
        await a.call('send', { name: outsider.teammate.name, prompt: 'late' }),
      ).toMatchObject({ ok: false });
      const ownerName = f.owner.memberOwner().name;
      await f.host.close();
      expect(
        await a.call('send', { name: ownerName, prompt: 'late owner' }),
      ).toMatchObject({ ok: false });
    });
  });
