/**
 * Managed-service PATH includes provider-declared runtime binary dirs.
 *
 * Runtime packages declare their binary checks through the neutral diagnostic
 * seam. The service unit only receives the resolved binary paths as opaque
 * `runtimeBins`; it must not know whether they came from Codex, Claude Code, or
 * any future provider.
 */

import { describe, expect, it } from 'vitest';
import { delimiter } from 'node:path';

import {
  managedServiceEnvironment,
  validateManagedServiceLaunch,
  type ServiceInstallAnswers,
} from '../src/onboard/service.js';
import type { CommandRunner } from '../src/onboard/types.js';

class ServiceRunner implements CommandRunner {
  readonly checks: string[] = [];

  async run(): Promise<void> {}

  async check(command: string): Promise<boolean> {
    this.checks.push(command);
    return true;
  }

  async capture(): Promise<string> {
    return 'v22.7.0';
  }
}

function answers(
  overrides: Partial<ServiceInstallAnswers> = {},
): ServiceInstallAnswers {
  return {
    configDir: '/home/op/.dreamux',
    runtimeBins: ['/opt/runtime-a/bin/runtime-a'],
    dreamuxBin: '/opt/dreamux/bin/dreamux',
    nodeBin: '/usr/bin/node',
    startService: false,
    dryRun: true,
    ...overrides,
  };
}

describe('managed service runtime PATH', () => {
  it('includes provider-declared runtime binary directories', () => {
    const env = managedServiceEnvironment(
      answers({ runtimeBins: ['/opt/runtime-a/bin/runtime-a', '/home/op/.local/bin/runtime-b'] }),
    );
    const dirs = env['PATH'].split(delimiter);
    expect(dirs).toContain('/home/op/.local/bin');
    expect(dirs).toContain('/opt/runtime-a/bin');
  });

  it('omits runtime dirs when no provider declares a binary', () => {
    const env = managedServiceEnvironment(answers({ runtimeBins: [] }));
    const dirs = env['PATH'].split(delimiter);
    expect(dirs).not.toContain('/home/op/.local/bin');
    expect(dirs).not.toContain('/opt/runtime-a/bin');
  });

  it('validates only the declared runtime binaries', async () => {
    const runner = new ServiceRunner();

    await expect(
      validateManagedServiceLaunch(answers({ runtimeBins: [] }), runner),
    ).resolves.toMatchObject({ ok: true });
    expect(runner.checks).toEqual(['/opt/dreamux/bin/dreamux']);
  });
});
