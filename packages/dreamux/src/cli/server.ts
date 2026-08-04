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
 *   - built-in defaults compiled into the binary
 *
 * Per-dispatcher channel secrets live in the dreamux JSON config.
 */
import { mkdir } from 'node:fs/promises';
import { Server } from '../server.js';
import { loadConfig } from '../config/config.js';
import { ProviderPluginStore } from '../registry/provider-plugin-store.js';
import { createLogger } from '../platform/logger.js';
import {
  adminSocketPath,
  channelLogDir,
  channelLogPath,
  channelMcpLogDir,
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
  await mkdir(stateRoot(), { recursive: true });
  await mkdir(logsRoot(), { recursive: true });
  await mkdir(channelLogDir(), { recursive: true });
  await mkdir(channelMcpLogDir(), { recursive: true });
  // The CLI is the only constructor of file-backed loggers; everything else
  // (tests) gets stderr-only defaults. Both stream to stderr too, so a
  // foreground `serve` stays visible.
  const logger = createLogger({ name: 'server', filePath: serverLogPath() });
  const providerPluginStore = new ProviderPluginStore({ logger });
  const {
    config,
    configFile,
    providerRegistry,
    providerPluginPackages,
    providerPluginWarnings,
  } = await loadConfig({
    providerPluginStore,
  });
  for (const warning of providerPluginWarnings) logger.warn(warning);
  logger.info({ config_file: configFile }, 'loaded global config');
  const server = new Server({
    config,
    providerRegistry,
    logger,
    channelLoggerFactory: (id) =>
      createLogger({ name: `channel/${id}`, filePath: channelLogPath(id) }),
    runtimeSocketSweep: () => sweepRuntimeSocketDirs(),
    legacyAdminLockPath: `${legacyAdminSocketPath()}.lock`,
  });
  try {
    await server.start();
  } catch (err) {
    await providerPluginStore.closeUpdater();
    throw err;
  }
  providerPluginStore.startUpdater(providerPluginPackages);
  logger.info({ admin_socket: adminSocketPath() }, 'server up');
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'received signal');
    await providerPluginStore.closeUpdater();
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
                            channel secrets.
Runtime data:
  ~/.dreamux/run/           volatile run files: admin socket + lock, one-shot
                            restart marker, and runtime rendezvous sockets.
                            Safe to clear while no server is running.
  ~/.dreamux/state/         durable server state: per-dispatcher status/access
                            files and TeamMate records.
  ~/.dreamux/logs/          server, channel, agent runtime, and MCP
                            shim logs.
Environment overrides:
  DREAMUX_CONFIG_DIR        Overrides ~/.dreamux (where config.json lives)
Dispatcher declarations:
  Edit ~/.dreamux/config.json dispatchers[] and restart dreamux serve.
  Provider refs load through the registry before provider-owned config parsing.
  npm:<package>[#export] refs use the local plugin-store load session; built-in
  refs bypass the plugin store.
`);
}
main().catch((err) => {
  console.error('[server] fatal:', err);
  process.exit(1);
});
