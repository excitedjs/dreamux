import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeTextFile } from './ledger.js';
import type { OnboardFileLedger } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(dirname(HERE));
const DISPATCHER_SKILL_SOURCE = join(
  PACKAGE_ROOT,
  'skills',
  'dispatcher',
  'SKILL.md',
);

export async function installDispatcherSkill(options: {
  skillPath: string;
  ledger: OnboardFileLedger;
  dryRun: boolean;
}): Promise<void> {
  const content = await readDispatcherSkill();
  await writeTextFile(
    options.skillPath,
    content,
    options.ledger,
    'workspace-local dispatcher skill',
    { mode: 0o600, dryRun: options.dryRun },
  );
}

async function readDispatcherSkill(): Promise<string> {
  try {
    return await readFile(DISPATCHER_SKILL_SOURCE, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `missing bundled dispatcher skill: ${DISPATCHER_SKILL_SOURCE}`,
      );
    }
    throw err;
  }
}
