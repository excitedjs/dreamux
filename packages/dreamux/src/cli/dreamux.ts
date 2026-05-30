/**
 * `dreamux` — the unified top-level CLI (issue #4).
 *
 * Subcommands:
 *   dreamux server start                # start the long-running server
 *   dreamux server status               # admin-socket query
 *   dreamux dispatcher add ...          # configure a dispatcher
 *   dreamux dispatcher remove --id X
 *   dreamux dispatcher list
 *   dreamux dispatcher status --id X
 *   dreamux dispatcher start --id X
 *   dreamux dispatcher stop --id X
 *
 * Implementation note: this binary is a thin router. `server start` delegates
 * to the same entrypoint as the legacy `dreamux-server` (`./server.js`);
 * everything else is forwarded to the legacy `server-ctl` flow
 * (`./server-ctl.js`). Both legacy binaries are kept as aliases for users
 * with stale PATH entries (PR #6 shipped them; reverting would break local
 * setups).
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = join(HERE, 'server.js');
const SERVER_CTL_ENTRY = join(HERE, 'server-ctl.js');

function printRootHelp(): void {
  console.log(`dreamux — Codex-host MVP unified CLI (excitedjs/dreamux#4)

Usage:
  dreamux server start
  dreamux server status
  dreamux dispatcher list
  dreamux dispatcher add --id <ID> --bot-app-id <APP_ID> \\
                         --bot-secret-ref env:<VAR> [--codex-args-json <JSON>] [--codex-cwd <PATH>]
  dreamux dispatcher status --id <ID>
  dreamux dispatcher start  --id <ID>
  dreamux dispatcher stop   --id <ID>
  dreamux dispatcher remove --id <ID>

Environment:
  CODEX_HOST_RUNTIME_DIR    Root dir (default: ~/.codex-host)
  CODEX_HOST_ADMIN_SOCKET   Admin Unix socket path
  CODEX_HOST_CODEX_BIN      Codex binary (default: 'codex' on PATH)
  BOT_SECRET_<NAME>         Each dispatcher's bot secret (referenced via
                            bot_secret_ref=env:BOT_SECRET_<NAME>)

The legacy 'dreamux-server' and 'server-ctl' binaries remain available as
aliases for compatibility; new tooling should call 'dreamux'.
`);
}

function fail(msg: string, code = 2): never {
  console.error(`dreamux: ${msg}\n`);
  printRootHelp();
  process.exit(code);
}

async function execEntry(entry: string, argv: string[]): Promise<never> {
  // Re-exec node on the target so each subcommand keeps its own argv / process
  // environment; no shared state to leak between subcommands.
  const child = spawn(process.execPath, [entry, ...argv], {
    stdio: 'inherit',
  });
  await new Promise<void>((res, rej) => {
    child.once('error', rej);
    child.once('exit', (code, signal) => {
      if (signal !== null) process.kill(process.pid, signal);
      process.exit(code ?? 0);
      res();
    });
  });
  process.exit(0); // unreachable; satisfies TS never
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printRootHelp();
    return;
  }

  const [topic, sub, ...rest] = argv;
  if (topic === 'server') {
    if (sub === 'start') {
      await execEntry(SERVER_ENTRY, rest);
      return;
    }
    if (sub === 'status') {
      // server status is an admin-socket query (server-ctl `server status`).
      await execEntry(SERVER_CTL_ENTRY, ['server', 'status', ...rest]);
      return;
    }
    fail(`unknown 'server' subcommand: ${sub ?? '(missing)'}`);
  }
  if (topic === 'dispatcher') {
    if (sub === undefined) fail("missing 'dispatcher' subcommand");
    await execEntry(SERVER_CTL_ENTRY, ['dispatcher', sub, ...rest]);
    return;
  }
  fail(`unknown command: ${topic ?? ''}`);
}

main().catch((err) => {
  console.error(`dreamux: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
