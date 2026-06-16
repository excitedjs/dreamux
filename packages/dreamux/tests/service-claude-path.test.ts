/**
 * Managed-service PATH includes provider-declared binary check dirs.
 *
 * Providers declare their binary checks through the diagnostic seam. The service
 * unit receives those checks as opaque provider-owned descriptors; it must not
 * know whether they came from Codex, Claude Code, a channel, or any future
 * provider.
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
  readonly checks: Array<{ command: string; args: string[] }> = [];

  async run(): Promise<void> {}

  async check(command: string, args: string[]): Promise<boolean> {
    this.checks.push({ command, args });
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
    providerBinChecks: [
      {
        name: 'runtime-a',
        bin: '/opt/runtime-a/bin/runtime-a',
        args: ['probe'],
      },
    ],
    dreamuxBin: '/opt/dreamux/bin/dreamux',
    nodeBin: '/usr/bin/node',
    startService: false,
    dryRun: true,
    ...overrides,
  };
}

describe('managed service provider PATH', () => {
  it('includes provider-declared binary directories', () => {
    const env = managedServiceEnvironment(
      answers({
        providerBinChecks: [
          {
            name: 'runtime-a',
            bin: '/opt/runtime-a/bin/runtime-a',
            args: ['probe'],
          },
          {
            name: 'runtime-b',
            bin: '/home/op/.local/bin/runtime-b',
            args: ['probe'],
          },
        ],
      }),
    );
    const dirs = env['PATH'].split(delimiter);
    expect(dirs).toContain('/home/op/.local/bin');
    expect(dirs).toContain('/opt/runtime-a/bin');
  });

  it('omits runtime dirs when no provider declares a binary', () => {
    const env = managedServiceEnvironment(answers({ providerBinChecks: [] }));
    const dirs = env['PATH'].split(delimiter);
    expect(dirs).not.toContain('/home/op/.local/bin');
    expect(dirs).not.toContain('/opt/runtime-a/bin');
  });

  it('validates only the declared provider binary checks', async () => {
    const runner = new ServiceRunner();

    await expect(
      validateManagedServiceLaunch(answers({ providerBinChecks: [] }), runner),
    ).resolves.toMatchObject({ ok: true });
    expect(runner.checks).toEqual([
      { command: '/opt/dreamux/bin/dreamux', args: ['--help'] },
    ]);
  });

  it('validates provider-declared args instead of assuming --help', async () => {
    const runner = new ServiceRunner();

    await expect(
      validateManagedServiceLaunch(answers(), runner),
    ).resolves.toMatchObject({ ok: true });
    expect(runner.checks).toContainEqual({
      command: '/opt/runtime-a/bin/runtime-a',
      args: ['probe'],
    });
  });
});
