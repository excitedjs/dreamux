import {
  type ConfigPathOverrides,
  assertNoLegacyTomlOnly,
  globalConfigFile,
  readConfigJson,
} from './config.js';
import { pathExists } from '../platform/fs-errors.js';
import { validateConfigRawEnvelope } from './raw-envelope.js';

export interface RawConfigInspectionResult {
  configFile: string;
  raw: unknown;
}

export async function inspectRawConfig(
  overrides: ConfigPathOverrides = {},
): Promise<RawConfigInspectionResult> {
  const file = globalConfigFile(overrides);
  await assertNoLegacyTomlOnly(overrides);
  if (!(await pathExists(file))) {
    throw new Error(
      `dreamux config is missing at ${file}.\n` +
        'Run `dreamux onboard` to create it before starting the server.',
    );
  }
  const raw = await readConfigJson(file);
  validateConfigRawEnvelope(raw, file);
  return {
    configFile: file,
    raw,
  };
}
