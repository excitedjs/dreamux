/**
 * Managed-service PATH includes the Claude Code install dir (issue #126 PR8).
 *
 * beta.52 could not route TeamMate work to builtin:claude-code because the
 * daemon service PATH resolved `codex` but not `claude`. The fix seeds the unit
 * PATH with the claude binary's directory when Claude Code is installed, while
 * keeping codex-only installs working (claudeBin omitted).
 */

import { describe, expect, it } from 'vitest';
import { delimiter, dirname } from 'node:path';

import {
  managedServiceEnvironment,
  selectServiceClaudeBin,
  type ServiceInstallAnswers,
} from '../src/onboard/service.js';

function answers(
  overrides: Partial<ServiceInstallAnswers> = {},
): ServiceInstallAnswers {
  return {
    configDir: '/home/op/.dreamux',
    codexBin: '/opt/codex/bin/codex',
    dreamuxBin: '/opt/dreamux/bin/dreamux',
    nodeBin: '/usr/bin/node',
    startService: false,
    dryRun: true,
    ...overrides,
  };
}

describe('managed service Claude Code PATH (issue #126 PR8)', () => {
  it('includes the claude binary directory when Claude Code is installed', () => {
    const env = managedServiceEnvironment(
      answers({ claudeBin: '/home/op/.local/bin/claude' }),
    );
    const dirs = env['PATH'].split(delimiter);
    expect(dirs).toContain('/home/op/.local/bin');
    expect(dirs).toContain(dirname('/opt/codex/bin/codex'));
  });

  it('omits a claude directory for a codex-only install', () => {
    const env = managedServiceEnvironment(answers());
    const dirs = env['PATH'].split(delimiter);
    expect(dirs).not.toContain('/home/op/.local/bin');
    // Codex still seeds the PATH so the codex worker keeps resolving.
    expect(dirs).toContain('/opt/codex/bin');
  });

  it('honours the DREAMUX_CLAUDE_BIN override and defaults to claude', () => {
    expect(selectServiceClaudeBin({ DREAMUX_CLAUDE_BIN: '/custom/claude' })).toBe(
      '/custom/claude',
    );
    expect(selectServiceClaudeBin({})).toBe('claude');
  });
});
