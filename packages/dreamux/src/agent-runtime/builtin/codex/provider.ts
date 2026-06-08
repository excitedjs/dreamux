import { codexMcpServerArgs } from './mcp-config.js';
import { CodexWsClient } from './rpc.js';
import {
  CodexProcess,
  type CodexProcessOptions,
} from './supervisor.js';
import { CodexRuntime } from './runtime.js';
import {
  defaultDispatcherCodexConfig,
  dispatcherCodexConfig,
  readDispatcherCodexConfig,
} from './config.js';
import type { DispatcherCodexHomeDoctor } from './codex-home.js';
import { codexAgentRuntimeDiagnostic } from './diagnostic.js';
import { codexArgsFromConfig, codexArgsToCli } from './args.js';
import {
  BUILTIN_CODEX_PROVIDER_REF,
  type ProviderDescriptor,
} from '../../../registry/index.js';
import type {
  AgentRuntimeCapabilities,
  AgentRuntime,
  AgentRuntimeProvider,
  AgentRuntimeMcpServer,
} from '../../types.js';

export interface CodexAgentRuntimeProviderOptions {
  descriptor: ProviderDescriptor;
  codexProcessFactory?: (opts: CodexProcessOptions) => CodexProcess;
  codexClientFactory?: (socketPath: string) => CodexWsClient;
  codexHomeDoctor?: DispatcherCodexHomeDoctor;
  restartBackoffBaseMs?: number;
  restartBackoffMaxMs?: number;
}

/**
 * Final codex binary path for one dispatcher. The `CODEX_HOST_CODEX_BIN`
 * environment variable is a deliberate host-level override that takes
 * precedence over the dispatcher's `runtime.config.bin`; otherwise the
 * dispatcher-local bin (default `"codex"`) is used. `env` defaults to the live
 * process environment for the runtime spawn path; doctor passes the installed
 * service unit's environment so it checks what the service will run.
 */
export function resolveCodexBinPath(
  configBin: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = env['CODEX_HOST_CODEX_BIN'];
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv;
  return configBin;
}

export const CODEX_AGENT_RUNTIME_CAPABILITIES: AgentRuntimeCapabilities = {
  resume: { supported: true, checkpoint: 'codexThread' },
  steer: { supported: true },
  events: { kind: 'push' },
  last: { supported: true },
  context: { supported: false },
  systemPrompt: { mode: 'replace' },
  teammateCompletion: [
    {
      kind: 'codexInboxTurn',
      description:
        'inject the completion into thread history (thread/inject_items), then ' +
        'trigger a dispatcher turn',
    },
  ],
};

export function createCodexAgentRuntimeProvider(
  options: CodexAgentRuntimeProviderOptions,
): AgentRuntimeProvider {
  return {
    ref: BUILTIN_CODEX_PROVIDER_REF,
    descriptor: options.descriptor,
    getCapabilities: () => CODEX_AGENT_RUNTIME_CAPABILITIES,
    diagnostic: codexAgentRuntimeDiagnostic,
    readConfig(rawConfig, context) {
      return readDispatcherCodexConfig(
        rawConfig,
        context.file,
        context.prefix,
      ) as unknown as Record<string, unknown>;
    },
    createRuntime(context): AgentRuntime {
      const codexConfig =
        context.dispatcher === null
          ? defaultDispatcherCodexConfig()
          : dispatcherCodexConfig(context.dispatcher);
      const codexArgs = codexArgsFromConfig(codexConfig);
      const runtimeArgs = [
        ...codexArgsToCli(codexArgs),
        ...codexMcpServerArgs(context.mcpServers),
      ];
      const runtimeDeps = {
        dispatchers: context.dispatchers,
        cwd: context.cwd,
        systemPromptContent: context.systemPromptContent,
        state: context.state,
        paths: context.paths,
        codexBinPath: resolveCodexBinPath(codexConfig.bin),
        resolveExtraArgs: () => runtimeArgs,
        handshakeTimeoutMs: codexConfig.initialize_timeout_ms,
        extraEnv: codexConfig.extra_env,
        onTurnSettled: context.onTurnSettled,
        log: context.log,
        ...(options.codexProcessFactory !== undefined
          ? { codexProcessFactory: options.codexProcessFactory }
          : {}),
        ...(options.codexClientFactory !== undefined
          ? { codexClientFactory: options.codexClientFactory }
          : {}),
        ...(options.codexHomeDoctor !== undefined
          ? { codexHomeDoctor: options.codexHomeDoctor }
          : {}),
        ...(options.restartBackoffBaseMs !== undefined
          ? { restartBackoffBaseMs: options.restartBackoffBaseMs }
          : {}),
        ...(options.restartBackoffMaxMs !== undefined
          ? { restartBackoffMaxMs: options.restartBackoffMaxMs }
          : {}),
      };
      return new CodexRuntime(context.row, {
        ...runtimeDeps,
      });
    },
  };
}

export function codexRuntimeArgsForMcpServers(
  servers: readonly AgentRuntimeMcpServer[],
): string[] {
  return codexMcpServerArgs(servers);
}
