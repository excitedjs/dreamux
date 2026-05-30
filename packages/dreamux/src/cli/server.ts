/**
 * `dreamux-server` — the long-running server entry point.
 *
 * Usage:
 *   dreamux-server                  # run in foreground; logs to stderr
 *   dreamux-server --help
 *
 * Configuration sources (highest precedence first):
 *   1. environment variables (CODEX_HOST_RUNTIME_DIR, CODEX_HOST_ADMIN_SOCKET,
 *      CODEX_HOST_CODEX_BIN) — escape hatch for CI / one-off debug runs
 *   2. per-dispatcher fields in SQLite (codex_args_json: approvalPolicy, extraArgs)
 *   3. ~/.dreamux/config.toml — user-editable global defaults; auto-created
 *      with sensible defaults on first boot (see src/runtime/config.ts)
 *   4. built-in defaults compiled into the binary
 *
 * Per-dispatcher secrets stay in env (bot_secret_ref=env:VAR_NAME); they
 * deliberately do not flow through the config file (issue #2 Q9).
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

  // Load (or create on first boot) ~/.dreamux/config.toml *before* anything
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
  console.log(`dreamux-server — Codex-host MVP server (excitedjs/dreamux#2)

Usage:
  dreamux-server [--help]

Global config:
  ~/.dreamux/config.toml    Auto-created on first boot. Override with the
                            DREAMUX_CONFIG_DIR env var. Edit and restart to
                            apply. Holds defaults for codex.bin,
                            approval_policy, runtime_dir, outbound retries,
                            etc. See the file's own comments for keys.

Runtime data (kept separate from config):
  ~/.codex-host/            SQLite, admin socket, per-dispatcher logs.
                            Override via 'runtime_dir' in config, or
                            CODEX_HOST_RUNTIME_DIR env (env wins).

Environment overrides (highest precedence):
  CODEX_HOST_RUNTIME_DIR    Overrides config.runtime_dir
  CODEX_HOST_ADMIN_SOCKET   Overrides config.admin_socket
  CODEX_HOST_CODEX_BIN      Overrides config.codex.bin
  DREAMUX_CONFIG_DIR        Overrides ~/.dreamux (where config.toml lives)
  BOT_SECRET_<NAME>         Each dispatcher's bot secret (referenced via
                            bot_secret_ref=env:BOT_SECRET_<NAME>)

Add dispatchers via server-ctl:
  dreamux dispatcher add --id flow --bot-app-id cli_aaa \\
    --bot-secret-ref env:BOT_SECRET_FLOW
`);
}

main().catch((err) => {
  console.error('[server] fatal:', err);
  process.exit(1);
});
