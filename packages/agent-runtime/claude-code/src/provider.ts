import {
  ClaudeCodeRuntime,
  type ClaudeCodeRuntimeDeps,
} from './runtime.js';
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
import { BUILTIN_CLAUDE_CODE_PROVIDER_REF } from './provider-ref.js';
import { claudeCodeAgentRuntimeDiagnostic } from './diagnostic.js';
import type {
  AgentRuntimeCapabilities,
  AgentRuntime,
  AgentRuntimeCreateContext,
  AgentRuntimeProvider,
  AgentRuntimeProviderDescriptor,
  AgentRuntimeProviderFactory,
  ProviderDescriptor,
  ProviderFactoryContext,
} from '@excitedjs/dreamux-types';

/**
 * Construction options for the built-in Claude Code provider. Env injection now
 * arrives on the NEUTRAL create context (`context.injectEnv`), not as a factory
 * hook. What remains here is the `descriptor` and the test/host seams (the
 * resident-session factory, an optional host bin resolver) that let core and
 * tests wire behavior without changing the provider.
 */
export interface ClaudeCodeAgentRuntimeProviderOptions {
  /**
   * The registry descriptor for `builtin:claude-code`. Defaults to a minimal
   * one. Accepted wide (`ProviderDescriptor`) so a host that resolved it from
   * its registry need not pre-narrow the kind; the factory validates it is an
   * `agentRuntime` descriptor.
   */
  descriptor?: ProviderDescriptor;
  /** Optional host-level bin resolver (default: identity on the config bin). */
  resolveBinPath?: (bin: string) => string;
  /** Override the resident-session factory (tests inject a fake). */
  sessionFactory?: ClaudeCodeSessionFactory;
}

export const CLAUDE_CODE_AGENT_RUNTIME_CAPABILITIES: AgentRuntimeCapabilities = {
  resume: { supported: true, checkpoint: 'claudeCodeSession' },
  steer: { supported: true },
  events: { kind: 'synthesized' },
  last: { supported: true },
  context: { supported: false },
  teammateCompletion: [
    {
      kind: 'claudeCodePlainTurn',
      description:
        'deliver the completion as a plain user turn (no task-notification harness path)',
    },
  ],
};

const DEFAULT_CLAUDE_CODE_DESCRIPTOR: AgentRuntimeProviderDescriptor = {
  id: 'claude-code',
  kind: 'agentRuntime',
  ref: {
    source: 'builtin',
    id: 'claude-code',
    raw: BUILTIN_CLAUDE_CODE_PROVIDER_REF,
  },
};

/** Validate + narrow a seed descriptor to the Agent Runtime kind. */
function asAgentRuntimeDescriptor(
  descriptor: ProviderDescriptor,
): AgentRuntimeProviderDescriptor {
  if (descriptor.kind !== 'agentRuntime') {
    throw new Error(
      `@excitedjs/agent-runtime-claude-code: descriptor.kind must be ` +
        `'agentRuntime' (got ${JSON.stringify(descriptor.kind)})`,
    );
  }
  return { ...descriptor, kind: descriptor.kind };
}

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
    descriptor:
      options.descriptor === undefined
        ? DEFAULT_CLAUDE_CODE_DESCRIPTOR
        : asAgentRuntimeDescriptor(options.descriptor),
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
        ...(context.injectEnv !== undefined
          ? { injectEnv: context.injectEnv }
          : {}),
        ...(context.skillSources !== undefined
          ? { skillSources: context.skillSources }
          : {}),
        ...(context.disableFeatures !== undefined
          ? { disableFeatures: context.disableFeatures }
          : {}),
        ...(context.systemPrompt !== undefined
          ? { systemPromptAppend: context.systemPrompt.append }
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
 * The context Dreamux core's generic provider package-loader passes to this
 * package's factory export. A back-compat alias of the public
 * {@link ProviderFactoryContext}, narrowed to the Agent Runtime descriptor kind
 * so the factory assigns `descriptor` without a cast.
 */
export type ClaudeCodeProviderFactoryContext =
  ProviderFactoryContext<AgentRuntimeProviderDescriptor>;

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
const claudeCodeAgentRuntimeProviderFactory: AgentRuntimeProviderFactory<DispatcherClaudeCodeConfig> =
  (context) =>
    createClaudeCodeAgentRuntimeProvider({ descriptor: context.descriptor });

export default claudeCodeAgentRuntimeProviderFactory;
