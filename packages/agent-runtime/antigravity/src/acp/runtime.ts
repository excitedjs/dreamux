import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';

import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type ClientConnection,
  type NewSessionRequest,
  type PromptRequest,
  type PromptResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import type {
  AgentRuntime,
  AgentRuntimeCreateContext,
  AgentRuntimeInterruptOutcome,
  AgentRuntimeStartOutcome,
  AgentRuntimeStatus,
  AgentRuntimeSubmissionInput,
  RuntimeAdmission,
  RuntimeSubmissionSettlement,
} from '@excitedjs/dreamux-types';
import { RuntimeStateFence, SupervisedChild } from '@excitedjs/dreamux-utils';

import type { AntigravityConfig } from '../config.js';
import type { AntigravityRuntimeOptions } from '../runtime-options.js';
import {
  antigravityTranscriptPath,
  resolveAntigravityNativeRoots,
} from '../paths.js';
import { LiveTranscript } from '../transcript/live.js';
import { userInputText, type NativeRecord } from '../transcript/records.js';
import { AcpActivity } from './activity.js';

type Terminal = PromptResponse['stopReason'];

interface Prompt {
  params: PromptRequest;
  inputText: string;
  admission: Promise<RuntimeAdmission>;
  admit: (value: RuntimeAdmission) => void;
  settled: Promise<RuntimeSubmissionSettlement>;
  settle: (value: RuntimeSubmissionSettlement) => void;
  terminal: Promise<Terminal | null>;
  end: (value: Terminal | null) => void;
  writeStarted: boolean;
  admitted: boolean;
  finished: boolean;
  group: NativeGroup | null;
  response: Terminal | null;
  responseOrder: number;
}

interface NativeGroup {
  members: Prompt[];
  text: string | null;
  hasResponse: boolean;
  hasTool: boolean;
  closed: boolean;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** One native ACP process and the session it owns. */
export class AcpRuntime implements AgentRuntime {
  private readonly activity: AcpActivity;
  private readonly fence = new RuntimeStateFence({
    terminate: () => this.terminateForFence(),
    log: (level, message, error) =>
      this.context.logger[level]({ error }, message),
  });
  private child: SupervisedChild | null = null;
  private connection: ClientConnection | null = null;
  private sessionId: string | null;
  private ready = false;
  private stopped = false;
  private startTask: Promise<AgentRuntimeStartOutcome> | null = null;
  private stopTask: Promise<void> | null = null;
  private readonly prompts = new Map<PromptRequest, Prompt>();
  private readonly groups = new Set<NativeGroup>();
  private group: NativeGroup | null = null;
  private transcript: LiveTranscript | null = null;
  private transcriptTimer: NodeJS.Timeout | null = null;
  private readingTranscript = false;
  private readTranscriptAgain = false;
  private responseOrder = 0;

  constructor(
    private readonly context: AgentRuntimeCreateContext<AntigravityConfig>,
    private readonly options: AntigravityRuntimeOptions,
  ) {
    this.sessionId = context.identity.sessionId;
    this.activity = new AcpActivity(context.events);
  }

  start(): Promise<AgentRuntimeStartOutcome> {
    if (this.stopped || this.fence.isFenced)
      return Promise.reject(new Error('Antigravity ACP runtime is stopped'));
    if (this.startTask) return this.startTask;
    if (this.ready)
      return Promise.resolve({
        continuity: this.context.identity.sessionId ? 'resumed' : 'fresh',
      });
    const task = this.startRuntime();
    this.startTask = task;
    void task
      .finally(() => {
        if (this.startTask === task) this.startTask = null;
      })
      .catch(() => undefined);
    return task;
  }

