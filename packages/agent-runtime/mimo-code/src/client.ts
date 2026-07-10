import { Buffer } from 'node:buffer';
import type { AgentRuntimeMcpServer } from '@excitedjs/dreamux-types';

export interface MimoCreateSessionInput {
  cwd: string;
  model: string | null;
  agent: string | null;
  systemPrompt: string | null;
  mcpServers: readonly AgentRuntimeMcpServer[];
}

export interface MimoMessageInput {
  text: string;
  turnId: string;
  timeoutMs: number;
  model: string | null;
  agent: string | null;
  systemPrompt: string | null;
}

export interface MimoMessageResult {
  text: string | null;
}

export interface MimoClient {
  createSession(input: MimoCreateSessionInput): Promise<string>;
  sendMessage(
    sessionId: string,
    input: MimoMessageInput,
  ): Promise<MimoMessageResult>;
}

export interface MimoHttpClientOptions {
  baseUrl: string;
  password?: string | null;
  username?: string | null;
}

export class MimoHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'MimoHttpError';
  }
}

export class MimoBusyError extends MimoHttpError {
  constructor(message = 'MiMo session is busy') {
    super(message, 409);
    this.name = 'MimoBusyError';
  }
}

export class MimoHttpClient implements MimoClient {
  private readonly baseUrl: string;
  private readonly password: string | null;
  private readonly username: string;

  constructor(options: MimoHttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.password = options.password ?? null;
    this.username = options.username ?? 'mimocode';
  }

  async createSession(_input: MimoCreateSessionInput): Promise<string> {
    const response = await this.request('/session', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const body = await readJsonObject(response);
    const id = readString(body, ['id', 'sessionID', 'sessionId']);
    if (id === null) {
      throw new Error('MiMo create session response did not include a session id');
    }
    return id;
  }

  async sendMessage(
    sessionId: string,
    input: MimoMessageInput,
  ): Promise<MimoMessageResult> {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      const response = await this.request(
        `/session/${encodeURIComponent(sessionId)}/message`,
        {
          method: 'POST',
          body: JSON.stringify({
            ...(input.model !== null ? { modelRef: input.model } : {}),
            ...(input.agent !== null ? { agent: input.agent } : {}),
            ...(input.systemPrompt !== null ? { system: input.systemPrompt } : {}),
            parts: [{ type: 'text', text: input.text }],
          }),
          signal: controller.signal,
        },
      );
      const body = await readJsonObject(response);
      return { text: readMessageResultText(body) };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error(`MiMo turn ${input.turnId} timed out`);
      }
      throw err;
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('content-type', 'application/json');
    if (this.password !== null && this.password !== '') {
      const encoded = Buffer.from(`${this.username}:${this.password}`).toString(
        'base64',
      );
      headers.set('authorization', `Basic ${encoded}`);
    }
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });
    if (response.status === 409) throw new MimoBusyError();
    if (!response.ok) {
      throw new MimoHttpError(
        `MiMo HTTP ${response.status} for ${path}: ${await response.text()}`,
        response.status,
      );
    }
    return response;
  }
}

function readMessageResultText(body: Record<string, unknown>): string | null {
  const direct = readString(body, ['text', 'message', 'content', 'result']);
  if (direct !== null) return direct;

  const parts = body['parts'];
  if (!Array.isArray(parts)) return null;
  const textParts = parts.flatMap((part) => {
    if (part === null || typeof part !== 'object' || Array.isArray(part)) {
      return [];
    }
    const record = part as Record<string, unknown>;
    return record['type'] === 'text' && typeof record['text'] === 'string'
      ? [record['text']]
      : [];
  });
  return textParts.length === 0 ? null : textParts.join('');
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  const trimmed = text.trim();
  if (trimmed === '') return {};
  const parsed: unknown = JSON.parse(trimmed);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('MiMo HTTP response was not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function readString(
  obj: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string') return value;
  }
  return null;
}
