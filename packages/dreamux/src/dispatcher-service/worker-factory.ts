import type { ClaudeCodeSessionFactory } from '../agent-runtime/claude-code-session.js';
import type { CodexProcess, CodexProcessOptions } from '../codex/supervisor.js';
import type { CodexWsClient } from '../codex/rpc.js';
import {
  BUILTIN_CLAUDE_CODE_PROVIDER_REF,
  BUILTIN_CODEX_PROVIDER_REF,
  DEFAULT_CLAUDE_CODE_BIN,
  DEFAULT_CODEX_BIN,
  defaultDispatcherClaudeCodeConfig,
  defaultDispatcherCodexConfig,
  dispatcherClaudeCodeConfig,
  dispatcherCodexConfig,
  type DispatcherClaudeCodeConfig,
  type DispatcherCodexConfig,
  type DreamuxConfig,
} from '../runtime/config.js';
import type { DispatcherStore } from '../runtime/dispatcher-store.js';
import type { DreamuxLogger } from '../runtime/logger.js';
import {
  dispatcherProcessEnv,
  resolveExecutableOnPath,
} from '../runtime/package-bin.js';
import { dispatcherCodexCwd } from '../runtime/paths.js';
import { createClaudeCodeTeamMateWorkerProvider } from '../teammate/worker/claude-code-provider.js';
import { createCodexTeamMateWorkerProvider } from '../teammate/worker/codex-provider.js';
import { TeamMateWorkerProviderCatalog } from '../teammate/worker/catalog.js';
import type {
  TeamMateWorkerAvailability,
  WorkerBinaryProbe,
} from './teammate-types.js';

export interface DefaultTeamMateWorkerCatalogOptions {
  config: DreamuxConfig;
  dispatchers: DispatcherStore;
  codexBinPath?: string;
  codexProcessFactory?: (opts: CodexProcessOptions) => CodexProcess;
  codexClientFactory?: (socketPath: string) => CodexWsClient;
  claudeCodeWorkerSessionFactory?: ClaudeCodeSessionFactory;
  log: DreamuxLogger;
}

export function createDefaultTeamMateWorkerCatalog(
  opts: DefaultTeamMateWorkerCatalogOptions,
): TeamMateWorkerProviderCatalog {
  return new TeamMateWorkerProviderCatalog({
    providers: [
      createCodexTeamMateWorkerProvider({
        resolveBinPath: (dispatcherBin) =>
          resolveCodexBinPath(opts.codexBinPath, dispatcherBin),
        resolveCodexConfig: (dispatcherId) =>
          resolveDispatcherCodexConfig(opts, dispatcherId),
        resolveDispatcherCwd: (dispatcherId) =>
          resolveDispatcherCwd(opts, dispatcherId),
        ...(opts.codexProcessFactory !== undefined
          ? { codexProcessFactory: opts.codexProcessFactory }
          : {}),
        ...(opts.codexClientFactory !== undefined
          ? { codexClientFactory: opts.codexClientFactory }
          : {}),
        log: (level, message, fields) => opts.log[level](fields ?? {}, message),
      }),
      createClaudeCodeTeamMateWorkerProvider({
        resolveBinPath: (dispatcherBin) => dispatcherBin,
        resolveClaudeCodeConfig: (dispatcherId) =>
          resolveDispatcherClaudeCodeConfig(opts, dispatcherId),
        resolveDispatcherCwd: (dispatcherId) =>
          resolveDispatcherCwd(opts, dispatcherId),
        ...(opts.claudeCodeWorkerSessionFactory !== undefined
          ? { sessionFactory: opts.claudeCodeWorkerSessionFactory }
          : {}),
        log: (level, message, fields) => opts.log[level](fields ?? {}, message),
      }),
    ],
    defaultRef: BUILTIN_CODEX_PROVIDER_REF,
  });
}

export function createDefaultWorkerBinaryProbe(
  codexBinPath: string | undefined,
): WorkerBinaryProbe {
  return async (providerRef) => {
    const availability = await defaultWorkerBinaryProbe(
      providerRef,
      codexBinPath,
    );
    return availability;
  };
}

async function defaultWorkerBinaryProbe(
  providerRef: string,
  codexBinPath: string | undefined,
): Promise<TeamMateWorkerAvailability> {
  let bin: string;
  if (providerRef === BUILTIN_CODEX_PROVIDER_REF) {
    bin = resolveCodexBinPath(codexBinPath, DEFAULT_CODEX_BIN);
  } else if (providerRef === BUILTIN_CLAUDE_CODE_PROVIDER_REF) {
    bin = DEFAULT_CLAUDE_CODE_BIN;
  } else {
    return { available: true, reason: '' };
  }
  const resolved = await resolveExecutableOnPath(
    bin,
    dispatcherProcessEnv(process.env),
  );
  if (resolved !== null) return { available: true, reason: '' };
  return {
    available: false,
    reason:
      `worker binary '${bin}' was not found on the dispatcher service PATH; ` +
      'install it (or set the binary/PATH for this runtime) before routing tasks here',
  };
}

function resolveCodexBinPath(
  codexBinPath: string | undefined,
  dispatcherBin: string,
): string {
  if (codexBinPath !== undefined) return codexBinPath;
  const fromEnv = process.env['CODEX_HOST_CODEX_BIN'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return dispatcherBin;
}

function resolveDispatcherCodexConfig(
  opts: DefaultTeamMateWorkerCatalogOptions,
  dispatcherId: string,
): DispatcherCodexConfig {
  const dispatcher = opts.config.dispatchers.find(
    (entry) => entry.id === dispatcherId,
  );
  if (
    dispatcher === undefined ||
    dispatcher.runtime.provider !== BUILTIN_CODEX_PROVIDER_REF
  ) {
    return defaultDispatcherCodexConfig();
  }
  return dispatcherCodexConfig(dispatcher);
}

function resolveDispatcherClaudeCodeConfig(
  opts: DefaultTeamMateWorkerCatalogOptions,
  dispatcherId: string,
): DispatcherClaudeCodeConfig {
  const dispatcher = opts.config.dispatchers.find(
    (entry) => entry.id === dispatcherId,
  );
  if (
    dispatcher === undefined ||
    dispatcher.runtime.provider !== BUILTIN_CLAUDE_CODE_PROVIDER_REF
  ) {
    return defaultDispatcherClaudeCodeConfig();
  }
  return dispatcherClaudeCodeConfig(dispatcher);
}

function resolveDispatcherCwd(
  opts: DefaultTeamMateWorkerCatalogOptions,
  dispatcherId: string,
): string {
  return opts.dispatchers.get(dispatcherId)?.codex_cwd ?? dispatcherCodexCwd(dispatcherId);
}
