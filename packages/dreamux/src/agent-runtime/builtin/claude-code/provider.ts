/**
 * Core-owned adapter for the built-in Claude Code runtime (issue #209 slice 4).
 *
 * The Claude Code engine now lives in the published
 * `@excitedjs/agent-runtime-claude-code` package, which implements the neutral
 * `@excitedjs/dreamux-types` `AgentRuntimeProvider`. Core's launcher (server /
 * Dispatcher Service) still threads its host-shaped create context (dispatcher
 * row, store, host logger). This adapter bridges the two: it presents the host
 * `AgentRuntimeProvider` core already wires through the catalog, and on
 * `createRuntime` it maps the host context onto the neutral one — resolving the
 * host path/log/state contracts and the package-bin `PATH` the package must not
 * reconstruct, then delegating to the package provider.
 */
import {
  createClaudeCodeAgentRuntimeProvider as createPackageClaudeCodeProvider,
  CLAUDE_CODE_AGENT_RUNTIME_CAPABILITIES,
  dispatcherClaudeCodeConfig,
  defaultDispatcherClaudeCodeConfig,
  type ClaudeCodeSessionFactory,
  type DispatcherClaudeCodeConfig,
} from '@excitedjs/agent-runtime-claude-code';
import type {
  AgentRuntimeCreateContext as NeutralCreateContext,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';
import { claudeCodeAgentRuntimeDiagnostic } from './diagnostic.js';
import {
  claudeCodeRowStateStore,
  defaultClaudeCodeRuntimePaths,
} from './runtime-support.js';
import { dispatcherProcessEnv } from '../../../platform/package-bin.js';
import type { ProviderDescriptor } from '../../../registry/index.js';
import type {
  AgentRuntime,
  AgentRuntimeCreateContext,
  AgentRuntimeProvider,
  AgentRuntimeRole,
} from '../../types.js';
import type { DispatcherProviderConfig } from '../../../config/config.js';

export { CLAUDE_CODE_AGENT_RUNTIME_CAPABILITIES };

/**
 * Host-shaped options for the built-in Claude Code provider. Unchanged from
 * before the package split so the server and tests keep their session-factory /
 * bin-resolver seams; core fills the package's host hooks (package-bin env)
 * internally.
 */
export interface ClaudeCodeAgentRuntimeProviderOptions {
  descriptor: ProviderDescriptor;
  /** Optional host-level bin resolver (default: identity on the config bin). */
  resolveBinPath?: (bin: string) => string;
  /** Override the resident-session factory (tests inject a fake). */
  sessionFactory?: ClaudeCodeSessionFactory;
}

/** Adapt the host's level/msg/err log callback to the neutral structured logger. */
function loggerFromHostLog(
  log: (level: 'info' | 'warn' | 'error', msg: string, err?: unknown) => void,
): DreamuxLogger {
  const forward =
    (lvl: 'info' | 'warn' | 'error') =>
    (msg: string, fields?: Record<string, unknown>) =>
      log(lvl, msg, fields?.['err']);
  return {
    error: forward('error'),
    warn: forward('warn'),
    info: forward('info'),
    // The Claude Code runtime only ever logs at info/warn/error; the host log
    // has no debug/trace sink, so these are intentional no-ops.
    debug: () => {},
    trace: () => {},
  };
}

export function createClaudeCodeAgentRuntimeProvider(
  options: ClaudeCodeAgentRuntimeProviderOptions,
): AgentRuntimeProvider {
  const pkg = createPackageClaudeCodeProvider({
    descriptor: options.descriptor,
    baseProcessEnv: (extraEnv) => dispatcherProcessEnv(process.env, extraEnv),
    ...(options.resolveBinPath !== undefined
      ? { resolveBinPath: options.resolveBinPath }
      : {}),
    ...(options.sessionFactory !== undefined
      ? { sessionFactory: options.sessionFactory }
      : {}),
  });

  return {
    ref: pkg.ref,
    descriptor: options.descriptor,
    getCapabilities: () => CLAUDE_CODE_AGENT_RUNTIME_CAPABILITIES,
    diagnostic: claudeCodeAgentRuntimeDiagnostic,
    readConfig(rawConfig, context) {
      return pkg.readConfig!(
        rawConfig,
        context,
      ) as unknown as DispatcherProviderConfig;
    },
    createRuntime(context: AgentRuntimeCreateContext): AgentRuntime {
      const claudeConfig: DispatcherClaudeCodeConfig =
        context.dispatcher === null
          ? defaultDispatcherClaudeCodeConfig()
          : dispatcherClaudeCodeConfig(context.dispatcher);
      // Role is cosmetic for Claude Code (it ignores it); the teammate launcher
      // is the only caller that passes onTurnSettled. Proper role/skill
      // selection is a later slice.
      const role: AgentRuntimeRole =
        context.onTurnSettled !== undefined ? 'teammate' : 'dispatcher';
      const neutralContext: NeutralCreateContext<DispatcherClaudeCodeConfig> = {
        identity: {
          runtime_id: context.row.dispatcher_id,
          checkpoint_id: context.row.thread_id,
        },
        role,
        config: claudeConfig,
        cwd: context.cwd,
        mcpServers: context.mcpServers,
        skillSources: [],
        logger: loggerFromHostLog(context.log),
        paths: context.paths ?? defaultClaudeCodeRuntimePaths,
        state: context.state ?? claudeCodeRowStateStore(context.dispatchers),
        ...(context.systemPromptContent !== undefined
          ? { systemPromptContent: context.systemPromptContent }
          : {}),
        ...(context.onTurnSettled !== undefined
          ? { onTurnSettled: context.onTurnSettled }
          : {}),
      };
      return pkg.createRuntime(neutralContext);
    },
  };
}
