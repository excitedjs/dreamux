import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  providerPluginGenerationDir,
  providerPluginGenerationRootBridgePath,
  providerPluginGenerationRootInstalledPackageJsonPath,
  providerPluginGenerationRootLockfilePath,
  providerPluginGenerationRootPackageJsonPath,
  providerPluginMetadataPath,
} from '../../src/platform/paths.js';
export function publishProviderPluginGenerationSync(input: {
  root?: string;
  packageName: string;
  version: string;
  source?: string;
  packageExports?: unknown;
}): void {
  publishProviderPluginGenerationRootSync({
    generationRoot: providerPluginGenerationDir(
      input.packageName,
      input.version,
      input.root,
    ),
    packageName: input.packageName,
    version: input.version,
    source: input.source,
    packageExports: input.packageExports,
  });
}
export function publishProviderPluginGenerationRootSync(input: {
  generationRoot: string;
  packageName: string;
  version: string;
  source?: string;
  packageExports?: unknown;
}): void {
  const {
    generationRoot,
    packageName,
    version,
    source = providerPluginSource({ version }),
    packageExports = { import: './provider.mjs', require: './require.cjs' },
  } = input;
  const packageJsonPath = providerPluginGenerationRootInstalledPackageJsonPath(
    generationRoot,
    packageName,
  );
  const packageRoot = dirname(packageJsonPath);
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    providerPluginGenerationRootPackageJsonPath(generationRoot),
    json({ private: true, dependencies: { [packageName]: version } }),
  );
  writeFileSync(providerPluginGenerationRootLockfilePath(generationRoot), '{}\n');
  writeFileSync(
    packageJsonPath,
    json({ name: packageName, version, type: 'module', exports: packageExports }),
  );
  writeFileSync(join(packageRoot, 'provider.mjs'), source);
  writeFileSync(
    join(packageRoot, 'require.cjs'),
    "module.exports = { loadedFrom: 'require' };\n",
  );
  writeFileSync(
    providerPluginGenerationRootBridgePath(generationRoot),
    `const namespace = await import(${JSON.stringify(packageName)});\nexport default namespace;\n`,
  );
}
export function writeProviderPluginMetadataSync(input: {
  root?: string;
  packageName: string;
  version: string | null;
  checkedAt: number;
  candidateVersion?: string | null;
  lastCheckError?: string | null;
  omitAdditive?: boolean;
}): void {
  const {
    root,
    packageName,
    version,
    checkedAt,
    candidateVersion,
    lastCheckError,
    omitAdditive,
  } = input;
  const metadataPath = providerPluginMetadataPath(packageName, root);
  mkdirSync(dirname(metadataPath), { recursive: true });
  writeFileSync(
    metadataPath,
    json({
      version: 1,
      selected_version: version,
      ...(omitAdditive === true
        ? {}
        : {
            candidate_version: candidateVersion ?? null,
            last_check_error: lastCheckError ?? null,
          }),
      last_check_completed_at: checkedAt,
    }),
  );
}
export function readProviderPluginMetadataSync(
  packageName: string,
  root?: string,
): Record<string, unknown> {
  return JSON.parse(
    readFileSync(providerPluginMetadataPath(packageName, root), 'utf8'),
  ) as Record<string, unknown>;
}
function json(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
export function providerPluginSource(options: {
  version?: string;
  readConfigBody?: string;
  collectBody?: string;
  channelDiagnostic?: string;
} = {}): string {
  const { version, readConfigBody, collectBody, channelDiagnostic } = options;
  return `
export const loadedFrom = 'esm';
export const value = ${JSON.stringify(version)};
export function provider({ ref, descriptor }) { return { ref, descriptor: { ...descriptor, kind: 'agentRuntime' }, getCapabilities() { return { resume: { supported: true } }; }, readConfig(rawConfig) { ${readConfigBody ?? `return { ...rawConfig, runtime_generation: ${JSON.stringify(version)} };`} }, ${collectBody === undefined ? '' : `onboard: { collect() { ${collectBody} } },`} createRuntime() { throw new Error('test runtime does not create a runtime'); } }; }
export function channel({ ref, descriptor }) { return { ref, descriptor: { ...descriptor, kind: 'channel' }, readConfig(rawConfig) { return { ...rawConfig, channel_generation: ${JSON.stringify(version)} }; }, ${channelDiagnostic ?? ''} createSession() { throw new Error('test channel does not create a session'); } }; }
export const runtime = provider;
`;
}
