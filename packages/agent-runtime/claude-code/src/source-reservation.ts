import type { RuntimeAdmission } from '@excitedjs/dreamux-types';

import { ClaudeSteerAdmissionError } from './rpc.js';

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Reserve one provider-private source until its native admission is known. */
export function reserveSource(
  key: string | undefined,
  committed: Set<string>,
  pending: Map<string, Promise<RuntimeAdmission>>,
  operation: () => Promise<RuntimeAdmission>,
): Promise<RuntimeAdmission> {
  if (key === undefined || key === '') return operation();
  if (committed.has(key)) return Promise.resolve({ status: 'duplicate' });
  const existing = pending.get(key);
  if (existing !== undefined) return existing;
  const task = Promise.resolve()
    .then(operation)
    .catch((error: unknown): RuntimeAdmission => ({
      status: 'ambiguous',
      error: asError(error),
    }));
  pending.set(key, task);
  void task.then((admission) => {
    if (admission.status === 'submitted' || admission.status === 'ambiguous') {
      committed.add(key);
    }
    if (pending.get(key) === task) pending.delete(key);
  });
  return task;
}

export function classifySteerFailure(
  error: unknown,
  stopped: boolean,
): RuntimeAdmission {
  if (error instanceof ClaudeSteerAdmissionError) {
    if (error.admission === 'ambiguous') {
      return { status: 'ambiguous', error };
    }
    if (!stopped) return { status: 'failed', error };
  }
  if (stopped) return { status: 'stopped' };
  return { status: 'ambiguous', error: asError(error) };
}
