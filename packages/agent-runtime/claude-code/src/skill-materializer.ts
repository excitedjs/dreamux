import { randomUUID } from 'node:crypto';
import {
  mkdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { AgentRuntimeSkillSource } from '@excitedjs/dreamux-types';

import {
  readSkillAdapterManifest,
  validateSkillAdapter,
  type SkillAdapterManifest,
} from './skill-adapter.js';

/**
 * Materialize the Claude-compatible view of role-gated skills and return the
 * adapter root the child must be given, or null when this runtime has no
 * skill sources.
 *
 * The root is `<cacheDir>/claude-code/skills/<key>`, one directory per set of
 * source roots. Its manifest records the skill directories under each root as
 * they were when the view was built; a start that reads a different inventory
 * (an in-place package upgrade that renamed skills, a custom root that gained
 * a skill) rebuilds the view beside the root and swaps it into the same path,
 * so the path never changes and no earlier view is left behind.
 */
export async function materializeClaudeSkillAddDir(
  cacheDir: string,
  sources: readonly AgentRuntimeSkillSource[],
  testHooks: { beforePublish?: () => void | Promise<void> } = {},
): Promise<string | null> {
  if (sources.length === 0) return null;
  const manifest = await readSkillAdapterManifest(sources);
  const root = join(cacheDir, 'claude-code', 'skills', manifest.key);
  if (await validateSkillAdapter(root, manifest)) return root;
  const tmpRoot = `${root}.${randomUUID()}.tmp`;
  const tmpSkillsRoot = join(tmpRoot, '.claude', 'skills');
  try {
    await mkdir(tmpSkillsRoot, { recursive: true });
    const linkedNames = new Map<string, string>();
    for (const source of manifest.sources) {
      for (const skill of source.skills) {
        const previous = linkedNames.get(skill.name);
        if (previous !== undefined && previous !== skill.path) {
          throw new Error(
            `duplicate Claude skill name ${JSON.stringify(skill.name)} from ` +
              `${previous} and ${skill.path}`,
          );
        }
        if (previous !== undefined) continue;
        linkedNames.set(skill.name, skill.path);
        await symlink(skill.path, join(tmpSkillsRoot, skill.name), 'dir');
      }
    }
    await writeFile(
      join(tmpRoot, '.dreamux-skill-adapter.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 },
    );
    await mkdir(dirname(root), { recursive: true });
    await testHooks.beforePublish?.();
    await publish(tmpRoot, root, manifest);
  } catch (err) {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  return root;
}

/**
 * Put the fresh view at `root`: whatever occupies the path (a stale view, a
 * manifest of the previous format, a half-written tree) is moved aside first
 * and removed once the swap is done. Two runtimes starting together may both
 * reach here; each swap leaves a complete view at the path, and the one whose
 * final rename finds the path already taken keeps the other's view when it
 * validates.
 */
async function publish(
  tmpRoot: string,
  root: string,
  manifest: SkillAdapterManifest,
): Promise<void> {
  const staleRoot = `${root}.${randomUUID()}.stale`;
  try {
    await rename(root, staleRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  try {
    await rename(tmpRoot, root);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw err;
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
    if (!(await validateSkillAdapter(root, manifest))) {
      throw new Error(
        `invalid Claude skill adapter at ${root} after a concurrent publish`,
        { cause: err },
      );
    }
  } finally {
    await rm(staleRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
