import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import type { AgentRuntimeSkillSource } from '@excitedjs/dreamux-types';

/**
 * One source root as it exists on disk: the root's own name and absolute path,
 * plus the skill directories under it.
 *
 * The adapter root is keyed by the roots alone, so one set of roots always
 * maps to one directory; the children are recorded in the manifest and
 * compared on every start, because package upgrades happen in place:
 * `npm install --global` can rename the skills under a source root whose own
 * name and path never change, and a view validated by its roots alone would
 * keep serving the previous names forever. A mismatch refreshes the same
 * directory instead of opening a new one.
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

/**
 * Whether the directory at `root` is the current view: a plain directory whose
 * manifest is exactly `expected`. Anything else that occupies the path — a
 * view of an earlier inventory, a manifest of the previous format, a
 * half-written tree — is stale and is reported as such so the caller replaces
 * it. Only a path that is not a plain directory at all is refused, because
 * replacing it would delete something this adapter never wrote.
 */
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
  let skillsInfo;
  try {
    skillsInfo = await lstat(join(root, '.claude', 'skills'));
  } catch {
    return false;
  }
  if (!skillsInfo.isDirectory() || skillsInfo.isSymbolicLink()) return false;
  let value: unknown;
  try {
    value = JSON.parse(
      await readFile(join(root, '.dreamux-skill-adapter.json'), 'utf8'),
    );
  } catch {
    return false;
  }
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(value) === JSON.stringify(expected)
  );
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
      return {
        name: source.name,
        path,
        skills: await skillDirsInRoot(source.name, path),
      };
    }),
  );
}

function skillAdapterManifest(
  inventory: SkillAdapterSource[],
): SkillAdapterManifest {
  return { version: 2, key: skillAdapterKey(inventory), sources: inventory };
}

/**
 * The key names the directory for one set of roots and nothing else, so the
 * same roots always land in the same place and a refreshed view keeps the path
 * a running child was given. It is the key the version-1 manifests used, so a
 * root left by an earlier release is refreshed in place rather than orphaned.
 */
function skillAdapterKey(inventory: readonly SkillAdapterSource[]): string {
  const roots = inventory.map(({ name, path }) => ({ name, path }));
  return createHash('sha256')
    .update(JSON.stringify(roots))
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
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, source]) => source);
}

/**
 * The child skills of one root in code-point order: the key hashes this list,
 * so the order must not depend on the process locale.
 *
 * The roots are read on every start, so a custom root that was deleted or
 * moved after the Team was created stops the start here; the error names the
 * source so the operator knows which `skill_sources` entry to repair.
 */
async function skillDirsInRoot(
  name: string,
  root: string,
): Promise<Array<{ name: string; path: string }>> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    throw new Error(
      `skill source ${JSON.stringify(name)} root ${root} cannot be read: ` +
        (error instanceof Error ? error.message : String(error)),
      { cause: error },
    );
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: join(root, entry.name) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
