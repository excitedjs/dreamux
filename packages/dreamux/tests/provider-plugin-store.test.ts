import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  ExecaProviderPluginNpmRunner,
  ProviderPluginStore,
  PROVIDER_PLUGIN_UPDATE_INTERVAL_MS,
  type ProviderPluginNpmRunner,
} from '../src/registry/provider-plugin-store.js';
import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import {
  providerPluginGenerationDir,
  providerPluginGenerationRootBridgePath,
  providerPluginGenerationRootLockfilePath,
  providerPluginGenerationRootPackageJsonPath,
  providerPluginMetadataPath,
  providerPluginStagingDir,
} from '../src/platform/paths.js';

class FakeNpmRunner implements ProviderPluginNpmRunner {
  readonly installs: Array<{ packageName: string; version: string; cwd: string }> = [];
  readonly latestCalls: string[] = [];
  latest = new Map<string, string>();
  failInstall = false;
  failLatest = false;
  blockInstall: Promise<void> | null = null;
  installSignal: AbortSignal | null = null;
  onLatest: ((packageName: string) => Promise<void> | void) | null = null;
  onAfterInstallPackage: ((cwd: string) => Promise<void> | void) | null = null;
  private readonly latestWaiters: Array<() => void> = [];

  async latestVersion(packageName: string): Promise<string> {
    this.latestCalls.push(packageName);
    for (const waiter of this.latestWaiters.splice(0)) waiter();
    await this.onLatest?.(packageName);
    if (this.failLatest) throw new Error('latest failed');
    return this.latest.get(packageName) ?? '1.0.0';
  }

  async installExact(input: {
    packageName: string;
    version: string;
    cwd: string;
    signal?: AbortSignal;
  }): Promise<void> {
    this.installs.push(input);
    this.installSignal = input.signal ?? null;
    if (this.blockInstall !== null) await this.blockInstall;
    if (this.failInstall) throw new Error('install failed');
    await publishFakePackage(input.cwd, input.packageName, input.version);
    await this.onAfterInstallPackage?.(input.cwd);
  }

  async waitForLatestCalls(count: number): Promise<void> {
    if (this.latestCalls.length >= count) return;
    await new Promise<void>((resolve) => {
      this.latestWaiters.push(resolve);
    });
  }
}

