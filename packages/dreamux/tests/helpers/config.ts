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

export function testDreamuxConfig(
  dispatchers: DispatcherConfig[] = [testDispatcherConfig()],
): DreamuxConfig {
  return { dispatchers };
}
