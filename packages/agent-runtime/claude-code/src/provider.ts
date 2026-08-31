import { ClaudeCodeRuntime } from './runtime.js';
import type { ClaudeCodeRuntimeDeps } from './runtime-deps.js';
import {
  DEFAULT_CLAUDE_CODE_BIN,
  dispatcherClaudeCodeConfig,
  readDispatcherClaudeCodeConfig,
  type DispatcherClaudeCodeConfig,
} from './config.js';
import {
  createDefaultClaudeCodeSession,
  type ClaudeCodeSessionFactory,
} from './supervisor.js';
import { claudeCodeAgentRuntimeDiagnostic } from './diagnostic.js';
import { readClaudeRecentActivity } from './activity/reader.js';
import type {
  AgentRuntime,
  AgentRuntimeCreateContext,
  AgentRuntimeProvider,
  AgentRuntimeProviderCapabilities,
  AgentRuntimeProviderFactory,
  AgentRuntimeSessionRef,
} from '@excitedjs/dreamux-types';

function normalizedSystemPromptAppend(
  append: readonly string[] | undefined,
): readonly string[] | undefined {
  const normalized = (append ?? []).filter((prompt) => prompt !== '');
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * Construction options for the built-in Claude Code provider. Env injection
 * arrives on the NEUTRAL create context (`context.injectEnv`), not as a factory
 * hook, and registration identity is Core's: the provider carries no
 * descriptor. What remains here are the test/host seams (the resident-session
 * factory, an optional host bin resolver) that let core and tests wire behavior
 * without changing the provider.
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
 * Claude Code resumes from its native session id alone, so its session identity
 * is the base {@link AgentRuntimeSessionRef}.
 */
export function createClaudeCodeAgentRuntimeProvider(
  options: ClaudeCodeAgentRuntimeProviderOptions = {},
): AgentRuntimeProvider<DispatcherClaudeCodeConfig, AgentRuntimeSessionRef> {
  const sessionFactory =
    options.sessionFactory ?? createDefaultClaudeCodeSession;
  const resolveBinPath = options.resolveBinPath ?? ((bin: string) => bin);
  return {
    getCapabilities: () => CLAUDE_CODE_AGENT_RUNTIME_CAPABILITIES,
    diagnostic: claudeCodeAgentRuntimeDiagnostic,
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
      context: AgentRuntimeCreateContext<
        DispatcherClaudeCodeConfig,
        AgentRuntimeSessionRef
      >,
    ): Promise<AgentRuntime> {
      const systemPromptAppend = normalizedSystemPromptAppend(
        context.systemPrompt?.append,
      );
      const deps: ClaudeCodeRuntimeDeps = {
        config: context.config,
        cwd: context.cwd,
        state: context.state,
        activitySink: context.activity ?? (() => undefined),
        paths: context.paths,
        mcpServers: context.mcpServers,
        sessionFactory,
        resolveBinPath,
        ...(context.injectEnv !== undefined
          ? { injectEnv: context.injectEnv }
          : {}),
        ...(context.skillSources !== undefined
          ? { skillSources: context.skillSources }
          : {}),
        // Neutral seam name in, provider-native name out: `disableFeatures` is
        // this package's own internal wording and stops at the adapter.
        disableFeatures: context.disabledFeatures,
        outputSchema: context.outputSchema,
        ...(options.generateSessionId !== undefined
          ? { generateSessionId: options.generateSessionId }
          : {}),
        ...(systemPromptAppend !== undefined
          ? { systemPromptAppend }
          : {}),
        ...(context.logger !== undefined ? { logger: context.logger } : {}),
      };
      return new ClaudeCodeRuntime(context.identity, deps);
    },
  };
}

/** Re-export the typed accessor for a runtime's resolved claude-code config. */
export { dispatcherClaudeCodeConfig };

/**
 * Default export — the factory Dreamux core's generic provider-loader selects
 * for the `builtin:claude-code` ref (it imports this package and calls the
 * default export with `{ ref }`). It returns a provider on package defaults:
 * the real resident-session factory and an identity bin resolver.
 *
 * This is the production path. Core drives the loaded provider through the
 * neutral facade alone — it holds no adapter for this package — and supplies
 * every host contract (state lease, path context, skill sources, MCP servers)
 * through the neutral create context. The options argument of
 * {@link createClaudeCodeAgentRuntimeProvider} exists for embedders and tests.
 */
const claudeCodeAgentRuntimeProviderFactory: AgentRuntimeProviderFactory<
  DispatcherClaudeCodeConfig,
  AgentRuntimeSessionRef
> = () => createClaudeCodeAgentRuntimeProvider();

export default claudeCodeAgentRuntimeProviderFactory;
