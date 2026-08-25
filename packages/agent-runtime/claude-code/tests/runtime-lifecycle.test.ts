/**
 * Claude Code RUNTIME lifecycle tests.
 *
 * Companion to `runtime-activity.test.ts`: that suite drives the protocol seam
 * (`ClaudeCodeStreamRpc` -> `handleProtocolEvent`) and owns the completion-token
 * matrix. This suite drives the RUNTIME object itself — `ClaudeCodeRuntime` over
 * its injectable `sessionFactory` / `state` / `resolveTranscriptPath` seams —
 * and covers what the runtime, not the protocol, is responsible for:
 *
 *  - provider-private source-id reservation (share while pending, commit on an
 *    accepted or ambiguous admission, release on a proven pre-admission
 *    failure, bound the committed set);
 *  - resident-session lifecycle (one session for concurrent starts, stop
 *    fencing during start / queued work / queued live steer, recovery after a
 *    failed native turn);
 *  - checkpoint + transcript association persistence (no ghost association, reap
 *    on persistence failure, no admitted native command before the association
 *    commits, old association preserved on a failed resume write);
 *  - idle accounting and folding.
 *
 * The fakes never receive an instruction like "produce two completions". A fake
 * session only replays the NATIVE protocol events one answered command window
 * produces (`command_lifecycle` started, `result`, `command_lifecycle`
 * completed) through the real `spec.onProtocolEvent` seam, or — for the
 * RPC-backed fakes — real NDJSON stdout lines through a real
 * `ClaudeCodeStreamRpc`. Completion identity is therefore always derived, never
 * scripted.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultDispatcherClaudeCodeConfig } from '../src/config.js';
import { ClaudeCodeStreamRpc } from '../src/rpc.js';
import { ClaudeCodeRuntime } from '../src/runtime.js';
import type { ClaudeCodeRuntimeDeps } from '../src/runtime-deps.js';
import type {
  ClaudeCodeSession,
  ClaudeCodeSessionFactory,
  ClaudeCodeSessionSpec,
  TurnOutcome,
  TurnSubmitOptions,
} from '../src/supervisor.js';
import type {
  AgentRuntimeIdentity,
  AgentRuntimePathContext,
  AgentRuntimeResumeCheckpoint,
  AgentRuntimeStateCallbacks,
  AgentRuntimeStatus,
  RuntimeCompletion,
  RuntimeSubmissionSettlement,
} from '@excitedjs/dreamux-types';

const TEST_SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OLD_SESSION_ID = '22222222-2222-4222-8222-222222222222';

describe('claude-code runtime source reservation', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-claude-lifecycle-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('shares and releases a concurrent source reservation after proven unsupported steer', async () => {
    const stdin = new RecordingStdin();
    const sessions: RpcSession[] = [];
    const runtime = runtimeWith(root, {
      sessionFactory: rpcSessionFactory(sessions, stdin),
    });
    await runtime.start();

    const initial = await runtime.completionInput({
      text: 'first',
      sourceId: 'initial',
    });
    if (initial.status !== 'submitted') {
      throw new Error(`expected submitted, got ${initial.status}`);
    }
    await waitFor(() => stdin.writes.length === 1);
    const live = sessions[0]!;

    const first = runtime.completionInput({ text: 'follow', sourceId: 'same' });
    const concurrent = runtime.completionInput({
      text: 'follow duplicate',
      sourceId: 'same',
    });
    // No `msg_lifecycle_v1`: the CLI cannot prove live-steer admission, so the
    // steer is a PROVEN pre-admission failure — nothing crossed to the native side.
    live.emit(initLine([]));

    const firstAdmission = await first;
    const concurrentAdmission = await concurrent;
    // One reservation shared by both concurrent sends: the very same admission
    // value, not merely an equal-looking one.
    expect(concurrentAdmission).toBe(firstAdmission);
    expect(firstAdmission.status).toBe('failed');
    if (firstAdmission.status !== 'failed') {
      throw new Error('expected a proven pre-admission failure');
    }
    expect(firstAdmission.error.message).toMatch(/msg_lifecycle_v1/u);

    // A proven `failed` releases the key: the source is retryable, and the retry
    // is a fresh admission rather than the still-pending shared one.
    const retry = await runtime.completionInput({
      text: 'safe retry',
      sourceId: 'same',
    });
    expect(retry).not.toBe(firstAdmission);
    expect(retry.status).toBe('failed');
    // Three failed steers, zero extra native writes.
    expect(stdin.writes).toHaveLength(1);

    await runtime.stop();
    await expect(initial.submission.settled).resolves.toEqual({ kind: 'stopped' });
  });

  it('commits one accepted concurrent source reservation and returns one RuntimeSubmission', async () => {
    const stdin = new RecordingStdin();
    const sessions: RpcSession[] = [];
    const runtime = runtimeWith(root, {
      sessionFactory: rpcSessionFactory(sessions, stdin),
    });
    await runtime.start();

    const initial = await runtime.channelInput({
      text: 'first',
      sourceId: 'initial',
    });
    if (initial.status !== 'submitted') {
      throw new Error(`expected submitted, got ${initial.status}`);
    }
    await waitFor(() => stdin.writes.length === 1);
    const live = sessions[0]!;

    const first = runtime.channelInput({ text: 'follow', sourceId: 'same' });
    const concurrent = runtime.channelInput({
      text: 'follow duplicate',
      sourceId: 'same',
    });
    live.emit(initLine(['msg_lifecycle_v1']));
    const [firstAdmission, concurrentAdmission] = await Promise.all([
      first,
      concurrent,
    ]);

    expect(firstAdmission.status).toBe('submitted');
    expect(concurrentAdmission).toBe(firstAdmission);
    if (firstAdmission.status !== 'submitted') {
      throw new Error('expected a shared submitted admission');
    }
    // One accepted send => one submission, and it is a DIFFERENT send from the
    // initial one (submission identity never implies folding).
    expect(firstAdmission.submission).not.toBe(initial.submission);
    // Exactly one extra native write for the two concurrent duplicates.
    expect(stdin.writes).toHaveLength(2);

    // An accepted admission commits the key, so the same source can never be
    // written a second time.
    await expect(
      runtime.channelInput({ text: 'accepted retry', sourceId: 'same' }),
    ).resolves.toEqual({ status: 'duplicate' });
    expect(stdin.writes).toHaveLength(2);

    const [initialUuid, followUuid] = live.commandUuids;
    live.emit(lifecycleLine(initialUuid!, 'started'));
    live.emit(lifecycleLine(followUuid!, 'started'));
    live.emit(successResultLine('final result'));
    live.emit(lifecycleLine(initialUuid!, 'completed'));
    live.emit(lifecycleLine(followUuid!, 'completed'));
    await runtime.waitIdle();

    const completion = completedOf(await initial.submission.settled);
    expect(completion.resultText).toBe('final result');
    expect(completionOf(await firstAdmission.submission.settled)).toBe(completion);
    await runtime.stop();
  });

  it('commits a post-write ambiguous source and never writes its retry', async () => {
    // The steer's stdin write callback (write index 1) is withheld, so its
    // native admission is unknown until the test decides it.
    const stdin = new RecordingStdin(1);
    const sessions: RpcSession[] = [];
    const runtime = runtimeWith(root, {
      sessionFactory: rpcSessionFactory(sessions, stdin),
    });
    await runtime.start();

    const initial = await runtime.completionInput({
      text: 'first',
      sourceId: 'initial',
    });
    if (initial.status !== 'submitted') {
      throw new Error(`expected submitted, got ${initial.status}`);
    }
    await waitFor(() => stdin.writes.length === 1);
    sessions[0]!.emit(initLine(['msg_lifecycle_v1']));

    const ambiguous = runtime.completionInput({
      text: 'ambiguous follow',
      sourceId: 'same',
    });
    await waitFor(() => stdin.writes.length === 2);
    stdin.finish(new Error('native callback lost'));

    const admission = await ambiguous;
    expect(admission.status).toBe('ambiguous');
    if (admission.status !== 'ambiguous') {
      throw new Error('expected an ambiguous admission');
    }
    expect(admission.error.message).toContain('native callback lost');

    // The bytes may have crossed, so the key is committed and the retry is
    // refused rather than duplicated onto the native session.
    await expect(
      runtime.completionInput({ text: 'must not retry', sourceId: 'same' }),
    ).resolves.toEqual({ status: 'duplicate' });
    expect(stdin.writes).toHaveLength(2);

    await runtime.stop();
    await expect(initial.submission.settled).resolves.toEqual({ kind: 'stopped' });
  });

  it('bounds committed source ids while retaining pending and recent duplicates', async () => {
    const sessions: FakeSession[] = [];
    const runtime = runtimeWith(root, {
      sessionFactory: fakeSessionFactory(sessions),
      sourceIdDedupeWindow: 2,
    });
    await runtime.start();

    for (const sourceId of ['one', 'two', 'three']) {
      const admission = await runtime.completionInput({
        text: sourceId,
        sourceId,
      });
      if (admission.status !== 'submitted') {
        throw new Error(`expected submitted for ${sourceId}`);
      }
      expect(completedOf(await admission.submission.settled).resultText).toBe(
        'done',
      );
      await runtime.waitIdle();
    }

    // Inside the window of 2: still refused.
    await expect(
      runtime.completionInput({ text: 'recent duplicate', sourceId: 'three' }),
    ).resolves.toEqual({ status: 'duplicate' });

    // Evicted from the window: admitted again rather than leaking memory forever.
    const evicted = await runtime.completionInput({
      text: 'evicted retry',
      sourceId: 'one',
    });
    if (evicted.status !== 'submitted') {
      throw new Error('expected the evicted source to be admitted again');
    }
    expect(completedOf(await evicted.submission.settled).resultText).toBe('done');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.prompts).toEqual([
      'one',
      'two',
      'three',
      'evicted retry',
    ]);
    await runtime.stop();
  });
});

describe('claude-code resident session lifecycle', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-claude-lifecycle-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('joins concurrent starts and creates one resident session', async () => {
    const sessions: FakeSession[] = [];
    const spawnGate = deferred<void>();
    const runtime = runtimeWith(root, {
      sessionFactory: fakeSessionFactory(sessions, {
        onStart: () => spawnGate.promise,
      }),
    });

    const first = runtime.start();
    const second = runtime.start();
    // The second caller JOINS the in-flight start: the very same promise, so no
    // second startRuntime pass and no second child can exist.
    expect(second).toBe(first);
    await waitFor(() => sessions.length === 1);

    spawnGate.resolve();
    await first;
    await second;
    expect(runtime.getStatus()).toBe('ready');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.startCalls).toBe(1);
    await runtime.stop();
  });

  it('does not publish ready or leak a session when stop wins during start', async () => {
    const sessions: FakeSession[] = [];
    const spawnGate = deferred<void>();
    const recorder = recordingState();
    const runtime = runtimeWith(root, {
      state: recorder.state,
      sessionFactory: fakeSessionFactory(sessions, {
        onStart: () => spawnGate.promise,
      }),
    });

    const starting = runtime.start();
    await waitFor(() => sessions.length === 1);
    const stopping = runtime.stop();
    spawnGate.resolve();

    await expect(starting).rejects.toThrow(/stopped/u);
    await stopping;

    // `ready` was never published, and the in-flight child was reaped exactly
    // once — no orphan is left behind by the losing start.
    expect(recorder.statuses).toEqual(['starting', 'stopping', 'stopped']);
    expect(runtime.getStatus()).toBe('stopped');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.stopCalls).toBe(1);
    expect(sessions[0]!.isAlive()).toBe(false);
  });

  it('does not create a replacement session for queued work after stop', async () => {
    const sessions: FakeSession[] = [];
    const runtime = runtimeWith(root, {
      sessionFactory: fakeSessionFactory(sessions),
    });
    await runtime.start();
    // The resident child is gone: the next turn would normally re-spawn.
    sessions[0]!.die();

    const admissionPromise = runtime.channelInput({
      sourceId: 'queued',
      text: 'go',
    });
    const stopping = runtime.stop();
    const admission = await admissionPromise;
    await stopping;

    expect(admission).toEqual({ status: 'stopped' });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.prompts).toEqual([]);
  });

  it('does not submit a queued live steer after stop wins', async () => {
    const sessions: FakeSession[] = [];
    const steerGate = deferred<void>();
    const runtime = runtimeWith(root, {
      sessionFactory: fakeSessionFactory(sessions, {
        holdTurns: true,
        steerGate: () => steerGate.promise,
        onStop: () => {
          steerGate.resolve();
          return Promise.resolve();
        },
      }),
    });
    await runtime.start();

    const initial = await runtime.channelInput({
      sourceId: 'initial',
      text: 'initial',
    });
    if (initial.status !== 'submitted') {
      throw new Error(`expected submitted, got ${initial.status}`);
    }
    await waitFor(() => sessions[0]!.prompts.length === 1);

    const firstSteer = runtime.channelInput({
      sourceId: 'steer-1',
      text: 'steer one',
    });
    await waitFor(() => sessions[0]!.steers.length === 1);
    const secondSteer = runtime.channelInput({
      sourceId: 'steer-2',
      text: 'steer two',
    });
    await flush();

    const order: string[] = [];
    void initial.submission.settled.then(() => {
      order.push('settled');
    });
    await runtime.stop().then(() => {
      order.push('stopped');
    });
    const [firstAdmission, secondAdmission] = await Promise.all([
      firstSteer,
      secondSteer,
    ]);

    // The queued second steer never reached the native session.
    expect(sessions[0]!.steers).toEqual(['steer one']);
    expect(secondAdmission).toEqual({ status: 'stopped' });
    expect(firstAdmission).toEqual({ status: 'stopped' });
    await expect(initial.submission.settled).resolves.toEqual({ kind: 'stopped' });
    // stop() may not resolve while an accepted submission is still unsettled.
    expect(order).toEqual(['settled', 'stopped']);
  });

  it('returns stopped and writes no queued pre-init steer after runtime stop', async () => {
    const stdin = new RecordingStdin();
    const sessions: RpcSession[] = [];
    const runtime = runtimeWith(root, {
      sessionFactory: rpcSessionFactory(sessions, stdin),
    });
    await runtime.start();

    const initial = await runtime.completionInput({
      text: 'first',
      sourceId: 'completion:first',
    });
    if (initial.status !== 'submitted') {
      throw new Error(`expected submitted, got ${initial.status}`);
    }
    await waitFor(() => stdin.writes.length === 1);
    const live = sessions[0]!;

    // Parked: live-steer capability is still undecided, so nothing is written.
    const follow = runtime.completionInput({
      text: 'second',
      sourceId: 'completion:second',
    });
    await flush();
    expect(stdin.writes).toHaveLength(1);

    const order: string[] = [];
    void initial.submission.settled.then(() => {
      order.push('settled');
    });
    const stopping = runtime.stop().then(() => {
      order.push('stopped');
    });
    // Capability readiness arriving after stop must not release the parked steer.
    live.emit(initLine(['msg_lifecycle_v1']));
    await flush();
    expect(stdin.writes).toHaveLength(1);
    await stopping;

    expect(stdin.writes).toHaveLength(1);
    await expect(follow).resolves.toEqual({ status: 'stopped' });
    await expect(initial.submission.settled).resolves.toEqual({ kind: 'stopped' });
    expect(order).toEqual(['settled', 'stopped']);
  });

  it('returns a rejected promise instead of throwing when start follows stop', async () => {
    const sessions: FakeSession[] = [];
    const runtime = runtimeWith(root, {
      sessionFactory: fakeSessionFactory(sessions),
    });
    await runtime.start();
    await runtime.stop();

    // A synchronous throw here would escape every `void runtime.start()` call
    // site and crash the host event loop instead of surfacing as a rejection.
    const restart = runtime.start();
    expect(restart).toBeInstanceOf(Promise);
    await expect(restart).rejects.toThrow(/stopped/u);
    expect(runtime.getStatus()).toBe('stopped');
    expect(sessions).toHaveLength(1);
  });

  it('creates a fresh session for the next input after a failed native turn', async () => {
    const sessions: FakeSession[] = [];
    const runtime = runtimeWith(root, {
      sessionFactory: fakeSessionFactory(sessions, {
        onStart: (index) =>
          index === 1
            ? Promise.reject(new Error('replacement spawn failed'))
            : Promise.resolve(),
      }),
    });
    await runtime.start();
    sessions[0]!.die();

    const failed = await runtime.channelInput({
      sourceId: 'first',
      text: 'first',
    });
    if (failed.status !== 'submitted') {
      throw new Error(`expected submitted, got ${failed.status}`);
    }
    const failure = await failed.submission.settled;
    expect(failure.kind).toBe('failed');
    if (failure.kind !== 'failed') throw new Error('expected a failed settlement');
    expect(failure.error.message).toContain('replacement spawn failed');
    await waitFor(() => runtime.getStatus() === 'degraded');
    // The child that could not spawn was reaped, not retained as the resident one.
    expect(sessions[1]!.stopCalls).toBe(1);

    // The failure must not wedge the runtime: the next input spawns a fresh
    // resident session and completes normally.
    const recovered = await runtime.channelInput({
      sourceId: 'second',
      text: 'second',
    });
    if (recovered.status !== 'submitted') {
      throw new Error(`expected submitted, got ${recovered.status}`);
    }
    expect(completedOf(await recovered.submission.settled).resultText).toBe(
      'done',
    );
    expect(sessions).toHaveLength(3);
    expect(sessions[2]!.prompts).toEqual(['second']);
    await waitFor(() => runtime.getStatus() === 'ready');
    await runtime.stop();
  });
});

describe('claude-code checkpoint and transcript association', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-claude-lifecycle-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('does not publish a ghost association when a fresh child start fails', async () => {
    const sessions: FakeSession[] = [];
    const recorder = recordingState();
    const runtime = runtimeWith(root, {
      state: recorder.state,
      sessionFactory: fakeSessionFactory(sessions, {
        onStart: () => Promise.reject(new Error('fresh child failed')),
      }),
      resolveTranscriptPath: async () => join(root, 'fresh.jsonl'),
    });

    await expect(runtime.start()).rejects.toThrow('fresh child failed');
    // Nothing spawned => no association may be published anywhere.
    expect(recorder.checkpoints).toEqual([]);
    expect(runtime.getCheckpoint()).toBeNull();
    expect(sessions[0]!.stopCalls).toBe(1);
    expect(recorder.statuses).toEqual(['starting', 'degraded']);
  });

  it('reaps a fresh child when checkpoint persistence fails', async () => {
    const sessions: FakeSession[] = [];
    const runtime = runtimeWith(root, {
      state: {
        async setStatus() {
          /* no-op */
        },
        async setCheckpoint() {
          throw new Error('checkpoint write failed');
        },
      },
      sessionFactory: fakeSessionFactory(sessions),
      resolveTranscriptPath: async () => join(root, 'fresh.jsonl'),
    });

    await expect(runtime.start()).rejects.toThrow('checkpoint write failed');
    // A live child whose association could not be persisted is unreachable
    // forever: it must be reaped, not left running.
    expect(runtime.getCheckpoint()).toBeNull();
    expect(sessions[0]!.isAlive()).toBe(false);
    expect(sessions[0]!.stopCalls).toBe(1);
  });

  it('does not admit a turn before the fresh checkpoint commits', async () => {
    const checkpointGate = deferred<void>();
    const sessions: FakeSession[] = [];
    const runtime = runtimeWith(root, {
      state: {
        async setStatus() {
          /* no-op */
        },
        async setCheckpoint() {
          await checkpointGate.promise;
        },
      },
      sessionFactory: fakeSessionFactory(sessions),
      resolveTranscriptPath: async () => join(root, 'fresh.jsonl'),
    });

    const starting = runtime.start();
    await waitFor(() => sessions.length === 1 && sessions[0]!.isAlive());
    const admission = runtime.channelInput({
      sourceId: 'before-checkpoint',
      text: 'wait for association',
    });
    await sleep(20);
    // The child is alive, but no native command may cross before the
    // association is durable — otherwise a crash orphans an unrecoverable turn.
    expect(sessions[0]!.prompts).toEqual([]);
    expect(runtime.getCheckpoint()).toBeNull();

    checkpointGate.resolve();
    await starting;
    const accepted = await admission;
    if (accepted.status !== 'submitted') {
      throw new Error(`expected submitted, got ${accepted.status}`);
    }
    expect(completedOf(await accepted.submission.settled).resultText).toBe(
      'done',
    );
    expect(sessions[0]!.prompts).toEqual(['wait for association']);
    expect(runtime.getCheckpoint()).toEqual({
      id: TEST_SESSION_ID,
      transcript_locator: join(root, 'fresh.jsonl'),
    });
    await runtime.stop();
  });

  it('preserves the old association when resumed locator persistence fails', async () => {
    const oldCheckpoint: AgentRuntimeResumeCheckpoint = {
      id: OLD_SESSION_ID,
      transcript_locator: join(root, 'old.jsonl'),
    };
    const sessions: FakeSession[] = [];
    const runtime = runtimeWith(
      root,
      {
        state: {
          async setStatus() {
            /* no-op */
          },
          async setCheckpoint() {
            throw new Error('resume checkpoint write failed');
          },
        },
        sessionFactory: fakeSessionFactory(sessions),
        resolveTranscriptPath: async () => join(root, 'refreshed.jsonl'),
      },
      { runtime_id: 'flow', checkpoint: oldCheckpoint },
    );

    await expect(runtime.start()).rejects.toThrow(
      'resume checkpoint write failed',
    );
    // A failed refresh must never downgrade the association we already hold.
    expect(runtime.getCheckpoint()).toEqual(oldCheckpoint);
    expect(runtime.wasCheckpointResumed()).toBe(true);
    expect(sessions[0]!.isAlive()).toBe(false);
    expect(sessions[0]!.stopCalls).toBe(1);
  });
});

