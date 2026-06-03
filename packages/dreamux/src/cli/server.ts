/**
 * Internal server entry point for `dreamux serve`.
 *
 * Usage:
 *   dreamux serve                  # run in foreground; logs to stderr
 *   dreamux serve --help
 *
 * Configuration sources (highest precedence first):
 *   1. CODEX_HOST_CODEX_BIN — escape hatch for CI / one-off debug runs
 *   2. per-dispatcher fields in ~/.dreamux/config.json (dispatchers[].codex)
 *   3. ~/.dreamux/config.json — user-editable global defaults and channel secrets;
 *      created by `dreamux onboard`
 *   4. built-in defaults compiled into the binary
 *
 * Per-dispatcher Feishu secrets live in the dreamux JSON config.
 */

import { mkdirSync } from 'node:fs';

import { Server } from '../server.js';
import { loadConfig } from '../runtime/config.js';
import {
  adminSocketPath,
  codexAppServerLogDir,
  feishuChannelLogDir,
  logsRoot,
  stateRoot,
} from '../runtime/paths.js';

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  // Load ~/.dreamux/config.json before anything else starts. Missing or invalid
  // config is a setup error; `dreamux serve` must not silently create defaults.
  const { config, configFile } = loadConfig();
  console.error(`[server] loaded global config from ${configFile}`);

  mkdirSync(stateRoot(), { recursive: true });
  mkdirSync(logsRoot(), { recursive: true });
  mkdirSync(codexAppServerLogDir(), { recursive: true });
  mkdirSync(feishuChannelLogDir(), { recursive: true });

  const server = new Server({ config });
  await server.start();
  console.error(`[server] up; admin socket: ${adminSocketPath()}`);

  const shutdown = async (signal: string): Promise<void> => {
    console.error(`[server] received ${signal}`);
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
                            apply. Holds defaults for codex.bin,
                            approval_policy, dispatcher declarations,
                            and Feishu channel secrets.

Runtime data:
  ~/.dreamux/state/         server state, admin socket,
                            and per-dispatcher Codex sockets.
  ~/.dreamux/logs/          server, Feishu channel, and Codex app-server logs.

Environment overrides (highest precedence):
  CODEX_HOST_CODEX_BIN      Overrides config.codex.bin
  DREAMUX_CONFIG_DIR        Overrides ~/.dreamux (where config.json lives)

Dispatcher declarations:
  Edit ~/.dreamux/config.json dispatchers[] and restart dreamux serve.
`);
}

main().catch((err) => {
  console.error('[server] fatal:', err);
  process.exit(1);
});
