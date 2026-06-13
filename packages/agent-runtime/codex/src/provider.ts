import { codexMcpServerArgs } from './mcp-config.js';
import { CodexWsClient } from './rpc.js';
import {
  CodexProcess,
  type CodexProcessOptions,
} from './supervisor.js';
import {
  CodexRuntime,
  type CodexRuntimeDeps,
  type CodexWorkspaceSkillPrepResult,
} from './runtime.js';
import {
  dispatcherCodexConfig,
  readDispatcherCodexConfig,
  type DispatcherCodexConfig,
} from './config.js';
import { codexArgsFromConfig, codexArgsToCli } from './args.js';
import { BUILTIN_CODEX_PROVIDER_REF } from './provider-ref.js';
import type {
  AgentRuntimeCapabilities,
  AgentRuntime,
  AgentRuntimeCreateContext,
  AgentRuntimeMcpServer,
  AgentRuntimeProvider,
  ProviderDescriptor,
} from '@excitedjs/dreamux-types';

/**
 * Host-supplied hooks for the built-in Codex provider. Everything that is a
 * Dreamux host contract — the volatile socket root, the package-bin `PATH`, the
 * bundled-skill install mechanism, the Codex home/auth pre-start check — is
 * injected here by Dreamux core (or by an external embedder), so this package
 * reconstructs none of it. The `descriptor` and the test factories let core and
 * tests wire process/WS/home seams without changing the provider.
 */
export interface CodexAgentRuntimeProviderOptions {
  /** The registry descriptor for `builtin:codex`. Defaults to a minimal one. */
  descriptor?: ProviderDescriptor;
  /**
   * Allocate a fresh volatile rendezvous socket path per app-server start
   * (host runtime-socket contract). Required for a runnable runtime.
   */
  allocateSocketPath?: (id: string) => string;
  /** Materialize bundled skill sources into the runtime workspace before start. */
  prepareWorkspaceSkills?: (
    cwd: string,
  ) => Promise<readonly CodexWorkspaceSkillPrepResult[]>;
  /** Build the base process env (host seeds `PATH` with the Dreamux package bins). */
  baseProcessEnv?: (extraEnv: Record<string, string>) => NodeJS.ProcessEnv;
  /** Host-owned Codex home/auth pre-start check, invoked with the runtime id and cwd. */
  codexHomeDoctor?: (info: {
    runtimeId: string;
    cwd: string;
  }) => void | Promise<void>;
  codexProcessFactory?: (opts: CodexProcessOptions) => CodexProcess;
  codexClientFactory?: (socketPath: string) => CodexWsClient;
  restartBackoffBaseMs?: number;
  restartBackoffMaxMs?: number;
}

/**
 * Final codex binary path for one runtime. The `CODEX_HOST_CODEX_BIN`
 * environment variable is a deliberate host-level override that takes precedence
 * over the configured `runtime.config.bin`; otherwise the configured bin
 * (default `"codex"`) is used. `env` defaults to the live process environment
 * for the runtime spawn path; doctor passes the installed service unit's
 * environment so it checks what the service will run.
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

const DEFAULT_CODEX_DESCRIPTOR: ProviderDescriptor = {
  id: 'codex',
  kind: 'agentRuntime',
  ref: { source: 'builtin', id: 'codex', raw: BUILTIN_CODEX_PROVIDER_REF },
};

/**
 * Create the built-in Codex `AgentRuntimeProvider`. It implements the neutral
 * `@excitedjs/dreamux-types` contract: `readConfig` parses Codex runtime config,
 * `getCapabilities` reports Codex's resume/steer/completion shape, and
 * `createRuntime` builds a {@link CodexRuntime} from the neutral create context
 * plus the host-supplied hooks.
 */
export function createCodexAgentRuntimeProvider(
  options: CodexAgentRuntimeProviderOptions = {},
): AgentRuntimeProvider<DispatcherCodexConfig> {
  return {
    ref: BUILTIN_CODEX_PROVIDER_REF,
    descriptor: options.descriptor ?? DEFAULT_CODEX_DESCRIPTOR,
    getCapabilities: () => CODEX_AGENT_RUNTIME_CAPABILITIES,
    readConfig(rawConfig, context) {
      return readDispatcherCodexConfig(rawConfig, context.file, context.prefix);
    },
    createRuntime(context: AgentRuntimeCreateContext<DispatcherCodexConfig>): AgentRuntime {
      if (context.state === undefined) {
        throw new Error('codex runtime requires a state sink in the create context');
      }
      if (context.paths === undefined) {
        throw new Error('codex runtime requires a path context in the create context');
      }
      if (options.allocateSocketPath === undefined) {
        throw new Error(
          'codex runtime requires a socket allocator (host runtime-socket contract)',
        );
      }
      const codexConfig = context.config;
      const codexArgs = codexArgsFromConfig(codexConfig);
      const runtimeArgs = [
        ...codexArgsToCli(codexArgs),
        ...codexMcpServerArgs(context.mcpServers),
      ];
      const deps: CodexRuntimeDeps = {
        cwd: context.cwd,
        state: context.state,
        paths: context.paths,
        allocateSocketPath: options.allocateSocketPath,
        codexBinPath: resolveCodexBinPath(codexConfig.bin),
        resolveExtraArgs: () => runtimeArgs,
        handshakeTimeoutMs: codexConfig.initialize_timeout_ms,
        extraEnv: codexConfig.extra_env,
        ...(context.systemPromptContent !== undefined
          ? { systemPromptContent: context.systemPromptContent }
          : {}),
        ...(context.onTurnSettled !== undefined
          ? { onTurnSettled: context.onTurnSettled }
          : {}),
        ...(context.logger !== undefined ? { logger: context.logger } : {}),
        ...(options.prepareWorkspaceSkills !== undefined
          ? { prepareWorkspaceSkills: options.prepareWorkspaceSkills }
          : {}),
        ...(options.baseProcessEnv !== undefined
          ? { baseProcessEnv: options.baseProcessEnv }
          : {}),
        ...(options.codexHomeDoctor !== undefined
          ? { codexHomeDoctor: options.codexHomeDoctor }
          : {}),
        ...(options.codexProcessFactory !== undefined
          ? { codexProcessFactory: options.codexProcessFactory }
          : {}),
        ...(options.codexClientFactory !== undefined
          ? { codexClientFactory: options.codexClientFactory }
          : {}),
        ...(options.restartBackoffBaseMs !== undefined
          ? { restartBackoffBaseMs: options.restartBackoffBaseMs }
          : {}),
        ...(options.restartBackoffMaxMs !== undefined
          ? { restartBackoffMaxMs: options.restartBackoffMaxMs }
          : {}),
      };
      return new CodexRuntime(context.identity, deps);
    },
  };
}

/** Re-export the typed accessor for a runtime's resolved codex config. */
export { dispatcherCodexConfig };

export function codexRuntimeArgsForMcpServers(
  servers: readonly AgentRuntimeMcpServer[],
): string[] {
  return codexMcpServerArgs(servers);
}
