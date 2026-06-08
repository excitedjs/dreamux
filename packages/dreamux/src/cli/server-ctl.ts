/**
 * `server-ctl` — admin CLI that talks to the server via Unix socket.
 *
 * Connects to the admin socket under ~/.dreamux/state/admin.sock, sends a
 * single NDJSON request, prints the response, exits.
 *
 * Usage:
 *   server-ctl server status
 *   server-ctl dispatcher list
 *   server-ctl dispatcher status --id flow
 *   server-ctl dispatcher start --id flow
 *   server-ctl dispatcher stop --id flow
 */

import { connect, type Socket } from 'node:net';
import { adminSocketPath } from '../platform/paths.js';
import type { AdminRequest, AdminResponse } from '../admin/protocol.js';

interface ParsedArgs {
  flags: Record<string, string>;
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = 'true';
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

async function main(): Promise<void> {
  const programName = process.env['DREAMUX_ADMIN_CLI_NAME'] || 'server-ctl';
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp(programName);
    return;
  }

  const { flags, positional } = parseArgs(argv);
  const [obj, verb] = positional;

  const method = resolveMethod(obj, verb);
  if (method === null) {
    console.error(`unknown command: ${obj ?? ''} ${verb ?? ''}\n`);
    printHelp(programName);
    process.exit(2);
  }

  const params = flagsToParams(method, flags);
  const request: AdminRequest = { id: cryptoRandomId(), method, params };
  const response = await sendOne(adminSocketPath(), request);
  if (response.ok) {
    console.log(JSON.stringify(response.result, null, 2));
  } else {
    console.error(
      `error: [${response.error.code}] ${response.error.message}`,
    );
    process.exit(1);
  }
}

function resolveMethod(obj: string | undefined, verb: string | undefined): string | null {
  const o = obj ?? '';
  const v = verb ?? '';
  if (o === 'server' && v === 'status') return 'server.status';
  if (o === 'dispatcher') {
    switch (v) {
      case 'add': return 'dispatcher.add';
      case 'remove': return 'dispatcher.remove';
      case 'list': return 'dispatcher.list';
      case 'status': return 'dispatcher.status';
      case 'start': return 'dispatcher.start';
      case 'stop': return 'dispatcher.stop';
    }
  }
  return null;
}

const FLAG_TO_PARAM: Record<string, string> = {
  id: 'dispatcher_id',
  'bot-app-id': 'bot_app_id',
  'bot-secret-ref': 'bot_secret_ref',
};

function flagsToParams(
  _method: string,
  flags: Record<string, string>,
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flags)) {
    const key = FLAG_TO_PARAM[k] ?? k.replace(/-/g, '_');
    params[key] = v;
  }
  return params;
}

function sendOne(
  socketPath: string,
  request: AdminRequest,
): Promise<AdminResponse> {
  return new Promise((resolve, reject) => {
    let buf = '';
    let settled = false;
    let sock: Socket;
    try {
      sock = connect(socketPath);
    } catch (err) {
      reject(err);
      return;
    }
    sock.setEncoding('utf8');
    sock.on('connect', () => {
      sock.write(`${JSON.stringify(request)}\n`);
    });
    sock.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl !== -1 && !settled) {
        settled = true;
        const line = buf.slice(0, nl).trim();
        try {
          resolve(JSON.parse(line) as AdminResponse);
        } catch (err) {
          reject(err);
        }
        sock.end();
      }
    });
    sock.on('error', (err) => {
      if (settled) return;
      settled = true;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ECONNREFUSED') {
        reject(
          new Error(
            `cannot reach admin socket at ${socketPath} — is the server running?`,
          ),
        );
      } else {
        reject(err);
      }
    });
    sock.on('close', () => {
      if (settled) return;
      settled = true;
      reject(new Error('admin socket closed without a response'));
    });
  });
}

function cryptoRandomId(): string {
  return `cli-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

function printHelp(programName = 'server-ctl'): void {
  console.log(`${programName} — admin CLI for the dreamux server

Usage:
  ${programName} server status
  ${programName} dispatcher list
  ${programName} dispatcher status --id <ID>
  ${programName} dispatcher start --id <ID>
  ${programName} dispatcher stop --id <ID>

Dispatcher declarations live in ~/.dreamux/config.json dispatchers[].
Edit config and restart dreamux serve to add or remove dispatchers.

Admin socket:
  ~/.dreamux/state/admin.sock
`);
}

main().catch((err) => {
  const programName = process.env['DREAMUX_ADMIN_CLI_NAME'] || 'server-ctl';
  console.error(`${programName}: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
