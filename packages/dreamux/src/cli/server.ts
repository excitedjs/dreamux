/**
 * Internal server entry point for `dreamux serve`.
 *
 * Usage:
 *   dreamux serve                  # run in foreground; logs to stderr
 *   dreamux serve --help
 *
 * Configuration sources (highest precedence first):
 *   1. environment variables (CODEX_HOST_RUNTIME_DIR, CODEX_HOST_ADMIN_SOCKET,
 *      CODEX_HOST_CODEX_BIN) — escape hatch for CI / one-off debug runs
 *   2. per-dispatcher fields in SQLite (codex_args_json: approvalPolicy, extraArgs)
 *   3. ~/.dreamux/config.json — user-editable global defaults and channel secrets; auto-created
 *      with sensible defaults on first boot (see src/runtime/config.ts)
 *   4. built-in defaults compiled into the binary
 *
 * Per-dispatcher Feishu secrets live in the dreamux JSON config.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { Server } from '../server.js';
import { loadOrInitConfig } from '../runtime/config.js';
import { adminSocketPath, databasePath, runtimeRoot } from '../runtime/paths.js';

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  // Load (or create on first boot) ~/.dreamux/config.json *before* anything
  // else looks at runtime paths — paths.* consults the active config for
  // its non-env defaults. A parse error here fails-fast with a file:line
  // pointer; the operator fixes the file and restarts.
  const { config, configFile, createdOnThisBoot } = loadOrInitConfig();
  if (createdOnThisBoot) {
    console.error(
      `[server] created ${configFile} with default settings — edit and restart to change`,
    );
  } else {
    console.error(`[server] loaded global config from ${configFile}`);
  }

  mkdirSync(runtimeRoot(), { recursive: true });
  mkdirSync(dirname(databasePath()), { recursive: true });

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
  ~/.dreamux/config.json    Auto-created on first boot. Override with the
                            DREAMUX_CONFIG_DIR env var. Edit and restart to
                            apply. Holds defaults for codex.bin,
                            approval_policy, runtime_dir, outbound retries,
                            and Feishu channel secrets.

Runtime data (kept separate from config):
  ~/.codex-host/            SQLite, admin socket, per-dispatcher logs.
                            Override via 'runtime_dir' in config, or
                            CODEX_HOST_RUNTIME_DIR env (env wins).

Environment overrides (highest precedence):
  CODEX_HOST_RUNTIME_DIR    Overrides config.runtime_dir
  CODEX_HOST_ADMIN_SOCKET   Overrides config.admin_socket
  CODEX_HOST_CODEX_BIN      Overrides config.codex.bin
  DREAMUX_CONFIG_DIR        Overrides ~/.dreamux (where config.json lives)

Add dispatchers:
  dreamux dispatcher add --id flow --bot-app-id <APP_ID> \\
    --bot-secret-ref config:flow
`);
}

main().catch((err) => {
  console.error('[server] fatal:', err);
  process.exit(1);
});
