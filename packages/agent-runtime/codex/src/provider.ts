import { codexMcpServerArgs } from './mcp-config.js';
import { CodexWsClient } from './rpc.js';
import { CodexProcess, type CodexProcessOptions } from './supervisor.js';
import { CodexRuntime } from './runtime.js';
import type { CodexRuntimeDeps } from './runtime-deps.js';
import {
  DEFAULT_CODEX_BIN,
  readDispatcherCodexConfig,
  type DispatcherCodexConfig,
} from './config.js';
import { codexArgsFromConfig, codexArgsToCli } from './args.js';
import { resolveCodexBinPath } from './bin.js';
import { codexAgentRuntimeDiagnostic } from './diagnostic.js';
import { allocateCodexSocketPath } from './internal/socket.js';
import { readCodexRecentActivity } from './activity/reader.js';
import { resolveCodexHomeDir } from './paths.js';
import {
  compileCodexOutputSchema,
  type CodexOutputSchemaCodec,
} from './output-schema-codec.js';
import type {
  AgentRuntime,
  AgentRuntimeCreateContext,
  AgentRuntimeProvider,
  AgentRuntimeProviderCapabilities,
  AgentRuntimeSystemPrompt,
} from '@excitedjs/dreamux-types';

/**
 * Construction options for the built-in Codex provider. The runtime's host
 * contracts arrive on the NEUTRAL create context, not as factory hooks:
 * volatile socket placement comes from `context.paths.runtimeSocketDirs()` (this
 * package owns the allocation policy). Role-gated bundled skills arrive as
 * neutral `skillSources`. Registration identity is Core's: the provider
 * carries no descriptor. What remains here are the test/host seams
 * (process/WS factories, restart backoff) that let core and tests wire
 * behavior without changing the provider. The Codex home/auth pre-start check
 * runs unconditionally as part of `diagnostic.ts`'s doctor capability, not as
 * a runtime-start hook.
 */
export interface CodexAgentRuntimeProviderOptions {
  codexProcessFactory?: (opts: CodexProcessOptions) => CodexProcess;
  codexClientFactory?: (socketPath: string) => CodexWsClient;
  restartBackoffBaseMs?: number;
  restartBackoffMaxMs?: number;
}

/**
 * Provider-static selection metadata. Recovery, session-bound structured
 * output, and recent Activity reads are mandatory provider behavior, so none of
 * them is advertised here.
 */
export const CODEX_AGENT_RUNTIME_CAPABILITIES: AgentRuntimeProviderCapabilities =
  { tags: [] };

export function codexSystemPromptReplace(
  systemPrompt: AgentRuntimeSystemPrompt | undefined,
): string | undefined {
  if (systemPrompt === undefined) return undefined;
  if (systemPrompt.replace !== undefined) return systemPrompt.replace;
  return undefined;
}

export function codexSystemPromptAppend(
  systemPrompt: AgentRuntimeSystemPrompt | undefined,
): readonly string[] | undefined {
  if (systemPrompt === undefined) return undefined;
  if (systemPrompt.replace !== undefined) return undefined;
  if (systemPrompt.append === undefined || systemPrompt.append.length === 0)
    return undefined;
  const append = systemPrompt.append.filter((prompt) => prompt !== '');
  return append.length > 0 ? append : undefined;
}

/**
 * Create the built-in Codex `AgentRuntimeProvider`. It implements the neutral
 * `@excitedjs/dreamux-types` contract: `config.read` parses Codex runtime
 * config, `readRecentActivity` serves neutral Activity Records for any session,
 * and `createRuntime` builds a {@link CodexRuntime} from the neutral create
 * context plus the host-supplied hooks.
 *
 * Codex resumes from its thread id alone, which it publishes as the neutral
 * opaque session id.
 */
export function createCodexAgentRuntimeProvider(
  options: CodexAgentRuntimeProviderOptions = {},
): AgentRuntimeProvider<DispatcherCodexConfig> {
  return {
    getCapabilities: () => CODEX_AGENT_RUNTIME_CAPABILITIES,
    diagnostic: codexAgentRuntimeDiagnostic,
    operatorStateRoot: resolveCodexHomeDir,
    onboard: {
      async collect(_context, prompts): Promise<Record<string, unknown>> {
        const bin = await prompts.text({
          message: 'Codex CLI binary',
          initialValue: DEFAULT_CODEX_BIN,
          required: true,
        });
        return { bin };
      },
    },
    config: {
      read(rawConfig, context) {
        return readDispatcherCodexConfig(
          rawConfig,
          context.file,
          context.prefix,
        );
      },
    },
    readRecentActivity: (query, context) =>
      readCodexRecentActivity(query, context),
    async createRuntime(
      context: AgentRuntimeCreateContext<DispatcherCodexConfig>,
    ): Promise<AgentRuntime> {
      const codexConfig = context.config;
      const codexArgs = codexArgsFromConfig(codexConfig);
      const runtimeArgs = [
        ...codexArgsToCli(codexArgs),
        ...codexMcpServerArgs(context.mcpServers),
      ];
      const paths = context.paths;
      const systemPromptReplace = codexSystemPromptReplace(
        context.systemPrompt,
      );
      const systemPromptAppend = codexSystemPromptAppend(context.systemPrompt);
      // Bind the output schema once, here. A compile failure is a create-time
      // error; no later submission can change or renegotiate the schema.
      const codec: CodexOutputSchemaCodec | null =
        context.outputSchema === undefined
          ? null
          : compileCodexOutputSchema(context.outputSchema);
      const deps: CodexRuntimeDeps = {
        cwd: context.cwd,
        state: context.state,
        activitySink: context.activity,
        codec,
        paths,
        // The package owns socket allocation: pick a fresh name in the first of
        // the host's preference-ordered candidate dirs that fits the budget.
        allocateSocketPath: (id) =>
          allocateCodexSocketPath(paths.runtimeSocketDirs(), id),
        codexBinPath: resolveCodexBinPath(codexConfig.bin),
        extraArgs: runtimeArgs,
        handshakeTimeoutMs: codexConfig.initialize_timeout_ms,
        extraEnv: codexConfig.extra_env,
        // context.skillSources is a required field on AgentRuntimeCreateContext
        // (never undefined) — assign it directly.
        skillSources: context.skillSources,
        systemPromptReplace,
        systemPromptAppend,
        logger: context.logger,
        codexProcessFactory: options.codexProcessFactory,
        codexClientFactory: options.codexClientFactory,
        restartBackoffBaseMs: options.restartBackoffBaseMs,
        restartBackoffMaxMs: options.restartBackoffMaxMs,
      };
      return new CodexRuntime(context.identity, deps);
    },
  };
}
