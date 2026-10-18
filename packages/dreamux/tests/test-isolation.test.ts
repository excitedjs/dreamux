import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const runner = fileURLToPath(
  new URL('../../../common/scripts/run-tests.mjs', import.meta.url),
);

describe('package test process isolation', () => {
  it.each([0, 7])(
    'isolates native homes and cleans up after test exit %i',
    async (exitCode) => {
      const root = await mkdtemp(join(tmpdir(), 'dreamux-test-runner-'));
      const account = join(root, 'account');
      const auth = join(account, '.codex');
      const fixture = join(root, 'package');
      const vitest = join(fixture, 'node_modules', 'vitest');
      try {
        await Promise.all([
          mkdir(auth, { recursive: true }),
          mkdir(vitest, { recursive: true }),
        ]);
        await writeFile(join(auth, 'auth.json'), 'operator sentinel');
        await writeFile(join(fixture, 'package.json'), '{}');
        await writeFile(join(vitest, 'package.json'), '{}');
        await writeFile(
          join(vitest, 'vitest.mjs'),
          `import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
const env = process.env;
await writeFile(join(env.CODEX_HOME, 'auth.json'), 'test fixture');
console.log(JSON.stringify({
  home: homedir(),
  profile: env.USERPROFILE,
  codex: env.CODEX_HOME,
  claude: env.CLAUDE_CONFIG_DIR,
  dreamux: env.DREAMUX_ROOT,
  authSource: env.DREAMUX_TEST_AUTH_HOME,
}));
process.exit(${exitCode});
`,
        );
        const result = await execute(process.execPath, [runner, 'run'], {
          cwd: fixture,
          env: {
            ...process.env,
            HOME: account,
            USERPROFILE: account,
            TMP: account,
            TEMP: account,
            CODEX_HOME: auth,
            DREAMUX_RUN_LIVE_MODEL_GATE: '0',
            DREAMUX_TEST_AUTH_HOME: auth,
          },
          windowsHide: true,
        }).catch((error: unknown) => {
          const failure = error as { code: number; stdout: string };
          expect(failure.code).toBe(exitCode);
          return failure;
        });
        const child = JSON.parse(result.stdout) as Record<string, string>;
        expect(dirname(child['home']!)).toBe(account);
        expect(child['profile']).toBe(child['home']);
        for (const key of ['codex', 'claude', 'dreamux']) {
          expect(dirname(child[key]!)).toBe(child['home']);
        }
        expect(child['authSource']).toBeUndefined();
        await expect(
          readFile(join(child['home']!, '.codex', 'auth.json')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(join(auth, 'auth.json'), 'utf8')).toBe(
          'operator sentinel',
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
