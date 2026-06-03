import { existsSync, readFileSync } from 'node:fs';
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

export function installDispatcherSkill(options: {
  skillPath: string;
  ledger: OnboardFileLedger;
  dryRun: boolean;
}): void {
  const content = readDispatcherSkill();
  writeTextFile(
    options.skillPath,
    content,
    options.ledger,
    'workspace-local dispatcher skill',
    { mode: 0o600, dryRun: options.dryRun },
  );
}

function readDispatcherSkill(): string {
  if (!existsSync(DISPATCHER_SKILL_SOURCE)) {
    throw new Error(`missing bundled dispatcher skill: ${DISPATCHER_SKILL_SOURCE}`);
  }
  return readFileSync(DISPATCHER_SKILL_SOURCE, 'utf8');
}
