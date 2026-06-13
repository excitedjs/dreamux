/**
 * Guard: the retired workspace-symlink bundled-skill model stays retired
 * (issue #209 slice 6). Core injects bundled skills at runtime by role via the
 * create context's `skillSources`; nothing in `src/` may reintroduce the
 * symlink installer or a runtime/onboard hook that writes bundled skills into a
 * workspace `.codex/skills` dir.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..', 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

// The retired installer symbols and the package hook that drove it.
const FORBIDDEN = [
  'installBundledWorkspaceSkills',
  'installDispatcherSkill',
  'prepareWorkspaceSkills',
];

describe('bundled-skill symlink model is removed from core src', () => {
  const files = walk(srcRoot);

  for (const symbol of FORBIDDEN) {
    it(`no src file references \`${symbol}\``, () => {
      const offenders = files.filter((file) =>
        readFileSync(file, 'utf8').includes(symbol),
      );
      expect(offenders).toEqual([]);
    });
  }
});
