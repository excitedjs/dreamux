import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { execa as defaultExeca } from 'execa';
import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import { writeFileAtomic } from '../platform/atomic-write.js';
import { isNotFound, pathExists } from '../platform/fs-errors.js';
import { JsonDocumentStore } from '../platform/json-document-store.js';
import {
  pluginRoot,
  providerPluginGenerationBridgePath,
  providerPluginGenerationDir,
  providerPluginGenerationLockfilePath,
  providerPluginGenerationPackageJsonPath,
  providerPluginGenerationRootBridgePath,
  providerPluginGenerationRootInstalledPackageJsonPath,
  providerPluginGenerationRootPackageJsonPath,
  providerPluginMetadataPath,
  providerPluginStagingDir,
} from '../platform/paths.js';
import { NPM_PACKAGE_PATTERN } from './provider-ref.js';
import type { ProviderModule } from './provider-loader.js';

export const PROVIDER_PLUGIN_UPDATE_INTERVAL_MS = 4 * 60 * 60 * 1000;

const METADATA_VERSION = 1;

interface ProviderPluginMetadata {
  version: typeof METADATA_VERSION;
  selected_version: string | null;
  last_check_completed_at: number | null;
}

export interface ProviderPluginInspection {
  packageName: string;
  ok: boolean;
  version: string | null;
  error: string | null;
}

export interface ProviderPluginNpmRunner {
  latestVersion(packageName: string, signal?: AbortSignal): Promise<string>;
  installExact(input: {
    packageName: string;
    version: string;
    cwd: string;
    signal?: AbortSignal;
  }): Promise<void>;
}

type ProviderPluginExeca = (
  command: string,
  args: string[],
  options: {
    cancelSignal?: AbortSignal;
    stdio?: 'pipe';
  },
) => Promise<{ stdout: string }>;

export interface ProviderPluginStoreOptions {
  root?: string;
  runner?: ProviderPluginNpmRunner;
  now?: () => number;
  importBridge?: (url: string) => Promise<unknown>;
  logger?: DreamuxLogger;
}

export class ExecaProviderPluginNpmRunner implements ProviderPluginNpmRunner {
  constructor(
    private readonly execa: ProviderPluginExeca =
      defaultExeca as unknown as ProviderPluginExeca,
  ) {}

  async latestVersion(
    packageName: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const result = await this.execa(
      'npm',
      ['view', packageName, 'dist-tags.latest', '--json'],
      { cancelSignal: signal },
    );
    const raw = result.stdout.trim();
    const parsed = raw === '' ? '' : (JSON.parse(raw) as unknown);
    if (typeof parsed !== 'string' || parsed.trim() === '') {
      throw new Error(`npm latest dist-tag for ${packageName} was empty`);
    }
    return parsed.trim();
  }

  async installExact(input: {
    packageName: string;
    version: string;
    cwd: string;
    signal?: AbortSignal;
  }): Promise<void> {
    await this.execa(
      'npm',
      [
        'install',
        '--prefix',
        input.cwd,
        '--save-exact',
        '--package-lock=true',
        `${input.packageName}@${input.version}`,
      ],
      { cancelSignal: input.signal, stdio: 'pipe' },
    );
  }
}

export class ProviderPluginStore {
  private readonly root: string;
  private readonly runner: ProviderPluginNpmRunner;
  private readonly now: () => number;
  private readonly importBridge: (url: string) => Promise<unknown>;
  private readonly logger?: DreamuxLogger;
  private readonly metadata = new JsonDocumentStore<ProviderPluginMetadata>({
    version: METADATA_VERSION,
    empty: emptyMetadata,
    parse: parseMetadata,
    corruptPolicy: 'warn-rebuild',
    warn: (message) => this.warn(message),
  });
  private updater: ProviderPluginUpdater | null = null;

  constructor(options: ProviderPluginStoreOptions = {}) {
    this.root = options.root ?? pluginRoot();
    this.runner = options.runner ?? new ExecaProviderPluginNpmRunner();
    this.now = options.now ?? Date.now;
    this.importBridge = options.importBridge ?? defaultImportBridge;
    this.logger = options.logger;
  }

