import type {
  ChannelTaskSubmitInput,
  ChannelTaskSubmitResult,
  ChannelTaskTerminalResult,
} from '@excitedjs/dreamux-types';

import type { TaskHostStore } from './store.js';
import type { TaskTargetRecord } from './types.js';

export function matchesDuplicate(
  existing: TaskTargetRecord,
  input: ChannelTaskSubmitInput,
  fingerprint: string,
): boolean {
  if (existing.request_fingerprint !== fingerprint) return false;
  if (existing.container_generation !== input.container_generation) return false;
  if (existing.repository_binding.source === 'static') return true;
  return input.repository !== undefined &&
    existing.logical_repository?.repository_key === input.repository.repository_key &&
    (input.repository.expected_revision === undefined ||
      input.repository.expected_revision ===
        existing.repository_binding.binding_revision);
}

export function requiredTarget(
  store: TaskHostStore,
  targetId: string,
): TaskTargetRecord {
  const target = store.get(targetId);
  if (target === null) throw new Error(`unknown task target '${targetId}'`);
  return target;
}

export function rejected(
  code: Extract<ChannelTaskSubmitResult, { status: 'rejected' }>['code'],
  message: string,
  retryable: boolean,
): ChannelTaskSubmitResult {
  return { status: 'rejected', code, message, retryable };
}

export function boundedTerminal(
  result: ChannelTaskTerminalResult,
): ChannelTaskTerminalResult {
  return {
    outcome: result.outcome,
    ...(result.summary !== undefined
      ? { summary: boundedText(result.summary, 64 * 1024) }
      : {}),
  };
}

export function boundedText(value: string, limit: number): string {
  if (limit <= 0) return '';
  if (Buffer.byteLength(value, 'utf8') <= limit) return value;
  const codePoints = Array.from(value);
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(codePoints.slice(0, middle).join(''), 'utf8') <= limit) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return codePoints.slice(0, low).join('');
}

export function errorInfo(error: unknown): Record<string, unknown> {
  return error instanceof Error
    ? { type: error.name, message: error.message }
    : { value: String(error) };
}
