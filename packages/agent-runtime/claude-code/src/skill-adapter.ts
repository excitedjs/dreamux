import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import type { AgentRuntimeSkillSource } from '@excitedjs/dreamux-types';

/**
 * One source root as it exists on disk: the root's own name and absolute path,
 * plus the skill directories under it.
 *
 * The children are part of the adapter's identity because package upgrades
 * happen in place: `npm install --global` can rename the skills under a source
 * root whose own name and path never change, and a key that saw only the roots
 * would keep serving the previous names forever.
 */
interface SkillAdapterSource {
  name: string;
  path: string;
  skills: Array<{ name: string; path: string }>;
}

export interface SkillAdapterManifest {
  version: 2;
  key: string;
  sources: SkillAdapterSource[];
}

export async function validateSkillAdapter(
  root: string,
  expected: SkillAdapterManifest,
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

/**
 * Read the adapter's identity from disk — the source roots and the skill
 * directories under each. Every adapter root is keyed by this manifest, so a
 * renamed child lands on a new key instead of reusing the stale view.
 */
export async function readSkillAdapterManifest(
  sources: readonly AgentRuntimeSkillSource[],
): Promise<SkillAdapterManifest> {
  return skillAdapterManifest(await readSkillAdapterInventory(sources));
}

async function readSkillAdapterInventory(
  sources: readonly AgentRuntimeSkillSource[],
): Promise<SkillAdapterSource[]> {
  return Promise.all(
    uniqueSkillSources(sources).map(async (source) => {
      const path = resolve(source.path);
      return { name: source.name, path, skills: await skillDirsInRoot(path) };
    }),
  );
}

function skillAdapterManifest(
  inventory: SkillAdapterSource[],
): SkillAdapterManifest {
  return { version: 2, key: skillAdapterKey(inventory), sources: inventory };
}

function skillAdapterKey(inventory: readonly SkillAdapterSource[]): string {
  return createHash('sha256')
    .update(JSON.stringify(inventory))
    .digest('hex')
    .slice(0, 24);
}

function uniqueSkillSources(
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

/** The child skills of one root, in a fixed order: the key hashes this list. */
async function skillDirsInRoot(
  root: string,
): Promise<Array<{ name: string; path: string }>> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: join(root, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
