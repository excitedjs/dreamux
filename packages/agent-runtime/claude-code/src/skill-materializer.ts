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
  skillAdapterManifest,
  skillDirsInRoot,
  uniqueSkillSources,
  validateSkillAdapter,
} from './skill-adapter.js';

/** Atomically materialize the Claude-compatible view of role-gated skills. */
export async function materializeClaudeSkillAddDir(
  skillAddDirRoot: string,
  sources: readonly AgentRuntimeSkillSource[],
  testHooks: { beforePublish?: () => void | Promise<void> } = {},
): Promise<void> {
  if (sources.length === 0) return;
  if (await validateSkillAdapter(skillAddDirRoot, sources)) return;
  const tmpRoot = `${skillAddDirRoot}.${randomUUID()}.tmp`;
  const tmpSkillsRoot = join(tmpRoot, '.claude', 'skills');
  try {
    await mkdir(tmpSkillsRoot, { recursive: true });
    const linkedNames = new Map<string, string>();
    for (const source of uniqueSkillSources(sources)) {
      for (const skill of await skillDirsInRoot(source.path)) {
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
      `${JSON.stringify(skillAdapterManifest(sources), null, 2)}\n`,
      { mode: 0o600 },
    );
    await mkdir(dirname(skillAddDirRoot), { recursive: true });
    await testHooks.beforePublish?.();
    await rename(tmpRoot, skillAddDirRoot);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ENOTEMPTY') {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
      if (await validateSkillAdapter(skillAddDirRoot, sources)) return;
    }
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}