  async materializePackage(
    packageName: string,
    signal?: AbortSignal,
  ): Promise<string> {
    assertProviderPluginPackageName(packageName);
    const current = await this.selectedUsableVersion(packageName);
    if (current !== null) return current;

    const latest = await this.runner.latestVersion(packageName, signal);
    await this.throwIfAborted(signal);
    const existing = await this.generationUsable(packageName, latest);
    if (existing) {
      await this.selectVersion(packageName, latest, this.now());
      return latest;
    }

    await this.installGeneration(packageName, latest, signal);
    await this.selectVersion(packageName, latest, this.now());
    return latest;
  }

  async inspectPackage(packageName: string): Promise<ProviderPluginInspection> {
    assertProviderPluginPackageName(packageName);
    try {
      const meta = await this.readMetadata(packageName);
      if (meta.selected_version === null) {
        return {
          packageName,
          ok: false,
          version: null,
          error: `provider plugin ${packageName} has no selected generation`,
        };
      }
      await this.assertGenerationComplete(packageName, meta.selected_version);
      return {
        packageName,
        ok: true,
        version: meta.selected_version,
        error: null,
      };
    } catch (err) {
      return {
        packageName,
        ok: false,
        version: null,
        error: errorMessage(err),
      };
    }
  }

  async importModule(packageName: string): Promise<ProviderModule> {
    assertProviderPluginPackageName(packageName);
    const meta = await this.readMetadata(packageName);
    if (meta.selected_version === null) {
      throw new Error(`provider plugin ${packageName} has no selected generation`);
    }
    await this.assertGenerationComplete(packageName, meta.selected_version);
    const bridge = providerPluginGenerationBridgePath(
      packageName,
      meta.selected_version,
      this.root,
    );
    const imported = await this.importBridge(pathToFileURL(bridge).href);
    const unwrapped = unwrapBridgeModule(imported);
    if (!isRecord(unwrapped)) {
      throw new Error(`provider plugin ${packageName} did not export a module namespace`);
    }
    return unwrapped as ProviderModule;
  }

  startUpdater(packages: Iterable<string>): void {
    if (this.updater !== null) return;
    const uniquePackages = [...new Set(packages)].sort();
    if (uniquePackages.length === 0) return;
    this.updater = new ProviderPluginUpdater(
      this,
      uniquePackages,
      (message) => this.warn(message),
    );
    this.updater.start();
  }

  async closeUpdater(): Promise<void> {
    const updater = this.updater;
    this.updater = null;
    await updater?.close();
  }

  async checkForUpdate(
    packageName: string,
    signal?: AbortSignal,
  ): Promise<void> {
    assertProviderPluginPackageName(packageName);
    const before = await this.readMetadata(packageName);
    try {
      const latest = await this.runner.latestVersion(packageName, signal);
      await this.throwIfAborted(signal);
      if (before.selected_version !== latest) {
        const existing = await this.generationUsable(packageName, latest);
        if (!existing) await this.installGeneration(packageName, latest, signal);
        await this.selectVersion(packageName, latest, this.now());
      } else {
        await this.writeMetadata(packageName, {
          ...before,
          last_check_completed_at: this.now(),
        });
      }
    } catch (err) {
      if (signal?.aborted === true) throw err;
      this.warn(
        `provider plugin update check failed for ${packageName}: ${errorMessage(err)}`,
      );
      await this.writeMetadata(packageName, {
        ...before,
        last_check_completed_at: this.now(),
      });
    }
  }

  async nextUpdateDelay(packages: readonly string[]): Promise<number> {
    if (packages.length === 0) return PROVIDER_PLUGIN_UPDATE_INTERVAL_MS;
    const now = this.now();
    let min = PROVIDER_PLUGIN_UPDATE_INTERVAL_MS;
    for (const packageName of packages) {
      assertProviderPluginPackageName(packageName);
      const meta = await this.readMetadata(packageName);
      const last = meta.last_check_completed_at;
      const delay =
        last === null
          ? 0
          : Math.max(0, PROVIDER_PLUGIN_UPDATE_INTERVAL_MS - (now - last));
      min = Math.min(min, delay);
    }
    return min;
  }

