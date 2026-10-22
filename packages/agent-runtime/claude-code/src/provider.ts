import type {
  AgentRuntime,
  AgentRuntimeCreateContext,
  AgentRuntimeProvider,
} from '@excitedjs/dreamux-types';
import { readClaudeRecentActivity } from './activity/reader.js';
import {
  DEFAULT_CLAUDE_CODE_BIN,
  readDispatcherClaudeCodeConfig,
  type DispatcherClaudeCodeConfig,
} from './config.js';
import { claudeCodeAgentRuntimeDiagnostic } from './diagnostic.js';
import { resolveClaudeConfigHomeDir } from './paths.js';
import type { ClaudeCodeRuntimeDeps } from './runtime-deps.js';
import { ClaudeCodeRuntime } from './runtime.js';

function normalizedSystemPromptAppend(
  append: readonly string[] | undefined,
): readonly string[] | undefined {
  const normalized = (append ?? []).filter((prompt) => prompt !== '');
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * Create the built-in Claude Code `AgentRuntimeProvider`. It implements the
 * neutral `@excitedjs/dreamux-types` contract: `config.read` parses Claude Code
 * runtime config, `readRecentActivity` serves neutral Activity Records for any
 * session, and `createRuntime` builds a {@link ClaudeCodeRuntime} from the
 * neutral create context and the configured Claude binary.
 *
 * Claude Code resumes from its native session id alone, which it publishes as
 * the neutral opaque session id.
 */
export function createClaudeCodeAgentRuntimeProvider(): AgentRuntimeProvider<DispatcherClaudeCodeConfig> {
  return {
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
        events: context.events,
        paths: context.paths,
        mcpServers: context.mcpServers,
        skillSources: context.skillSources,
        // Neutral seam name in, provider-native name out: `disableFeatures` is
        // this package's own internal wording and stops at the adapter.
        disableFeatures: context.disabledFeatures,
        outputSchema: context.outputSchema,
        systemPromptAppend,
        logger: context.logger,
      };
      return new ClaudeCodeRuntime(context.identity, deps);
    },
  };
}
