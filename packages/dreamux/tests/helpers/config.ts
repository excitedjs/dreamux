import {
  BUILTIN_CODEX_PROVIDER_REF,
  BUILTIN_FEISHU_PROVIDER_REF,
} from '../../src/registry/index.js';

/**
 * `testDispatcherConfig()`/`testDreamuxConfig()`, an in-memory `DispatcherConfig`/
 * `DreamuxConfig` builder pair that used to live here, were deleted as Stage
 * 2a Item 6 collateral: `testDispatcherConfig()` built the now-deleted
 * `.runtime` field and `testDreamuxConfig()` read it back off each dispatcher.
 * Confirmed zero callers across the repo before this item touched them, so no
 * test lost coverage — see
 * `.agents/tasks/architecture/code-organization-refactor/artifacts/deleted-tests.md`,
 * Stage 2a Item 6.
 */

/**
 * `cwd` is required on every dispatcher. Fixtures that never touch the
 * workspace get this absolute path, which no test creates.
 */
function placeholderCwd(dispatcherId: string): string {
  return `/nonexistent/dreamux-test/${dispatcherId}`;
}

/** One agents[] file entry: a named runtime declaration. */
export interface TestFileAgent {
  id: string;
  provider?: string;
  config?: Record<string, unknown>;
}

/** One dispatchers[] file entry referencing an agent by id. */
export interface TestFileDispatcher {
  id: string;
  cwd?: string;
  enabled?: boolean;
  agentRuntime: string;
  feishu?: { app_id: string; app_secret: string };
  channelId?: string;
  channelProvider?: string;
  workspace?: Record<string, unknown>;
}

/**
 * Render the on-disk config.json shape (top-level `agents[]` +
 * `dispatchers[].agentRuntime`) as a plain object for tests that write a config
 * file and expect the parser to accept (or reject) it. Distinct from the
 * in-memory {@link testDreamuxConfig}: agents and dispatchers are stated
 * explicitly so a test can declare shared or mismatched agents, dangling refs,
 * etc.
 */
export function testConfigFileObject(input: {
  agents?: TestFileAgent[];
  dispatchers?: TestFileDispatcher[];
}): Record<string, unknown> {
  return {
    agents: (input.agents ?? []).map((agent) => ({
      id: agent.id,
      provider: agent.provider ?? BUILTIN_CODEX_PROVIDER_REF,
      config: agent.config ?? {},
    })),
    dispatchers: (input.dispatchers ?? []).map((dispatcher) => ({
      id: dispatcher.id,
      cwd: dispatcher.cwd ?? placeholderCwd(dispatcher.id),
      ...(dispatcher.enabled !== undefined ? { enabled: dispatcher.enabled } : {}),
      ...(dispatcher.workspace !== undefined
        ? { workspace: dispatcher.workspace }
        : {}),
      channels: [
        {
          id: dispatcher.channelId ?? 'primary',
          provider: dispatcher.channelProvider ?? BUILTIN_FEISHU_PROVIDER_REF,
          config: dispatcher.feishu ?? {
            app_id: `app-${dispatcher.id}`,
            app_secret: `secret-${dispatcher.id}`,
          },
        },
      ],
      agentRuntime: dispatcher.agentRuntime,
    })),
  };
}

/**
 * Convenience: a single-codex-dispatcher file object, the most common fixture.
 * `codex` overrides the agent's config block; `feishu` overrides the channel
 * secrets. Agent id == dispatcher id.
 */
export function testSingleDispatcherFileObject(options: {
  id?: string;
  cwd?: string;
  enabled?: boolean;
  codex?: Record<string, unknown>;
  feishu?: { app_id: string; app_secret: string };
  agentProvider?: string;
  channelProvider?: string;
} = {}): Record<string, unknown> {
  const id = options.id ?? 'flow';
  return testConfigFileObject({
    agents: [
      {
        id,
        ...(options.agentProvider !== undefined ? { provider: options.agentProvider } : {}),
        config: options.codex ?? {},
      },
    ],
    dispatchers: [
      {
        id,
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.enabled !== undefined ? { enabled: options.enabled } : {}),
        agentRuntime: id,
        ...(options.feishu !== undefined ? { feishu: options.feishu } : {}),
        ...(options.channelProvider !== undefined
          ? { channelProvider: options.channelProvider }
          : {}),
      },
    ],
  });
}
