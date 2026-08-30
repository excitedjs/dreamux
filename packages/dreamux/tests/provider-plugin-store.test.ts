import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
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
  providerPluginGenerationRootPackageJsonPath,
  providerPluginMetadataPath,
  providerPluginStagingDir,
} from '../src/platform/paths.js';
import {
  providerPluginSource,
  publishProviderPluginGenerationRootSync,
  readProviderPluginMetadataSync,
  writeProviderPluginMetadataSync,
} from './helpers/provider-plugin.js';
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
  it('installs a missing package, commits the load session, and imports through the bridge', async () => {
    const runner = new FakeNpmRunner();
    runner.latest.set('@example/provider', '1.2.3');
    const store = new ProviderPluginStore({ root, runner, now: () => 1000 });
    await prepareAndCommit(store, '@example/provider');
    expect(runner.latestCalls).toEqual(['@example/provider']);
    expect(runner.installs).toHaveLength(1);
    expect((await importSelected(store, '@example/provider'))['loadedFrom']).toBe('esm');
    await expectMetadata(root, '@example/provider', {
      selected_version: '1.2.3',
      last_check_completed_at: 1000,
    });
    const packageName = '@example/import-conditions';
    runner.latest.set(packageName, '1.0.0');
    await prepareAndCommit(store, packageName);
    expect((await importSelected(store, packageName))['condition']).toBe('import-only');
  });
  it('reads additive v1 metadata and uses selected generations without querying npm', async () => {
    await publishGeneration(root, '@example/provider', '1.0.0');
    await writeMetadata(root, '@example/provider', '1.0.0', 123, { omitAdditive: true });
    const runner = new FakeNpmRunner();
    const store = new ProviderPluginStore({ root, runner });
    await expect(store.inspectPackages(['@example/provider'])).resolves.toEqual([
      {
        packageName: '@example/provider',
        ok: true,
        version: '1.0.0',
        error: null,
        lastCheckError: null,
      },
    ]);
    await expect(
      store.createMaterializingSession(['@example/provider']).preparePackage(
        '@example/provider',
      ),
    ).resolves.toBe('1.0.0');
    const module = await importSelected(store, '@example/provider');
    expect(module['loadedFrom']).toBe('esm');
    expect(runner.latestCalls).toEqual([]);
    expect(runner.installs).toEqual([]);
  });
  it('commits a prepared first-use candidate only when the load session commits', async () => {
    const runner = new FakeNpmRunner();
    runner.latest.set('@example/provider', '1.0.0');
    const store = new ProviderPluginStore({ root, runner, now: () => 1111 });
    const session = store.createMaterializingSession(['@example/provider']);
    await expect(session.preparePackage('@example/provider')).resolves.toBe('1.0.0');
    await expectMetadata(root, '@example/provider', {
      selected_version: null,
      candidate_version: '1.0.0',
      last_check_completed_at: 1111,
      last_check_error: null,
    });
    await expect(importSelected(store, '@example/provider')).rejects.toThrow(
      /no selected generation/,
    );
    await session.commit();
    await expectMetadata(root, '@example/provider', {
      selected_version: '1.0.0',
      candidate_version: null,
      last_check_completed_at: 1111,
      last_check_error: null,
    });
    expect((await importSelected(store, '@example/provider'))['value']).toBe('1.0.0');
    await publishGeneration(root, '@example/recovered-provider', '2.0.0');
    runner.latest.set('@example/recovered-provider', '2.0.0');
    const installCount = runner.installs.length;
    await expect(prepareAndCommit(store, '@example/recovered-provider')).resolves.toBe('2.0.0');
    expect(runner.installs).toHaveLength(installCount);
    await expectMetadata(root, '@example/recovered-provider', {
      selected_version: '2.0.0',
      last_check_completed_at: 1111,
    });
  });
  it('rejects a candidate without changing the selected generation or check error', async () => {
    const blocked = '@example/blocked-provider';
    await publishGeneration(root, blocked, '2.0.0');
    await writeMetadata(root, blocked, null, 900, { candidateVersion: '2.0.0' });
    await publishGeneration(root, '@example/provider', '1.0.0', 'selected');
    await publishGeneration(root, '@example/provider', '2.0.0', 'candidate');
    await writeMetadata(root, '@example/provider', '1.0.0', 1000, {
      candidateVersion: '2.0.0',
      lastCheckError: 'previous background failure',
    });
    const blockedMetadata = providerPluginMetadataPath(blocked, root);
    await chmod(dirname(blockedMetadata), 0o500);
    const store = new ProviderPluginStore({ root, runner: new FakeNpmRunner() });
    const session = store.createMaterializingSession([blocked, '@example/provider']);
    await expect(session.preparePackage(blocked)).resolves.toBe('2.0.0');
    await expect(session.preparePackage('@example/provider')).resolves.toBe('2.0.0');
    expect((await session.importModule('@example/provider'))['value']).toBe('candidate');
    try {
      const thrown = await session.rejectCandidates().catch((err: unknown) => err);
      expect(thrown).toBeInstanceOf(AggregateError);
      expect((thrown as AggregateError).errors).toMatchObject([
        { packageName: blocked, version: '2.0.0' },
      ]);
    } finally {
      await chmod(dirname(blockedMetadata), 0o700);
    }
    await expectMetadata(root, blocked, {
      candidate_version: '2.0.0',
    });
    await expectMetadata(root, '@example/provider', {
      selected_version: '1.0.0',
      candidate_version: null,
      last_check_completed_at: 1000,
      last_check_error: 'previous background failure',
    });
    expect((await importSelected(store, '@example/provider'))['value']).toBe('selected');
  });
  it('foreground and inspection preserve updater-owned check errors', async () => {
    await writeMetadata(root, '@example/provider', '1.0.0', 1000, {
      lastCheckError: 'background registry failure',
    });
    const store = new ProviderPluginStore({ root, runner: new FakeNpmRunner() });
    await expect(store.inspectPackages(['@example/provider'])).resolves.toEqual([
      {
        packageName: '@example/provider',
        ok: false,
        version: null,
        error: expect.stringContaining('missing'),
        lastCheckError: 'background registry failure',
      },
    ]);
    const runner = new FakeNpmRunner();
    runner.latest.set('@example/provider', '1.0.0');
    const warnings: string[] = [];
    const materializing = new ProviderPluginStore({
      root,
      runner,
      now: () => 2000,
      logger: fakeLogger(warnings),
    });
    const session = materializing.createMaterializingSession(['@example/provider']);
    await expect(session.preparePackage('@example/provider')).resolves.toBe('1.0.0');
    expect(runner.installs.map((entry) => entry.packageName)).toEqual(['@example/provider']);
    expect(warnings.join('\n')).toContain('selected generation 1.0.0 is incomplete');
    await expectMetadata(root, '@example/provider', {
      selected_version: '1.0.0',
      candidate_version: '1.0.0',
      last_check_completed_at: 2000,
    });
    await session.commit();
    await expectMetadata(root, '@example/provider', {
      selected_version: '1.0.0',
      candidate_version: null,
      last_check_completed_at: 2000,
      last_check_error: 'background registry failure',
    });
    expect((await importSelected(materializing, '@example/provider'))['value']).toBe('1.0.0');
  });
  it('keeps staging non-importable and prunes only package-local old entries', async () => {
    const leftover = providerPluginStagingDir('@example/provider', 'leftover', root);
    const oldStaging = providerPluginStagingDir('@example/provider', 'old', root);
    const recentStaging = providerPluginStagingDir('@example/provider', 'recent', root);
    const otherPackageStaging = providerPluginStagingDir('@example/other', 'old', root);
    await Promise.all([leftover, oldStaging, recentStaging, otherPackageStaging].map((path) => mkdir(path, { recursive: true })));
    await writeFile(
      providerPluginGenerationRootPackageJsonPath(leftover),
      '{"private":true,"dependencies":{"@example/provider":"9.9.9"}}\n',
    );
    await utimes(oldStaging, new Date(1_000), new Date(1_000));
    await utimes(recentStaging, new Date(100_000), new Date(100_000));
    await utimes(otherPackageStaging, new Date(1_000), new Date(1_000));
    const runner = new FakeNpmRunner();
    runner.latest.set('@example/provider', '1.0.0');
    const store = new ProviderPluginStore({
      root,
      runner,
      now: () => 1_000 + 24 * 60 * 60 * 1000 + 1,
    });
    await prepareAndCommit(store, '@example/provider');
    expect(runner.installs).toHaveLength(1);
    expect((await importSelected(store, '@example/provider'))['value']).toBe('1.0.0');
    await expect(readdir(oldStaging)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(recentStaging)).resolves.toEqual([]);
    await expect(readdir(otherPackageStaging)).resolves.toEqual([]);
  });
  it('records settled failed background checks without changing selection', async () => {
    await publishGeneration(root, '@example/provider', '1.0.0');
    await publishGeneration(root, '@example/provider', '1.5.0');
    await writeMetadata(root, '@example/provider', '1.0.0', 0, {
      candidateVersion: '1.5.0',
    });
    const runner = new FakeNpmRunner();
    runner.failInstall = true;
    runner.latest.set('@example/provider', '2.0.0');
    const store = new ProviderPluginStore({ root, runner, now: () => 9000 });
    await store.checkForUpdate('@example/provider');
    await expectMetadata(root, '@example/provider', {
      selected_version: '1.0.0',
      candidate_version: '1.5.0',
      last_check_completed_at: 9000,
      last_check_error: 'install failed',
    });
  });
  it('applies successful background update state-table transitions', async () => {
    const cases = [
      { name: '@example/no-update', latest: '1.0.0', selectedValue: '1.0.0', candidate: '1.5.0', expected: null, now: 7000 },
      { name: '@example/same-candidate', latest: '2.0.0', selectedValue: '1.0.0', candidate: '2.0.0', expected: '2.0.0', now: 8000 },
      { name: '@example/new-candidate', latest: '2.0.0', selectedValue: 'old', candidate: null, expected: '2.0.0', now: 10_000 },
    ];
    for (const testCase of cases) {
      await publishGeneration(root, testCase.name, '1.0.0', testCase.selectedValue);
      if (testCase.candidate !== null) await publishGeneration(root, testCase.name, testCase.candidate);
      await writeMetadata(root, testCase.name, '1.0.0', 0, {
        lastCheckError: 'stale error',
      });
      const runner = new FakeNpmRunner();
      runner.latest.set(testCase.name, testCase.latest);
      const store = new ProviderPluginStore({ root, runner, now: () => testCase.now });
      const before = await importSelected(store, testCase.name);
      await store.checkForUpdate(testCase.name);
      const after = await importSelected(store, testCase.name);
      if (testCase.candidate === testCase.latest) expect(runner.installs).toEqual([]);
      expect(before['value']).toBe(testCase.selectedValue);
      expect(after['value']).toBe(testCase.selectedValue);
      await expectMetadata(root, testCase.name, {
        selected_version: '1.0.0',
        candidate_version: testCase.expected,
        last_check_completed_at: testCase.now,
        last_check_error: null,
      });
    }
  });
  it('honors update scheduling boundaries', async () => {
    vi.useFakeTimers();
    await publishGeneration(root, '@example/provider', '1.0.0');
    await writeMetadata(root, '@example/provider', '1.0.0', 1000);
    const runner = new FakeNpmRunner();
    const store = new ProviderPluginStore({
      root,
      runner,
      now: () => 1000 + PROVIDER_PLUGIN_UPDATE_INTERVAL_MS - 10,
    });
    await expect(store.nextUpdateDelay(['@example/provider'])).resolves.toBe(10);
    store.startUpdater(['@example/provider']);
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.latestCalls).toEqual([]);
    await store.closeUpdater();
    runner.latest.set('@example/fresh-provider', '1.0.0');
    const fresh = new ProviderPluginStore({ root, runner, now: () => 2000 });
    await prepareAndCommit(fresh, '@example/fresh-provider');
    fresh.startUpdater(['@example/fresh-provider']);
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.latestCalls).toEqual(['@example/fresh-provider']);
    await fresh.closeUpdater();
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
    await expectMetadata(root, '@example/provider', {
      selected_version: '1.0.0',
      last_check_completed_at: 0,
    });
  });
  it('does not start staging when closed after pruning settles', async () => {
    await publishGeneration(root, '@example/provider', '1.0.0');
    await writeMetadata(root, '@example/provider', '1.0.0', 0);
    const oldStaging = providerPluginStagingDir('@example/provider', 'old', root);
    const stagingRoot = dirname(oldStaging);
    await mkdir(oldStaging, { recursive: true });
    await utimes(oldStaging, new Date(1), new Date(1));
    const controller = new AbortController();
    const runner = new FakeNpmRunner();
    runner.latest.set('@example/provider', '2.0.0');
    let nowCalls = 0;
    const store = new ProviderPluginStore({
      root,
      runner,
      now: () => {
        nowCalls += 1;
        if (nowCalls === 2) {
          controller.abort(new Error('closed during staging prune'));
        }
        return 24 * 60 * 60 * 1000 + 10;
      },
    });
    await expect(
      store.checkForUpdate('@example/provider', controller.signal),
    ).rejects.toThrow(/closed during staging prune/);
    expect(runner.installs).toEqual([]);
    await expect(readdir(oldStaging)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(stagingRoot)).resolves.toEqual([]);
    await expectGenerationMissing(root, '@example/provider', '2.0.0');
    await expectMetadata(root, '@example/provider', {
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
    await expectGenerationMissing(root, '@example/provider', '1.0.0');
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
    await expectGenerationMissing(root, '@example/provider', '2.0.0');
    await expectMetadata(root, '@example/provider', {
      selected_version: '1.0.0',
      last_check_completed_at: 0,
    });
  });
  it('npm runner honors aborts and uses explicit lockfile generation', async () => {
    const calls: unknown[] = [];
    const runner = new ExecaProviderPluginNpmRunner(
      async (...args: unknown[]) => {
        calls.push(args);
        return { stdout: '"1.0.0"' };
      },
    );
    const aborted = new AbortController();
    aborted.abort(new Error('already closed'));
    await expect(runner.latestVersion('@example/provider', aborted.signal)).rejects.toThrow(/already closed/);
    await expect(installExample(runner, aborted.signal)).rejects.toThrow(/already closed/);
    expect(calls).toEqual([]);
    const controller = new AbortController();
    await runner.latestVersion('@example/provider', controller.signal);
    await installExample(runner, controller.signal);
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
  publishProviderPluginGenerationRootSync({
    generationRoot: providerPluginGenerationDir(packageName, version, root),
    packageName,
    version,
    source: providerPluginSource({ version: value }),
  });
}
async function publishFakePackage(
  generationRoot: string,
  packageName: string,
  version: string,
): Promise<void> {
  publishProviderPluginGenerationRootSync({
    generationRoot,
    packageName,
    version,
    source: packageName === '@example/import-conditions'
      ? "export const condition = 'import-only';\n"
      : providerPluginSource({ version }),
    packageExports: packageName === '@example/import-conditions' ? { '.': { import: './provider.mjs' } } : undefined,
  });
}
async function writeMetadata(
  root: string,
  packageName: string,
  version: string | null,
  checkedAt: number,
  options: {
    candidateVersion?: string | null;
    lastCheckError?: string | null;
    omitAdditive?: boolean;
  } = {},
): Promise<void> {
  writeProviderPluginMetadataSync({ root, packageName, version, checkedAt, ...options });
}
async function expectMetadata(
  root: string,
  packageName: string,
  expected: Record<string, unknown>,
): Promise<void> {
  expect(readProviderPluginMetadataSync(packageName, root)).toMatchObject(expected);
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
async function prepareAndCommit(
  store: ProviderPluginStore,
  packageName: string,
): Promise<string> {
  const session = store.createMaterializingSession([packageName]);
  const version = await session.preparePackage(packageName);
  await session.commit();
  return version;
}
async function importSelected(
  store: ProviderPluginStore,
  packageName: string,
): Promise<Record<string, unknown>> {
  return await store.createInstalledOnlySession([packageName]).importModule(packageName);
}
async function expectGenerationMissing(
  root: string,
  packageName: string,
  version: string,
): Promise<void> {
  await expect(
    readFile(
      providerPluginGenerationRootPackageJsonPath(
        providerPluginGenerationDir(packageName, version, root),
      ),
      'utf8',
    ),
  ).rejects.toMatchObject({ code: 'ENOENT' });
}
async function installExample(
  runner: ExecaProviderPluginNpmRunner,
  signal: AbortSignal,
): Promise<void> {
  await runner.installExact({
    packageName: '@example/provider',
    version: '1.0.0',
    cwd: '/tmp/dreamux-provider-install',
    signal,
  });
}
