import { renderChannelInput } from '@excitedjs/dreamux-utils';

import type { MimoClient } from './client.js';
import { MimoBusyError } from './client.js';
import type { MimoCodeConfig } from './config.js';
import type {
  MimoServerFactory,
  MimoServerHandle,
  MimoServerStartOptions,
} from './supervisor.js';
import { createDefaultMimoServer } from './supervisor.js';
import { MIMO_CODE_AGENT_RUNTIME_CAPABILITIES } from './provider.js';
import { MIMO_CODE_PROVIDER_REF } from './provider-ref.js';
import type {
  AgentRuntime,
  AgentRuntimeCapabilities,
  AgentRuntimeCreateContext,
  AgentRuntimeIdentity,
  AgentRuntimeLastResult,
  AgentRuntimeStatus,
  AgentRuntimeTextInput,
  AgentRuntimeTurnResult,
  DreamuxLogger,
  InboundDeliveryHooks,
  InboundTurnInput,
  TurnSettledSignal,
} from '@excitedjs/dreamux-types';

export interface MimoCodeRuntimeDeps {
  context: AgentRuntimeCreateContext<MimoCodeConfig>;
  serverFactory?: MimoServerFactory;
}

let nextRuntimeInstanceId = 0;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

export function selectMimoSystemPrompt(
  systemPrompt: AgentRuntimeCreateContext<MimoCodeConfig>['systemPrompt'],
): string | null {
  if (systemPrompt === undefined) return null;
  const append = (systemPrompt.append ?? []).filter((prompt) => prompt !== '');
  if (systemPrompt.replace !== undefined) {
    return [systemPrompt.replace, ...append].filter((prompt) => prompt !== '').join(
      '\n\n',
    );
  }
  if (append.length === 0) return null;
  return append.join('\n\n');
}

export class MimoCodeRuntime implements AgentRuntime {
  readonly providerRef = MIMO_CODE_PROVIDER_REF;

  private readonly runtimeId: string;
  private readonly config: MimoCodeConfig;
  private readonly context: AgentRuntimeCreateContext<MimoCodeConfig>;
  private readonly logger: DreamuxLogger | null;
  private readonly serverFactory: MimoServerFactory;
  private readonly runtimeInstanceId = ++nextRuntimeInstanceId;
  private status: AgentRuntimeStatus = 'declared';
  private stopped = false;
  private server: MimoServerHandle | null = null;
  private sessionId: string | null;
  private resumed: boolean;
  private queue: Promise<void> = Promise.resolve();
  private readonly seenChannelSourceIds = new Set<string>();
  private readonly seenTextSourceIds = new Set<string>();
  private turnCounter = 0;
  private queuedTurnCount = 0;
  private idlePromise: Promise<void> | null = null;
  private idleResolve: (() => void) | null = null;
  private lastResult: AgentRuntimeLastResult | null = null;

  constructor(identity: AgentRuntimeIdentity, deps: MimoCodeRuntimeDeps) {
    this.runtimeId = identity.runtime_id;
    this.context = deps.context;
    this.config = deps.context.config;
    this.logger = deps.context.logger ?? null;
    this.serverFactory = deps.serverFactory ?? createDefaultMimoServer;
    this.sessionId = identity.checkpoint_id ?? null;
    this.resumed = this.sessionId !== null;
  }

  getStatus(): AgentRuntimeStatus {
    return this.status;
  }

  getCapabilities(): AgentRuntimeCapabilities {
    return MIMO_CODE_AGENT_RUNTIME_CAPABILITIES;
  }

  getCheckpoint(): { id: string } | null {
    return this.sessionId === null ? null : { id: this.sessionId };
  }

  wasCheckpointResumed(): boolean {
    return this.resumed;
  }

  async getLast(): Promise<AgentRuntimeLastResult | null> {
    return this.lastResult;
  }

  async getContext(): Promise<null> {
    return null;
  }

  async start(): Promise<void> {
    if (this.context.paths === undefined) {
      throw new Error('mimo-code runtime requires a path context in the create context');
    }
    if (this.context.state === undefined) {
      throw new Error('mimo-code runtime requires a state sink in the create context');
    }
    await this.setStatus('starting');
    try {
      const startOptions: MimoServerStartOptions = {
        runtimeId: this.runtimeId,
        config: this.config,
        cwd: this.context.cwd,
        paths: this.context.paths,
        mcpServers: this.context.mcpServers,
        systemPrompt: selectMimoSystemPrompt(this.context.systemPrompt),
        ...(this.context.injectEnv !== undefined
          ? { injectEnv: this.context.injectEnv }
          : {}),
      };
      this.server = await this.serverFactory(startOptions);
      if (this.sessionId === null) {
        this.sessionId = await this.client().createSession({
          cwd: this.context.cwd,
          model: this.config.model,
          agent: this.config.agent,
          systemPrompt: startOptions.systemPrompt,
          mcpServers: this.context.mcpServers,
        });
        await this.context.state.setCheckpoint({ id: this.sessionId });
      }
      await this.setStatus('ready');
    } catch (err) {
      await this.setStatus('degraded', err);
      throw err;
    }
  }

  async resume(): Promise<void> {
    await this.start();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.setStatus('stopping');
    const server = this.server;
    this.server = null;
    if (server !== null) {
      try {
        await server.stop();
      } catch (err) {
        this.log('warn', 'mimo-code server stop errored', err);
      }
    }
    this.queuedTurnCount = 0;
    this.resolveIdleWaitersIfIdle();
    await this.setStatus('stopped');
  }

