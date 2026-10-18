import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorkflowJournal } from '../src/service/workflow-service/journal.js';
import {
  expectOwnerOnlyPermissions,
  makeWorldReadable,
} from '../../../common/scripts/test-permissions.mjs';

describe('WorkflowJournal privacy and ordered JSONL writes', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-jsonl-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('appends owner-only newline-delimited JSON in call order', async () => {
    const path = join(root, 'nested', 'events.jsonl');
    const journal = new WorkflowJournal(path);
    const header = {
      kind: 'run',
      version: 1,
      run_id: 'privacy-test',
      script_hash: 'hash',
      caller: { kind: 'dispatcher' },
      dispatcher_id: 'test',
      team_id: null,
      created_at: 1,
    } as const;
    await journal.create(header);
    await expectOwnerOnlyPermissions(path, 0o600);
    const first = { kind: 'log', message: 'first', created_at: 2 } as const;
    const second = { kind: 'log', message: 'second', created_at: 3 } as const;
    await Promise.all([journal.append(first), journal.append(second)]);

    expect(await readFile(path, 'utf8')).toBe(
      [header, first, second].map((row) => JSON.stringify(row) + '\n').join(''),
    );
    await expectOwnerOnlyPermissions(path, 0o600);
  });

  it('tightens a pre-existing readable file before appending', async () => {
    const path = join(root, 'events.jsonl');
    await writeFile(path, '{"kind":"log","message":"first","created_at":1}\n');
    await makeWorldReadable(path, 0o644);
    const journal = new WorkflowJournal(path);
    await journal.append({ kind: 'log', message: 'second', created_at: 2 });
    expect(await readFile(path, 'utf8')).toBe(
      '{"kind":"log","message":"first","created_at":1}\n{"kind":"log","message":"second","created_at":2}\n',
    );
    await expectOwnerOnlyPermissions(path, 0o600);
  });

  it('does not recreate a removed journal with unprepared permissions', async () => {
    const path = join(root, 'events.jsonl');
    await writeFile(path, '{"kind":"log","message":"first","created_at":1}\n');
    const journal = new WorkflowJournal(path);
    await journal.resultEvents();
    await rm(path);
    await expect(
      journal.append({ kind: 'log', message: 'second', created_at: 2 }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
