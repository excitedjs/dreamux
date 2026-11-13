import { execFile } from 'node:child_process';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const vitestRoot = dirname(require.resolve('vitest/package.json'));
const cli = join(vitestRoot, 'vitest.mjs');
const configUrl = new URL('../vitest.config.mjs', import.meta.url);
const fixtures = fileURLToPath(
  new URL('./fixtures/test-isolation/', import.meta.url),
);

interface Observation {
  home: string;
  HOME: string;
  USERPROFILE: string;
  CODEX_HOME: string;
  CLAUDE_CONFIG_DIR: string;
  DREAMUX_ROOT: string;
  authSource?: string;
}

async function snapshot(root: string) {
  const entries = (await readdir(root, { recursive: true })).sort();
  return Promise.all(
    entries.map(async (name) => {
      const path = join(root, name);
      return [
        name,
        (await stat(path)).isDirectory() ? null : await readFile(path, 'utf8'),
      ];
    }),
  );
}

describe('Vitest account isolation', () => {
  it.each([
    { name: 'normal run', fail: false, auth: 'off', watch: false },
    { name: 'failed test run', fail: true, auth: 'off', watch: false },
    {
      name: 'explicit synthetic auth opt-in',
      fail: false,
      auth: 'configured',
      watch: false,
    },
    {
      name: 'default synthetic auth opt-in',
      fail: false,
      auth: 'default',
      watch: false,
    },
    {
      name: 'watch rerun and normal close',
      fail: false,
      auth: 'off',
      watch: true,
    },
    {
      name: 'watch rerun after setup failure',
      fail: false,
      auth: 'off',
      watch: true,
      setupFailure: true,
    },
  ])(
    'isolates imports and children, preserves sentinels and cleans up: $name',
    async ({ fail, auth, watch, setupFailure = false }) => {
      const root = await mkdtemp(join(tmpdir(), 'dreamux-vitest-'));
      const account = join(root, 'account');
      const temporary = join(root, 'tmp');
      const project = join(root, 'project');
      const report = join(root, 'observations.jsonl');
      const importMarker = join(root, 'imported');
      const configuredAuth = join(account, 'configured-codex');
      try {
        for (const directory of [
          account,
          join(account, '.codex'),
          configuredAuth,
          join(account, '.claude'),
          join(account, '.dreamux'),
          temporary,
          project,
        ]) {
          await mkdir(directory, { recursive: true });
        }
        for (const directory of [
          account,
          configuredAuth,
          join(account, '.codex'),
          join(account, '.claude'),
          join(account, '.dreamux'),
        ]) {
          await writeFile(join(directory, 'sentinel'), 'operator sentinel');
        }
        await writeFile(
          join(configuredAuth, 'auth.json'),
          'configured synthetic auth',
        );
        await writeFile(
          join(account, '.codex', 'auth.json'),
          'default synthetic auth',
        );
        const before = await snapshot(account);
        await copyFile(
          join(fixtures, 'case.mjs'),
          join(project, 'isolation.test.mjs'),
        );
        await copyFile(
          join(fixtures, 'observe-home.mjs'),
          join(project, 'observe-home.mjs'),
        );
        await writeFile(
          join(project, 'vitest.config.mjs'),
          `import base from ${JSON.stringify(configUrl.href)};
export default {
  ...base,
  resolve: { alias: { vitest: ${JSON.stringify(join(vitestRoot, 'dist/index.js'))} } },
  cacheDir: ${JSON.stringify(join(root, 'cache'))},
  test: {
    ...base.test,
    include: ['isolation.test.mjs'],
    reporters: ['dot'],
    env: { DREAMUX_TEST_AUTH_HOME: 'stale-config-auth' },
  },
};
`,
        );
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          HOME: account,
          USERPROFILE: account,
          CODEX_HOME: configuredAuth,
          CLAUDE_CONFIG_DIR: join(account, '.claude'),
          DREAMUX_ROOT: join(account, '.dreamux'),
          TMP: temporary,
          TEMP: temporary,
          TMPDIR: temporary,
          DREAMUX_RUN_LIVE_MODEL_GATE: auth === 'off' ? '0' : '1',
          DREAMUX_TEST_AUTH_HOME: join(account, 'stale-inherited-auth'),
          ISOLATION_REPORT: report,
          ISOLATION_IMPORT_MARKER: importMarker,
          ISOLATION_FAIL: fail ? '1' : '0',
        };
        if (auth === 'default') delete env['CODEX_HOME'];
        const argv = watch
          ? [
              join(
                fixtures,
                setupFailure ? 'watch-setup-failure.mjs' : 'watch.mjs',
              ),
              project,
            ]
          : [cli, 'run', '--maxWorkers=1', '--minWorkers=1'];
        const result = await execute(process.execPath, argv, {
          cwd: project,
          env,
          windowsHide: true,
          timeout: 30_000,
        }).then(
          ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
          (error: unknown) => {
            const failure = error as {
              code: number | string;
              stdout: string;
              stderr: string;
            };
            return {
              code: failure.code,
              stdout: failure.stdout,
              stderr: failure.stderr,
            };
          },
        );
        expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(
          fail || setupFailure ? 1 : 0,
        );
        if (setupFailure) {
          expect(result.stderr).toMatch(/mkdtemp/);
          expect(
            JSON.parse(await readFile(join(project, 'watch.json'), 'utf8')),
          ).toEqual({
            initialImportAbsent: true,
            rerunStates: ['fail'],
            errors: ['Isolated test environment was not initialized'],
          });
          await expect(access(importMarker)).rejects.toMatchObject({
            code: 'ENOENT',
          });
          await expect(access(report)).rejects.toMatchObject({
            code: 'ENOENT',
          });
          expect(await readdir(temporary)).toEqual([]);
          expect(await snapshot(account)).toEqual(before);
          return;
        }
        const observations = (await readFile(report, 'utf8'))
          .trim()
          .split('\n')
          .map(
            (line) =>
              JSON.parse(line) as {
                imported: Observation;
                child: Observation;
                auth: string | null;
              },
          );
        expect(observations).toHaveLength(watch ? 2 : 1);
        const home = observations[0]!.imported.home;
        expect(dirname(home)).toBe(
          process.platform === 'win32' ? temporary : account,
        );
        for (const observation of observations) {
          expect(observation.child).toEqual(observation.imported);
          expect(observation.imported).toEqual({
            home,
            HOME: home,
            USERPROFILE: home,
            CODEX_HOME: join(home, '.codex'),
            CLAUDE_CONFIG_DIR: join(home, '.claude'),
            DREAMUX_ROOT: join(home, '.dreamux'),
            ...(auth === 'off'
              ? {}
              : {
                  authSource:
                    auth === 'configured'
                      ? configuredAuth
                      : join(account, '.codex'),
                }),
          });
          expect(observation.auth).toBe(
            auth === 'off'
              ? null
              : `${auth === 'configured' ? 'configured' : 'default'} synthetic auth`,
          );
        }
        if (watch) {
          expect(
            JSON.parse(await readFile(join(project, 'watch.json'), 'utf8')),
          ).toEqual({
            home,
            runnerAuth: env['DREAMUX_TEST_AUTH_HOME'],
          });
        }
        await expect(access(home)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readdir(temporary)).toEqual([]);
        expect(await snapshot(account)).toEqual(before);
      } finally {
        // The fixture owns this mkdtemp result; no cleanup path comes from env.
        await rm(root, { recursive: true, force: true, maxRetries: 3 });
      }
    },
    40_000,
  );
});
