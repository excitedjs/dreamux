import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import type { AgentRuntimeSkillSource } from '@excitedjs/dreamux-types';

interface SkillAdapterManifest {
  version: 1;
  key: string;
  sources: Array<{ name: string; path: string }>;
}

export async function validateSkillAdapter(
  root: string,
  sources: readonly AgentRuntimeSkillSource[],
): Promise<boolean> {
  let rootInfo;
  try {
    rootInfo = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`invalid Claude skill adapter directory at ${root}`);
  }
  const skillsRoot = join(root, '.claude', 'skills');
  const manifest = join(root, '.dreamux-skill-adapter.json');
  let skillsInfo;
  try {
    skillsInfo = await lstat(skillsRoot);
  } catch (error) {
    throw new Error(`invalid Claude skill adapter directory at ${root}`, {
      cause: error,
    });
  }
  if (!skillsInfo.isDirectory() || skillsInfo.isSymbolicLink()) {
    throw new Error(`invalid Claude skill adapter directory at ${root}`);
  }
  let raw: string;
  try {
    raw = await readFile(manifest, 'utf8');
  } catch (error) {
    throw new Error(`invalid Claude skill adapter manifest at ${manifest}`, {
      cause: error,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid Claude skill adapter manifest at ${manifest}`, {
      cause: error,
    });
  }
  const expected = skillAdapterManifest(sources);
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    JSON.stringify(value) !== JSON.stringify(expected)
  ) {
    throw new Error(`invalid Claude skill adapter manifest at ${manifest}`);
  }
  return true;
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
  for (const source of sources) {
    if (!isAbsolute(source.path)) {
      throw new Error(
        `skill source ${JSON.stringify(source.name)} path must be absolute`,
      );
    }
    byRoot.set(resolve(source.path), source);
  }
  return [...byRoot.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, source]) => source);
}

export function skillAdapterManifest(
  sources: readonly AgentRuntimeSkillSource[],
): SkillAdapterManifest {
  return {
    version: 1,
    key: skillAdapterKey(sources),
    sources: uniqueSkillSources(sources).map((source) => ({
      name: source.name,
      path: resolve(source.path),
    })),
  };
}

export async function skillDirsInRoot(
  root: string,
): Promise<Array<{ name: string; path: string }>> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: join(root, entry.name) }));
}