  private async startRuntime(): Promise<AgentRuntimeStartOutcome> {
    const prior = this.sessionId;
    await this.publishStatus('starting');
    try {
      this.assertRunning();
      if (this.child) {
        await this.child.stop();
        this.child = null;
        this.assertRunning();
      }
      await mkdir(dirname(this.options.nativeLogPath), { recursive: true });
      this.assertRunning();
      const args = [
        'acp',
        '--stdio',
        '--dangerously-skip-permissions',
        ...(this.options.skillAddDir === null
          ? []
          : ['--add-dir', this.options.skillAddDir]),
        '--log-file',
        this.options.nativeLogPath,
        ...this.context.config.extra_args,
      ];
      const supervised = new SupervisedChild({
        kind: 'spawn',
        command: this.context.config.bin,
        args,
        options: {
          cwd: this.context.cwd,
          env: { ...process.env, ...this.context.config.extra_env },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      });
      this.child = supervised;
      supervised.onExit(({ code, signal }) =>
        this.transportLost(
          new Error(`Antigravity ACP exited (${code ?? signal ?? 'unknown'})`),
        ),
      );
      supervised.onError((error) => this.transportLost(error));
      const child = await supervised.start();
      this.assertRunning();
      if (!child.stdin || !child.stdout || !child.stderr)
        throw new Error('Antigravity ACP stdio is unavailable');
      child.stderr.resume();
      child.stdin.on('error', () => undefined);
      const bytes = new WritableStream<Uint8Array>({
        write: (chunk) =>
          new Promise<void>((resolve, reject) => {
            child.stdin!.write(chunk, (error) =>
              error ? reject(error) : resolve(),
            );
          }),
      });
      const encoded = ndJsonStream(
        bytes,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      );
      const writer = encoded.writable.getWriter();
      const app = client({ name: 'dreamux-antigravity' })
        .onNotification('session/update', ({ params }) => this.onUpdate(params))
        .onRequest('session/request_permission', () => {
          this.context.logger.warn(
            {},
            'rejected Antigravity ACP permission request; permission prompts are unsupported in Dreamux-managed runtimes',
          );
          return {
            outcome: { outcome: 'cancelled' },
          };
        });
      const connection = app.connect({
        readable: encoded.readable,
        writable: new WritableStream({
          write: async (message) => {
            const prompt =
              'method' in message && message.method === 'session/prompt'
                ? this.prompts.get(message.params as PromptRequest)
                : undefined;
            if (this.stopped || this.fence.isFenced)
              throw new Error('Antigravity ACP runtime is stopped');
            if (prompt) prompt.writeStarted = true;
            await writer.write(message);
            if (prompt) this.admit(prompt);
          },
        }),
      });
      this.connection = connection;
      void connection.closed.then(() => {
        if (this.connection === connection && !this.stopped) {
          this.transportLost(
            asError(
              connection.signal.reason ?? 'Antigravity ACP connection closed',
            ),
          );
        }
      });
      const initialized = await connection.agent.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { session: { compaction: {} } },
        clientInfo: { name: 'dreamux-antigravity', version: '1.0' },
      });
      this.assertRunning();
      if (initialized.protocolVersion !== PROTOCOL_VERSION)
        throw new Error(
          `Unsupported ACP protocol version ${initialized.protocolVersion}`,
        );
      const mcpServers = this.context.mcpServers.map((server) => ({
        name: server.name,
        command: server.command,
        args: [...server.args],
        env: Object.entries(server.env ?? {}).map(([name, value]) => ({
          name,
          value,
        })),
      }));
      const promptAppend = (this.context.systemPrompt?.append ?? []).join(
        '\n\n',
      );
      const setup: NewSessionRequest = {
        cwd: this.context.cwd,
        mcpServers,
        ...(promptAppend === ''
          ? {}
          : {
              _meta: {
                antigravity: {
                  systemPrompt: { append: promptAppend },
                },
              },
            }),
      };
      let session: {
        sessionId?: string;
        configOptions?: Array<{ id: string; currentValue: unknown }> | null;
      };
      if (prior !== null) {
        if (!initialized.agentCapabilities?.loadSession)
          throw new Error(
            'Antigravity ACP does not support exact session load',
          );
        session = await connection.agent.request('session/load', {
          ...setup,
          sessionId: prior,
        });
        if (session.sessionId !== undefined && session.sessionId !== prior)
          throw new Error('Antigravity ACP loaded a different session');
        this.sessionId = prior;
      } else {
        const created = await connection.agent.request('session/new', setup);
        if (!created.sessionId)
          throw new Error('Antigravity ACP did not return a session ID');
        this.sessionId = created.sessionId;
        session = created;
      }
      this.assertRunning();
      await this.fence.publish(() =>
        this.context.state.publish({
          kind: 'session',
          sessionId: this.sessionId!,
        }),
      );
      this.assertRunning();
      for (const [configId, value] of [
        ['model', this.context.config.model],
        ['thought_level', this.context.config.effort],
      ] as const) {
        if (value === null) continue;
        const option = session.configOptions?.find(
          (item) => item.id === configId,
        );
        if (option?.currentValue !== value) {
          await connection.agent.request('session/set_config_option', {
            sessionId: this.sessionId,
            configId,
            value,
          });
          this.assertRunning();
        }
      }
      const env = { ...process.env, ...this.context.config.extra_env };
      this.transcript = await LiveTranscript.open(
        antigravityTranscriptPath(
          resolveAntigravityNativeRoots(env),
          this.sessionId,
        ),
      );
      this.assertRunning();
      await this.publishStatus('ready');
      this.assertRunning();
      if (
        connection.signal.aborted ||
        child.exitCode !== null ||
        child.signalCode !== null
      ) {
        throw new Error('Antigravity ACP exited during startup');
      }
      this.ready = true;
      this.transcriptTimer = setInterval(() => {
        void this.readTranscript();
      }, 100);
      this.transcriptTimer.unref();
      return { continuity: prior === null ? 'fresh' : 'resumed' };
    } catch (error) {
      this.connection?.close(error);
      if (this.child) await this.child.stop();
      if (!this.stopped && !this.fence.isFenced)
        await this.settleStatus('degraded', error);
      throw error;
    }
  }