describe('claude-code runtime idle and fold accounting', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-claude-lifecycle-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('waitIdle resolves after a steered channel turn without counting the steer', async () => {
    const sessions: FakeSession[] = [];
    const runtime = runtimeWith(root, {
      sessionFactory: fakeSessionFactory(sessions, { holdTurns: true }),
    });
    await runtime.start();

    const initial = await runtime.channelInput({
      sourceId: 'msg-1',
      text: 'first',
    });
    if (initial.status !== 'submitted') {
      throw new Error(`expected submitted, got ${initial.status}`);
    }
    await waitFor(() => sessions[0]!.prompts.length === 1);

    const steer = await runtime.channelInput({
      sourceId: 'msg-2',
      text: 'second',
    });
    if (steer.status !== 'submitted') {
      throw new Error(`expected submitted, got ${steer.status}`);
    }
    expect(sessions[0]!.prompts).toEqual(['first']);
    expect(sessions[0]!.steers).toEqual(['second']);

    let idle = false;
    void runtime.waitIdle().then(() => {
      idle = true;
    });
    await flush();
    expect(idle).toBe(false);

    // ONE native answer window closes. If the live steer had been counted as a
    // second queued turn, the runtime would still consider itself busy here.
    sessions[0]!.answer();
    await waitFor(() => idle);

    const completion = completedOf(await initial.submission.settled);
    expect(completionOf(await steer.submission.settled)).toBe(completion);
    await runtime.stop();
  });

  it('folds a pre-init follow-up into the same RuntimeSubmission window after capability readiness', async () => {
    const stdin = new RecordingStdin();
    const sessions: RpcSession[] = [];
    const runtime = runtimeWith(root, {
      sessionFactory: rpcSessionFactory(sessions, stdin),
    });
    await runtime.start();

    const initial = await runtime.completionInput({
      text: 'first',
      sourceId: 'completion:first',
    });
    if (initial.status !== 'submitted') {
      throw new Error(`expected submitted, got ${initial.status}`);
    }
    await waitFor(() => stdin.writes.length === 1);
    const live = sessions[0]!;

    const followPromise = runtime.completionInput({
      text: 'second',
      sourceId: 'completion:second',
    });
    let followSettled = false;
    void followPromise.finally(() => {
      followSettled = true;
    });
    await flush();
    // Admission is withheld until live-steer capability is decided.
    expect(followSettled).toBe(false);
    expect(stdin.writes).toHaveLength(1);

    live.emit(initLine(['msg_lifecycle_v1']));
    const follow = await followPromise;
    expect(follow.status).toBe('submitted');
    if (follow.status !== 'submitted') {
      throw new Error('expected the released steer to be submitted');
    }
    // Two accepted sends are two distinct submissions. Folding is proven by the
    // completion token below, never by submission identity.
    expect(follow.submission).not.toBe(initial.submission);
    expect(stdin.writes).toHaveLength(2);
    expect(parseWrite(stdin.writes[1])).toMatchObject({ priority: 'next' });

    const [initialUuid, followUuid] = live.commandUuids;
    live.emit(lifecycleLine(initialUuid!, 'started'));
    live.emit(lifecycleLine(followUuid!, 'started'));
    // ONE native result for both started commands: a native fold.
    live.emit(successResultLine('final result'));
    live.emit(lifecycleLine(initialUuid!, 'completed'));
    live.emit(lifecycleLine(followUuid!, 'completed'));

    const completion = completedOf(await initial.submission.settled);
    expect(completionOf(await follow.submission.settled)).toBe(completion);
    expect(Object.isFrozen(completion)).toBe(true);
    expect(completion.resultText).toBe('final result');
    expect(completion.truncated).toBe(false);
    // The display representative is the first STARTED command of the fold.
    expect(completion.displaySubmission).toBe(initial.submission);
    await runtime.waitIdle();
    await runtime.stop();
  });
});

