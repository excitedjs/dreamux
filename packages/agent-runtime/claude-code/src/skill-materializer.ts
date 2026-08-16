import { randomUUID } from 'node:crypto';
import {
  mkdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { AgentRuntimeSkillSource } from '@excitedjs/dreamux-types';

import {
  adapterExists,
  skillAdapterKey,
  skillDirsInRoot,
  uniqueSkillSources,
} from './skill-adapter.js';

/** Atomically materialize the Claude-compatible view of role-gated skills. */
export async function materializeClaudeSkillAddDir(
  skillAddDirRoot: string,
  sources: readonly AgentRuntimeSkillSource[],
): Promise<void> {
  if (sources.length === 0) return;
  const manifest = join(skillAddDirRoot, '.dreamux-skill-adapter.json');
  if (await adapterExists(manifest)) return;
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
      `${JSON.stringify({
        version: 1,
        key: skillAdapterKey(sources),
        sources: uniqueSkillSources(sources).map((source) => ({
          name: source.name,
          path: resolve(source.path),
        })),
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await mkdir(dirname(skillAddDirRoot), { recursive: true });
    await rename(tmpRoot, skillAddDirRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
      return;
    }
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}
