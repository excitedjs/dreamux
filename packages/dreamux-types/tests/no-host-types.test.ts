/**
 * Host-types guard (issue #209 public-types audit, P0).
 *
 * `@excitedjs/dreamux-types` is the neutral, host-agnostic provider contract.
 * Its public declarations must never reference `@types/node` globals such as
 * `NodeJS.*` or `Buffer` — those would drag a host typings dependency into every
 * external provider package and re-expose the leak P0 removed (the
 * `AgentRuntimeDiagnosticRunner` env + `AgentRuntimeDiagnosticContext.env` used
 * `NodeJS.ProcessEnv`; they now use the package-owned `DreamuxEnvironment`).
 *
 * The scan is intentionally literal (whole-token), so the source carries no
 * `NodeJS` / `Buffer` text at all — not even in prose — keeping the guard
 * unambiguous. Use `DreamuxEnvironment` instead of `NodeJS.ProcessEnv`, and
 * `Uint8Array` / `ArrayBuffer` (or an opaque shape) instead of `Buffer`.
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
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const BANNED = [/\bNodeJS\b/, /\bBuffer\b/];

describe('dreamux-types carries no @types/node host globals', () => {
  for (const file of walk(srcRoot)) {
    it(`${file.slice(srcRoot.length + 1)} references no NodeJS./Buffer host type`, () => {
      const text = readFileSync(file, 'utf8');
      for (const pattern of BANNED) {
        expect(pattern.test(text)).toBe(false);
      }
    });
  }
});
