/**
 * Internal server entry point for `dreamux serve`.
 *
 * Usage:
 *   dreamux serve                  # run in foreground; logs to stderr
 *   dreamux serve --help
 *
 * Configuration sources:
 *   - ~/.dreamux/config.json — dispatcher declarations and channel secrets;
 *     each dispatcher's Codex settings (including its `bin`) live under
 *     dispatchers[].codex
 *   - CODEX_HOST_CODEX_BIN — optional host-level override of the codex binary
 *     for every dispatcher; most operators never set it
 *   - built-in defaults compiled into the binary
 *
 * Per-dispatcher Feishu secrets live in the dreamux JSON config.
 */

import { mkdir } from 'node:fs/promises';

import { Server } from '../server.js';
import { loadConfig } from '../runtime/config.js';
import { createLogger } from '../runtime/logger.js';
import {
  adminSocketPath,
  codexAppServerLogDir,
  feishuChannelLogDir,
  feishuChannelLogPath,
  feishuMcpLogDir,
  logsRoot,
  serverLogPath,
  stateRoot,
} from '../runtime/paths.js';

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  // Load ~/.dreamux/config.json before anything else starts. Missing or invalid
  // config is a setup error; `dreamux serve` must not silently create defaults.
  const { config, configFile } = await loadConfig();

  await mkdir(stateRoot(), { recursive: true });
  await mkdir(logsRoot(), { recursive: true });
  await mkdir(codexAppServerLogDir(), { recursive: true });
  await mkdir(feishuChannelLogDir(), { recursive: true });
  await mkdir(feishuMcpLogDir(), { recursive: true });

  // The CLI is the only constructor of file-backed loggers; everything else
  // (tests) gets stderr-only defaults. Both stream to stderr too, so a
  // foreground `serve` stays visible.
  const logger = createLogger({ name: 'server', filePath: serverLogPath() });
  logger.info({ config_file: configFile }, 'loaded global config');

  const server = new Server({
    config,
    logger,
    channelLoggerFactory: (id) =>
      createLogger({ name: `channel/${id}`, filePath: feishuChannelLogPath(id) }),
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
                            apply. Holds dispatcher declarations (including each
                            dispatcher's Codex settings under
                            dispatchers[].codex) and Feishu channel secrets.

Runtime data:
  ~/.dreamux/state/         server state, admin socket,
                            and per-dispatcher Codex sockets.
  ~/.dreamux/logs/          server, Feishu channel, and Codex app-server logs.

Environment overrides:
  CODEX_HOST_CODEX_BIN      Optional host-level override of the codex binary for
                            every dispatcher (normally unset; each dispatcher's
                            dispatchers[].codex.bin is used, default "codex")
  DREAMUX_CONFIG_DIR        Overrides ~/.dreamux (where config.json lives)

Dispatcher declarations:
  Edit ~/.dreamux/config.json dispatchers[] and restart dreamux serve.
`);
}

main().catch((err) => {
  console.error('[server] fatal:', err);
  process.exit(1);
});
