import { ClaudeCodeRuntime } from './runtime.js';
import type { ClaudeCodeRuntimeDeps } from './runtime-deps.js';
import {
  DEFAULT_CLAUDE_CODE_BIN,
  readDispatcherClaudeCodeConfig,
  type DispatcherClaudeCodeConfig,
} from './config.js';
import {
  createDefaultClaudeCodeSession,
  type ClaudeCodeSessionFactory,
} from './supervisor.js';
import { claudeCodeAgentRuntimeDiagnostic } from './diagnostic.js';
import { readClaudeRecentActivity } from './activity/reader.js';
import { resolveClaudeConfigHomeDir } from './paths.js';
import type {
  AgentRuntime,
  AgentRuntimeCreateContext,
  AgentRuntimeProvider,
  AgentRuntimeProviderCapabilities,
} from '@excitedjs/dreamux-types';

function normalizedSystemPromptAppend(
  append: readonly string[] | undefined,
): readonly string[] | undefined {
  const normalized = (append ?? []).filter((prompt) => prompt !== '');
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * Construction options for the built-in Claude Code provider. Registration
 * identity is Core's: the provider carries no descriptor. What remains here
 * are the test/host seams (the resident-session factory, an optional host bin
 * resolver) that let core and tests wire behavior without changing the
 * provider.
 */
export interface ClaudeCodeAgentRuntimeProviderOptions {
  /** Optional host-level bin resolver (default: identity on the config bin). */
  resolveBinPath?: (bin: string) => string;
  /** Override the resident-session factory (tests inject a fake). */
  sessionFactory?: ClaudeCodeSessionFactory;
  /** Override native session UUID generation for deterministic tests. */
  generateSessionId?: ClaudeCodeRuntimeDeps['generateSessionId'];
}

/**
 * Provider-static selection metadata. Recovery, session-bound structured
 * output, and recent Activity reads are mandatory provider behavior, so none of
 * them is advertised here.
 */
export const CLAUDE_CODE_AGENT_RUNTIME_CAPABILITIES: AgentRuntimeProviderCapabilities =
  { tags: [] };

/**
 * Create the built-in Claude Code `AgentRuntimeProvider`. It implements the
 * neutral `@excitedjs/dreamux-types` contract: `config.read` parses Claude Code
 * runtime config, `readRecentActivity` serves neutral Activity Records for any
 * session, and `createRuntime` builds a {@link ClaudeCodeRuntime} from the
 * neutral create context plus the host-supplied options.
 *
 * Claude Code resumes from its native session id alone, which it publishes as
 * the neutral opaque session id.
 */
export function createClaudeCodeAgentRuntimeProvider(
  options: ClaudeCodeAgentRuntimeProviderOptions = {},
): AgentRuntimeProvider<DispatcherClaudeCodeConfig> {
  const sessionFactory =
    options.sessionFactory ?? createDefaultClaudeCodeSession;
  const resolveBinPath = options.resolveBinPath ?? ((bin: string) => bin);
  return {
    getCapabilities: () => CLAUDE_CODE_AGENT_RUNTIME_CAPABILITIES,
    diagnostic: claudeCodeAgentRuntimeDiagnostic,
    operatorStateRoot: (env) => resolveClaudeConfigHomeDir(env, process.cwd()),
    onboard: {
      async collect(_context, prompts): Promise<Record<string, unknown>> {
        const bin = await prompts.text({
          message: 'Claude Code CLI binary',
          initialValue: DEFAULT_CLAUDE_CODE_BIN,
          required: true,
        });
        return { bin };
      },
    },
    config: {
      read(rawConfig, context) {
        return readDispatcherClaudeCodeConfig(
          rawConfig,
          context.file,
          context.prefix,
        );
      },
    },
    readRecentActivity: (query, context) =>
      readClaudeRecentActivity(query, context),
    async createRuntime(
      context: AgentRuntimeCreateContext<DispatcherClaudeCodeConfig>,
    ): Promise<AgentRuntime> {
      const systemPromptAppend = normalizedSystemPromptAppend(
        context.systemPrompt?.append,
      );
      const deps: ClaudeCodeRuntimeDeps = {
        config: context.config,
        cwd: context.cwd,
        state: context.state,
        activitySink: context.activity,
        paths: context.paths,
        mcpServers: context.mcpServers,
        sessionFactory,
        resolveBinPath,
        skillSources: context.skillSources,
        // Neutral seam name in, provider-native name out: `disableFeatures` is
        // this package's own internal wording and stops at the adapter.
        disableFeatures: context.disabledFeatures,
        outputSchema: context.outputSchema,
        generateSessionId: options.generateSessionId,
        systemPromptAppend,
        logger: context.logger,
      };
      return new ClaudeCodeRuntime(context.identity, deps);
    },
  };
}
