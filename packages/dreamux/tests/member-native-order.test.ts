/** Protocol replays through the actual adapter collectors and Core owners; no live child. */
import { Writable } from 'node:stream';
import type {
  AgentRuntime,
  AgentRuntimeCreateContext,
  RuntimeCompletion,
  RuntimeSubmission,
} from '@excitedjs/dreamux-types';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeCodeStreamRpc } from '../../agent-runtime/claude-code/dist/rpc.js';
import { TurnManager } from '../../agent-runtime/codex/dist/turn-manager.js';
import { CodexReasoningEffort } from '../../agent-runtime/codex/dist/reasoning-effort.js';
import type { CodexWsClient } from '../../agent-runtime/codex/dist/rpc.js';
import { CodexNativeReplay } from './helpers/codex-native-replay.js';
import { ControlledRuntimeProvider } from './helpers/controlled-runtime-provider.js';
import { dispatcherFixture, teamRequest } from './helpers/real-dispatcher.js';
import { DREAMUX_MCP_LEASE_ENV } from '../src/mcp/launch.js';
import { TeammateCollection } from '../src/service/agent/index.js';

type Adapter = 'claude' | 'codex';
class ReplayProvider extends ControlledRuntimeProvider {
  readonly controllers: Array<{
    observed: RuntimeCompletion[];
    submissions: RuntimeSubmission[];
    emit(order: 'bound-first' | 'unbound-first', failed?: boolean): void;
    failConnection(): void;
    client: CodexNativeReplay;
  }> = [];
  constructor(private readonly adapter: Adapter) {
    super();
  }
  override async createRuntime(
    context: AgentRuntimeCreateContext<unknown>,
  ): Promise<AgentRuntime> {
    const runtime = await super.createRuntime(context);
    const controlled = this.runtimes.at(-1)!;
    const originalSubmit = runtime.submit;
    const originalStop = runtime.stop;
    const observed: RuntimeCompletion[] = [];
    const submissions: RuntimeSubmission[] = [];
    const results = (completion: RuntimeCompletion) => {
      observed.push(completion);
      context.results!(completion);
    };
    const uuids: string[] = [];
    const rpc = new ClaudeCodeStreamRpc(
      new Writable({
        write(chunk: Buffer, _encoding, done) {
          uuids.push((JSON.parse(chunk.toString()) as { uuid: string }).uuid);
          done();
        },
      }),
      {
        sessionId: null,
        results,
        turnTimeoutMs: 5000,
        reapOnTimeout: () => undefined,
      },
    );
    const client = new CodexNativeReplay();
    const codexClient = client as unknown as CodexWsClient;
    const manager = new TurnManager({
      threadId: 'replay-thread',
      client: codexClient,
      codec: null,
      reasoning: new CodexReasoningEffort(
        codexClient,
        { model: 'fixture', reasoningEffort: null },
        false,
        context.cwd,
      ),
      activitySink: context.activity,
      resultSink: results,
      logger: context.logger,
    });
    runtime.submit = async (input) => {
      if (input.text.startsWith('<task-notification>'))
        return originalSubmit(input);
      controlled.inputs.push(input.text);
      const admission = await (this.adapter === 'claude'
        ? rpc.submit(input.text)
        : manager.submitInput(input));
      if (admission.status === 'submitted')
        submissions.push(admission.submission);
      return admission;
    };
    runtime.stop = async () => {
      rpc.stop();
      await manager.stop();
      await originalStop();
    };
    const line = (text: string, uuid?: string) => ({
      type: 'result',
      subtype: 'success',
      result: text,
      user_message_uuid: uuid,
    });
    this.controllers.push({
      observed,
      submissions,
      client,
      emit: (order, failed = false) => {
        if (this.adapter === 'claude') {
          const bound = [
            ...uuids.slice(0, 2).map((command_uuid) => ({
              type: 'command_lifecycle',
              command_uuid,
              state: 'started',
            })),
            line('first folded result', uuids[0]),
          ];
          const unbound = [
            failed
              ? {
                  type: 'result',
                  subtype: 'error_during_execution',
                  is_error: true,
                  errors: ['observed failed background'],
                }
              : line('background result'),
          ];
          const frames = [
            ...(order === 'bound-first'
              ? [...bound, ...unbound]
              : [...unbound, ...bound]),
            line('third result', uuids[2]),
          ];
          rpc.onStdoutChunk(
            frames.map((frame) => JSON.stringify(frame) + '\n').join(''),
          );
        } else {
          if (order === 'bound-first')
            client.emitCompleted(
              'replay-thread',
              'first',
              'first folded result',
            );
          if (failed)
            client.emit({
              method: 'turn/completed',
              params: {
                threadId: 'replay-thread',
                turn: {
                  id: 'unbound',
                  status: 'failed',
                  error: { message: 'observed failed background' },
                },
              },
            });
          else
            client.emitCompleted(
              'replay-thread',
              'unbound',
              'background result',
            );
          if (order === 'unbound-first')
            client.emitCompleted(
              'replay-thread',
              'first',
              'first folded result',
            );
          client.emitCompleted('replay-thread', 'third', 'third result');
        }
      },
      failConnection: () =>
        this.adapter === 'claude'
          ? rpc.fail(new Error('transport lost'))
          : client.close(),
    });
    return runtime;
  }
}