// ─── runtime construction ───────────────────────────────────────────────────

type RuntimeOverrides = Partial<ClaudeCodeRuntimeDeps> &
  Pick<ClaudeCodeRuntimeDeps, 'sessionFactory'>;

function runtimeWith(
  root: string,
  overrides: RuntimeOverrides,
  identity: AgentRuntimeIdentity = { runtime_id: 'flow', checkpoint: null },
): ClaudeCodeRuntime {
  return new ClaudeCodeRuntime(identity, {
    config: defaultDispatcherClaudeCodeConfig(),
    cwd: root,
    state: noopState(),
    paths: paths(root),
    mcpServers: [],
    resolveBinPath: (bin) => bin,
    generateSessionId: () => TEST_SESSION_ID,
    resolveTranscriptPath: async () => join(root, 'native-session.jsonl'),
    activitySink: () => undefined,
    ...overrides,
  });
}

function noopState(): AgentRuntimeStateCallbacks {
  return {
    async setStatus() {
      /* no-op */
    },
    async setCheckpoint() {
      /* no-op */
    },
  };
}

function recordingState(): {
  state: AgentRuntimeStateCallbacks;
  statuses: AgentRuntimeStatus[];
  checkpoints: AgentRuntimeResumeCheckpoint[];
} {
  const statuses: AgentRuntimeStatus[] = [];
  const checkpoints: AgentRuntimeResumeCheckpoint[] = [];
  return {
    statuses,
    checkpoints,
    state: {
      async setStatus(status) {
        statuses.push(status);
      },
      async setCheckpoint(checkpoint) {
        checkpoints.push(checkpoint);
      },
    },
  };
}

