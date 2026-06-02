import { existsSync, readFileSync } from 'node:fs';

import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import type { DreamuxConfig } from '../runtime/config.js';
import { BUILT_IN_DEFAULTS } from '../runtime/config.js';
import type { OnboardAnswers } from './types.js';

export const DISPATCHER_PERMISSION_PROFILE = 'dreamux-dispatcher';

export interface DispatcherCodexConfigOptions {
  codexHomeConfigPath: string;
  model: string;
  marketplaceName: string;
  marketplaceSource: string;
  pluginRef: string;
}

export function buildDreamuxConfigToml(answers: OnboardAnswers): string {
  return stringifyToml({
    runtime_dir: answers.runtimeDir,
    admin_socket: null,
    codex: {
      bin: answers.codexBin,
      approval_policy: 'never',
      sandbox_mode: 'workspace-write',
      extra_args: [],
      initialize_timeout_ms: BUILT_IN_DEFAULTS.codex.initialize_timeout_ms,
    },
    outbound: {
      retries: BUILT_IN_DEFAULTS.outbound.retries,
      retry_delay_ms: BUILT_IN_DEFAULTS.outbound.retry_delay_ms,
    },
  });
}

export function dreamuxConfigFromAnswers(answers: OnboardAnswers): DreamuxConfig {
  return {
    runtime_dir: answers.runtimeDir,
    admin_socket: null,
    codex: {
      bin: answers.codexBin,
      approval_policy: 'never',
      sandbox_mode: 'workspace-write',
      extra_args: [],
      initialize_timeout_ms: BUILT_IN_DEFAULTS.codex.initialize_timeout_ms,
    },
    outbound: {
      retries: BUILT_IN_DEFAULTS.outbound.retries,
      retry_delay_ms: BUILT_IN_DEFAULTS.outbound.retry_delay_ms,
    },
  };
}

export function buildDispatcherCodexConfigToml(
  options: DispatcherCodexConfigOptions,
): string {
  const existing = readExistingTomlObject(options.codexHomeConfigPath);
  const pluginKey = pluginConfigKey(options.pluginRef, options.marketplaceName);
  const marketplaces = objectValue(existing['marketplaces']);
  const marketplace = objectValue(marketplaces[options.marketplaceName]);
  const plugins = objectValue(existing['plugins']);
  const plugin = objectValue(plugins[pluginKey]);

  return stringifyToml({
    ...existing,
    model: options.model,
    approval_policy: 'never',
    sandbox_mode: 'workspace-write',
    default_permissions: DISPATCHER_PERMISSION_PROFILE,
    sandbox_workspace_write: {
      ...objectValue(existing['sandbox_workspace_write']),
      network_access: true,
    },
    permissions: {
      ...objectValue(existing['permissions']),
      [DISPATCHER_PERMISSION_PROFILE]: {
        ...objectValue(
          objectValue(existing['permissions'])[DISPATCHER_PERMISSION_PROFILE],
        ),
        network: { enabled: true },
      },
    },
    marketplaces: {
      ...marketplaces,
      [options.marketplaceName]: {
        ...marketplace,
        source: options.marketplaceSource,
        source_type: marketplace['source_type'] ?? inferMarketplaceSourceType(
          options.marketplaceSource,
        ),
      },
    },
    plugins: {
      ...plugins,
      [pluginKey]: {
        ...plugin,
        enabled: true,
      },
    },
  });
}

export function dispatcherCodexArgsJson(): string {
  return JSON.stringify({
    approvalPolicy: 'never',
    sandboxMode: 'workspace-write',
    extraArgs: [],
  });
}

function readExistingTomlObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = parseToml(readFileSync(path, 'utf8'));
  return objectValue(parsed);
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function pluginConfigKey(pluginRef: string, marketplaceName: string): string {
  if (pluginRef.includes('@')) return pluginRef;
  return `${pluginRef}@${marketplaceName}`;
}

function inferMarketplaceSourceType(source: string): string {
  if (source.startsWith('http://') || source.startsWith('https://')) {
    return 'git';
  }
  if (source.includes('/') && !source.startsWith('.') && !source.startsWith('/')) {
    return 'github';
  }
  return 'local';
}
