import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { locateClaudeHistory } from '../src/activity/path.js';

vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:os')>();
  return { ...original, homedir: vi.fn() };
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it('finds native history through the OS home when HOME is absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dreamux-claude-home-'));
  roots.push(root);
  vi.mocked(homedir).mockReturnValue(root);
  const cwd = join(root, 'workspace');
  await mkdir(cwd);
  const canonicalCwd = await realpath(cwd);
  const sessionId = randomUUID();
  const project = join(
    root,
    '.claude',
    'projects',
    canonicalCwd.replace(/[^a-zA-Z0-9]/g, '-'),
  );
  await mkdir(project, { recursive: true });
  const path = join(project, `${sessionId}.jsonl`);
  await writeFile(
    path,
    `${JSON.stringify({ type: 'user', sessionId, message: { role: 'user', content: 'hello' } })}\n`,
  );

  const history = await locateClaudeHistory({
    sessionId,
    cwd,
    env: {},
    worktreePaths: [],
  });
  expect(history.path).toBe(await realpath(path));
});