function paths(root: string): AgentRuntimePathContext {
  return {
    cacheDir: () => join(root, 'cache'),
    logsDir: () => join(root, 'logs'),
    runtimeSocketDirs: () => [join(root, 'run')],
  };
}

// ─── fake resident session (native protocol events, no wire) ────────────────

interface FakeSession extends ClaudeCodeSession {
  /** Prompts written as an INITIAL native command of a resident window. */
  readonly prompts: string[];
  /** Prompts written as a live steer into an already-running window. */
  readonly steers: string[];
  startCalls: number;
  stopCalls: number;
  /** Close the held native window: one `result` for every started command. */
  answer(outcome?: TurnOutcome): void;
  /** Simulate an unexpected child death without notifying the runtime. */
  die(): void;
}

interface FakeSessionBehaviour {
  /** Runs before the child becomes alive; may reject or block. */
  onStart?: (index: number) => Promise<void>;
  onStop?: (index: number) => Promise<void>;
  /** Hold each submitted turn open until `answer()` (default: answer inline). */
  holdTurns?: boolean;
  /** Gate every live steer (default: the write confirms inline). */
  steerGate?: () => Promise<void>;
}

interface NativeWindow {
  initial: string;
  steers: string[];
}

function fakeSessionFactory(
  sessions: FakeSession[],
  behaviour: FakeSessionBehaviour = {},
): ClaudeCodeSessionFactory {
  return (spec: ClaudeCodeSessionSpec): ClaudeCodeSession => {
    const index = sessions.length;
    let alive = false;
    let stopRequested = false;
    let window: NativeWindow | null = null;
    let resolveTurn: (() => void) | null = null;

    const closeWindow = (outcome: TurnOutcome): void => {
      const current = window;
      window = null;
      if (current === null) throw new Error('no native window to answer');
      emitNativeAnswer(spec, current, outcome);
    };

    const session: FakeSession = {
      prompts: [],
      steers: [],
      startCalls: 0,
      stopCalls: 0,
      async start() {
        session.startCalls += 1;
        await behaviour.onStart?.(index);
        // Mirrors LiveClaudeCodeSession.assertStartAllowed: a start that loses
        // the race to stop() must never publish a live child.
        if (stopRequested) {
          throw new Error('ClaudeCodeSession.start: stopped during start');
        }
        alive = true;
      },
      async stop() {
        stopRequested = true;
        session.stopCalls += 1;
        alive = false;
        await behaviour.onStop?.(index);
        const resolve = resolveTurn;
        resolveTurn = null;
        window = null;
        // A reaped child answers nothing: the held turn simply ends.
        resolve?.();
      },
      isAlive: () => alive,
      setOnExit() {
        /* the runtime registers before start; these fakes never exit on their own */
      },
      async submitTurn(prompt: string, _options?: TurnSubmitOptions, commandUuid?: string) {
        session.prompts.push(prompt);
        window = { initial: commandUuid ?? randomUUID(), steers: [] };
        if (behaviour.holdTurns === true) {
          await new Promise<void>((resolve) => {
            resolveTurn = resolve;
          });
          return;
        }
        closeWindow(okOutcome());
      },
      async steerTurn(prompt: string, _options?: TurnSubmitOptions, commandUuid?: string) {
        session.steers.push(prompt);
        window?.steers.push(commandUuid ?? randomUUID());
        await behaviour.steerGate?.();
      },
      answer(outcome = okOutcome()) {
        const resolve = resolveTurn;
        if (resolve === null) throw new Error('no held native turn to answer');
        resolveTurn = null;
        closeWindow(outcome);
        resolve();
      },
      die() {
        alive = false;
      },
    };
    sessions.push(session);
    return session;
  };
}

