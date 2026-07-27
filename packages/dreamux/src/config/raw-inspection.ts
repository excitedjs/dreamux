import {
  describeType,
  isPlainObject,
  rejectUnknownKeys,
} from '@excitedjs/dreamux-utils';

import type { ProviderPluginInspection } from '../registry/provider-plugin-store.js';
import {
  type ConfigPathOverrides,
  assertNoLegacyTomlOnly,
  globalConfigFile,
  readConfigJson,
} from './config.js';
import { pathExists } from '../platform/fs-errors.js';
import {
  agentProviderRefs,
  channelProviderRefs,
} from './config-helpers.js';
import { prepareProviderPlugins } from './provider-plugin-loading.js';

export interface RawConfigInspectionResult {
  configFile: string;
  raw: unknown;
  providerPluginPackages: string[];
  providerPluginDiagnostics: ProviderPluginInspection[];
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
  assertRawConfigInspectionShape(raw, file);
  const pluginPlan = await prepareProviderPlugins({
    agentRefs: agentProviderRefs(raw),
    channelRefs: channelProviderRefs(raw),
    overrides: {
      ...overrides,
      providerPluginLoadMode: 'installed-only',
    },
  });
  return {
    configFile: file,
    raw,
    providerPluginPackages: pluginPlan.packages,
    providerPluginDiagnostics: pluginPlan.diagnostics,
  };
}

function assertRawConfigInspectionShape(raw: unknown, file: string): void {
  if (!isPlainObject(raw)) {
    throw new Error(`dreamux config error in ${file}: top-level must be an object`);
  }
  rejectTopLevelCodex(raw, file);
  rejectUnknownKeys(raw, new Set(['agents', 'dispatchers']), file, '');
  const agents = raw['agents'];
  const dispatchers = raw['dispatchers'];
  if (agents !== undefined && !Array.isArray(agents)) {
    throw new Error(
      `dreamux config error in ${file}: agents must be an array (got ${describeType(agents)})`,
    );
  }
  if (dispatchers !== undefined && !Array.isArray(dispatchers)) {
    throw new Error(
      `dreamux config error in ${file}: dispatchers must be an array (got ${describeType(dispatchers)})`,
    );
  }
}

function rejectTopLevelCodex(raw: Record<string, unknown>, file: string): void {
  if (!('codex' in raw)) return;
  throw new Error(
    `dreamux config error in ${file}: a top-level "codex" block is no longer ` +
      'supported. Declare a named agent under agents[] with the selected runtime ' +
      'provider and a provider-owned config block, then reference it from each ' +
      'dispatcher via dispatchers[].agentRuntime.',
  );
}
