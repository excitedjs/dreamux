import {
  ClaudeCodeRuntime,
  type ClaudeCodeRuntimeDeps,
} from './runtime.js';
import {
  dispatcherClaudeCodeConfig,
  readDispatcherClaudeCodeConfig,
  type DispatcherClaudeCodeConfig,
} from './config.js';
import {
  createDefaultClaudeCodeSession,
  type ClaudeCodeSessionFactory,
} from './supervisor.js';
import { BUILTIN_CLAUDE_CODE_PROVIDER_REF } from './provider-ref.js';
import type {
  AgentRuntimeCapabilities,
  AgentRuntime,
  AgentRuntimeCreateContext,
  AgentRuntimeProvider,
  ProviderDescriptor,
} from '@excitedjs/dreamux-types';

/**
 * Host-supplied options for the built-in Claude Code provider. The base process
 * env (the host seeds `PATH` with the Dreamux package bins) is a Dreamux host
 * contract injected here by core or an external embedder, so the package
 * reconstructs none of it. The `descriptor` and the session factory let core and
 * tests wire the resident-process seam without changing the provider.
 */
export interface ClaudeCodeAgentRuntimeProviderOptions {
  /** The registry descriptor for `builtin:claude-code`. Defaults to a minimal one. */
  descriptor?: ProviderDescriptor;
  /** Optional host-level bin resolver (default: identity on the config bin). */
  resolveBinPath?: (bin: string) => string;
  /** Override the resident-session factory (tests inject a fake). */
  sessionFactory?: ClaudeCodeSessionFactory;
  /** Build the base process env (host seeds `PATH` with the Dreamux package bins). */
  baseProcessEnv?: (extraEnv: Record<string, string>) => NodeJS.ProcessEnv;
}

export const CLAUDE_CODE_AGENT_RUNTIME_CAPABILITIES: AgentRuntimeCapabilities = {
  resume: { supported: true, checkpoint: 'claudeCodeSession' },
  steer: { supported: true },
  events: { kind: 'synthesized' },
  last: { supported: true },
  context: { supported: false },
  systemPrompt: { mode: 'append' },
  teammateCompletion: [
    {
      kind: 'claudeCodePlainTurn',
      description:
        'deliver the completion as a plain user turn (no task-notification harness path)',
    },
  ],
};

const DEFAULT_CLAUDE_CODE_DESCRIPTOR: ProviderDescriptor = {
  id: 'claude-code',
  kind: 'agentRuntime',
  ref: {
    source: 'builtin',
    id: 'claude-code',
    raw: BUILTIN_CLAUDE_CODE_PROVIDER_REF,
  },
};

/**
 * Create the built-in Claude Code `AgentRuntimeProvider`. It implements the
 * neutral `@excitedjs/dreamux-types` contract: `readConfig` parses Claude Code
 * runtime config, `getCapabilities` reports its append/synthesized/plain-turn
 * shape, and `createRuntime` builds a {@link ClaudeCodeRuntime} from the neutral
 * create context plus the host-supplied options.
 */
export function createClaudeCodeAgentRuntimeProvider(
  options: ClaudeCodeAgentRuntimeProviderOptions = {},
): AgentRuntimeProvider<DispatcherClaudeCodeConfig> {
  const sessionFactory =
    options.sessionFactory ?? createDefaultClaudeCodeSession;
  const resolveBinPath = options.resolveBinPath ?? ((bin: string) => bin);
  return {
    ref: BUILTIN_CLAUDE_CODE_PROVIDER_REF,
    descriptor: options.descriptor ?? DEFAULT_CLAUDE_CODE_DESCRIPTOR,
    getCapabilities: () => CLAUDE_CODE_AGENT_RUNTIME_CAPABILITIES,
    readConfig(rawConfig, context) {
      return readDispatcherClaudeCodeConfig(
        rawConfig,
        context.file,
        context.prefix,
      );
    },
    createRuntime(
      context: AgentRuntimeCreateContext<DispatcherClaudeCodeConfig>,
    ): AgentRuntime {
      if (context.state === undefined) {
        throw new Error(
          'claude-code runtime requires a state sink in the create context',
        );
      }
      if (context.paths === undefined) {
        throw new Error(
          'claude-code runtime requires a path context in the create context',
        );
      }
      const deps: ClaudeCodeRuntimeDeps = {
        config: context.config,
        cwd: context.cwd,
        state: context.state,
        paths: context.paths,
        mcpServers: context.mcpServers,
        sessionFactory,
        resolveBinPath,
        ...(options.baseProcessEnv !== undefined
          ? { baseProcessEnv: options.baseProcessEnv }
          : {}),
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
      };
      return new ClaudeCodeRuntime(context.identity, deps);
    },
  };
}

/** Re-export the typed accessor for a runtime's resolved claude-code config. */
export { dispatcherClaudeCodeConfig };

/**
 * The context Dreamux core's generic provider package-loader passes to a
 * package's factory export: the canonical ref and the seed descriptor the
 * provider echoes back. Structurally matches core's `ProviderFactoryContext`
 * without importing core.
 */
export interface ClaudeCodeProviderFactoryContext {
  ref: string;
  descriptor: ProviderDescriptor;
}

/**
 * Default export — the factory Dreamux core's generic provider-loader selects
 * for the `builtin:claude-code` ref (it imports this package and calls the
 * default export with `{ ref, descriptor }`). It returns a provider that runs on
 * package defaults: the real resident-session factory, an identity bin resolver,
 * and `process.env` base env.
 *
 * The Dreamux host does NOT use this bare path in production: its launcher still
 * drives the host-shaped create context, so it constructs the provider through
 * its own core-owned adapter (`@excitedjs/dreamux`
 * `builtin/claude-code/provider.ts`) to map that context onto the neutral one
 * AND inject its host contracts (the package-bin `PATH`, the durable state sink,
 * the per-dispatcher path context). This default export keeps the package a
 * first-class, loadable `AgentRuntimeProvider` for the generic loader and for
 * external embedders.
 */
export default function claudeCodeAgentRuntimeProviderFactory(
  context: ClaudeCodeProviderFactoryContext,
): AgentRuntimeProvider<DispatcherClaudeCodeConfig> {
  return createClaudeCodeAgentRuntimeProvider({ descriptor: context.descriptor });
}
