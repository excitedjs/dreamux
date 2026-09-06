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
} from './skill-adapter.js';

/**
 * Atomically materialize the Claude-compatible view of role-gated skills and
 * return the adapter root the child must be given, or null when this runtime
 * has no skill sources.
 *
 * The root is `<cacheDir>/claude-code/skills/<key>`, keyed by what is on disk:
 * the source roots and the skill directories under them. An in-place package
 * upgrade that renames skills under an unchanged root therefore lands on a new
 * key and materializes afresh; roots keyed by an earlier inventory are never
 * revalidated again.
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
    await rename(tmpRoot, root);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ENOTEMPTY') {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
      if (await validateSkillAdapter(root, manifest)) return root;
    }
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  return root;
}
