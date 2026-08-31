/**
 * The built-in Feishu `ChannelProvider`.
 *
 * The facade is now one creation method plus optional capabilities. There is
 * no `ref`, no `descriptor`, no `getIdentity`, no `readConfig`, no `tools()`,
 * and no `handleSessionlessTool`: registration identity belongs to Core's
 * registry wrapper, and everything else that used to be a method is a named
 * capability that a Channel either has or does not.
 *
 * MCP is composed outside the base session. `describe` is answered here from a
 * static caller-scoped catalog, and every registration targets the live
 * instance — Core takes an instance's capability at build time, so a session
 * tool is available from creation rather than from connection.
 */
import { join } from 'node:path';

import type {
  ChannelInstance,
  ChannelMcpCaller,
  ChannelMcpToolRegistration,
  ChannelProvider,
  ChannelProviderFactory,
  ChannelSessionCreateContext,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import { FeishuChannelSession } from './feishu-channel.js';
import type { FeishuBot } from './bot.js';
import { createFeishuSessionMcp } from './feishu-session-mcp.js';
import { feishuToolRegistrations } from './tools/registry.js';

/** Validated Feishu channel config the neutral session is constructed from. */
export interface FeishuChannelConfig {
  appId: string;
  appSecret: string;
}

/**
 * Minimal `console.error`-backed logger the channel falls back to when the host
 * injects none (the standalone / generic-loader path; core always injects its
 * pino logger). Pino-shaped (fields-first) like the neutral `DreamuxLogger`, so
 * the session and transport consume it with no adapter. Owned here as
 * implementation code — never in declaration-only `dreamux-types`.
 */
function consoleFallbackLogger(dispatcherId: string): DreamuxLogger {
  const sink =
    (level: string) =>
    (fields: Record<string, unknown> | string, message?: string): void => {
      const prefix = `[feishu ${dispatcherId}] ${level}`;
      if (typeof fields === 'string') {
        console.error(prefix, fields);
        return;
      }
      // Never dump the whole fields bag — it can carry credentials and this
      // fallback has no `redact` policy (core's injected pino does). Surface
      // only `err`, matching the runtime packages' console fallbacks.
      const err = fields['err'];
      if (err !== undefined) console.error(prefix, message ?? '', err);
      else console.error(prefix, message ?? '');
    };
  return {
    error: sink('error'),
    warn: sink('warn'),
    info: sink('info'),
    debug: () => {},
    trace: () => {},
  };
}

/** Options for {@link createFeishuChannelProvider}. */
export interface CreateFeishuChannelProviderOptions {
  /**
   * Test seam: build the underlying `FeishuBot` instead of opening a real Lark
   * connection. Mirrors the agent-runtime provider factories' process/session
   * seams. Receives the validated channel config so a test can key a bot by its
   * app identity (e.g. per-channel multi-bot routing). Omitted in production.
   */
  botFactory?: (config: FeishuChannelConfig) => FeishuBot;
}

export function createFeishuChannelProvider(
  options: CreateFeishuChannelProviderOptions = {},
): ChannelProvider<FeishuChannelConfig> {
  return {
    config: {
      read(raw): FeishuChannelConfig {
        const obj = (raw ?? {}) as Record<string, unknown>;
        // The Feishu channel owns its config validation: the host no longer
        // pre-validates Feishu app credentials. The bot secret is
        // config-sourced, so a non-empty app_secret is required at config-load
        // time to preserve fail-loud — not deferred to session start.
        const unknown = Object.keys(obj).filter(
          (key) => key !== 'app_id' && key !== 'app_secret',
        );
        if (unknown.length > 0) {
          throw new Error(
            `feishu channel config has unknown key(s): ${unknown
              .map((key) => `'${key}'`)
              .join(', ')}. Allowed: app_id, app_secret.`,
          );
        }
        const appId = obj['app_id'];
        const appSecret = obj['app_secret'];
        if (typeof appId !== 'string' || appId.trim() === '') {
          throw new Error('feishu channel config requires a non-empty app_id');
        }
        if (typeof appSecret !== 'string' || appSecret.trim() === '') {
          throw new Error(
            'feishu channel config requires a non-empty app_secret',
          );
        }
        return { appId, appSecret };
      },
    },
    identity: {
      get(config: FeishuChannelConfig): string {
        // Self-report the opaque channel identity (the bot app id). Core stores
        // and displays it without ever naming a Feishu config field.
        return config.appId;
      },
    },
    mcp: {
      describe(
        _config: FeishuChannelConfig,
        context: { caller: ChannelMcpCaller },
      ): readonly ChannelMcpToolRegistration[] {
        return feishuToolRegistrations(context.caller);
      },
    },
    onboard: {
      async collect(_context, prompts): Promise<Record<string, unknown>> {
        const appId = await prompts.text({
          message: 'Feishu bot app id',
          required: true,
        });
        const appSecret = await prompts.secret({
          message: 'Feishu bot app secret',
          required: true,
        });
        return { app_id: appId, app_secret: appSecret };
      },
    },
    diagnostic: {
      binChecks() {
        return [];
      },
      async runDiagnostic() {
        return {
          ok: true,
          detail: 'Feishu channel has no host-managed diagnostics',
          errors: [],
        };
      },
    },
    async createSession(
      context: ChannelSessionCreateContext<FeishuChannelConfig>,
    ): Promise<ChannelInstance> {
      const stateDir = context.state_root ?? '.';
      const cacheRoot = context.cache_root ?? stateDir;
      const log =
        context.logger ?? consoleFallbackLogger(context.dispatcher_id);
      const session = new FeishuChannelSession({
        dispatcherId: context.dispatcher_id,
        channelId: context.channel_id,
        appId: context.config.appId,
        appSecret: context.config.appSecret,
        stateDir,
        // The channel owns its cache-subdir layout; core supplies only a
        // per-dispatcher cache root. Effective path is unchanged.
        attachmentCacheDir: join(cacheRoot, 'feishu-attachments'),
        log,
        ...(options.botFactory !== undefined
          ? { botFactory: (): FeishuBot => options.botFactory!(context.config) }
          : {}),
      });
      return { session, mcp: createFeishuSessionMcp(session, log) };
    },
  };
}

/**
 * Default export — the factory Dreamux core's generic channel package-loader
 * selects for the `builtin:feishu` ref.
 */
const feishuChannelProviderFactory:
  ChannelProviderFactory<FeishuChannelConfig> = () =>
    createFeishuChannelProvider();

export default feishuChannelProviderFactory;
