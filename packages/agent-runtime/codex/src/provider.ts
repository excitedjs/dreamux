import type {
  AgentRuntime,
  AgentRuntimeCreateContext,
  AgentRuntimeProvider,
  AgentRuntimeProviderCapabilities,
  AgentRuntimeSystemPrompt,
} from '@excitedjs/dreamux-types';
import { readCodexRecentActivity } from './activity/reader.js';
import { codexArgsFromConfig, codexArgsToCli } from './args.js';
import { resolveCodexBinPath } from './bin.js';
import {
  DEFAULT_CODEX_BIN,
  readDispatcherCodexConfig,
  type DispatcherCodexConfig,
} from './config.js';
import { codexAgentRuntimeDiagnostic } from './diagnostic.js';
import { codexMcpServerArgs } from './mcp-config.js';
import {
  compileCodexOutputSchema,
  type CodexOutputSchemaCodec,
} from './output-schema-codec.js';
import { resolveCodexHomeDir } from './paths.js';
import type { CodexRuntimeDeps } from './runtime-deps.js';
import { CodexRuntime } from './runtime.js';

/**
 * Construction options for the built-in Codex provider. The runtime's host
 * contracts arrive on the NEUTRAL create context, not as factory hooks:
 * volatile socket placement comes from `context.paths.runtimeSocketDirs()` (this
 * package owns the allocation policy). Role-gated bundled skills arrive as
 * neutral `skillSources`. Registration identity is Core's: the provider
 * carries no descriptor. The optional settings here control restart backoff;
 * this package constructs its native process and WebSocket client directly. The Codex home/auth pre-start check
 * runs unconditionally as part of `diagnostic.ts`'s doctor capability, not as
 * a runtime-start hook.
 */
export interface CodexAgentRuntimeProviderOptions {
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
        restartBackoffBaseMs: options.restartBackoffBaseMs,
        restartBackoffMaxMs: options.restartBackoffMaxMs,
      };
      return new CodexRuntime(context.identity, deps);
    },
  };
}
