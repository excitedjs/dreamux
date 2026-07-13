import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable, Writable } from 'node:stream';

import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientConnection,
  type ContentBlock,
  type McpServer,
  type PromptResponse,
  type SessionNotification,
  type StopReason,
} from '@agentclientprotocol/sdk';
import {
  ensureOwnerOnlyDir,
  isProcessAlive,
  killProcessGroup,
  removeEmptyLogFile,
} from '@excitedjs/dreamux-utils';

export interface KimiCodeAcpSessionRequest {
  cwd: string;
  mcpServers: readonly McpServer[];
}

export interface KimiCodeAcpPromptResult {
  stopReason: StopReason;
  text: string | null;
}

export interface KimiCodeAcpClient {
  start(): Promise<void>;
  createSession(input: KimiCodeAcpSessionRequest): Promise<string>;
  resumeSession(
    sessionId: string,
    input: KimiCodeAcpSessionRequest,
  ): Promise<string>;
  prompt(sessionId: string, text: string): Promise<KimiCodeAcpPromptResult>;
  stop(): Promise<void>;
  isAlive(): boolean;
}

export interface KimiCodeAcpClientSpec {
  bin: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string | undefined>;
  homeDir: string;
  stderrLogPath: string;
  turnTimeoutMs: number;
  log?: (level: 'info' | 'warn' | 'error', message: string, err?: unknown) => void;
}

export type KimiCodeAcpClientFactory = (
  spec: KimiCodeAcpClientSpec,
) => KimiCodeAcpClient;

interface ActivePrompt {
  sessionId: string;
  chunks: string[];
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function textBlock(text: string): ContentBlock {
  return { type: 'text', text };
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout !== null) clearTimeout(timeout);
  });
}

class LiveKimiCodeAcpClient implements KimiCodeAcpClient {
  private child: ChildProcess | null = null;
  private pid: number | null = null;
  private exited = false;
  private stopped = false;
  private connection: ClientConnection | null = null;
  private activePrompt: ActivePrompt | null = null;

  constructor(private readonly spec: KimiCodeAcpClientSpec) {}

  isAlive(): boolean {
    return this.child !== null && !this.exited && this.connection !== null;
  }

  async start(): Promise<void> {
    if (this.child !== null) {
      throw new Error('KimiCodeAcpClient.start: already started');
    }
    await ensureOwnerOnlyDir(this.spec.homeDir);
    await mkdir(this.spec.cwd, { recursive: true });
    await mkdir(dirname(this.spec.stderrLogPath), { recursive: true });
    const stderrHandle = await open(this.spec.stderrLogPath, 'a', 0o600);
    const spawnOpts: SpawnOptions = {
      cwd: this.spec.cwd,
      env: this.spec.env,
      detached: true,
      stdio: ['pipe', 'pipe', stderrHandle.fd],
    };
    let child: ChildProcess;
    try {
      child = await new Promise<ChildProcess>((resolve, reject) => {
        let settled = false;
        const spawned = spawn(this.spec.bin, this.spec.args, spawnOpts);
        spawned.once('error', (err) => {
          if (settled) return;
          settled = true;
          reject(err);
        });
        spawned.once('spawn', () => {
          if (settled) return;
          settled = true;
          resolve(spawned);
        });
      });
    } finally {
      await stderrHandle.close();
    }
    if (child.pid === undefined) {
      throw new Error('kimi acp child spawned without a pid');
    }
    if (child.stdin === null || child.stdout === null) {
      throw new Error('kimi acp child spawned without stdio pipes');
    }
    this.child = child;
    this.pid = child.pid;
    child.on('error', (err) => {
      this.log('warn', 'kimi acp child error', err);
    });
    child.once('exit', () => {
      this.exited = true;
    });

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout),
    );
    const app = client({ name: 'dreamux-kimi-code' })
      .onRequest(methods.client.session.requestPermission, () => ({
        outcome: { outcome: 'cancelled' },
      }))
      .onNotification(methods.client.session.update, (ctx) => {
        this.onSessionUpdate(ctx.params);
      });
    this.connection = app.connect(stream);
    await this.connection.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
  }

  async createSession(input: KimiCodeAcpSessionRequest): Promise<string> {
    const conn = this.requireConnection();
    const response = await conn.agent.request(methods.agent.session.new, {
      cwd: input.cwd,
      mcpServers: [...input.mcpServers],
    });
    return response.sessionId;
  }

  async resumeSession(
    sessionId: string,
    input: KimiCodeAcpSessionRequest,
  ): Promise<string> {
    const conn = this.requireConnection();
    await conn.agent.request(methods.agent.session.resume, {
      sessionId,
      cwd: input.cwd,
      mcpServers: [...input.mcpServers],
    });
    return sessionId;
  }

  async prompt(sessionId: string, text: string): Promise<KimiCodeAcpPromptResult> {
    const conn = this.requireConnection();
    const active: ActivePrompt = { sessionId, chunks: [] };
    this.activePrompt = active;
    try {
      const response = await withTimeout<PromptResponse>(
        conn.agent.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [textBlock(text)],
        }),
        this.spec.turnTimeoutMs,
        'kimi acp prompt',
      );
      return {
        stopReason: response.stopReason,
        text: active.chunks.length === 0 ? null : active.chunks.join(''),
      };
    } catch (err) {
      try {
        await conn.agent.notify(methods.agent.session.cancel, { sessionId });
      } catch (cancelErr) {
        this.log('warn', 'kimi acp prompt cancellation failed', cancelErr);
      }
      throw err;
    } finally {
      if (this.activePrompt === active) this.activePrompt = null;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.connection?.close(new Error('kimi acp client stopped'));
    const pid = this.pid;
    if (pid !== null) {
      if (isProcessAlive(pid)) {
        killProcessGroup(pid, 'SIGTERM');
        const deadline = Date.now() + 1000;
        while (Date.now() < deadline) {
          if (!isProcessAlive(pid)) break;
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
        }
      }
      killProcessGroup(pid, 'SIGKILL');
    }
    this.exited = true;
    this.connection = null;
    this.child = null;
    await removeEmptyLogFile(this.spec.stderrLogPath);
  }

  private requireConnection(): ClientConnection {
    if (this.connection === null || this.stopped || this.exited) {
      throw new Error('kimi acp client is not running');
    }
    return this.connection;
  }

  private onSessionUpdate(notification: SessionNotification): void {
    const active = this.activePrompt;
    if (active === null || notification.sessionId !== active.sessionId) return;
    const update = notification.update;
    if (
      update.sessionUpdate === 'agent_message_chunk' &&
      update.content.type === 'text'
    ) {
      active.chunks.push(update.content.text);
    }
  }

  private log(
    level: 'info' | 'warn' | 'error',
    message: string,
    err?: unknown,
  ): void {
    this.spec.log?.(level, message, err);
    if (this.spec.log === undefined && level !== 'info') {
      console.error(`[kimi-code] ${message}: ${errMessage(err)}`);
    }
  }
}

export function createDefaultKimiCodeAcpClient(
  spec: KimiCodeAcpClientSpec,
): KimiCodeAcpClient {
  return new LiveKimiCodeAcpClient(spec);
}