describe('ProviderPluginStore', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-provider-plugins-'));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  });

  it('installs a missing package, selects it, and imports through the bridge', async () => {
    const runner = new FakeNpmRunner();
    runner.latest.set('@example/provider', '1.2.3');
    const store = new ProviderPluginStore({ root, runner, now: () => 1000 });

    const version = await store.materializePackage('@example/provider');
    const module = await store.importModule('@example/provider');

    expect(version).toBe('1.2.3');
    expect(runner.latestCalls).toEqual(['@example/provider']);
    expect(runner.installs).toHaveLength(1);
    expect(module['loadedFrom']).toBe('esm');
    expect(JSON.parse(await readFile(providerPluginMetadataPath('@example/provider', root), 'utf8'))).toMatchObject({
      version: 1,
      selected_version: '1.2.3',
      last_check_completed_at: 1000,
    });
  });

  it('uses Node import conditional exports through the generation bridge', async () => {
    const packageName = '@example/import-conditions';
    const runner = new FakeNpmRunner();
    runner.latest.set(packageName, '1.0.0');
    const store = new ProviderPluginStore({ root, runner });

    await store.materializePackage(packageName);
    const module = await store.importModule(packageName);

    expect(module['condition']).toBe('import-only');
  });

  it('uses a complete selected generation without querying npm', async () => {
    await publishGeneration(root, '@example/provider', '1.0.0');
    await writeMetadata(root, '@example/provider', '1.0.0', 123);
    const runner = new FakeNpmRunner();
    const store = new ProviderPluginStore({ root, runner });

    await expect(store.materializePackage('@example/provider')).resolves.toBe('1.0.0');
    const module = await store.importModule('@example/provider');

    expect(module['loadedFrom']).toBe('esm');
    expect(runner.latestCalls).toEqual([]);
    expect(runner.installs).toEqual([]);
  });

  it('recovers a published generation that was not selected', async () => {
    await publishGeneration(root, '@example/provider', '2.0.0');
    const runner = new FakeNpmRunner();
    runner.latest.set('@example/provider', '2.0.0');
    const store = new ProviderPluginStore({ root, runner, now: () => 2000 });

    await expect(store.materializePackage('@example/provider')).resolves.toBe('2.0.0');

    expect(runner.installs).toEqual([]);
    expect(JSON.parse(await readFile(providerPluginMetadataPath('@example/provider', root), 'utf8'))).toMatchObject({
      selected_version: '2.0.0',
      last_check_completed_at: 2000,
    });
  });

  it('ignores incomplete staging content', async () => {
    const leftover = providerPluginStagingDir('@example/provider', 'leftover', root);
    await mkdir(leftover, {
      recursive: true,
    });
    await writeFile(
      providerPluginGenerationRootPackageJsonPath(leftover),
      '{"private":true,"dependencies":{"@example/provider":"9.9.9"}}\n',
    );
    const runner = new FakeNpmRunner();
    runner.latest.set('@example/provider', '1.0.0');
    const store = new ProviderPluginStore({ root, runner });

    await store.materializePackage('@example/provider');
    const module = await store.importModule('@example/provider');

    expect(runner.installs).toHaveLength(1);
    expect(module['value']).toBe('1.0.0');
  });

  it('records settled failed background checks without changing selection', async () => {
    await publishGeneration(root, '@example/provider', '1.0.0');
    await writeMetadata(root, '@example/provider', '1.0.0', 0);
    const runner = new FakeNpmRunner();
    runner.failInstall = true;
    runner.latest.set('@example/provider', '2.0.0');
    const store = new ProviderPluginStore({ root, runner, now: () => 9000 });

    await store.checkForUpdate('@example/provider');

    expect(JSON.parse(await readFile(providerPluginMetadataPath('@example/provider', root), 'utf8'))).toMatchObject({
      selected_version: '1.0.0',
      last_check_completed_at: 9000,
    });
  });

  it('records settled no-update background checks', async () => {
    await publishGeneration(root, '@example/provider', '1.0.0');
    await writeMetadata(root, '@example/provider', '1.0.0', 0);
    const runner = new FakeNpmRunner();
    runner.latest.set('@example/provider', '1.0.0');
    const store = new ProviderPluginStore({ root, runner, now: () => 7000 });

    await store.checkForUpdate('@example/provider');

    expect(JSON.parse(await readFile(providerPluginMetadataPath('@example/provider', root), 'utf8'))).toMatchObject({
      selected_version: '1.0.0',
      last_check_completed_at: 7000,
    });
  });

  it('selects a newer generation for the next process without changing imported old module', async () => {
    await publishGeneration(root, '@example/provider', '1.0.0', 'old');
    await writeMetadata(root, '@example/provider', '1.0.0', 0);
    const runner = new FakeNpmRunner();
    runner.latest.set('@example/provider', '2.0.0');
    const store = new ProviderPluginStore({ root, runner, now: () => 10_000 });

    const oldModule = await store.importModule('@example/provider');
    await store.checkForUpdate('@example/provider');
    const nextModule = await store.importModule('@example/provider');

    expect(oldModule['value']).toBe('old');
    expect(nextModule['value']).toBe('2.0.0');
  });

  it('honors persisted four-hour check timing', async () => {
    await publishGeneration(root, '@example/provider', '1.0.0');
    await writeMetadata(root, '@example/provider', '1.0.0', 1000);
    const store = new ProviderPluginStore({
      root,
      runner: new FakeNpmRunner(),
      now: () => 1000 + PROVIDER_PLUGIN_UPDATE_INTERVAL_MS - 10,
    });

    await expect(store.nextUpdateDelay(['@example/provider'])).resolves.toBe(10);
  });

  it('does not immediately recheck after first materialization in the same process', async () => {
    vi.useFakeTimers();
    const runner = new FakeNpmRunner();
    runner.latest.set('@example/provider', '1.0.0');
    const store = new ProviderPluginStore({ root, runner, now: () => 1000 });

    await store.materializePackage('@example/provider');
    store.startUpdater(['@example/provider']);
    await vi.advanceTimersByTimeAsync(0);

    expect(runner.latestCalls).toEqual(['@example/provider']);
    await store.closeUpdater();
  });

  it('does not start an updater timer for an empty package set', async () => {
    vi.useFakeTimers();
    const runner = new FakeNpmRunner();
    const store = new ProviderPluginStore({ root, runner });

    store.startUpdater([]);
    expect(vi.getTimerCount()).toBe(0);
    await store.closeUpdater();
  });

  it('logs and rearms after a non-abort updater store error', async () => {
    vi.useFakeTimers();
    const runner = new FakeNpmRunner();
    runner.latest.set('@example/provider', '1.0.0');
    runner.failLatest = true;
    await publishGeneration(root, '@example/provider', '1.0.0');
    await writeMetadata(root, '@example/provider', '1.0.0', 0);
    const warnings: string[] = [];
    let onFallbackWarning: (() => void) | null = null;
    const warningsSettled = new Promise<void>((resolve) => {
      onFallbackWarning = resolve;
    });
    const metadata = providerPluginMetadataPath('@example/provider', root);
    runner.onLatest = async () => {
      await rm(metadata, { force: true });
      await mkdir(metadata);
    };
    const store = new ProviderPluginStore({
      root,
      runner,
      now: () => PROVIDER_PLUGIN_UPDATE_INTERVAL_MS + 1000,
      logger: fakeLogger(warnings, (message) => {
        if (message.includes('provider plugin updater scheduling failed')) {
          onFallbackWarning?.();
        }
      }),
    });

    try {
      store.startUpdater(['@example/provider']);
      await vi.advanceTimersByTimeAsync(0);
      await warningsSettled;

      expect(warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining('provider plugin update check failed'),
          expect.stringContaining('provider plugin updater failed'),
          expect.stringContaining('provider plugin updater scheduling failed'),
        ]),
      );
      await rm(metadata, { recursive: true, force: true });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
      const secondAttempt = runner.waitForLatestCalls(2);
      await vi.advanceTimersByTimeAsync(PROVIDER_PLUGIN_UPDATE_INTERVAL_MS);
      await secondAttempt;
    } finally {
      await store.closeUpdater();
    }
  });

  it('aborts an in-flight update without advancing metadata', async () => {
    await publishGeneration(root, '@example/provider', '1.0.0');
    await writeMetadata(root, '@example/provider', '1.0.0', 0);
    let releaseInstall!: () => void;
    const runner = new FakeNpmRunner();
    runner.latest.set('@example/provider', '2.0.0');
    runner.blockInstall = new Promise((resolve) => {
      releaseInstall = resolve;
    });
    const store = new ProviderPluginStore({ root, runner });

    store.startUpdater(['@example/provider']);
    await waitUntil(() => runner.installSignal !== null);
    const close = store.closeUpdater();
    expect(runner.installSignal?.aborted).toBe(true);
    releaseInstall();
    await close;

    expect(JSON.parse(await readFile(providerPluginMetadataPath('@example/provider', root), 'utf8'))).toMatchObject({
      selected_version: '1.0.0',
      last_check_completed_at: 0,
    });
  });

  it('does not start update work when closed during deferred scheduling', async () => {
    vi.useFakeTimers();
    let releaseDelay!: () => void;
    let markDelayStarted!: () => void;
    const delayStarted = new Promise<void>((resolve) => {
      markDelayStarted = resolve;
    });
    const delay = new Promise<number>((resolve) => {
      releaseDelay = () => resolve(0);
    });
    const runner = new FakeNpmRunner();
    const store = new ProviderPluginStore({ root, runner });
    store.nextUpdateDelay = vi.fn(async () => {
      markDelayStarted();
      return await delay;
    });

    store.startUpdater(['@example/provider']);
    await vi.advanceTimersByTimeAsync(0);
    await delayStarted;
    const close = store.closeUpdater();
    releaseDelay();
    await close;

    expect(runner.latestCalls).toEqual([]);
    expect(runner.installs).toEqual([]);
    await expect(
      readFile(providerPluginMetadataPath('@example/provider', root), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readFile(
        providerPluginGenerationRootPackageJsonPath(
          providerPluginGenerationDir('@example/provider', '1.0.0', root),
        ),
        'utf8',
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not install when closed during generation inspection', async () => {
    vi.useFakeTimers();
    await publishGeneration(root, '@example/provider', '1.0.0');
    await writeMetadata(root, '@example/provider', '1.0.0', 0);
    const runner = new FakeNpmRunner();
    runner.latest.set('@example/provider', '2.0.0');
    const store = new ProviderPluginStore({ root, runner });
    let releaseInspection!: () => void;
    let markInspectionStarted!: () => void;
    const inspectionStarted = new Promise<void>((resolve) => {
      markInspectionStarted = resolve;
    });
    const inspection = new Promise<void>((resolve) => {
      releaseInspection = resolve;
    });
    const probe = store as unknown as {
      generationUsable(packageName: string, version: string): Promise<boolean>;
    };
    probe.generationUsable = async () => {
      markInspectionStarted();
      await inspection;
      return false;
    };

    store.startUpdater(['@example/provider']);
    await vi.advanceTimersByTimeAsync(0);
    await inspectionStarted;
    const close = store.closeUpdater();
    releaseInspection();
    await close;

    expect(runner.latestCalls).toEqual(['@example/provider']);
    expect(runner.installs).toEqual([]);
    await expect(
      readdir(dirname(providerPluginStagingDir('@example/provider', 'unused', root))),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readFile(
        providerPluginGenerationRootPackageJsonPath(
          providerPluginGenerationDir('@example/provider', '2.0.0', root),
        ),
        'utf8',
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await readFile(providerPluginMetadataPath('@example/provider', root), 'utf8'))).toMatchObject({
      selected_version: '1.0.0',
      last_check_completed_at: 0,
    });
  });

  it('does not publish or select when aborted after npm installs before publication', async () => {
    await publishGeneration(root, '@example/provider', '1.0.0');
    await writeMetadata(root, '@example/provider', '1.0.0', 0);
    const controller = new AbortController();
    const runner = new FakeNpmRunner();
    runner.latest.set('@example/provider', '2.0.0');
    runner.onAfterInstallPackage = () => {
      controller.abort(new Error('stop after npm install'));
    };
    const store = new ProviderPluginStore({ root, runner });

    await expect(
      store.checkForUpdate('@example/provider', controller.signal),
    ).rejects.toThrow(/stop after npm install/);

    await expect(
      readFile(
        providerPluginGenerationRootPackageJsonPath(
          providerPluginGenerationDir('@example/provider', '2.0.0', root),
        ),
        'utf8',
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await readFile(providerPluginMetadataPath('@example/provider', root), 'utf8'))).toMatchObject({
      selected_version: '1.0.0',
      last_check_completed_at: 0,
    });
  });

  it('does not write a bridge when aborted after installed-package verification', async () => {
    const controller = new AbortController();
    const runner = new FakeNpmRunner();
    runner.latest.set('@example/provider', '2.0.0');
    const store = new ProviderPluginStore({ root, runner });
    const probe = store as unknown as {
      assertInstalledPackage(
        generationRoot: string,
        packageName: string,
        version: string,
      ): Promise<void>;
    };
    const original = probe.assertInstalledPackage.bind(store);
    probe.assertInstalledPackage = async (...args) => {
      await original(...args);
      controller.abort(new Error('stop after package verification'));
    };

    await expect(
      store.materializePackage('@example/provider', controller.signal),
    ).rejects.toThrow(/stop after package verification/);

    expect(runner.installs).toHaveLength(1);
    const staging = runner.installs[0]!.cwd;
    await expect(
      readFile(providerPluginGenerationRootBridgePath(staging), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readFile(
        providerPluginGenerationRootPackageJsonPath(
          providerPluginGenerationDir('@example/provider', '2.0.0', root),
        ),
        'utf8',
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readFile(providerPluginMetadataPath('@example/provider', root), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('npm runner uses abortable npm commands with explicit lockfile generation', async () => {
    const calls: unknown[] = [];
    const runner = new ExecaProviderPluginNpmRunner(
      async (...args: unknown[]) => {
        calls.push(args);
        return { stdout: '"1.0.0"' };
      },
    );
    const controller = new AbortController();

    await runner.latestVersion('@example/provider', controller.signal);
    await runner.installExact({
      packageName: '@example/provider',
      version: '1.0.0',
      cwd: '/tmp/dreamux-provider-install',
      signal: controller.signal,
    });

    expect(calls[0]).toEqual([
      'npm',
      ['view', '@example/provider', 'dist-tags.latest', '--json'],
      { cancelSignal: controller.signal },
    ]);
    expect(calls[1]).toEqual([
      'npm',
      [
        'install',
        '--prefix',
        '/tmp/dreamux-provider-install',
        '--save-exact',
        '--package-lock=true',
        '@example/provider@1.0.0',
      ],
      { cancelSignal: controller.signal, stdio: 'pipe' },
    ]);
  });
});

async function publishGeneration(
  root: string,
  packageName: string,
  version: string,
  value = version,
): Promise<void> {
  const generation = providerPluginGenerationDir(packageName, version, root);
  await publishFakePackage(generation, packageName, version, value);
  await writeFile(
    providerPluginGenerationRootPackageJsonPath(generation),
    `${JSON.stringify({ private: true, dependencies: { [packageName]: version } })}\n`,
  );
  await writeFile(providerPluginGenerationRootLockfilePath(generation), '{}\n');
  await writeFile(
    providerPluginGenerationRootBridgePath(generation),
    `const namespace = await import(${JSON.stringify(packageName)});\nexport default namespace;\n`,
  );
}

async function publishFakePackage(
  root: string,
  packageName: string,
  version: string,
  value = version,
): Promise<void> {
  const pkgDir = join(
    root,
    'node_modules',
    ...packageName.split('/'),
  );
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    join(pkgDir, 'package.json'),
    `${JSON.stringify({
      name: packageName,
      version,
      type: 'module',
      exports:
        packageName === '@example/import-conditions'
          ? {
              '.': {
                import: './import-only.js',
              },
            }
          : { import: './esm.js', require: './require.cjs' },
    })}\n`,
  );
  await writeFile(join(pkgDir, 'esm.js'), `export const loadedFrom = 'esm';\nexport const value = ${JSON.stringify(value)};\n`);
  await writeFile(join(pkgDir, 'require.cjs'), "module.exports = { loadedFrom: 'require' };\n");
  await writeFile(
    join(pkgDir, 'import-only.js'),
    "export const condition = 'import-only';\n",
  );
  await writeFile(join(pkgDir, 'default.js'), "export const condition = 'default';\n");
  await writeFile(providerPluginGenerationRootLockfilePath(root), '{}\n');
}

async function writeMetadata(
  root: string,
  packageName: string,
  version: string,
  checkedAt: number,
): Promise<void> {
  await mkdir(providerPluginGenerationDir(packageName, version, root), {
    recursive: true,
  });
  await mkdir(join(providerPluginMetadataPath(packageName, root), '..'), {
    recursive: true,
  });
  await writeFile(
    providerPluginMetadataPath(packageName, root),
    `${JSON.stringify({
      version: 1,
      selected_version: version,
      last_check_completed_at: checkedAt,
    })}\n`,
  );
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition was not reached');
}

function fakeLogger(
  warnings: string[],
  onWarn?: (message: string) => void,
): DreamuxLogger {
  const noop: DreamuxLogger['info'] = () => undefined;
  return {
    error: noop,
    warn(message: string | Record<string, unknown>, detail?: string) {
      const text =
        typeof message === 'string'
          ? [message, detail].filter(Boolean).join(' ')
          : JSON.stringify(message);
      warnings.push(text);
      onWarn?.(text);
    },
    info: noop,
    debug: noop,
    trace: noop,
  };
}
