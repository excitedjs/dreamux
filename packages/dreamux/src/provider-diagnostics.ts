import type {
  ChannelDiagnosticContext,
  ProviderBinCheck,
  ProviderDiagnosticScope,
  ProviderDiagnosticResult,
} from '@excitedjs/dreamux-types';

import {
  UnsupportedAgentRuntimeProviderError,
  type AgentRuntimeProviderCatalog,
} from './agent-runtime/catalog.js';
import { hostRuntimePaths } from './agent-runtime/host-paths.js';
import {
  UnsupportedChannelProviderError,
  type ChannelProviderCatalog,
} from './channel/catalog.js';
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

type DiagnosticProviderResolution<TProvider> =
  | { kind: 'provider'; provider: TProvider }
  | { kind: 'report'; report: ProviderDiagnosticResult };

export async function runDispatcherProviderDiagnostics(
  options: ProviderDiagnosticRunOptions,
): Promise<ProviderDiagnosticReport[]> {
  const { dispatcher, catalogs, runner, env, scope } = options;
  const runtimeProvider = resolveDiagnosticProvider(
    () => catalogs.agentRuntime.resolve(dispatcher.runtime.provider),
    (reason) =>
      providerUnavailableDiagnostic(
        'agentRuntime',
        dispatcher.runtime.provider,
        reason,
      ),
  );
  const runtimeResult =
    runtimeProvider.kind === 'report'
      ? runtimeProvider.report
      : await runRuntimeDiagnostic({
          provider: runtimeProvider.provider,
          dispatcher,
          env,
          scope,
          runner,
        });
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
    const provider = resolveDiagnosticProvider(
      () => catalogs.channel.resolve(channel.provider),
      (reason) =>
        providerUnavailableDiagnostic('channel', channel.provider, reason),
    );
    if (provider.kind === 'report') {
      reports.push({
        kind: 'channel',
        id: channel.id,
        provider: channel.provider,
        scope,
        result: provider.report,
      });
      continue;
    }
    const diagnostic = provider.provider.diagnostic;
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
    const provider = resolveOptionalDiagnosticProvider(() =>
      options.catalogs.agentRuntime.resolve(agent.provider),
    );
    if (provider === null) continue;
    const diagnostic = provider.diagnostic;
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
      const provider = resolveOptionalDiagnosticProvider(() =>
        options.catalogs.channel.resolve(channel.provider),
      );
      if (provider === null) continue;
      const diagnostic = provider.diagnostic;
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

async function runRuntimeDiagnostic(
  options: {
    dispatcher: DispatcherConfig;
    runner: CommandRunner;
    env: NodeJS.ProcessEnv;
    scope: ProviderDiagnosticScope;
    provider: ReturnType<AgentRuntimeProviderCatalog['resolve']>;
  },
): Promise<ProviderDiagnosticResult> {
  const { dispatcher, provider, env, scope, runner } = options;
  const diagnostic = provider.diagnostic;
  return diagnostic === undefined
    ? providerDefaultDiagnostic('agentRuntime', dispatcher.runtime.provider)
    : await diagnostic.runDiagnostic(
        {
          runtime_id: dispatcher.id,
          config: dispatcher.runtime.config,
          env,
          scope,
          paths: hostRuntimePaths,
        },
        runner,
      );
}

function resolveDiagnosticProvider<TProvider>(
  resolve: () => TProvider,
  unavailable: (reason: string) => ProviderDiagnosticResult,
): DiagnosticProviderResolution<TProvider> {
  try {
    return { kind: 'provider', provider: resolve() };
  } catch (err) {
    if (
      err instanceof UnsupportedAgentRuntimeProviderError ||
      err instanceof UnsupportedChannelProviderError
    ) {
      return { kind: 'report', report: unavailable(err.message) };
    }
    throw err;
  }
}

function resolveOptionalDiagnosticProvider<TProvider>(
  resolve: () => TProvider,
): TProvider | null {
  const resolved = resolveDiagnosticProvider(resolve, (reason) =>
    providerUnavailableDiagnostic('provider', 'unknown', reason),
  );
  return resolved.kind === 'report' ? null : resolved.provider;
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

function providerUnavailableDiagnostic(
  kind: ProviderDiagnosticKind | 'provider',
  provider: string,
  reason: string,
): ProviderDiagnosticResult {
  return {
    ok: false,
    detail: `${kind} provider ${provider} is not runnable`,
    errors: [reason],
  };
}
