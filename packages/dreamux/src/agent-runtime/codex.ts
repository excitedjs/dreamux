import { codexMcpServerArgs } from '../codex/mcp-config.js';
import { CodexWsClient } from '../codex/rpc.js';
import {
  CodexProcess,
  type CodexProcessOptions,
} from '../codex/supervisor.js';
import { DispatcherRuntime } from '../dispatcher/runtime.js';
import {
  BUILTIN_CODEX_PROVIDER_REF,
  defaultDispatcherCodexConfig,
  dispatcherCodexConfig,
} from '../runtime/config.js';
import type { DispatcherCodexHomeDoctor } from '../runtime/dispatcher-codex-home.js';
import { codexArgsToCli, parseCodexArgs } from '../runtime/codex-args.js';
import { type ProviderDescriptor } from '../registry/index.js';
import type {
  AgentRuntimeCapabilities,
  AgentRuntime,
  AgentRuntimeProvider,
  AgentRuntimeMcpServer,
} from './types.js';

export interface CodexAgentRuntimeProviderOptions {
  descriptor: ProviderDescriptor;
  resolveBinPath: (bin: string) => string;
  codexProcessFactory?: (opts: CodexProcessOptions) => CodexProcess;
  codexClientFactory?: (socketPath: string) => CodexWsClient;
  codexHomeDoctor?: DispatcherCodexHomeDoctor;
  restartBackoffBaseMs?: number;
  restartBackoffMaxMs?: number;
}

export const CODEX_AGENT_RUNTIME_CAPABILITIES: AgentRuntimeCapabilities = {
  resume: { supported: true, checkpoint: 'codexThread' },
  steer: { supported: true },
  events: { kind: 'push' },
  last: { supported: true },
  context: { supported: false },
  teammateCompletion: [
    {
      kind: 'codexInboxTurn',
      description:
        'write completion to a runtime inbox, then trigger a dispatcher turn',
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
    createRuntime(context): AgentRuntime {
      const codexConfig =
        context.dispatcher === null
          ? defaultDispatcherCodexConfig()
          : dispatcherCodexConfig(context.dispatcher);
      const codexArgs = parseCodexArgs(context.row.codex_args_json);
      const runtimeArgs = [
        ...codexArgsToCli(codexArgs),
        ...codexMcpServerArgs(context.mcpServers),
      ];
      const runtimeDeps = {
        dispatchers: context.dispatchers,
        state: context.state,
        paths: context.paths,
        codexBinPath: options.resolveBinPath(codexConfig.bin),
        resolveExtraArgs: () => runtimeArgs,
        handshakeTimeoutMs: codexConfig.initialize_timeout_ms,
        extraEnv: codexConfig.extra_env,
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
      return new DispatcherRuntime(context.row, {
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
