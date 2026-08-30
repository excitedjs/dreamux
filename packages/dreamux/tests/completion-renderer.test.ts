import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { PreparedCompletionFact } from '../src/service/completion-router/index.js';
import { buildCompletionTurnText } from '../src/service/teammate-service/completion-renderer.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('buildCompletionTurnText', () => {
  it.each([
    ['completed', 'TeamMate worker has finished its task.'],
    ['failed', "TeamMate worker's task failed."],
    ['stopped', "TeamMate worker's task was stopped."],
  ] as const)('preserves teammate %s wording', async (status, line) => {
    const text = await buildCompletionTurnText(
      teammateCompletion(status, 'result'),
      temporarySpillDir(),
    );

    expect(text).toBe(`${line} Output below:\n\nresult`);
  });

  it.each([
    ['failed', "TeamMate worker's task failed."],
    ['stopped', "TeamMate worker's task was stopped."],
  ] as const)(
    'renders a %s completion with a null result (no native text) as an empty inline body',
    async (status, line) => {
      // turn-recording.ts always builds a failed/stopped PreparedCompletionFact
      // with `result: null` — there was no native result to carry. This must
      // stay inline (never spilled) and never crash on the missing text.
      const text = await buildCompletionTurnText(
        teammateCompletion(status, null),
        temporarySpillDir(),
      );

      expect(text).toBe(`${line} Output below:\n\n`);
    },
  );

  it.each([
    ['completed', 'Workflow report-1 has completed.'],
    ['failed', 'Workflow report-1 failed.'],
    ['stopped', 'Workflow report-1 was stopped.'],
  ] as const)('renders workflow %s wording', async (status, line) => {
    const text = await buildCompletionTurnText(
      workflowCompletion(status, 'result'),
      temporarySpillDir(),
    );

    expect(text).toBe(`${line} Output below:\n\nresult`);
  });

  it('uses the same spill directory for workflow completions', async () => {
    const spillDir = temporarySpillDir();
    const text = await buildCompletionTurnText(
      workflowCompletion('completed', 'x'.repeat(32_001)),
      spillDir,
    );

    const prefix =
      'Workflow report-1 has completed. The output is too long, so the full ' +
      'result was saved to a file:\n\n';
    expect(text.startsWith(prefix)).toBe(true);
    expect(text.slice(prefix.length)).toMatch(
      new RegExp(`^${escapeRegex(spillDir)}/completion-[0-9a-f-]+\\.output$`, 'u'),
    );
  });
});

function teammateCompletion(
  status: PreparedCompletionFact['status'],
  result: string | null,
): PreparedCompletionFact {
  return {
    kind: 'teammate',
    source: 'worker',
    status,
    result,
  };
}

function workflowCompletion(
  status: PreparedCompletionFact['status'],
  result: string,
): PreparedCompletionFact {
  return {
    kind: 'workflow',
    source: 'workflow',
    runId: 'report-1',
    status,
    result,
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function temporarySpillDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'dreamux-completion-renderer-'));
  roots.push(root);
  return join(root, 'spill');
}
