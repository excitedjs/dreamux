/**
 * Internal server entry point for `dreamux serve`.
 *
 * Usage:
 *   dreamux serve                  # run in foreground; logs to stderr
 *   dreamux serve --help
 *
 * Configuration sources:
 *   - ~/.dreamux/config.json — named agents[], dispatcher declarations, and
 *     channel secrets; each dispatcher's channel lives under
 *     dispatchers[].channels[] and its runtime is a named agents[] entry
 *     referenced via dispatchers[].agentRuntime
 *   - CODEX_HOST_CODEX_BIN — optional host-level override of the codex binary
 *     for every dispatcher; most operators never set it
 *   - built-in defaults compiled into the binary
 *
 * Per-dispatcher Feishu secrets live in the dreamux JSON config.
 */

import { mkdir } from 'node:fs/promises';

import { Server } from '../server.js';
import { loadConfig } from '../config/config.js';
import { createBuiltinProviderRegistry } from '../registry/index.js';
import { createBuiltinAgentRuntimeProviderCatalog } from '../agent-runtime/index.js';
import { createLogger } from '../platform/logger.js';
import {
  adminSocketPath,
  feishuChannelLogDir,
  feishuChannelLogPath,
  feishuMcpLogDir,
  legacyAdminSocketPath,
  logsRoot,
  serverLogPath,
  stateRoot,
} from '../platform/paths.js';
import { sweepRuntimeSocketDirs } from '../platform/runtime-sockets.js';

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  // Compose the provider registry + builtin runtime catalog (with the real
  // process factories) first, so the builtins carry runnable implementations
  // before config parses agents[] (each agent's config is parsed through its
  // provider's readConfig). config does not register builtins itself (that
  // would re-form the #148 import cycle); the server owns this composition and
  // hands the populated registry to loadConfig. Leaf entry points that do not
  // build their own registry use loadConfigWithBuiltins instead.
  const providerRegistry = createBuiltinProviderRegistry();
  const agentRuntimeProviderCatalog = createBuiltinAgentRuntimeProviderCatalog({
    registry: providerRegistry,
    codex: {},
  });

  // Load ~/.dreamux/config.json before anything else starts. Missing or invalid
  // config is a setup error; `dreamux serve` must not silently create defaults.
  const { config, configFile } = await loadConfig({ providerRegistry });

  await mkdir(stateRoot(), { recursive: true });
  await mkdir(logsRoot(), { recursive: true });
  await mkdir(feishuChannelLogDir(), { recursive: true });
  await mkdir(feishuMcpLogDir(), { recursive: true });

  // The CLI is the only constructor of file-backed loggers; everything else
  // (tests) gets stderr-only defaults. Both stream to stderr too, so a
  // foreground `serve` stays visible.
  const logger = createLogger({ name: 'server', filePath: serverLogPath() });
  logger.info({ config_file: configFile }, 'loaded global config');

  const server = new Server({
    config,
    providerRegistry,
    agentRuntimeProviderCatalog,
    logger,
    channelLoggerFactory: (id) =>
      createLogger({ name: `channel/${id}`, filePath: feishuChannelLogPath(id) }),
    runtimeSocketSweep: () => sweepRuntimeSocketDirs(),
    legacyAdminLockPath: `${legacyAdminSocketPath()}.lock`,
  });
  await server.start();
  logger.info({ admin_socket: adminSocketPath() }, 'server up');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'received signal');
    await server.shutdown();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

function printHelp(): void {
  console.log(`dreamux serve — local dreamux server

Usage:
  dreamux serve [--help]

Global config:
  ~/.dreamux/config.json    Created by 'dreamux onboard'. Override with the
                            DREAMUX_CONFIG_DIR env var. Edit and restart to
                            apply. Holds named agents[], dispatcher
                            declarations (channels[] + agentRuntime), and
                            Feishu channel secrets.

Runtime data:
  ~/.dreamux/run/           volatile run files: admin socket + lock, one-shot
                            restart marker, and runtime rendezvous sockets.
                            Safe to clear while no server is running.
  ~/.dreamux/state/         durable server state: per-dispatcher status/access
                            files and TeamMate records.
  ~/.dreamux/logs/          server, Feishu channel, Codex app-server, and MCP
                            shim logs.

Environment overrides:
  CODEX_HOST_CODEX_BIN      Optional host-level override of the codex binary for
                            every dispatcher (normally unset; each agent's
                            agents[].config.bin is used, default "codex")
  DREAMUX_CONFIG_DIR        Overrides ~/.dreamux (where config.json lives)

Dispatcher declarations:
  Edit ~/.dreamux/config.json dispatchers[] and restart dreamux serve.
  Built-in Feishu channel: builtin:feishu.
  AgentRuntime providers: builtin:codex, builtin:claude-code, or installed npm:<package>[#export].
  Npm agentRuntime refs load through the same provider registry before config validation.
  Subscription channel plugins are an interface-only reservation.
`);
}

main().catch((err) => {
  console.error('[server] fatal:', err);
  process.exit(1);
});
