import { mkdirSync, writeFileSync } from 'node:fs';
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
}): void {
  const { root, packageName, version, source = providerFixtureSource(version) } = input;
  const generationRoot = providerPluginGenerationDir(packageName, version, root);
  const packageJsonPath = providerPluginGenerationRootInstalledPackageJsonPath(generationRoot, packageName);
  const packageRoot = dirname(packageJsonPath);
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    providerPluginGenerationRootPackageJsonPath(generationRoot),
    json({ private: true, dependencies: { [packageName]: version } }),
  );
  writeFileSync(providerPluginGenerationRootLockfilePath(generationRoot), '{}\n');
  writeFileSync(
    packageJsonPath,
    json({ name: packageName, version, type: 'module', exports: './provider.mjs' }),
  );
  writeFileSync(join(packageRoot, 'provider.mjs'), source);
  writeFileSync(
    providerPluginGenerationRootBridgePath(generationRoot),
    `const namespace = await import(${JSON.stringify(packageName)});\nexport default namespace;\n`,
  );
}
export function writeProviderPluginMetadataSync(input: {
  root?: string;
  packageName: string;
  version: string;
  checkedAt: number;
  candidateVersion?: string | null;
  lastCheckError?: string | null;
}): void {
  const { root, packageName, version, checkedAt, candidateVersion, lastCheckError } = input;
  const metadataPath = providerPluginMetadataPath(packageName, root);
  mkdirSync(dirname(metadataPath), { recursive: true });
  writeFileSync(
    metadataPath,
    json({
      version: 1,
      selected_version: version,
      candidate_version: candidateVersion ?? null,
      last_check_completed_at: checkedAt,
      last_check_error: lastCheckError ?? null,
    }),
  );
}
function json(value: unknown): string { return `${JSON.stringify(value)}\n`; }
function providerFixtureSource(version: string): string {
  return `
export function provider({ ref, descriptor }) { return { ref, descriptor: { ...descriptor, kind: 'agentRuntime' }, getCapabilities() { return { resume: { supported: true } }; }, readConfig(rawConfig) { return { ...rawConfig, runtime_generation: ${JSON.stringify(version)} }; }, createRuntime() { throw new Error('test runtime does not create a runtime'); } }; }
export const runtime = provider;
export function channel({ ref, descriptor }) { return { ref, descriptor: { ...descriptor, kind: 'channel' }, readConfig(rawConfig) { return { ...rawConfig, channel_generation: ${JSON.stringify(version)} }; }, createSession() { throw new Error('test channel does not create a session'); } }; }
`;
}
