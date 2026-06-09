/**
 * Fake codex app-server backed by an in-process `ws` WebSocket.Server.
 *
 * Implements the minimal JSON-RPC surface dreamux drives:
 *   - request:  thread/start  → { thread: { id } }
 *   - request:  thread/resume → { thread: { id: params.threadId } }
 *   - request:  turn/start    → { turn: { id } }, then async:
 *                                 item/completed (agentMessage)
 *                                 turn/completed
 *
 * Lets tests assert behavior (inbound submission, optional active-turn folding,
 * MCP reply-only outbound, approval fail-fast) without spawning a real codex
 * binary.
 */

import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

export interface FakeCodexOptions {
  /** Map turn input → assistant reply. Default: echo. */
  replyFor?: (input: string) => string | null;
  /** Make thread/resume always fail (used for visible-degradation test). */
  failResume?: boolean;
  /** Force turn/start to throw. */
  failTurnStart?: boolean;
  /** Force the first N turn/start requests to throw. */
  failTurnStartAttempts?: number;
  /** Force codex to issue a server-request that the dispatcher must reject. */
  triggerApprovalOnTurn?: boolean;
  /** Delay between turn/start ack and the eventual turn/completed (ms). */
  turnDelayMs?: number;
  /**
   * If true, additional turn/start requests while a fake turn is active are
   * accepted and folded into that active turn instead of completing separately.
   */
  activeTurnFolding?: boolean;
  /**
   * If true, mimic real codex 0.134 behavior: any non-`initialize` RPC
   * before the `initialized` notification arrives returns
   * `{error: {message: 'Not initialized'}}`. Default: true.
   */
  enforceInitHandshake?: boolean;
  /**
   * If true, accept the `initialize` request but never reply — exercises
   * the handshake timeout path. Default: false.
   */
  swallowInitialize?: boolean;
}

export interface FakeCodex {
  readonly url: string;
  /** Number of turn/start requests accepted by the fake. */
  readonly turnsHandled: number;
  /** Number of turn/completed notifications emitted by the fake. */
  readonly turnsCompleted: number;
  /** True once the client has completed the init handshake. */
  readonly initializedAt: number | null;
  /** Method names received in order — useful for asserting handshake order. */
  readonly methodLog: ReadonlyArray<string>;
  /** thread/start params received in order. */
  readonly threadStartParams: ReadonlyArray<Readonly<Record<string, unknown>>>;
  /** thread/resume params received in order. */
  readonly threadResumeParams: ReadonlyArray<Readonly<Record<string, unknown>>>;
  /** thread/inject_items params received in order. */
  readonly injectItemsParams: ReadonlyArray<Readonly<Record<string, unknown>>>;
  close(): Promise<void>;
}

