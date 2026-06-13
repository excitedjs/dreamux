/**
 * Core-owned adapter for the built-in Codex runtime (issue #209 slice 3).
 *
 * The Codex engine now lives in the published `@excitedjs/agent-runtime-codex`
 * package, which implements the neutral `@excitedjs/dreamux-types`
 * `AgentRuntimeProvider`. Core's launcher (server / Dispatcher Service) still
 * threads its host-shaped create context (dispatcher row, store, host logger).
 * This adapter bridges the two: it presents the host `AgentRuntimeProvider`
 * core already wires through the catalog, and on `createRuntime` it maps the
 * host context onto the neutral one — resolving the host path/socket/log/state
 * contracts and the bundled-skill install the package must not reconstruct, then
 * delegating to the package provider.
 */
import {
  createCodexAgentRuntimeProvider as createPackageCodexProvider,
  CODEX_AGENT_RUNTIME_CAPABILITIES,
  resolveCodexBinPath,
  dispatcherCodexConfig,
  defaultDispatcherCodexConfig,
  type CodexProcess,
  type CodexProcessOptions,
  type CodexWsClient,
  type DispatcherCodexConfig,
} from '@excitedjs/agent-runtime-codex';
import type {
  AgentRuntimeCreateContext as NeutralCreateContext,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';
import { codexAgentRuntimeDiagnostic } from './diagnostic.js';
import {
  codexRowStateStore,
  defaultCodexRuntimePaths,
} from './runtime-support.js';
import { allocateCodexSocketPath } from './paths.js';
import { installBundledWorkspaceSkills } from '../../../onboard/bundled-skills.js';
import { dispatcherProcessEnv } from '../../../platform/package-bin.js';
import {
  dispatcherCodexHomeDoctorContext,
  type DispatcherCodexHomeDoctor,
} from './codex-home.js';
import type { ProviderDescriptor } from '../../../registry/index.js';
import type {
  AgentRuntime,
  AgentRuntimeCreateContext,
  AgentRuntimeProvider,
  AgentRuntimeRole,
} from '../../types.js';
import type { DispatcherProviderConfig } from '../../../config/config.js';

export { resolveCodexBinPath, CODEX_AGENT_RUNTIME_CAPABILITIES };

/**
 * Host-shaped options for the built-in Codex provider. Unchanged from before the
 * package split so the server and tests keep their factory/doctor/backoff seams;
 * core fills the package's host hooks (socket allocator, package-bin env,
 * bundled-skill install) internally.
 */
export interface CodexAgentRuntimeProviderOptions {
  descriptor: ProviderDescriptor;
  codexProcessFactory?: (opts: CodexProcessOptions) => CodexProcess;
  codexClientFactory?: (socketPath: string) => CodexWsClient;
  codexHomeDoctor?: DispatcherCodexHomeDoctor;
  restartBackoffBaseMs?: number;
  restartBackoffMaxMs?: number;
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
    // The Codex runtime only ever logs at info/warn/error; the host log has no
    // debug/trace sink, so these are intentional no-ops.
    debug: () => {},
    trace: () => {},
  };
}

export function createCodexAgentRuntimeProvider(
  options: CodexAgentRuntimeProviderOptions,
): AgentRuntimeProvider {
  const pkg = createPackageCodexProvider({
    descriptor: options.descriptor,
    allocateSocketPath: allocateCodexSocketPath,
    baseProcessEnv: (extraEnv) => dispatcherProcessEnv(process.env, extraEnv),
    prepareWorkspaceSkills: (cwd) =>
      installBundledWorkspaceSkills({ dispatcherCwd: cwd }),
    ...(options.codexProcessFactory !== undefined
      ? { codexProcessFactory: options.codexProcessFactory }
      : {}),
    ...(options.codexClientFactory !== undefined
      ? { codexClientFactory: options.codexClientFactory }
      : {}),
    ...(options.codexHomeDoctor !== undefined
      ? {
          codexHomeDoctor: ({ runtimeId, cwd }) =>
            options.codexHomeDoctor!(
              dispatcherCodexHomeDoctorContext(runtimeId, {
                dispatcherCwd: cwd,
              }),
            ),
        }
      : {}),
    ...(options.restartBackoffBaseMs !== undefined
      ? { restartBackoffBaseMs: options.restartBackoffBaseMs }
      : {}),
    ...(options.restartBackoffMaxMs !== undefined
      ? { restartBackoffMaxMs: options.restartBackoffMaxMs }
      : {}),
  });

  return {
    ref: pkg.ref,
    descriptor: options.descriptor,
    getCapabilities: () => CODEX_AGENT_RUNTIME_CAPABILITIES,
    diagnostic: codexAgentRuntimeDiagnostic,
    readConfig(rawConfig, context) {
      return pkg.readConfig!(
        rawConfig,
        context,
      ) as unknown as DispatcherProviderConfig;
    },
    createRuntime(context: AgentRuntimeCreateContext): AgentRuntime {
      const codexConfig: DispatcherCodexConfig =
        context.dispatcher === null
          ? defaultDispatcherCodexConfig()
          : dispatcherCodexConfig(context.dispatcher);
      // Role is cosmetic for Codex (it ignores it); the teammate launcher is the
      // only caller that passes onTurnSettled. Proper role/skill selection is a
      // later slice.
      const role: AgentRuntimeRole =
        context.onTurnSettled !== undefined ? 'teammate' : 'dispatcher';
      const neutralContext: NeutralCreateContext<DispatcherCodexConfig> = {
        identity: {
          runtime_id: context.row.dispatcher_id,
          checkpoint_id: context.row.thread_id,
        },
        role,
        config: codexConfig,
        cwd: context.cwd,
        mcpServers: context.mcpServers,
        skillSources: [],
        logger: loggerFromHostLog(context.log),
        paths: context.paths ?? defaultCodexRuntimePaths,
        state: context.state ?? codexRowStateStore(context.dispatchers),
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
