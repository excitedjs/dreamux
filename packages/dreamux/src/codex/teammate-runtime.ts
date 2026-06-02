/**
 * Server-owned Codex teammate runtime.
 *
 * Unlike @excitedjs/tm's invocation-owned Codex daemon registry, this runtime
 * is a child of the long-running dreamux server. That keeps the daemon alive
 * across short-lived shell calls made by Codex.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { CodexTeammateRepo } from '../db/repository.js';
import type { CodexTeammateRow, CodexTeammateStatus } from '../db/types.js';
import { createFailFastApprovalHandler } from '../dispatcher/approval.js';
import { extractAssistantText, runTurn } from './events.js';
import { performInitializeHandshake } from './handshake.js';
import { CodexWsClient } from './rpc.js';
import { CodexProcess, type CodexProcessOptions } from './supervisor.js';
import type {
  ThreadResumeResponse,
  ThreadStartResponse,
} from './types.js';
import {
  codexTeammateSocketPath,
  codexTeammateStderrLog,
  codexTeammateStdoutLog,
} from '../runtime/paths.js';

const EMPTY_TURN_PLACEHOLDER = '(no text reply this turn)';

export interface CodexTeammateRuntimeDeps {
  teammates: CodexTeammateRepo;
  codexBinPath?: string;
  codexProcessFactory?: (opts: CodexProcessOptions) => CodexProcess;
  codexClientFactory?: (socketPath: string) => CodexWsClient;
  resolveExtraArgs?: (row: CodexTeammateRow) => string[];
  handshakeTimeoutMs?: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, err?: unknown) => void;
}

export interface CodexTeammateTurnResult {
  name: string;
  thread_id: string;
  turn_id: string;
  assistant_text: string;
}

export class CodexTeammateRuntime {
  private process: CodexProcess | null = null;
  private client: CodexWsClient | null = null;
  private threadId: string | null = null;
  private status: CodexTeammateStatus = 'declared';
  private turnQueue: Promise<void> = Promise.resolve();
  private readonly log: NonNullable<CodexTeammateRuntimeDeps['log']>;

  constructor(
    public readonly row: CodexTeammateRow,
    private readonly deps: CodexTeammateRuntimeDeps,
  ) {
    this.log = deps.log ?? ((lvl, msg, err) => {
      const prefix = `[codex teammate ${row.name}] ${lvl}`;
      if (err !== undefined) console.error(prefix, msg, err);
      else console.error(prefix, msg);
    });
    this.threadId = row.thread_id;
    this.status = row.status;
  }

  get name(): string {
    return this.row.name;
  }

  getStatus(): CodexTeammateStatus {
    return this.status;
  }

  getThreadId(): string | null {
    return this.threadId;
  }

  async start(): Promise<void> {
    if (this.status === 'ready' && this.client !== null) return;
    this.setStatus('starting');
    this.deps.teammates.setStatus(this.name, 'starting', {
      last_started_at: Date.now(),
    });

    try {
      const socketPath = codexTeammateSocketPath(this.name);
      const extraArgs = this.deps.resolveExtraArgs?.(this.row) ?? [];
      const factory = this.deps.codexProcessFactory ?? ((o) => new CodexProcess(o));
      this.process = factory({
        socketPath,
        cwd: this.row.cwd,
        createCwd: false,
        stdoutLogPath: codexTeammateStdoutLog(this.name),
        stderrLogPath: codexTeammateStderrLog(this.name),
        binPath: this.deps.codexBinPath,
        extraArgs,
      });
      mkdirSync(dirname(socketPath), { recursive: true });
      await this.process.start();

      const clientFactory =
        this.deps.codexClientFactory ?? ((sock) => new CodexWsClient({ socketPath: sock }));
      this.client = clientFactory(socketPath);
      this.client.onClose((reason) => {
        if (this.status === 'stopping' || this.status === 'stopped') return;
        this.log('warn', `codex connection closed: ${reason.message}`);
        this.setStatus('degraded');
        this.deps.teammates.setStatus(this.name, 'degraded', {
          last_error: reason.message,
        });
      });
      await this.client.ready();
      this.client.setServerRequestHandler(createFailFastApprovalHandler());

      const initResponse = await performInitializeHandshake(this.client, {
        ...(this.deps.handshakeTimeoutMs !== undefined
          ? { timeoutMs: this.deps.handshakeTimeoutMs }
          : {}),
      });
      this.log(
        'info',
        `codex initialized: ${initResponse.userAgent} (home=${initResponse.codexHome}, ${initResponse.platformOs})`,
      );

      await this.resolveThread();
      this.setStatus('ready');
      this.deps.teammates.setStatus(this.name, 'ready', {
        last_ready_at: Date.now(),
        last_error: null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log('error', `start failed: ${msg}`, err);
      this.setStatus('degraded');
      this.deps.teammates.setStatus(this.name, 'degraded', {
        last_error: msg,
      });
      await this.cleanupOnFailure();
      throw err;
    }
  }

  async send(prompt: string): Promise<CodexTeammateTurnResult> {
    const next = this.turnQueue.then(
      () => this.runOneTurn(prompt),
      () => this.runOneTurn(prompt),
    );
    this.turnQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async stop(): Promise<void> {
    this.setStatus('stopping');
    this.deps.teammates.setStatus(this.name, 'stopping');
    await this.turnQueue;
    if (this.client !== null) {
      try {
        this.client.close();
      } catch {
        /* best effort */
      }
      this.client = null;
    }
    if (this.process !== null) {
      await this.process.reap();
      this.process = null;
    }
    this.setStatus('stopped');
    this.deps.teammates.setStatus(this.name, 'stopped');
  }

  private async resolveThread(): Promise<void> {
    if (this.client === null) throw new Error('client not initialized');
    const existing = this.row.thread_id;
    if (existing === null) {
      const res = await this.client.request<ThreadStartResponse>(
        'thread/start',
        { cwd: this.row.cwd },
      );
      this.threadId = res.thread.id;
      this.deps.teammates.setThreadId(this.name, this.threadId);
      this.log('info', `started fresh thread ${this.threadId}`);
      return;
    }

    await this.client.request<ThreadResumeResponse>('thread/resume', {
      threadId: existing,
      cwd: this.row.cwd,
    });
    this.threadId = existing;
    this.log('info', `resumed thread ${this.threadId}`);
  }

  private async runOneTurn(prompt: string): Promise<CodexTeammateTurnResult> {
    if (this.client === null || this.threadId === null || this.status !== 'ready') {
      throw new Error(`codex teammate '${this.name}' is not ready`);
    }
    try {
      const turn = await runTurn(this.client, this.threadId, prompt, this.row.cwd);
      const assistantText =
        extractAssistantText(turn) ?? EMPTY_TURN_PLACEHOLDER;
      this.deps.teammates.recordTurn(this.name, turn.turnId, assistantText);
      return {
        name: this.name,
        thread_id: this.threadId,
        turn_id: turn.turnId,
        assistant_text: assistantText,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log('error', `turn failed: ${msg}`, err);
      this.setStatus('degraded');
      this.deps.teammates.setStatus(this.name, 'degraded', {
        last_error: msg,
      });
      throw err;
    }
  }

  private async cleanupOnFailure(): Promise<void> {
    if (this.client !== null) {
      try {
        this.client.close();
      } catch {
        /* */
      }
      this.client = null;
    }
    if (this.process !== null) {
      await this.process.reap();
      this.process = null;
    }
  }

  private setStatus(status: CodexTeammateStatus): void {
    this.status = status;
  }
}
