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
import type {
  ProviderDeclaration as ProviderDiagnosticDeclaration,
  ProviderDispatcherDeclaration as ProviderDiagnosticDispatcherDeclaration,
} from './config/provider-inspection.js';
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
interface ProviderDeclarationBinCheckOptions {
  agents: ProviderDiagnosticDeclaration[];
  dispatchers: ProviderDiagnosticDispatcherDeclaration[];
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
  return await runProviderDeclarationDiagnostics({
    ...options,
    dispatcher: dispatcherDeclaration(options.dispatcher),
  });
}

export async function runProviderDeclarationDiagnostics(options: {
  dispatcher: ProviderDiagnosticDispatcherDeclaration;
  catalogs: ProviderDiagnosticCatalogs;
  runner: CommandRunner;
  env: NodeJS.ProcessEnv;
  scope: ProviderDiagnosticScope;
}): Promise<ProviderDiagnosticReport[]> {
  const { dispatcher, catalogs, runner, env, scope } = options;
  const reports: ProviderDiagnosticReport[] = [];
  if (dispatcher.runtime !== null) {
    const runtime = dispatcher.runtime;
    const runtimeProvider = resolveDiagnosticProvider(
      () => catalogs.agentRuntime.resolve(runtime.provider),
      (reason) =>
        providerUnavailableDiagnostic(
          'agentRuntime',
          runtime.provider,
          reason,
        ),
    );
    const runtimeResult =
      runtimeProvider.kind === 'report'
        ? runtimeProvider.report
        : await runRuntimeDiagnostic({
            provider: runtimeProvider.provider,
            dispatcher,
            runtime,
            env,
            scope,
            runner,
          });
    reports.push({
      kind: 'agentRuntime',
      id: runtime.id,
      provider: runtime.provider,
      scope,
      result: runtimeResult,
    });
  }

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
              dispatcher.id,
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
  return providerBinChecksForDeclarations({
    ...options,
    ...declarationsForConfig(options.config),
  });
}

export function providerBinChecksForDeclarations(
  options: ProviderDeclarationBinCheckOptions,
): ProviderBinCheck[] {
  const checks = new Map<string, ProviderBinCheck>();
  const add = (check: ProviderBinCheck): void => {
    checks.set(`${check.name}\0${check.bin}\0${check.args.join('\0')}`, check);
  };

  for (const agent of options.agents) {
    const provider = resolveOptionalDiagnosticProvider(() =>
      options.catalogs.agentRuntime.resolve(agent.provider),
    );
    if (provider === null) continue;
    const diagnostic = provider.diagnostic;
    if (diagnostic === undefined) continue;
    for (const check of diagnostic.binChecks({
      runtime_id: agent.id,
      config: agent.config,
      env: options.env,
      scope: options.scope,
      paths: hostRuntimePaths,
    })) {
      add(check);
    }
  }

  for (const dispatcher of options.dispatchers) {
    for (const channel of dispatcher.channels) {
      const provider = resolveOptionalDiagnosticProvider(() =>
        options.catalogs.channel.resolve(channel.provider),
      );
      if (provider === null) continue;
      const diagnostic = provider.diagnostic;
      if (diagnostic === undefined) continue;
      for (const check of diagnostic.binChecks(
        channelDiagnosticContext(
          dispatcher.id,
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
    dispatcher: ProviderDiagnosticDispatcherDeclaration;
    runtime: ProviderDiagnosticDeclaration;
    runner: CommandRunner;
    env: NodeJS.ProcessEnv;
    scope: ProviderDiagnosticScope;
    provider: ReturnType<AgentRuntimeProviderCatalog['resolve']>;
  },
): Promise<ProviderDiagnosticResult> {
  const { dispatcher, runtime, provider, env, scope, runner } = options;
  const diagnostic = provider.diagnostic;
  return diagnostic === undefined
    ? providerDefaultDiagnostic('agentRuntime', runtime.provider)
    : await diagnostic.runDiagnostic(
        {
          runtime_id: dispatcher.id,
          config: runtime.config,
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
  dispatcherId: string,
  channelId: string,
  provider: string,
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  scope: ProviderDiagnosticScope,
): ChannelDiagnosticContext {
  return {
    dispatcher_id: dispatcherId,
    channel_id: channelId,
    provider,
    config,
    env,
    scope,
    state_root: dispatcherDir(dispatcherId),
    cache_root: dispatcherCacheDir(dispatcherId),
  };
}

function declarationsForConfig(config: DreamuxConfig): {
  agents: ProviderDiagnosticDeclaration[];
  dispatchers: ProviderDiagnosticDispatcherDeclaration[];
} {
  return {
    agents: Object.entries(config.agents).map(([id, agent]) => ({
      id,
      provider: agent.provider,
      config: agent.config,
    })),
    dispatchers: config.dispatchers.map(dispatcherDeclaration),
  };
}

function dispatcherDeclaration(
  dispatcher: DispatcherConfig,
): ProviderDiagnosticDispatcherDeclaration {
  return {
    id: dispatcher.id,
    runtime: {
      id: dispatcher.agentRuntime,
      provider: dispatcher.runtime.provider,
      config: dispatcher.runtime.config,
    },
    channels: dispatcher.channels.map((channel) => ({
      id: channel.id,
      provider: channel.provider,
      config: channel.config,
    })),
  };
}

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
