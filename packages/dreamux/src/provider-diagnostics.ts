import type {
  ChannelDiagnosticContext,
  ProviderBinCheck,
  ProviderDiagnosticScope,
  ProviderDiagnosticResult,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from './agent-runtime/catalog.js';
import { hostRuntimePaths } from './agent-runtime/host-paths.js';
import type { ChannelProviderCatalog } from './channel/catalog.js';
import type { DispatcherConfig, DreamuxConfig } from './config/config.js';
import {
  dispatcherCacheDir,
  dispatcherDir,
} from './platform/paths.js';
import type { CommandRunner } from './onboard/types.js';

export type ProviderDiagnosticKind = 'agentRuntime' | 'channel';

export interface ProviderDiagnosticCatalogs {
  agentRuntime: AgentRuntimeProviderCatalog;
  channel: ChannelProviderCatalog;
}

export interface ProviderDiagnosticReport {
  kind: ProviderDiagnosticKind;
  id: string;
  provider: string;
  scope: ProviderDiagnosticScope;
  result: ProviderDiagnosticResult;
}

interface ProviderDiagnosticRunOptions {
  dispatcher: DispatcherConfig;
  catalogs: ProviderDiagnosticCatalogs;
  runner: CommandRunner;
  env: NodeJS.ProcessEnv;
  scope: ProviderDiagnosticScope;
}

interface ProviderBinCheckOptions {
  config: DreamuxConfig;
  catalogs: ProviderDiagnosticCatalogs;
  env: NodeJS.ProcessEnv;
  scope: ProviderDiagnosticScope;
}

export async function runDispatcherProviderDiagnostics(
  options: ProviderDiagnosticRunOptions,
): Promise<ProviderDiagnosticReport[]> {
  const { dispatcher, catalogs, runner, env, scope } = options;
  const runtimeProvider = catalogs.agentRuntime.resolve(
    dispatcher.runtime.provider,
  );
  const runtimeDiagnostic = runtimeProvider.diagnostic;
  const runtimeResult =
    runtimeDiagnostic === undefined
      ? providerDefaultDiagnostic('agentRuntime', dispatcher.runtime.provider)
      : await runtimeDiagnostic.runDiagnostic(
          {
            runtime_id: dispatcher.id,
            config: dispatcher.runtime.config,
            env,
            scope,
            paths: hostRuntimePaths,
          },
          runner,
        );
  const reports: ProviderDiagnosticReport[] = [
    {
      kind: 'agentRuntime',
      id: dispatcher.agentRuntime,
      provider: dispatcher.runtime.provider,
      scope,
      result: runtimeResult,
    },
  ];

  for (const channel of dispatcher.channels) {
    const provider = catalogs.channel.resolve(channel.provider);
    const diagnostic = provider.diagnostic;
    const result =
      diagnostic === undefined
        ? providerDefaultDiagnostic('channel', channel.provider)
        : await diagnostic.runDiagnostic(
            channelDiagnosticContext(
              dispatcher,
              channel.id,
              channel.provider,
              channel.config,
              env,
              scope,
            ),
            runner,
          );
    reports.push({
      kind: 'channel',
      id: channel.id,
      provider: channel.provider,
      scope,
      result,
    });
  }
  return reports;
}

export function providerBinChecksForConfig(
  options: ProviderBinCheckOptions,
): ProviderBinCheck[] {
  const checks = new Map<string, ProviderBinCheck>();
  const add = (check: ProviderBinCheck): void => {
    checks.set(`${check.name}\0${check.bin}\0${check.args.join('\0')}`, check);
  };

  for (const [agentId, agent] of Object.entries(options.config.agents)) {
    const diagnostic = options.catalogs.agentRuntime.resolve(
      agent.provider,
    ).diagnostic;
    if (diagnostic === undefined) continue;
    for (const check of diagnostic.binChecks({
      runtime_id: agentId,
      config: agent.config,
      env: options.env,
      scope: options.scope,
      paths: hostRuntimePaths,
    })) {
      add(check);
    }
  }

  for (const dispatcher of options.config.dispatchers) {
    for (const channel of dispatcher.channels) {
      const diagnostic = options.catalogs.channel.resolve(
        channel.provider,
      ).diagnostic;
      if (diagnostic === undefined) continue;
      for (const check of diagnostic.binChecks(
        channelDiagnosticContext(
          dispatcher,
          channel.id,
          channel.provider,
          channel.config,
          options.env,
          options.scope,
        ),
      )) {
        add(check);
      }
    }
  }

  return [...checks.values()];
}

function channelDiagnosticContext(
  dispatcher: DispatcherConfig,
  channelId: string,
  provider: string,
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  scope: ProviderDiagnosticScope,
): ChannelDiagnosticContext {
  return {
    dispatcher_id: dispatcher.id,
    channel_id: channelId,
    provider,
    config,
    env,
    scope,
    state_root: dispatcherDir(dispatcher.id),
    cache_root: dispatcherCacheDir(dispatcher.id),
  };
}

/** Default passing result for a provider that declares no diagnostic surface. */
function providerDefaultDiagnostic(
  kind: ProviderDiagnosticKind,
  provider: string,
): ProviderDiagnosticResult {
  return {
    ok: true,
    detail: `${kind} provider ${provider} reports no diagnostics`,
    errors: [],
  };
}
