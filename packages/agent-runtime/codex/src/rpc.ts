/**
 * Codex app-server WebSocket JSON-RPC client.
 *
 * Adapted from claudemux's `plugins/claudemux/core/src/engines/codex/rpc.ts`
 * (excitedjs/dreamux#2 §"关键代码复用结论"). Two differences:
 *   - uses the public `ws` npm package instead of the vendored `#ws`;
 *   - replaces the `codex-protocol` import with the in-tree `./types.ts`.
 *
 * The wire envelope codex emits is *not* strict JSON-RPC 2.0 — the
 * `jsonrpc` version field is omitted. Frame routing is by structural probe:
 *   - method + id + params → request
 *   - method + params      → notification
 *   - id + result|error    → response
 */

import WebSocket, { type RawData } from 'ws';

import type {
  ErrResponseEnvelope,
  OkResponseEnvelope,
  RequestEnvelope,
  ResponseEnvelope,
  ServerNotification,
  ServerRequest,
} from './types.js';

export interface CodexWsClientOptions {
  /** Unix socket path the codex daemon listens on (production). */
  socketPath?: string;
  /** `ws://...` URL — used by tests pointing at an in-process WebSocket.Server. */
  url?: string;
}

export type NotificationHandler = (notif: ServerNotification) => void;
export type ServerRequestHandler = (req: ServerRequest) => Promise<unknown>;
export type CloseHandler = (reason: Error) => void;

/**
 * A long-running WebSocket connection to one codex app-server daemon.
 * One instance per Dispatcher; lifetime matches the dispatcher runtime.
 */
export class CodexWsClient {
  private readonly ws: WebSocket;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private readonly notifHandlers: NotificationHandler[] = [];
  private readonly closeHandlers: CloseHandler[] = [];
  private serverReqHandler: ServerRequestHandler = async () => {
    throw new Error(
      'codex sent a server-request but no handler is installed. ' +
        'Install one via setServerRequestHandler() before driving turns. ' +
        'See issue #2 §"信任模型" — approval handlers must fail loudly, not return null.',
    );
  };
  private nextId = 1;
  private readonly opened: Promise<void>;
  private closed = false;
  private closeReason: Error | null = null;

  constructor(opts: CodexWsClientOptions) {
    // `perMessageDeflate: false` is load-bearing — the codex app-server's
    // WebSocket upgrade is strict about Sec-WebSocket-Extensions and would
    // reject the `ws` package's default permessage-deflate proposal.
    // Verified empirically against codex 0.133.0 by claudemux.
    const wsOpts = { perMessageDeflate: false };
    if (opts.socketPath !== undefined) {
      this.ws = new WebSocket(`ws+unix://${opts.socketPath}`, wsOpts);
    } else if (opts.url !== undefined) {
      this.ws = new WebSocket(opts.url, wsOpts);
    } else {
      throw new Error('CodexWsClient: socketPath or url required');
    }

    this.opened = new Promise<void>((res, rej) => {
      this.ws.once('open', () => res());
      this.ws.once('error', (e) =>
        rej(e instanceof Error ? e : new Error(String(e))),
      );
    });

    this.ws.on('message', (data) => this.onFrame(data));
    this.ws.on('close', () =>
      this.tearDown(new Error('codex daemon closed the connection')),
    );
    this.ws.on('error', (e) =>
      this.tearDown(e instanceof Error ? e : new Error(String(e))),
    );
  }

  ready(): Promise<void> {
    return this.opened;
  }

  onNotification(handler: NotificationHandler): void {
    this.notifHandlers.push(handler);
  }

  /**
   * Install handler for server→client requests (approval, attestation, etc).
   * The handler's return value becomes the response `result`; a throw becomes
   * the response `error.message`.
   *
   * For dreamux MVP this should fail-fast on any approval request — see
   * issue #2 §"信任模型" (approval-policy=never + fail-fast handler).
   */
  setServerRequestHandler(handler: ServerRequestHandler): void {
    this.serverReqHandler = handler;
  }

  onClose(handler: CloseHandler): void {
    if (this.closed) {
      handler(this.closeReason ?? new Error('codex client closed'));
      return;
    }
    this.closeHandlers.push(handler);
  }

  request<R = unknown>(method: string, params: unknown): Promise<R> {
    if (this.closed) {
      return Promise.reject(this.closeReason ?? new Error('codex client closed'));
    }
    const id = this.nextId++;
    const envelope: RequestEnvelope = { method, id, params };
    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      try {
        this.ws.send(JSON.stringify(envelope));
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /**
   * Send a JSON-RPC notification (no `id`, no response expected). codex 0.134+
   * uses these for the `initialized` handshake confirmation, among others.
   */
  notify(method: string, params: unknown): void {
    if (this.closed) {
      throw this.closeReason ?? new Error('codex client closed');
    }
    const envelope = { method, params };
    this.ws.send(JSON.stringify(envelope));
  }

  close(): void {
    this.tearDown(new Error('codex client closed by caller'));
    this.ws.terminate();
  }

  private onFrame(data: RawData): void {
    let parsed: unknown;
    try {
      const text = typeof data === 'string' ? data : data.toString('utf8');
      parsed = JSON.parse(text);
    } catch (e) {
      this.tearDown(
        new Error(`codex daemon sent a non-JSON frame: ${(e as Error).message}`),
      );
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      this.tearDown(new Error('codex daemon sent a non-object envelope'));
      return;
    }
    const env = parsed as Record<string, unknown>;

    const hasMethod = typeof env['method'] === 'string';
    const hasId = typeof env['id'] === 'number';
    const hasResult = 'result' in env;
    const hasError = 'error' in env;

    if (hasMethod && hasId) {
      this.handleServerRequest(env as unknown as ServerRequest).catch((err) =>
        this.tearDown(err instanceof Error ? err : new Error(String(err))),
      );
    } else if (hasMethod) {
      this.dispatchNotification(env as unknown as ServerNotification);
    } else if (hasId && (hasResult || hasError)) {
      this.handleResponse(env as unknown as ResponseEnvelope);
    } else {
      this.tearDown(
        new Error('codex daemon sent envelope with neither id nor method'),
      );
    }
  }

  private handleResponse(env: ResponseEnvelope): void {
    const pending = this.pending.get(env.id);
    if (pending === undefined) return;
    this.pending.delete(env.id);
    if ('error' in env) {
      pending.reject(new Error(env.error.message));
    } else {
      pending.resolve(env.result);
    }
  }

  private dispatchNotification(notif: ServerNotification): void {
    for (const h of this.notifHandlers) {
      try {
        h(notif);
      } catch {
        // Handler throws must not poison the dispatch loop.
      }
    }
  }

  private async handleServerRequest(env: ServerRequest): Promise<void> {
    try {
      const result = await this.serverReqHandler(env);
      const reply: OkResponseEnvelope = { id: env.id, result };
      this.ws.send(JSON.stringify(reply));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const reply: ErrResponseEnvelope = { id: env.id, error: { message } };
      this.ws.send(JSON.stringify(reply));
    }
  }

  private tearDown(reason: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    for (const { reject } of this.pending.values()) reject(reason);
    this.pending.clear();
    for (const handler of this.closeHandlers) {
      try {
        handler(reason);
      } catch {
        // Close observers are cleanup hooks; one throw must not mask teardown.
      }
    }
  }
}