/**
 * Replay the native events one answered command window produces, in wire order:
 * every command that ran is `started`, ONE `result` answers them all, and each
 * command then reaches its terminal lifecycle state.
 */
function emitNativeAnswer(
  spec: ClaudeCodeSessionSpec,
  window: NativeWindow,
  outcome: TurnOutcome,
): void {
  const commandUuids = [window.initial, ...window.steers];
  for (const commandUuid of commandUuids) {
    spec.onProtocolEvent?.({ kind: 'command_lifecycle', commandUuid, state: 'started' });
  }
  spec.onProtocolEvent?.({ kind: 'result', outcome });
  for (const commandUuid of commandUuids) {
    spec.onProtocolEvent?.({ kind: 'command_lifecycle', commandUuid, state: 'completed' });
  }
}

function okOutcome(): TurnOutcome {
  return {
    isError: false,
    text: 'done',
    sessionId: TEST_SESSION_ID,
    subtype: 'success',
    errors: [],
    hasStructuredOutput: false,
  };
}

// ─── RPC-backed resident session (real rpc over a fake stdin) ───────────────

class RecordingStdin {
  writable = true;
  readonly writes: string[] = [];
  private held: ((error?: Error | null) => void) | null = null;

  /** `deferIndex` withholds one write's confirmation callback until `finish()`. */
  constructor(private readonly deferIndex: number | null = null) {}

  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    const index = this.writes.length;
    this.writes.push(chunk);
    if (this.deferIndex !== null && index === this.deferIndex) {
      this.held = callback ?? null;
    } else {
      callback?.(null);
    }
    return true;
  }

  finish(error?: Error): void {
    const callback = this.held;
    this.held = null;
    callback?.(error ?? null);
  }
}

