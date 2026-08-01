import type { WorkflowAgentOptions } from './protocol.js';

export interface NormalizedWorkflowAgentOptions {
  label?: string;
  phase?: string;
  schema?: Record<string, unknown>;
  agentType?: string;
  intent?: string;
  identity?: string;
}

export class WorkflowSemaphore {
  private active = 0;
  private closedError: Error | null = null;
  private readonly waiters: Array<{
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
  }> = [];

  constructor(private readonly limit: number) {}

  isFull(): boolean {
    return this.active >= this.limit;
  }

  acquire(): Promise<() => void> {
    if (this.closedError !== null) return Promise.reject(this.closedError);
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.releaseOnce());
    }
    return new Promise<() => void>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  close(error: Error): void {
    if (this.closedError !== null) return;
    this.closedError = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiter = this.waiters.shift();
      if (waiter !== undefined && this.closedError === null) {
        waiter.resolve(this.releaseOnce());
      } else {
        this.active -= 1;
      }
    };
  }
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

export function deferred(): Deferred<void> {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

export class WorkflowPersistenceError extends Error {}

export function normalizeAgentOptions(
  options: WorkflowAgentOptions,
): NormalizedWorkflowAgentOptions {
  const normalized: NormalizedWorkflowAgentOptions = {};
  for (const key of ['label', 'phase', 'agentType', 'intent', 'identity'] as const) {
    const value = options[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') {
      throw new Error(`workflow agent option ${key} must be a string`);
    }
    normalized[key] = value;
  }
  if (options.schema !== undefined) {
    if (!isRecord(options.schema)) {
      throw new Error('workflow agent option schema must be an object');
    }
    normalized.schema = options.schema;
  }
  return normalized;
}

export function nonEmpty(value: string | undefined): string | null {
  if (value === undefined || value.trim() === '') return null;
  return value;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorInfo(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return error.stack === undefined
      ? { message: error.message }
      : { message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