  private async installGeneration(
    packageName: string,
    version: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const installId = `${this.now()}-${randomUUID()}`;
    const staging = providerPluginStagingDir(packageName, installId, this.root);
    await mkdir(staging, { recursive: true });
    await writeFileAtomic(
      providerPluginGenerationRootPackageJsonPath(staging),
      `${JSON.stringify(stagingPackageJson(packageName, version), null, 2)}\n`,
      { mode: 0o600 },
    );
    await this.runner.installExact({ packageName, version, cwd: staging, signal });
    await this.throwIfAborted(signal);
    await this.assertInstalledPackage(staging, packageName, version);
    await writeFileAtomic(
      providerPluginGenerationRootBridgePath(staging),
      bridgeSource(packageName),
      { mode: 0o600 },
    );
    await this.publishGeneration(packageName, version, staging);
    await this.assertGenerationComplete(packageName, version);
  }

  private async publishGeneration(
    packageName: string,
    version: string,
    staging: string,
  ): Promise<void> {
    const generation = providerPluginGenerationDir(packageName, version, this.root);
    await mkdir(dirname(generation), { recursive: true });
    try {
      await rename(staging, generation);
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      await rm(staging, { recursive: true, force: true });
      await this.assertGenerationComplete(packageName, version);
    }
  }

  private async selectedUsableVersion(packageName: string): Promise<string | null> {
    const meta = await this.readMetadata(packageName);
    if (meta.selected_version === null) return null;
    if (await this.generationUsable(packageName, meta.selected_version)) {
      return meta.selected_version;
    }
    this.warn(
      `provider plugin ${packageName} selected generation ${meta.selected_version} is incomplete; rebuilding selection`,
    );
    return null;
  }

  private async generationUsable(
    packageName: string,
    version: string,
  ): Promise<boolean> {
    try {
      await this.assertGenerationComplete(packageName, version);
      return true;
    } catch {
      return false;
    }
  }

  private async assertGenerationComplete(
    packageName: string,
    version: string,
  ): Promise<void> {
    for (const path of [
      providerPluginGenerationPackageJsonPath(packageName, version, this.root),
      providerPluginGenerationLockfilePath(packageName, version, this.root),
      providerPluginGenerationBridgePath(packageName, version, this.root),
    ]) {
      if (!(await pathExists(path))) {
        throw new Error(`provider plugin generation is missing ${path}`);
      }
    }
    await this.assertInstalledPackage(
      providerPluginGenerationDir(packageName, version, this.root),
      packageName,
      version,
    );
  }

  private async assertInstalledPackage(
    generationRoot: string,
    packageName: string,
    version: string,
  ): Promise<void> {
    const pkgPath = providerPluginGenerationRootInstalledPackageJsonPath(
      generationRoot,
      packageName,
    );
    const parsed = JSON.parse(await readFile(pkgPath, 'utf8')) as unknown;
    if (!isRecord(parsed)) throw new Error(`${pkgPath} is not an object`);
    if (parsed['name'] !== packageName || parsed['version'] !== version) {
      throw new Error(
        `${pkgPath} identifies ${String(parsed['name'])}@${String(parsed['version'])}; expected ${packageName}@${version}`,
      );
    }
  }

  private async selectVersion(
    packageName: string,
    version: string,
    checkedAt: number,
  ): Promise<void> {
    await this.writeMetadata(packageName, {
      version: METADATA_VERSION,
      selected_version: version,
      last_check_completed_at: checkedAt,
    });
  }

  private async readMetadata(packageName: string): Promise<ProviderPluginMetadata> {
    return await this.metadata.read(providerPluginMetadataPath(packageName, this.root));
  }

