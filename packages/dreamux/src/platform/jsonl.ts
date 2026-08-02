import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Append one owner-only JSONL row. Domain owners decide whether errors fail loud. */
export async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}
