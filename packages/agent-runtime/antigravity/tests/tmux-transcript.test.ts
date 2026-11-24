import { appendFile, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { LiveTranscript } from '../src/transcript/live.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function transcriptPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agy-tail-test-'));
  dirs.push(dir);
  return join(dir, 'transcript_full.jsonl');
}

function line(content: string): string {
  return JSON.stringify({
    type: 'USER_INPUT',
    source: 'USER_EXPLICIT',
    status: 'DONE',
    step_index: 1,
    created_at: '2026-01-01T00:00:00Z',
    content,
  });
}

it('tails no historical records, including a partial record present at open', async () => {
  const path = await transcriptPath();
  const history = line('history');
  await writeFile(path, history);
  const transcript = await LiveTranscript.open(path);
  expect(await transcript.snapshot()).toMatchObject({
    kind: 'existing',
    offset: Buffer.byteLength(history),
  });
  const newest = line('later 🧪');
  await appendFile(path, '\n' + newest);
  expect(await transcript.read()).toEqual([]);
  await appendFile(path, '\n');
  expect(await transcript.read()).toEqual([
    {
      record: expect.objectContaining({ type: 'USER_INPUT' }),
      offset: Buffer.byteLength(history) + 1,
    },
  ]);
});

it('tails a newly created file at offset zero and rejects a replacement binding', async () => {
  const path = await transcriptPath();
  const transcript = await LiveTranscript.open(path);
  expect(await transcript.snapshot()).toEqual({ kind: 'missing', offset: 0 });
  await writeFile(path, line('first') + '\n');
  expect(await transcript.read()).toEqual([
    { record: expect.objectContaining({ type: 'USER_INPUT' }), offset: 0 },
  ]);
  await rename(path, join(dirname(path), 'old.jsonl'));
  await writeFile(path, line('replacement record') + '\n');
  await expect(transcript.snapshot()).rejects.toThrow('was replaced');
});
