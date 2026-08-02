import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { CompletionEnvelope } from '../src/service/completion-router/index.js';
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

    expect(text).toBe(
      `Workflow report-1 has completed. The output is too long, so the full result was saved to a file:\n\n${join(spillDir, 'teammate-workflow-report-1.output')}`,
    );
  });
});

function teammateCompletion(
  status: CompletionEnvelope['status'],
  result: string,
): CompletionEnvelope {
  return {
    kind: 'teammate',
    source: 'worker',
    id: 'worker:turn-1',
    status,
    result,
  };
}

function workflowCompletion(
  status: CompletionEnvelope['status'],
  result: string,
): CompletionEnvelope {
  return {
    kind: 'workflow',
    source: 'workflow',
    id: 'report-1',
    status,
    result,
  };
}

function temporarySpillDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'dreamux-completion-renderer-'));
  roots.push(root);
  return join(root, 'spill');
}
