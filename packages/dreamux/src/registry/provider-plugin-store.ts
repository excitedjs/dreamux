import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execa as defaultExeca } from 'execa';
import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import { writeFileAtomic } from '../platform/atomic-write.js';
import { isNotFound, pathExists } from '../platform/fs-errors.js';
import { JsonDocumentStore } from '../platform/json-document-store.js';
import {
  pluginRoot,
  providerPluginGenerationDir,
  providerPluginGenerationRootBridgePath,
  providerPluginGenerationRootInstalledPackageJsonPath,
  providerPluginGenerationRootLockfilePath,
  providerPluginGenerationRootPackageJsonPath,
  providerPluginMetadataPath,
  providerPluginStagingDir,
} from '../platform/paths.js';
import { NPM_PACKAGE_PATTERN } from './provider-ref.js';
import type { ProviderModule } from './provider-loader.js';
import { errMessage, isRecord } from './provider-loader.js';
import {
  ProviderPluginUpdater,
  PROVIDER_PLUGIN_UPDATE_INTERVAL_MS,
} from './provider-plugin-updater.js';
export { PROVIDER_PLUGIN_UPDATE_INTERVAL_MS } from './provider-plugin-updater.js';
const METADATA_VERSION = 1;
interface ProviderPluginMetadata {
  version: typeof METADATA_VERSION;
  selected_version: string | null;
  candidate_version: string | null;
  last_check_completed_at: number | null;
  last_check_error: string | null;
}
export interface ProviderPluginInspection {
  packageName: string;
  ok: boolean;
  version: string | null;
  error: string | null;
  lastCheckError: string | null;
}
export interface ProviderPluginAccess {
  createMaterializingSession(
    packages: Iterable<string>,
    signal?: AbortSignal,
  ): ProviderPluginLoadSession;
  createInstalledOnlySession(packages: Iterable<string>): ProviderPluginLoadSession;
  inspectPackages(packages: Iterable<string>): Promise<ProviderPluginInspection[]>;
}
export interface ProviderPluginLoadSession {
  preparePackage(packageName: string): Promise<string>;
  importModule(packageName: string): Promise<ProviderModule>;
  commit(): Promise<void>;
  rejectCandidates(): Promise<void>;
  canUseSelectedOnly(): Promise<boolean>;
  selectedOnly(): ProviderPluginLoadSession;
  readonly candidatePackages: readonly string[];
}
type ProviderPluginSessionMode = 'materialize' | 'selected-only';
interface ProviderPluginSessionOps {
  prepareMaterializedCandidate(packageName: string, signal?: AbortSignal): Promise<string>;
  pinnedSelectedVersion(packageName: string): Promise<string | null>;
  pinnedCandidateVersion(packageName: string): Promise<string | null>;
  commitCandidate(packageName: string, version: string): Promise<void>;
  rejectCandidate(packageName: string, version: string): Promise<void>;
  importModule(packageName: string, version: string): Promise<ProviderModule>;
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
const STAGING_PRUNE_AGE_MS = 24 * 60 * 60 * 1000;
export class ExecaProviderPluginNpmRunner implements ProviderPluginNpmRunner {
  constructor(
    private readonly execa: ProviderPluginExeca =
      defaultExeca as unknown as ProviderPluginExeca,
  ) {}
  async latestVersion(
    packageName: string,
    signal?: AbortSignal,
  ): Promise<string> {
    throwIfAborted(signal);
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
    throwIfAborted(input.signal);
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
  private readonly sessionOps: ProviderPluginSessionOps = {
    prepareMaterializedCandidate: async (packageName, signal) =>
      await this.prepareMaterializedCandidate(packageName, signal),
    pinnedSelectedVersion: async (packageName) =>
      await this.pinnedSelectedVersion(packageName),
    pinnedCandidateVersion: async (packageName) =>
      await this.pinnedCandidateVersion(packageName),
    commitCandidate: async (packageName, version) =>
      await this.commitCandidate(packageName, version),
    rejectCandidate: async (packageName, version) =>
      await this.rejectCandidate(packageName, version),
    importModule: async (packageName, version) =>
      await this.importGenerationModule(packageName, version),
  };
  constructor(options: ProviderPluginStoreOptions = {}) {
    this.root = options.root ?? pluginRoot();
    this.runner = options.runner ?? new ExecaProviderPluginNpmRunner();
    this.now = options.now ?? Date.now;
    this.importBridge = options.importBridge ?? defaultImportBridge;
    this.logger = options.logger;
  }
  createMaterializingSession(
    packages: Iterable<string>,
    signal?: AbortSignal,
  ): ProviderPluginLoadSession {
    return new StoreProviderPluginLoadSession(this.sessionOps, packages, 'materialize', signal);
  }
  createInstalledOnlySession(
    packages: Iterable<string>,
  ): ProviderPluginLoadSession {
    return new StoreProviderPluginLoadSession(this.sessionOps, packages, 'selected-only');
  }
  async inspectPackages(
    packages: Iterable<string>,
  ): Promise<ProviderPluginInspection[]> {
    const out: ProviderPluginInspection[] = [];
    for (const packageName of [...new Set(packages)].sort()) {
      out.push(await this.inspectPackage(packageName));
    }
    return out;
  }
  async inspectPackage(packageName: string): Promise<ProviderPluginInspection> {
    assertProviderPluginPackageName(packageName);
    try {
      const meta = await this.readMetadata(packageName);
      if (meta.selected_version === null) {
        return pluginInspection(packageName, false, null,
          `provider plugin ${packageName} has no selected generation`, meta);
      }
      await this.assertGenerationComplete(packageName, meta.selected_version);
      return pluginInspection(packageName, true, meta.selected_version, null, meta);
    } catch (err) {
      return pluginInspection(packageName, false, null, pluginErrorMessage(err));
    }
  }
  async importModule(
    packageName: string,
    version?: string,
  ): Promise<ProviderModule> {
    assertProviderPluginPackageName(packageName);
    if (version !== undefined) {
      return await this.importGenerationModule(packageName, version);
    }
    const meta = await this.readMetadata(packageName);
    if (meta.selected_version === null) {
      throw new Error(`provider plugin ${packageName} has no selected generation`);
    }
    return await this.importGenerationModule(packageName, meta.selected_version);
  }
  private async importGenerationModule(
    packageName: string,
    version: string,
  ): Promise<ProviderModule> {
    assertProviderPluginPackageName(packageName);
    await this.assertGenerationComplete(packageName, version);
    const generationRoot = providerPluginGenerationDir(
      packageName,
      version,
      this.root,
    );
    const bridge = providerPluginGenerationRootBridgePath(generationRoot);
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
    throwIfAborted(signal);
    try {
      const latest = await this.runner.latestVersion(packageName, signal);
      throwIfAborted(signal);
      if (before.selected_version === latest) {
        await this.writeSuccessfulCheckMetadata(packageName, before, null);
        return;
      }
      if (before.candidate_version === latest) {
        await this.writeSuccessfulCheckMetadata(packageName, before);
        return;
      }
      {
        const existing = await this.generationUsable(packageName, latest);
        throwIfAborted(signal);
        if (!existing) await this.installGeneration(packageName, latest, signal);
        throwIfAborted(signal);
        await this.writeSuccessfulCheckMetadata(packageName, before, latest);
      }
    } catch (err) {
      if (signal?.aborted === true) throw err;
      this.warn(
        `provider plugin update check failed for ${packageName}: ${pluginErrorMessage(err)}`,
      );
      await this.writeMetadata(packageName, {
        ...before,
        last_check_completed_at: this.now(),
        last_check_error: pluginErrorMessage(err),
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
  private async prepareMaterializedCandidate(
    packageName: string,
    signal?: AbortSignal,
  ): Promise<string> {
    assertProviderPluginPackageName(packageName);
    const latest = await this.runner.latestVersion(packageName, signal);
    throwIfAborted(signal);
    if (!(await this.generationUsable(packageName, latest))) {
      throwIfAborted(signal);
      await this.installGeneration(packageName, latest, signal);
    }
    throwIfAborted(signal);
    const before = await this.readMetadata(packageName);
    await this.writeSuccessfulCheckMetadata(packageName, before, latest);
    return latest;
  }
  private async pinnedSelectedVersion(packageName: string): Promise<string | null> {
    assertProviderPluginPackageName(packageName);
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
  private async pinnedCandidateVersion(packageName: string): Promise<string | null> {
    assertProviderPluginPackageName(packageName);
    const meta = await this.readMetadata(packageName);
    return meta.candidate_version;
  }
  private async commitCandidate(packageName: string, version: string): Promise<void> {
    assertProviderPluginPackageName(packageName);
    const before = await this.readMetadata(packageName);
    if (before.candidate_version !== version) return;
    await this.writeMetadata(packageName, {
      ...before,
      selected_version: version,
      candidate_version: null,
    });
  }
  private async rejectCandidate(packageName: string, version: string): Promise<void> {
    assertProviderPluginPackageName(packageName);
    const before = await this.readMetadata(packageName);
    if (before.candidate_version !== version) return;
    await this.writeMetadata(packageName, {
      ...before,
      candidate_version: null,
    });
  }
  private async installGeneration(
    packageName: string,
    version: string,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const installId = `${this.now()}-${randomUUID()}`;
    const staging = providerPluginStagingDir(packageName, installId, this.root);
    await this.pruneOldStaging(packageName);
    try {
      await mkdir(staging, { recursive: true });
      throwIfAborted(signal);
      await writeFileAtomic(
        providerPluginGenerationRootPackageJsonPath(staging),
        `${JSON.stringify(stagingPackageJson(packageName, version), null, 2)}\n`,
        { mode: 0o600 },
      );
      throwIfAborted(signal);
      await this.runner.installExact({ packageName, version, cwd: staging, signal });
      throwIfAborted(signal);
      await this.assertInstalledPackage(staging, packageName, version);
      throwIfAborted(signal);
      await writeFileAtomic(
        providerPluginGenerationRootBridgePath(staging),
        bridgeSource(packageName),
        { mode: 0o600 },
      );
      throwIfAborted(signal);
      await this.publishGeneration(packageName, version, staging);
      throwIfAborted(signal);
      await this.assertGenerationComplete(packageName, version);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
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
  private async pruneOldStaging(packageName: string): Promise<void> {
    const stagingRoot = dirname(providerPluginStagingDir(packageName, 'probe', this.root));
    let entries;
    try {
      entries = await readdir(stagingRoot, { withFileTypes: true });
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
    const cutoff = this.now() - STAGING_PRUNE_AGE_MS;
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const path = join(stagingRoot, entry.name);
          const info = await stat(path);
          if (info.mtimeMs < cutoff) {
            await rm(path, { recursive: true, force: true });
          }
        }),
    );
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
    const generationRoot = providerPluginGenerationDir(packageName, version, this.root);
    for (const path of [
      providerPluginGenerationRootPackageJsonPath(generationRoot),
      providerPluginGenerationRootLockfilePath(generationRoot),
      providerPluginGenerationRootBridgePath(generationRoot),
    ]) {
      if (!(await pathExists(path))) {
        throw new Error(`provider plugin generation is missing ${path}`);
      }
    }
    await this.assertInstalledPackage(
      generationRoot,
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
  private async readMetadata(packageName: string): Promise<ProviderPluginMetadata> {
    return await this.metadata.read(providerPluginMetadataPath(packageName, this.root));
  }
  private async writeMetadata(
    packageName: string,
    metadata: ProviderPluginMetadata,
  ): Promise<void> {
    await this.metadata.write(providerPluginMetadataPath(packageName, this.root), metadata);
  }
  private async writeSuccessfulCheckMetadata(
    packageName: string,
    before: ProviderPluginMetadata,
    candidateVersion = before.candidate_version,
  ): Promise<void> {
    await this.writeMetadata(packageName, {
      ...before,
      candidate_version: candidateVersion,
      last_check_completed_at: this.now(),
      last_check_error: null,
    });
  }
  private warn(message: string): void {
    this.logger?.warn(message);
  }
}
class StoreProviderPluginLoadSession implements ProviderPluginLoadSession {
  private readonly prepared = new Map<string, { version: string; source: 'selected' | 'candidate' }>();
  private readonly packages: readonly string[];
  constructor(
    private readonly ops: ProviderPluginSessionOps,
    packages: Iterable<string>,
    private readonly mode: ProviderPluginSessionMode,
    private readonly signal?: AbortSignal,
  ) {
    this.packages = [...new Set(packages)].sort();
    for (const packageName of this.packages) assertProviderPluginPackageName(packageName);
  }
  get candidatePackages(): readonly string[] {
    return [...this.prepared.entries()]
      .filter(([, entry]) => entry.source === 'candidate')
      .map(([packageName]) => packageName)
      .sort();
  }
  async preparePackage(packageName: string): Promise<string> {
    assertProviderPluginPackageName(packageName);
    const current = this.prepared.get(packageName);
    if (current !== undefined) return current.version;
    const candidate = this.mode === 'materialize' ? await this.ops.pinnedCandidateVersion(packageName) : null;
    if (candidate !== null) return this.prepare(packageName, candidate, 'candidate');
    const selected = await this.ops.pinnedSelectedVersion(packageName);
    if (selected !== null) return this.prepare(packageName, selected, 'selected');
    if (this.mode === 'selected-only') throw new Error(`provider plugin ${packageName} has no selected generation`);
    return this.prepare(packageName, await this.ops.prepareMaterializedCandidate(packageName, this.signal), 'candidate');
  }
  async importModule(packageName: string): Promise<ProviderModule> {
    return await this.ops.importModule(packageName, await this.preparePackage(packageName));
  }
  async commit(): Promise<void> {
    for (const [packageName, entry] of this.prepared) {
      if (entry.source === 'candidate') await this.ops.commitCandidate(packageName, entry.version);
    }
  }
  async rejectCandidates(): Promise<void> {
    for (const [packageName, entry] of this.prepared) {
      if (entry.source === 'candidate') await this.ops.rejectCandidate(packageName, entry.version);
    }
  }
  async canUseSelectedOnly(): Promise<boolean> {
    for (const packageName of this.packages) {
      if ((await this.ops.pinnedSelectedVersion(packageName)) === null) return false;
    }
    return true;
  }
  selectedOnly(): ProviderPluginLoadSession {
    return new StoreProviderPluginLoadSession(this.ops, this.packages, 'selected-only', this.signal);
  }
  private prepare(packageName: string, version: string, source: 'selected' | 'candidate'): string {
    this.prepared.set(packageName, { version, source });
    return version;
  }
}
function assertProviderPluginPackageName(packageName: string): void {
  if (!NPM_PACKAGE_PATTERN.test(packageName)) {
    throw new Error(`invalid provider plugin package name: ${packageName}`);
  }
}
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
  }
}
function emptyMetadata(): ProviderPluginMetadata {
  return {
    version: METADATA_VERSION,
    selected_version: null,
    candidate_version: null,
    last_check_completed_at: null,
    last_check_error: null,
  };
}
function pluginInspection(
  packageName: string,
  ok: boolean,
  version: string | null,
  error: string | null,
  meta = emptyMetadata(),
): ProviderPluginInspection {
  return {
    packageName,
    ok,
    version,
    error,
    lastCheckError: meta.last_check_error,
  };
}
function parseMetadata(raw: unknown, ctx: { path: string }): ProviderPluginMetadata {
  if (!isRecord(raw)) throw new Error(`${ctx.path} must be an object`);
  const selected = raw['selected_version'];
  const candidate = raw['candidate_version'] ?? null;
  const checked = raw['last_check_completed_at'];
  const checkError = raw['last_check_error'] ?? null;
  if (selected !== null && typeof selected !== 'string') {
    throw new Error(`${ctx.path}.selected_version must be a string or null`);
  }
  if (candidate !== null && typeof candidate !== 'string') {
    throw new Error(`${ctx.path}.candidate_version must be a string or null`);
  }
  if (checked !== null && typeof checked !== 'number') {
    throw new Error(`${ctx.path}.last_check_completed_at must be a number or null`);
  }
  if (checkError !== null && typeof checkError !== 'string') {
    throw new Error(`${ctx.path}.last_check_error must be a string or null`);
  }
  return {
    version: METADATA_VERSION,
    selected_version: selected,
    candidate_version: candidate,
    last_check_completed_at: checked,
    last_check_error: checkError,
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
function isAlreadyExists(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    ['EEXIST', 'ENOTEMPTY'].includes(String((err as { code?: unknown }).code))
  );
}
function pluginErrorMessage(err: unknown): string {
  if (isNotFound(err)) return 'missing file or directory';
  return errMessage(err);
}
