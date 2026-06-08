import {
  BUILTIN_CODEX_PROVIDER_REF,
  BUILTIN_FEISHU_PROVIDER_REF,
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_CODEX_BIN,
  DEFAULT_CODEX_TURN_TIMEOUT_MS,
  DEFAULT_INITIALIZE_TIMEOUT_MS,
  DEFAULT_SANDBOX_MODE,
  type DispatcherConfig,
  type DreamuxConfig,
} from '../../src/config/config.js';

interface TestDispatcherOptions {
  id?: string;
  cwd?: string | null;
  enabled?: boolean;
  channelId?: string;
  channelProvider?: string;
  /** The agents[].id this dispatcher references. Defaults to the dispatcher id. */
  agentRuntime?: string;
  runtimeProvider?: string;
  feishu?: Record<string, unknown>;
  codex?: Record<string, unknown>;
  channels?: DispatcherConfig['channels'];
  runtime?: DispatcherConfig['runtime'];
}

export function testDispatcherConfig(
  options: TestDispatcherOptions = {},
): DispatcherConfig {
  const id = options.id ?? 'flow';
  return {
    id,
    cwd: options.cwd ?? null,
    enabled: options.enabled ?? true,
    channels:
      options.channels ??
      [
        {
          id: options.channelId ?? 'primary',
          provider: options.channelProvider ?? BUILTIN_FEISHU_PROVIDER_REF,
          config: {
            app_id: `app-${id}`,
            app_secret: `secret-${id}`,
            ...(options.feishu ?? {}),
          },
        },
      ],
    agentRuntime: options.agentRuntime ?? id,
    runtime:
      options.runtime ??
      {
        provider: options.runtimeProvider ?? BUILTIN_CODEX_PROVIDER_REF,
        config: {
          bin: DEFAULT_CODEX_BIN,
          approval_policy: DEFAULT_APPROVAL_POLICY,
          sandbox_mode: DEFAULT_SANDBOX_MODE,
          extra_args: [],
          extra_env: {},
          initialize_timeout_ms: DEFAULT_INITIALIZE_TIMEOUT_MS,
          turn_timeout_ms: DEFAULT_CODEX_TURN_TIMEOUT_MS,
          ...(options.codex ?? {}),
        },
      },
  };
}

/**
 * Build an in-memory {@link DreamuxConfig} from dispatcher configs, deriving the
 * `agents` map from each dispatcher's `agentRuntime` id + resolved `runtime`
 * (one agent per dispatcher, the common case). Tests that need shared or
 * mismatched agents construct `agents` explicitly instead.
 */
export function testDreamuxConfig(
  dispatchers: DispatcherConfig[] = [testDispatcherConfig()],
): DreamuxConfig {
  const agents: DreamuxConfig['agents'] = {};
  for (const dispatcher of dispatchers) {
    agents[dispatcher.agentRuntime] = {
      provider: dispatcher.runtime.provider,
      config: dispatcher.runtime.config,
    };
  }
  return { agents, dispatchers };
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
  cwd?: string | null;
  enabled?: boolean;
  agentRuntime: string;
  feishu?: { app_id: string; app_secret: string };
  channelId?: string;
  channelProvider?: string;
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
      ...(dispatcher.cwd !== undefined ? { cwd: dispatcher.cwd } : {}),
      ...(dispatcher.enabled !== undefined ? { enabled: dispatcher.enabled } : {}),
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
  cwd?: string | null;
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
