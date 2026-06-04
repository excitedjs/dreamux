import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ExecaCommandRunner } from '../src/onboard/commands.js';

describe('ExecaCommandRunner', () => {
  let previousLeakEnv: string | undefined;

  beforeEach(() => {
    previousLeakEnv = process.env['DREAMUX_TEST_LEAK'];
  });

  afterEach(() => {
    if (previousLeakEnv === undefined) {
      delete process.env['DREAMUX_TEST_LEAK'];
    } else {
      process.env['DREAMUX_TEST_LEAK'] = previousLeakEnv;
    }
  });

  it('does not inherit ambient environment when explicit env is passed', async () => {
    process.env['DREAMUX_TEST_LEAK'] = 'present';
    const runner = new ExecaCommandRunner();

    await expect(
      runner.check(
        process.execPath,
        [
          '-e',
          'process.exit(process.env.DREAMUX_TEST_LEAK === undefined ? 0 : 1)',
        ],
        { env: {} },
      ),
    ).resolves.toBe(true);
  });
});
