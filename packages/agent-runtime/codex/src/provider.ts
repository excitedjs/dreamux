import { codexMcpServerArgs } from './mcp-config.js';
import { CodexWsClient } from './rpc.js';
import {
  CodexProcess,
  type CodexProcessOptions,
} from './supervisor.js';
import {
  CodexRuntime,
  type CodexRuntimeDeps,
} from './runtime.js';
import {
  dispatcherCodexConfig,
  readDispatcherCodexConfig,
  type DispatcherCodexConfig,
} from './config.js';
import { codexArgsFromConfig, codexArgsToCli } from './args.js';
import { BUILTIN_CODEX_PROVIDER_REF } from './provider-ref.js';
import { defaultVolatileSocketPath } from './internal/socket.js';
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
 * Codex home/auth pre-start check — is injected here by Dreamux core (or by an
 * external embedder), so this package reconstructs none of it. Role-gated
 * bundled skills arrive on the create context as neutral `skillSources` (not a
 * host hook). The `descriptor` and the test factories let core and tests wire
 * process/WS/home seams without changing the provider.
 */
export interface CodexAgentRuntimeProviderOptions {
  /** The registry descriptor for `builtin:codex`. Defaults to a minimal one. */
  descriptor?: ProviderDescriptor;
  /**
   * Allocate a fresh volatile rendezvous socket path per app-server start. The
   * Dreamux host injects its own shared runtime-socket root here; when omitted
   * the package falls back to {@link defaultVolatileSocketPath} so a
   * loader-constructed / standalone runtime is still runnable.
   */
  allocateSocketPath?: (id: string) => string;
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
        allocateSocketPath: options.allocateSocketPath ?? defaultVolatileSocketPath,
        codexBinPath: resolveCodexBinPath(codexConfig.bin),
        resolveExtraArgs: () => runtimeArgs,
        handshakeTimeoutMs: codexConfig.initialize_timeout_ms,
        extraEnv: codexConfig.extra_env,
        ...(context.skillSources !== undefined
          ? { skillSources: context.skillSources }
          : {}),
        ...(context.systemPromptContent !== undefined
          ? { systemPromptContent: context.systemPromptContent }
          : {}),
        ...(context.onTurnSettled !== undefined
          ? { onTurnSettled: context.onTurnSettled }
          : {}),
        ...(context.logger !== undefined ? { logger: context.logger } : {}),
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

/**
 * The context Dreamux core's generic provider package-loader passes to a
 * package's factory export: the canonical ref and the seed descriptor the
 * provider echoes back. Structurally matches core's `ProviderFactoryContext`
 * without importing core.
 */
export interface CodexProviderFactoryContext {
  ref: string;
  descriptor: ProviderDescriptor;
}

/**
 * Default export — the factory Dreamux core's generic provider-loader selects
 * for the `builtin:codex` ref (it imports this package and calls the default
 * export with `{ ref, descriptor }`). It returns a provider that runs on package
 * defaults: a standalone volatile-socket allocator and no host-injected bundled
 * skills.
 *
 * The Dreamux host does NOT use this bare path in production: its launcher still
 * drives the host-shaped create context, so it constructs the provider through
 * its own core-owned adapter (`@excitedjs/dreamux` `builtin/codex/provider.ts`)
 * to map that context onto the neutral one AND inject its host contracts (the
 * shared runtime-socket root, the package-bin `PATH`, and the bundled Dreamux
 * skills). This default export keeps the package a first-class, loadable
 * `AgentRuntimeProvider` for the generic loader and for external embedders;
 * converging core's launcher onto the neutral context so it can drive the loaded
 * provider directly is later-slice work.
 */
export default function codexAgentRuntimeProviderFactory(
  context: CodexProviderFactoryContext,
): AgentRuntimeProvider<DispatcherCodexConfig> {
  return createCodexAgentRuntimeProvider({ descriptor: context.descriptor });
}