  private async writeMetadata(
    packageName: string,
    metadata: ProviderPluginMetadata,
  ): Promise<void> {
    await this.metadata.write(providerPluginMetadataPath(packageName, this.root), metadata);
  }

  private async throwIfAborted(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) {
      throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
    }
  }

  private warn(message: string): void {
    this.logger?.warn(message);
  }
}

function assertProviderPluginPackageName(packageName: string): void {
  if (!NPM_PACKAGE_PATTERN.test(packageName)) {
    throw new Error(`invalid provider plugin package name: ${packageName}`);
  }
}

class ProviderPluginUpdater {
  private timer: NodeJS.Timeout | null = null;
  private flight: Promise<void> | null = null;
  private abortController: AbortController | null = null;
  private closed = false;

  constructor(
    private readonly store: ProviderPluginStore,
    private readonly packages: readonly string[],
    private readonly warn: (message: string) => void,
  ) {}

  start(): void {
    this.schedule(0);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.abortController?.abort(new Error('provider plugin updater closed'));
    await this.flight?.catch(() => undefined);
  }

  private schedule(delay: number): void {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      void this.run();
    }, delay);
    this.timer.unref?.();
  }

  private async run(): Promise<void> {
    if (this.closed || this.flight !== null) return;
    this.timer = null;
    this.flight = this.runPackages();
    try {
      await this.flight;
    } catch (err) {
      if (!this.closed) this.warn(`provider plugin updater failed: ${errorMessage(err)}`);
    } finally {
      this.flight = null;
      if (!this.closed) {
        const delay = await this.nextDelay();
        if (!this.closed) this.schedule(delay);
      }
    }
  }

  private async nextDelay(): Promise<number> {
    try {
      return await this.store.nextUpdateDelay(this.packages);
    } catch (err) {
      this.warn(
        `provider plugin updater scheduling failed: ${errorMessage(err)}`,
      );
      return PROVIDER_PLUGIN_UPDATE_INTERVAL_MS;
    }
  }

  private async runPackages(): Promise<void> {
    for (const packageName of this.packages) {
      if (this.closed) return;
      if ((await this.store.nextUpdateDelay([packageName])) > 0) continue;
      this.abortController = new AbortController();
      try {
        await this.store.checkForUpdate(packageName, this.abortController.signal);
      } finally {
        this.abortController = null;
      }
    }
  }
}

function emptyMetadata(): ProviderPluginMetadata {
  return {
    version: METADATA_VERSION,
    selected_version: null,
    last_check_completed_at: null,
  };
}

function parseMetadata(raw: unknown, ctx: { path: string }): ProviderPluginMetadata {
  if (!isRecord(raw)) throw new Error(`${ctx.path} must be an object`);
  const selected = raw['selected_version'];
  const checked = raw['last_check_completed_at'];
  if (selected !== null && typeof selected !== 'string') {
    throw new Error(`${ctx.path}.selected_version must be a string or null`);
  }
  if (checked !== null && typeof checked !== 'number') {
    throw new Error(`${ctx.path}.last_check_completed_at must be a number or null`);
  }
  return {
    version: METADATA_VERSION,
    selected_version: selected,
    last_check_completed_at: checked,
  };
}

function stagingPackageJson(packageName: string, version: string): unknown {
  return {
    private: true,
    dependencies: {
      [packageName]: version,
    },
  };
}

function bridgeSource(packageName: string): string {
  return `const namespace = await import(${JSON.stringify(packageName)});\nexport default namespace;\n`;
}

async function defaultImportBridge(url: string): Promise<unknown> {
  return await import(/* @vite-ignore */ url);
}

function unwrapBridgeModule(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return value['default'] ?? value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAlreadyExists(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    ['EEXIST', 'ENOTEMPTY'].includes(String((err as { code?: unknown }).code))
  );
}

function errorMessage(err: unknown): string {
  if (isNotFound(err)) return 'missing file or directory';
  return err instanceof Error ? err.message : String(err);
}