export async function startFakeCodex(opts: FakeCodexOptions = {}): Promise<FakeCodex> {
  const http: HttpServer = createServer();
  const wss = new WebSocketServer({ server: http });
  let nextThreadId = 1;
  let nextTurnId = 1;
  let turnsHandled = 0;
  let turnsCompleted = 0;
  let nextSrvReqId = 100;
  let initializedAt: number | null = null;
  let remainingTurnStartFailures =
    opts.failTurnStartAttempts ?? (opts.failTurnStart === true ? Infinity : 0);
  const methodLog: string[] = [];
  const threadStartParams: Array<Record<string, unknown>> = [];
  const threadResumeParams: Array<Record<string, unknown>> = [];
  const injectItemsParams: Array<Record<string, unknown>> = [];
  const enforceInit = opts.enforceInitHandshake !== false;
  const clients = new Set<WebSocket>();
  let activeTurn: {
    threadId: string;
    turnId: string;
    inputs: string[];
  } | null = null;

  wss.on('connection', (ws: WebSocket) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('message', (data) => {
      let env: { method?: string; id?: number; params?: Record<string, unknown> };
      try {
        env = JSON.parse(data.toString()) as typeof env;
      } catch {
        return;
      }
      if (typeof env.method !== 'string') {
        // No method → it's a response to a server-request (id+result|error).
        // Fake doesn't track those.
        return;
      }
      methodLog.push(env.method);
      if (typeof env.id !== 'number') {
        // Notification (no id). Only one we care about is `initialized`.
        if (env.method === 'initialized') {
          initializedAt = Date.now();
        }
        return;
      }
      handleRequest(ws, env.method, env.id, env.params ?? {});
    });
  });

  function send(ws: WebSocket, frame: unknown): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
  }

  function handleRequest(
    ws: WebSocket,
    method: string,
    id: number,
    params: Record<string, unknown>,
  ): void {
    // Mimic codex 0.134: pre-handshake any non-`initialize` RPC fails fast.
    if (enforceInit && initializedAt === null && method !== 'initialize') {
      send(ws, { id, error: { code: -32002, message: 'Not initialized' } });
      return;
    }
    if (method === 'initialize') {
      if (opts.swallowInitialize === true) {
        // Accept the request, never reply — exercises handshake timeout.
        return;
      }
      send(ws, {
        id,
        result: {
          userAgent: 'fake-codex/0.134-test',
          codexHome: '/tmp/fake-codex-home',
          platformFamily: 'unix',
          platformOs: 'linux',
        },
      });
      return;
    }
    if (method === 'thread/start') {
      threadStartParams.push({ ...params });
      const tid = `thread_fake_${nextThreadId++}`;
      send(ws, { id, result: { thread: { id: tid } } });
      return;
    }
    if (method === 'thread/resume') {
      threadResumeParams.push({ ...params });
      if (opts.failResume === true) {
        send(ws, {
          id,
          error: { code: -32000, message: 'fake codex: resume failed' },
        });
        return;
      }
      const tid = String(params['threadId'] ?? `thread_fake_${nextThreadId++}`);
      send(ws, { id, result: { thread: { id: tid } } });
      return;
    }
    if (method === 'thread/inject_items') {
      injectItemsParams.push({ ...params });
      send(ws, { id, result: {} });
      return;
    }
    if (method === 'turn/start') {
      if (remainingTurnStartFailures > 0) {
        remainingTurnStartFailures -= 1;
        send(ws, {
          id,
          error: { code: -32000, message: 'fake codex: turn/start refused' },
        });
        return;
      }
      const tid = String(params['threadId']);
      const input = extractText(params['input']);
      if (opts.activeTurnFolding === true && activeTurn !== null) {
        const submissionId = `turn_fake_${nextTurnId++}`;
        activeTurn.inputs.push(input);
        send(ws, { id, result: { turn: { id: submissionId } } });
        turnsHandled++;
        return;
      }
      const turnId = `turn_fake_${nextTurnId++}`;
      send(ws, { id, result: { turn: { id: turnId } } });
      turnsHandled++;
      if (opts.activeTurnFolding === true) {
        activeTurn = { threadId: tid, turnId, inputs: [input] };
      }

      void (async () => {
        await delay(opts.turnDelayMs ?? 10);
        if (opts.triggerApprovalOnTurn === true) {
          // Push a server-request for approval; client should reject.
          send(ws, {
            method: 'exec_command_approval',
            id: nextSrvReqId++,
            params: { command: 'rm -rf /' },
          });
          await delay(20);
        }
        const completionInputs =
          opts.activeTurnFolding === true && activeTurn?.turnId === turnId
            ? activeTurn.inputs.slice()
            : [input];
        if (opts.activeTurnFolding === true && activeTurn?.turnId === turnId) {
          activeTurn = null;
        }
        const completionInput = completionInputs.join('\n\n');
        const reply = opts.replyFor
          ? opts.replyFor(completionInput)
          : `echo: ${completionInput}`;
        if (reply !== null) {
          send(ws, {
            method: 'item/completed',
            params: {
              threadId: tid,
              turnId,
              completedAtMs: Date.now(),
              item: { type: 'agentMessage', id: `item_${turnId}`, text: reply },
            },
          });
        }
        send(ws, {
          method: 'turn/completed',
          params: { threadId: tid, turn: { id: turnId, items: [] } },
        });
        turnsCompleted++;
      })();
      return;
    }
    // Unknown method — ack with empty result so the test doesn't hang.
    send(ws, { id, result: {} });
  }

  await new Promise<void>((res) => http.listen(0, '127.0.0.1', res));
  const addr = http.address() as AddressInfo;
  const url = `ws://127.0.0.1:${addr.port}`;

  return {
    url,
    get turnsHandled() {
      return turnsHandled;
    },
    get turnsCompleted() {
      return turnsCompleted;
    },
    get initializedAt() {
      return initializedAt;
    },
    get methodLog() {
      return methodLog;
    },
    get threadStartParams() {
      return threadStartParams;
    },
    get threadResumeParams() {
      return threadResumeParams;
    },
    get injectItemsParams() {
      return injectItemsParams;
    },
    async close(): Promise<void> {
      for (const ws of clients) ws.terminate();
      await new Promise<void>((res) => wss.close(() => res()));
      await new Promise<void>((res) => http.close(() => res()));
    },
  };
}

function extractText(input: unknown): string {
  if (!Array.isArray(input)) return '';
  const first = input[0];
  if (first && typeof first === 'object' && 'text' in first) {
    return String((first as { text: unknown }).text ?? '');
  }
  return '';
}

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
