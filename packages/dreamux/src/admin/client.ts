/**
 * The admin socket, bound to the shared one-request/one-result JSON invoker.
 *
 * This is the whole of what an out-of-process caller needs: it names a Command,
 * hands it a payload, and gets one JSON answer back. Nothing above it knows a
 * socket is involved, and nothing here knows what any Command means — the same
 * neutral port Core binds in-process for a Channel, bound to a different
 * transport.
 *
 * The two failure kinds stay distinct on purpose. An {@link AdminClientError}
 * means the request reached a Command and that Command refused it; a
 * {@link TransportError} means no answer was ever produced, which is a fact
 * only this side can observe.
 */
import { connect, type Socket } from 'node:net';

import type { JsonInvoker, JsonValue } from '@excitedjs/dreamux-types';

import { errorMessage, TransportError } from '../platform/errors.js';
import { adminSocketPath as defaultAdminSocketPath } from '../platform/paths.js';
import type { AdminRequest, AdminResponse } from './protocol.js';

export interface AdminInvokerOptions {
  socketPath?: string;
  timeoutMs?: number;
}

/** A failure the SERVER reported, carrying the server's own stable code. */
export class AdminClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    /**
     * The next step the failure stated for itself, when it stated one. Absent
     * means the failure never authored one, so a caller renders the code and
     * the message alone.
     */
    public readonly action?: string,
  ) {
    super(message);
    this.name = 'AdminClientError';
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
let nextRequestId = 1;

export function adminJsonInvoker(
  options: AdminInvokerOptions = {},
): JsonInvoker {
  const socketPath = options.socketPath ?? defaultAdminSocketPath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    invoke(method: string, params: JsonValue): Promise<JsonValue> {
      const request: AdminRequest = {
        id: adminRequestId(),
        method,
        // A Command payload is a JSON object; the envelope frames it unchanged.
        params: params as Record<string, unknown>,
      };
      // Whatever came back crossed the wire as JSON and parsed as JSON.
      return sendOne(socketPath, request, timeoutMs) as Promise<JsonValue>;
    },
  };
}

function sendOne(
  socketPath: string,
  request: AdminRequest,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = '';
    let settled = false;
    let sock: Socket | null = null;
    const timer = setTimeout(() => {
      settle(
        new TransportError(
          `admin socket request timed out after ${timeoutMs}ms`,
        ),
      );
      try {
        sock?.destroy();
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    timer.unref();

    function settle(value: unknown, isError = true): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (isError) reject(value);
      else resolve(value);
    }

    try {
      sock = connect(socketPath);
    } catch (err) {
      settle(
        new TransportError(
          `cannot reach admin socket at ${socketPath} - ${errorMessage(err)}`,
        ),
      );
      return;
    }
    sock.setEncoding('utf8');
    sock.on('connect', () => {
      sock.write(`${JSON.stringify(request)}\n`);
    });
    sock.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1 || settled) return;
      const line = buf.slice(0, nl).trim();
      try {
        const response = JSON.parse(line) as AdminResponse;
        if (response.ok) settle(response.result, false);
        else
          settle(
            new AdminClientError(
              response.error.code,
              response.error.message,
              response.error.action,
            ),
          );
      } catch (err) {
        // A reply that will not parse never delivered an answer, whatever it
        // was meant to say.
        settle(
          new TransportError(
            `admin socket returned a malformed response - ${errorMessage(err)}`,
          ),
        );
      }
      sock.end();
    });
    sock.on('error', (err) => {
      if (settled) return;
      // One construction for every socket failure. An absent or refused socket
      // used to be answered with advice instead of with what happened; Node
      // already said what happened, and that sentence is the only concrete
      // fact there is, so it is the one that travels.
      settle(
        new TransportError(
          `admin socket connection to ${socketPath} failed - ${errorMessage(err)}`,
        ),
      );
    });
    sock.on('close', () => {
      settle(new TransportError('admin socket closed without a response'));
    });
  });
}

function adminRequestId(): string {
  return `mcp-${process.pid}-${Date.now()}-${nextRequestId++}`;
}
