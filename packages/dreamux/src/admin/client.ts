import { connect, type Socket } from 'node:net';

import { adminSocketPath as defaultAdminSocketPath } from '../platform/paths.js';
import type { AdminRequest, AdminResponse } from './protocol.js';

export interface SendAdminRequestOptions {
  socketPath?: string;
  timeoutMs?: number;
  requestId?: string;
}

export class AdminClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AdminClientError';
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
let nextRequestId = 1;

export function sendAdminRequest(
  method: string,
  params: Record<string, unknown>,
  options: SendAdminRequestOptions = {},
): Promise<unknown> {
  const socketPath = options.socketPath ?? defaultAdminSocketPath();
  const request: AdminRequest = {
    id: options.requestId ?? adminRequestId(),
    method,
    params,
  };
  return sendOne(socketPath, request, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}

export function sendOneAdminRequest(
  socketPath: string,
  request: AdminRequest,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  return sendOne(socketPath, request, timeoutMs);
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
      settle(new Error(`admin socket request timed out after ${timeoutMs}ms`));
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
      settle(err);
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
        else settle(new AdminClientError(response.error.code, response.error.message));
      } catch (err) {
        settle(err);
      }
      sock.end();
    });
    sock.on('error', (err) => {
      if (settled) return;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ECONNREFUSED') {
        settle(
          new Error(
            `cannot reach admin socket at ${socketPath} - is the server running?`,
          ),
        );
      } else {
        settle(err);
      }
    });
    sock.on('close', () => {
      settle(new Error('admin socket closed without a response'));
    });
  });
}

function adminRequestId(): string {
  return `mcp-${process.pid}-${Date.now()}-${nextRequestId++}`;
}