  submit(input: AgentRuntimeSubmissionInput): Promise<RuntimeAdmission> {
    if (this.stopped || this.fence.isFenced)
      return Promise.resolve({ status: 'stopped' });
    if (!this.ready || !this.connection || !this.sessionId)
      return Promise.resolve({
        status: 'failed',
        error: new Error('Antigravity ACP session is not ready'),
      });
    const admission = deferred<RuntimeAdmission>();
    const settlement = deferred<RuntimeSubmissionSettlement>();
    const terminal = deferred<Terminal | null>();
    const params: PromptRequest = {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text: input.text }],
    };
    const prompt: Prompt = {
      params,
      inputText: input.text,
      admission: admission.promise,
      admit: admission.resolve,
      settled: settlement.promise,
      settle: settlement.resolve,
      terminal: terminal.promise,
      end: terminal.resolve,
      writeStarted: false,
      admitted: false,
      finished: false,
      group: null,
      response: null,
      responseOrder: 0,
    };
    this.prompts.set(params, prompt);
    const request = this.connection.agent.request('session/prompt', params);
    void request.then(
      (response) => this.onTerminal(prompt, response),
      (error: unknown) => this.onRequestError(prompt, asError(error)),
    );
    return prompt.admission;
  }

  private admit(prompt: Prompt): void {
    if (
      prompt.admitted ||
      prompt.finished ||
      this.stopped ||
      this.fence.isFenced
    )
      return;
    prompt.admitted = true;
    prompt.admit({
      status: 'submitted',
      submission: { settled: prompt.settled },
    });
  }

  private onUpdate(notification: SessionNotification): void {
    if (
      !this.ready ||
      this.stopped ||
      notification.sessionId !== this.sessionId
    )
      return;
    this.activity.update(notification);
    void this.readTranscript();
  }

  private onTerminal(prompt: Prompt, response: PromptResponse): void {
    if (prompt.finished || this.stopped) return;
    const reason = response.stopReason;
    if (
      ![
        'end_turn',
        'max_tokens',
        'max_turn_requests',
        'refusal',
        'cancelled',
      ].includes(reason)
    ) {
      this.onRequestError(
        prompt,
        new Error('Antigravity ACP returned an invalid stop reason'),
      );
      return;
    }
    this.admit(prompt);
    if (!prompt.admitted) return;
    prompt.response = reason;
    prompt.responseOrder = ++this.responseOrder;
    void this.readTranscript();
  }

  private async readTranscript(): Promise<void> {
    if (!this.ready || !this.transcript) return;
    if (this.readingTranscript) {
      this.readTranscriptAgain = true;
      return;
    }
    this.readingTranscript = true;
    try {
      do {
        this.readTranscriptAgain = false;
        const records = await this.transcript.read();
        if (!this.ready || this.stopped) return;
        for (const { record } of records) this.observeRecord(record);
        this.completeGroups();
      } while (this.readTranscriptAgain);
      for (const prompt of this.prompts.values()) {
        const reason = prompt.response;
        if (prompt.group !== null || reason === null || reason === 'end_turn')
          continue;
        if (this.prompts.size === 1) this.activity.finishMessages();
        this.finishNativeTerminal([prompt], reason, null);
      }
      this.completeGroups();
    } catch (error) {
      this.transportLost(asError(error));
    } finally {
      this.readingTranscript = false;
    }
  }

  private observeRecord(record: NativeRecord): void {
    if (record.type === 'USER_INPUT') {
      // The SDK serializes the native stdin writes; agy's transcript records
      // the resulting inputs in native order, including duplicate text.
      const input = userInputText(record);
      const pending = [...this.prompts.values()].find(
        (prompt) => prompt.writeStarted && prompt.group === null,
      );
      if (!pending || input !== pending.inputText) {
        throw new Error(
          'Antigravity ACP transcript input does not match the native write order',
        );
      }
      if (this.group?.hasResponse) {
        this.group.closed = true;
        this.group = null;
      }
      if (!this.group) {
        this.group = {
          members: [],
          text: null,
          hasResponse: false,
          hasTool: false,
          closed: false,
        };
        this.groups.add(this.group);
      }
      pending.group = this.group;
      this.group.members.push(pending);
      return;
    }
    if (record.type === 'PLANNER_RESPONSE' && this.group) {
      if (record.toolCalls?.length) {
        this.group.text = null;
        this.group.hasResponse = false;
        this.group.hasTool = true;
      } else if (record.status === 'DONE') {
        this.group.text = record.content || null;
        this.group.hasResponse = true;
      }
    }
  }

  private completeGroups(): void {
    for (const group of this.groups) {
      if (group.members.some((prompt) => prompt.response === null)) continue;
      const selected = group.members.reduce((latest, prompt) =>
        prompt.responseOrder > latest.responseOrder ? prompt : latest,
      );
      const reason = selected.response!;
      if (
        reason === 'end_turn' &&
        !group.closed &&
        this.activity.hasRunningTools()
      )
        continue;
      if (reason === 'end_turn' && !group.hasResponse) {
        const unmatched = [...this.prompts.values()].some(
          (prompt) => prompt.group === null,
        );
        // A cancelled native permission can finish with a failed tool and no
        // post-tool planner response. Its final reply is empty, not the text
        // attached to the earlier tool call.
        if (
          !group.hasTool ||
          !this.activity.hasFailedTools() ||
          unmatched ||
          this.groups.size !== 1
        )
          continue;
      }
      this.groups.delete(group);
      if (this.group === group) this.group = null;
      if (this.prompts.size === group.members.length)
        this.activity.finishMessages();
      if (group.hasTool) this.activity.clearFailedTools();
      this.finishNativeTerminal(group.members, reason, group.text);
    }
  }

  private finishNativeTerminal(
    members: readonly Prompt[],
    reason: Terminal,
    resultText: string | null,
  ): void {
    const completion = this.activity.finishTurn(reason, resultText);
    for (const member of members)
      this.finish(
        member,
        completion === null
          ? { kind: 'stopped' }
          : { kind: 'completion', completion },
        reason,
      );
  }

  private onRequestError(prompt: Prompt, error: Error): void {
    if (prompt.finished) return;
    // A matching JSON-RPC error proves the child received the write even if
    // Node has not yet invoked its stdio callback.
    if (error instanceof RequestError && prompt.writeStarted)
      this.admit(prompt);
    if (prompt.group && this.ready && !this.stopped) {
      this.transportLost(error);
      return;
    }
    if (!prompt.admitted) {
      prompt.admit(
        prompt.writeStarted
          ? { status: 'ambiguous', error }
          : { status: 'failed', error },
      );
    }
    this.finish(prompt, { kind: 'failed', error }, null);
  }

  private finish(
    prompt: Prompt,
    settlement: RuntimeSubmissionSettlement,
    terminal: Terminal | null,
  ): void {
    if (prompt.finished) return;
    prompt.finished = true;
    this.prompts.delete(prompt.params);
    prompt.end(terminal);
    prompt.settle(settlement);
    if (this.prompts.size === 0) this.activity.reset();
  }

  async interrupt(): Promise<AgentRuntimeInterruptOutcome> {
    if (
      this.stopped ||
      !this.connection ||
      !this.sessionId ||
      this.prompts.size === 0
    )
      return { status: 'idle' };
    const pending = new Set(
      [...this.prompts.values()].map((prompt) => prompt.terminal),
    );
    await this.connection.agent.notify('session/cancel', {
      sessionId: this.sessionId,
    });
    while (pending.size) {
      const { promise, terminal } = await Promise.race(
        [...pending].map((promise) =>
          promise.then((terminal) => ({ promise, terminal })),
        ),
      );
      if (terminal === 'cancelled') return { status: 'interrupted' };
      pending.delete(promise);
    }
    return { status: 'idle' };
  }

  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    const wasReady = this.ready;
    this.stopped = true;
    this.ready = false;
    if (this.transcriptTimer) clearInterval(this.transcriptTimer);
    this.convergePrompts();
    if (wasReady)
      this.context.events({
        kind: 'turn.ended',
        occurredAt: Date.now(),
        status: 'interrupted',
        reason: null,
      });
    const task = this.stopRuntime();
    this.stopTask = task;
    void task.catch(() => {
      if (this.stopTask === task) this.stopTask = null;
    });
    return task;
  }

  private async stopRuntime(): Promise<void> {
    if (this.fence.isFenced) {
      await this.fence.terminated();
      return;
    }
    this.connection?.close();
    await this.settleStatus('stopping');
    await this.child?.stop();
    await this.startTask?.catch(() => undefined);
    await this.settleStatus('stopped');
  }

  private async terminateForFence(): Promise<void> {
    this.stopped = true;
    this.ready = false;
    if (this.transcriptTimer) clearInterval(this.transcriptTimer);
    this.convergePrompts();
    this.connection?.close();
    await this.child?.stop();
  }

  private convergePrompts(): void {
    for (const prompt of this.prompts.values()) {
      if (!prompt.admitted) {
        prompt.admit(
          prompt.writeStarted
            ? {
                status: 'ambiguous',
                error: new Error('Antigravity ACP stopped during write'),
              }
            : { status: 'stopped' },
        );
      }
      this.finish(prompt, { kind: 'stopped' }, null);
    }
    this.groups.clear();
    this.group = null;
    this.activity.reset();
  }

  private transportLost(error: Error): void {
    if (this.stopped || !this.ready) return;
    this.ready = false;
    if (this.transcriptTimer) clearInterval(this.transcriptTimer);
    for (const prompt of this.prompts.values())
      this.onRequestError(prompt, error);
    this.groups.clear();
    this.group = null;
    this.activity.reset();
    this.context.events({
      kind: 'turn.ended',
      occurredAt: Date.now(),
      status: 'interrupted',
      reason: error.message,
    });
    this.connection?.close(error);
    void this.child?.stop().catch((stopError: unknown) => {
      this.context.logger.error(
        { error: stopError },
        'Antigravity ACP child cleanup failed',
      );
    });
    this.fence.publishDetached(() =>
      this.context.state.publish({
        kind: 'status',
        status: 'degraded',
        lastError: error.message,
      }),
    );
  }

  private assertRunning(): void {
    this.fence.assertOpen();
    if (this.stopped) throw new Error('Antigravity ACP runtime is stopped');
  }

  private async publishStatus(status: AgentRuntimeStatus): Promise<void> {
    await this.fence.publish(() =>
      this.context.state.publish({ kind: 'status', status }),
    );
  }

  private async settleStatus(
    status: AgentRuntimeStatus,
    error?: unknown,
  ): Promise<void> {
    try {
      await this.fence.publish(() =>
        this.context.state.publish({
          kind: 'status',
          status,
          ...(error === undefined ? {} : { lastError: asError(error).message }),
        }),
      );
    } catch {
      // The state fence owns failure and teardown.
    }
  }
}
