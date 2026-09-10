import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  PreparedCompletionFact,
  WorkflowCompletionFact,
} from '../src/service/completion-router/index.js';
import { buildCompletionTurnText } from '../src/service/teammate-service/completion-renderer.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// An independent literal of the pushed sentence (ruling R14 in
// `.agents/tasks/mcp/refine-model-facing-surfaces/requirement.md`),
// deliberately not imported from the renderer, so a wording change in source
// has to be made here knowingly too.
const NOTIFICATION =
  'This is an automated notification from Dreamux, not a message from the user.';

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

    expect(text).toBe(`${line} ${NOTIFICATION} Output below:\n\nresult`);
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

      expect(text).toBe(`${line} ${NOTIFICATION} Output below:\n\n`);
    },
  );

  it('states a finished run as tagged facts and never inlines its result', async () => {
    const text = await buildCompletionTurnText(
      workflowCompletion('completed'),
      temporarySpillDir(),
    );

    expect(text).toBe(
      [
        NOTIFICATION,
        '',
        '<workflow-notification>',
        '<task-id>report-1</task-id>',
        '<output-file>/runs/report-1/output.json</output-file>',
        '<status>completed — 3 agents: 3 succeeded, 0 failed</status>',
        '<summary>Dynamic workflow "survey the tree" completed</summary>',
        '<diagnostics>Per-agent results: /runs/report-1/journal.jsonl — one ' +
          '{"kind":"result",...} line per settled Agent. Read it before ' +
          'diagnosing an unexpected result.</diagnostics>',
        '</workflow-notification>',
      ].join('\n'),
    );
    // The result is the one thing the notification does not carry: no tag holds
    // it, and no length of result can put it into the caller's context.
    expect(text).not.toContain('<result>');
  });

  it.each(['failed', 'stopped'] as const)(
    'appends the %s reason to the status line',
    async (status) => {
      const text = await buildCompletionTurnText(
        {
          ...workflowCompletion(status),
          error: 'boom',
          agents: { total: 3, succeeded: 1, failed: 2 },
        },
        temporarySpillDir(),
      );

      expect(text).toContain(
        `<status>${status} — 3 agents: 1 succeeded, 2 failed — boom</status>`,
      );
      expect(text).toContain(
        `<summary>Dynamic workflow "survey the tree" ${status}</summary>`,
      );
    },
  );

  it('counts a single Agent in the singular', async () => {
    const text = await buildCompletionTurnText(
      {
        ...workflowCompletion('completed'),
        agents: { total: 1, succeeded: 1, failed: 0 },
      },
      temporarySpillDir(),
    );

    expect(text).toContain('<status>completed — 1 agent: 1 succeeded, 0 failed</status>');
  });

  it('names the run when the record predates the script\'s own words', async () => {
    const text = await buildCompletionTurnText(
      { ...workflowCompletion('completed'), description: null },
      temporarySpillDir(),
    );

    expect(text).toContain('<summary>Dynamic workflow report-1 completed</summary>');
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
): WorkflowCompletionFact {
  return {
    kind: 'workflow',
    source: 'workflow',
    runId: 'report-1',
    status,
    description: 'survey the tree',
    error: null,
    agents: { total: 3, succeeded: 3, failed: 0 },
    outputPath: '/runs/report-1/output.json',
    journalPath: '/runs/report-1/journal.jsonl',
  };
}

function temporarySpillDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'dreamux-completion-renderer-'));
  roots.push(root);
  return join(root, 'spill');
}
