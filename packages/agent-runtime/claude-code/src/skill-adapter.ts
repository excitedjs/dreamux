import { createHash } from 'node:crypto';
import { access, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { AgentRuntimeSkillSource } from '@excitedjs/dreamux-types';

export async function adapterExists(manifest: string): Promise<boolean> {
  try {
    await access(manifest);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

export function skillAdapterKey(
  sources: readonly AgentRuntimeSkillSource[],
): string {
  if (sources.length === 0) return 'empty';
  const normalized = uniqueSkillSources(sources).map((source) => ({
    name: source.name,
    path: resolve(source.path),
  }));
  return createHash('sha256')
    .update(JSON.stringify(normalized))
    .digest('hex')
    .slice(0, 24);
}

export function uniqueSkillSources(
  sources: readonly AgentRuntimeSkillSource[],
): AgentRuntimeSkillSource[] {
  const byRoot = new Map<string, AgentRuntimeSkillSource>();
  for (const source of sources) byRoot.set(resolve(source.path), source);
  return [...byRoot.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, source]) => source);
}

export async function skillDirsInRoot(
  root: string,
): Promise<Array<{ name: string; path: string }>> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: join(root, entry.name) }));
}