interface RpcSession extends ClaudeCodeSession {
  /** Command uuids the runtime handed to this session, in submission order. */
  readonly commandUuids: string[];
  emit(line: Record<string, unknown>): void;
}

function rpcSessionFactory(
  sessions: RpcSession[],
  stdin: RecordingStdin,
): ClaudeCodeSessionFactory {
  return (spec: ClaudeCodeSessionSpec): ClaudeCodeSession => {
    const rpc = new ClaudeCodeStreamRpc(stdin as unknown as Writable, {
      turnTimeoutMs: 5_000,
      reapOnTimeout: () => undefined,
      onProtocolEvent: spec.onProtocolEvent,
    });
    const commandUuids: string[] = [];
    let alive = false;
    const session: RpcSession = {
      commandUuids,
      async start() {
        alive = true;
      },
      async stop() {
        rpc.failPending(new Error('claude resident session stopped mid-turn'));
        alive = false;
      },
      isAlive: () => alive,
      setOnExit() {
        /* no-op */
      },
      submitTurn(prompt: string, options?: TurnSubmitOptions, commandUuid?: string) {
        const uuid = commandUuid ?? randomUUID();
        commandUuids.push(uuid);
        return rpc.submitTurn(prompt, options, uuid);
      },
      steerTurn(prompt: string, options?: TurnSubmitOptions, commandUuid?: string) {
        const uuid = commandUuid ?? randomUUID();
        commandUuids.push(uuid);
        return rpc.steerTurn(prompt, options, uuid);
      },
      emit(line: Record<string, unknown>) {
        rpc.onStdoutChunk(`${JSON.stringify(line)}\n`);
      },
    };
    sessions.push(session);
    return session;
  };
}