  async completionInput(input: AgentRuntimeTextInput): Promise<AgentRuntimeTurnResult> {
    if (this.stopped) return { status: 'stopped' };
    const key = input.sourceId;
    if (key !== undefined && key !== '' && this.seenTextSourceIds.has(key)) {
      return { status: 'duplicate' };
    }
    if (key !== undefined && key !== '') this.seenTextSourceIds.add(key);
    const turnId = this.nextTurnId();
    this.recordQueuedTurnStart();
    void this.runTurnOnQueue(input.text, turnId).then(
      (resultText) => this.markTurnSucceeded(turnId, resultText),
      (err) => this.markTurnFailed(turnId, err),
    );
    return { status: 'submitted', turnId };
  }

  async channelInput(
    input: InboundTurnInput,
    hooks: InboundDeliveryHooks = {},
  ): Promise<AgentRuntimeTurnResult> {
    if (this.stopped) return { status: 'stopped' };
    const key = input.sourceId;
    if (key !== '' && this.seenChannelSourceIds.has(key)) {
      return { status: 'duplicate' };
    }
    if (key !== '') this.seenChannelSourceIds.add(key);
    try {
      await hooks.onAccepted?.(input);
    } catch (err) {
      this.log('warn', 'mimo-code onAccepted hook failed', err);
    }
    const turnId = this.nextTurnId();
    this.recordQueuedTurnStart();
    void this.runTurnOnQueue(renderChannelInput(input), turnId).then(
      (resultText) => this.markTurnSucceeded(turnId, resultText),
      (err) => this.markTurnFailed(turnId, err),
    );
    return { status: 'submitted', turnId };
  }

  waitIdle(): Promise<void> {
    if (this.queuedTurnCount === 0) return Promise.resolve();
    if (this.idlePromise === null) {
      this.idlePromise = new Promise((resolve) => {
        this.idleResolve = resolve;
      });
    }
    return this.idlePromise;
  }

  private runTurnOnQueue(
    text: string,
    turnId: string,
  ): Promise<string | null> {
    const run = this.queue.then(() => this.runTurn(text, turnId));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runTurn(text: string, turnId: string): Promise<string | null> {
    if (this.stopped) throw new Error('mimo-code runtime is stopped');
    const sessionId = this.sessionId;
    if (sessionId === null) {
      throw new Error('mimo-code runtime has no bound session');
    }
    const startedAt = Date.now();
    for (;;) {
      try {
        const result = await this.client().sendMessage(sessionId, {
          text,
          turnId,
          timeoutMs: this.config.turn_timeout_ms,
          model: this.config.model,
          agent: this.config.agent,
          systemPrompt: selectMimoSystemPrompt(this.context.systemPrompt),
        });
        if (result.text !== null) this.lastResult = { text: result.text };
        return result.text;
      } catch (err) {
        if (!(err instanceof MimoBusyError)) throw err;
        if (Date.now() - startedAt >= this.config.turn_timeout_ms) {
          throw new Error(`MiMo session stayed busy for turn ${turnId}`);
        }
        await sleep(50);
      }
    }
  }

  private async markTurnSucceeded(
    turnId: string,
    resultText: string | null,
  ): Promise<void> {
    this.recordQueuedTurnEnd();
    this.context.onTurnSettled?.({
      turnId,
      status: 'completed',
      result: { text: resultText },
    });
    if (this.stopped) return;
    if (this.status !== 'ready') await this.setStatus('ready');
  }

  private async markTurnFailed(turnId: string, err: unknown): Promise<void> {
    this.recordQueuedTurnEnd();
    this.log('error', `mimo-code turn ${turnId} failed`, err);
    const settled: TurnSettledSignal = {
      turnId,
      status: this.stopped ? 'stopped' : 'failed',
      result: { text: null },
      error: err instanceof Error ? err : new Error(String(err)),
    };
    this.context.onTurnSettled?.(settled);
    if (this.stopped) return;
    await this.setStatus('degraded', err);
  }

  private recordQueuedTurnStart(): void {
    this.queuedTurnCount += 1;
  }

  private recordQueuedTurnEnd(): void {
    this.queuedTurnCount = Math.max(0, this.queuedTurnCount - 1);
    this.resolveIdleWaitersIfIdle();
  }

  private resolveIdleWaitersIfIdle(): void {
    if (this.queuedTurnCount !== 0) return;
    const resolve = this.idleResolve;
    this.idlePromise = null;
    this.idleResolve = null;
    resolve?.();
  }

  private client(): MimoClient {
    if (this.server === null) {
      throw new Error('mimo-code server is not started');
    }
    return this.server.client;
  }

  private nextTurnId(): string {
    return `mimo-turn-${this.runtimeInstanceId}-${++this.turnCounter}`;
  }

  private async setStatus(
    status: AgentRuntimeStatus,
    err?: unknown,
  ): Promise<void> {
    this.status = status;
    try {
      await this.context.state?.setStatus(
        status,
        err !== undefined ? { last_error: errMessage(err) } : {},
      );
    } catch (stateErr) {
      this.log('warn', 'mimo-code status persistence failed', stateErr);
    }
  }

  private log(level: 'info' | 'warn' | 'error', msg: string, err?: unknown): void {
    if (err === undefined) {
      this.logger?.[level]?.(msg);
      return;
    }
    this.logger?.[level]?.({ err }, msg);
  }
}