for (const adapter of ['claude', 'codex'] as const)
  for (const scope of ['team', 'dispatcher'] as const)
    describe(`${adapter} native results to ${scope} owner`, () => {
      if (adapter === 'codex')
        it('routes a finalized native result once when a folded admission binds after publication', async () => {
          const provider = new ReplayProvider(adapter);
          const f = await dispatcherFixture({ provider });
          await f.host.start();
          const owner =
            scope === 'dispatcher'
              ? f.host
              : await f.teams.open(
                  (
                    await f.teams.createFromRequest(
                      teamRequest('late-association'),
                    )
                  ).team_name,
                );
          await owner.submitInput({ source: 'task', text: 'owner ready' });
          const ownerRuntime = provider.runtimes.at(-1)!;
          const spawned = await owner.teammates.spawn({
            name: 'worker',
            prompt: 'first',
            intent: 'late association',
          });
          const controller = provider.controllers.at(-1)!;
          controller.client.holdNextAdmission = true;
          const sending = owner.teammates.send({
            name: spawned.teammate.name,
            prompt: 'late folded input',
          });
          await vi.waitFor(() =>
            expect(controller.client.admissionPending).toBe(true),
          );
          controller.client.emitCompleted(
            'replay-thread',
            'first',
            'early native result',
          );
          await vi.waitFor(() =>
            expect(
              ownerRuntime.inputs.filter((text) =>
                text.startsWith('<task-notification>'),
              ),
            ).toHaveLength(1),
          );
          const early = await controller.submissions[0]!.settled;
          if (early.kind !== 'completion') throw new Error('early C missing');
          controller.client.release();
          await sending;
          const late = await controller.submissions[1]!.settled;
          if (late.kind !== 'completion') throw new Error('late C missing');
          expect(late.completion).toBe(early.completion);
          expect(early.completion).toBe(controller.observed[0]);
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(
            ownerRuntime.inputs.filter((text) =>
              text.startsWith('<task-notification>'),
            ),
          ).toHaveLength(1);
        });
      if (adapter === 'codex')
        it('delivers native order before a pending admission binds and folds its later answer', async () => {
          const provider = new ReplayProvider(adapter);
          const f = await dispatcherFixture({ provider });
          await f.host.start();
          const owner =
            scope === 'dispatcher'
              ? f.host
              : await f.teams.open(
                  (
                    await f.teams.createFromRequest(
                      teamRequest('pending-admission'),
                    )
                  ).team_name,
                );
          await owner.submitInput({ source: 'task', text: 'owner ready' });
          const ownerRuntime = provider.runtimes.at(-1)!;
          const spawned = await owner.teammates.spawn({
            name: 'worker',
            prompt: 'first',
            intent: 'order',
          });
          const controller = provider.controllers.at(-1)!;
          await owner.teammates.send({
            name: spawned.teammate.name,
            prompt: 'folded',
          });
          controller.client.holdNextAdmission = true;
          const pending = owner.teammates.send({
            name: spawned.teammate.name,
            prompt: 'third',
          });
          await vi.waitFor(() =>
            expect(controller.client.admissionPending).toBe(true),
          );
          controller.emit('unbound-first');
          await vi.waitFor(() =>
            expect(
              ownerRuntime.inputs.filter((text) =>
                text.startsWith('<task-notification>'),
              ),
            ).toHaveLength(3),
          );
          expect(controller.client.admissionPending).toBe(true);
          controller.client.release();
          await pending;
          await vi.waitFor(() =>
            expect(
              ownerRuntime.inputs.filter((text) =>
                text.startsWith('<task-notification>'),
              ),
            ).toHaveLength(3),
          );
          const delivered = ownerRuntime.inputs.filter((text) =>
            text.startsWith('<task-notification>'),
          );
          for (const [index, expected] of [
            'background result',
            'first folded result',
            'third result',
          ].entries())
            expect(delivered[index]).toContain(expected);
        });
      if (adapter === 'codex')
        it.each([
          'protocol-positive',
          'protocol-ambiguous',
          'transport-ambiguous',
          'host-stop-positive',
        ] as const)(
          'keeps actual owner delivery and late input values across %s after observed terminals',
          async (failure) => {
            const provider = new ReplayProvider(adapter);
            const f = await dispatcherFixture({ provider });
            await f.host.start();
            const owner =
              scope === 'dispatcher'
                ? f.host
                : await f.teams.open(
                    (
                      await f.teams.createFromRequest(
                        teamRequest('observed-before-failure'),
                      )
                    ).team_name,
                  );
            await owner.submitInput({ source: 'task', text: 'owner ready' });
            const ownerRuntime = provider.runtimes.at(-1)!;
            const spawned = await owner.teammates.spawn({
              name: 'worker',
              prompt: 'bound work',
              intent: 'observed result before lost admission',
            });
            const controller = provider.controllers.at(-1)!;
            controller.client.holdNextAdmission = true;
            const sending = owner.teammates.send({
              name: spawned.teammate.name,
              prompt: 'pending folded input',
            });
            await vi.waitFor(() =>
              expect(controller.client.admissionPending).toBe(true),
            );
            controller.client.emitCompleted(
              'replay-thread',
              'unbound-first',
              'first observed background',
            );
            controller.client.emit({
              method: 'turn/completed',
              params: {
                threadId: 'replay-thread',
                turn: {
                  id: 'unbound-failed',
                  status: 'failed',
                  error: { message: 'private native failure' },
                },
              },
            });
            controller.client.emit({
              method: 'turn/completed',
              params: {
                threadId: 'replay-thread',
                turn: {
                  id: 'unbound-interrupted',
                  status: 'interrupted',
                  items: [],
                },
              },
            });
            controller.client.emitCompleted(
              'replay-thread',
              'first',
              'observed bound answer',
            );
            controller.client.emitCompleted(
              'replay-thread',
              'unbound-last',
              'last observed background',
            );
            expect(controller.observed).toHaveLength(4);
            const early = await controller.submissions[0]!.settled;
            if (early.kind !== 'completion')
              throw new Error('bound observed answer lost');
            expect(early.completion).toBe(controller.observed[2]);
            let stopping: Promise<void> | null = null;
            if (failure === 'host-stop-positive') {
              if (!(owner.teammates instanceof TeammateCollection))
                throw new Error('missing actual member owner');
              stopping = owner.teammates
                .materializedEntities()
                .find((member) => member.name === spawned.teammate.name)!
                .stopForHost();
            } else if (failure === 'transport-ambiguous')
              controller.client.close();
            else
              controller.client.emit({
                method: 'error',
                params: {
                  threadId: 'replay-thread',
                  willRetry: false,
                  error: { message: 'unscoped connection failure' },
                },
              });
            // Deliveries must enter the owner before the pending acknowledgement retires.
            await vi.waitFor(() =>
              expect(
                ownerRuntime.inputs.filter((text) =>
                  text.startsWith('<task-notification>'),
                ),
              ).toHaveLength(4),
            );
            if (failure === 'protocol-ambiguous')
              controller.client.reject(new Error('negative acknowledgement'));
            else if (failure !== 'transport-ambiguous')
              controller.client.release();
            const receipt = await sending;
            if (failure.endsWith('positive')) {
              expect(receipt.status).toBe('submitted');
              const late = await controller.submissions[1]!.settled;
              if (late.kind !== 'completion')
                throw new Error('late accepted value lost');
              expect(late.completion).toBe(early.completion);
            } else {
              expect(receipt.status).toBe('ambiguous');
              expect(controller.submissions).toHaveLength(1);
            }
            await stopping;
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(controller.observed).toHaveLength(4);
            const delivered = ownerRuntime.inputs.filter((text) =>
              text.startsWith('<task-notification>'),
            );
            expect(delivered).toHaveLength(4);
            for (const [index, text] of [
              'first observed background',
              'turn failed.',
              'observed bound answer',
              'last observed background',
            ].entries())
              expect(delivered[index]).toContain(text);
            expect(
              delivered.every(
                (text) =>
                  !text.includes('private native failure') &&
                  !text.includes('unscoped connection failure'),
              ),
            ).toBe(true);
          },
        );
      it.each([
        ['bound-first', false],
        ['unbound-first', false],
        ['bound-first', true],
        ['unbound-first', true],
      ] as const)(
        'delivers %s terminal order and folds both submissions with observation',
        async (order, failed) => {
          const provider = new ReplayProvider(adapter);
          const f = await dispatcherFixture({ provider });
          await f.host.start();
          const owner =
            scope === 'dispatcher'
              ? f.host
              : await f.teams.open(
                  (await f.teams.createFromRequest(teamRequest('native-order')))
                    .team_name,
                );
          const recipient =
            scope === 'dispatcher' ? f.host.dispatcherAgent.mustAgent() : owner;
          // Owner inbox is live; no submitted owner obligation is invented.
          if ('activate' in recipient) await recipient.activate();
          else await owner.submitInput({ source: 'task', text: 'owner ready' });
          const ownerRuntime = provider.runtimes.at(-1)!;
          const spawned = await owner.teammates.spawn({
            name: 'worker',
            prompt: 'first',
            intent: 'native order',
          });
          const memberRuntime = provider.runtimes.at(-1)!;
          const controller = provider.controllers.at(-1)!;
          await owner.teammates.send({
            name: spawned.teammate.name,
            prompt: 'folded',
          });
          await owner.teammates.send({
            name: spawned.teammate.name,
            prompt: 'third',
          });
          controller.emit(order, failed);
          await vi.waitFor(() =>
            expect(
              ownerRuntime.inputs.filter((text) =>
                text.startsWith('<task-notification>'),
              ),
            ).toHaveLength(3),
          );
          const delivered = ownerRuntime.inputs.filter((text) =>
            text.startsWith('<task-notification>'),
          );
          const expected =
            order === 'bound-first'
              ? [
                  'first folded result',
                  failed ? 'turn failed.' : 'background result',
                  'third result',
                ]
              : [
                  failed ? 'turn failed.' : 'background result',
                  'first folded result',
                  'third result',
                ];
          for (let index = 0; index < 3; index++)
            expect(delivered[index]).toContain(expected[index]);
          const settlements = await Promise.all(
            controller.submissions.map((submission) => submission.settled),
          );
          expect(settlements[0]).toMatchObject({ kind: 'completion' });
          for (let index = 0; index < 2; index++) {
            const settlement = settlements[index]!;
            if (settlement.kind !== 'completion')
              throw new Error('bound result absent');
            expect(settlement.completion).toBe(
              controller.observed[order === 'bound-first' ? 0 : 1],
            );
          }
          const token =
            memberRuntime.context.mcpServers[0]!.env![DREAMUX_MCP_LEASE_ENV]!;
          expect(
            await f.mcpLeases.invoke(token, {
              name: 'send',
              arguments: { name: owner.memberOwner().name, prompt: 'progress' },
            }),
          ).toMatchObject({ ok: true, structured: { status: 'submitted' } });
          expect(ownerRuntime.inputs.at(-1)).toBe(
            `<task from="${spawned.teammate.name}">progress</task>`,
          );
          const before = controller.observed.length;
          controller.failConnection();
          expect(controller.observed).toHaveLength(before);
        },
      );
    });