// ─── native stdout line builders (real wire shapes only) ────────────────────

function initLine(capabilities: readonly string[]): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'init',
    session_id: TEST_SESSION_ID,
    model: 'claude-sonnet-4-5',
    capabilities,
  };
}

function lifecycleLine(
  commandUuid: string,
  state: 'started' | 'completed',
): Record<string, unknown> {
  return { type: 'command_lifecycle', command_uuid: commandUuid, state };
}

function successResultLine(text: string): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    session_id: TEST_SESSION_ID,
  };
}

// ─── settlement helpers ─────────────────────────────────────────────────────

function completionOf(settlement: RuntimeSubmissionSettlement): RuntimeCompletion {
  if (settlement.kind !== 'completion') {
    throw new Error(`expected a completion settlement, got ${settlement.kind}`);
  }
  return settlement.completion;
}

function completedOf(
  settlement: RuntimeSubmissionSettlement,
): Extract<RuntimeCompletion, { status: 'completed' }> {
  const completion = completionOf(settlement);
  if (completion.status !== 'completed') {
    throw new Error(`expected a completed token: ${completion.error.message}`);
  }
  return completion;
}

// ─── misc ───────────────────────────────────────────────────────────────────

function parseWrite(chunk: string | undefined): Record<string, unknown> {
  return JSON.parse(chunk ?? '{}') as Record<string, unknown>;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error('waitFor timed out');
}

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
