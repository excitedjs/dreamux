import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, open, realpath, rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { AgentRuntimeCreateContext } from '@excitedjs/dreamux-types';
import {
  resolveExecutableOnPath,
  unixSocketPathFitsBudget,
} from '@excitedjs/dreamux-utils';

import type { AntigravityConfig } from '../config.js';
import type { AntigravityRuntimeOptions } from '../runtime-options.js';

const SESSION = 'agy';

export class TmuxSession {
  private owned: { socket: string; bin: string } | undefined;
  private launch: Promise<void> | undefined;

  constructor(
    private readonly context: AgentRuntimeCreateContext<AntigravityConfig>,
    private readonly options: AntigravityRuntimeOptions,
  ) {}

  start(): Promise<void> {
    return (this.launch ??= this.launchNative());
  }

  private async launchNative(): Promise<void> {
    if (process.platform === 'win32') {
      throw new Error('Antigravity tmux transport requires a Unix platform');
    }
    const bin = await resolveExecutableOnPath('tmux');
    if (!bin) throw new Error('Antigravity tmux binary was not found');
    const { config, cwd, paths, identity } = this.context;
    const { agentName, nativeLogPath } = this.options;
    const socketDir = paths
      .runtimeSocketDirs()
      .find((dir) => unixSocketPathFitsBudget(join(dir, 'a-XXXXXX', 's')));
    if (!socketDir) {
      throw new Error(
        'Antigravity tmux has no usable runtime socket directory',
      );
    }
    await mkdir(dirname(nativeLogPath), { recursive: true, mode: 0o700 });
    const log = await open(nativeLogPath, 'a', 0o600);
    await log.close();
    await mkdir(socketDir, { recursive: true, mode: 0o700 });
    this.owned = {
      socket: join(await mkdtemp(join(socketDir, 'a-')), 's'),
      bin,
    };

    const args = [
      config.bin,
      '--dangerously-skip-permissions',
      '--agent',
      agentName,
      '--log-file',
      nativeLogPath,
      '--settings',
      JSON.stringify({ trustedWorkspaces: [await realpath(cwd)] }),
      ...(identity.sessionId ? ['--conversation', identity.sessionId] : []),
      ...(config.model ? ['--model', config.model] : []),
      ...(config.effort ? ['--effort', config.effort] : []),
      ...config.extra_args,
    ];
    // Pass a single quoted command to a known shell so raw native arguments
    // cannot become tmux command separators or shell syntax.
    const native = ['exec', ...args].map(shellQuote).join(' ');
    await this.command(
      [
        'new-session',
        '-d',
        '-s',
        SESSION,
        '-x',
        '160',
        '-y',
        '40',
        '-c',
        cwd,
        '--',
        '/bin/sh',
        '-c',
        native,
      ],
      undefined,
      config.extra_env,
    );
  }

  capture(): Promise<string> {
    return this.command(['capture-pane', '-p', '-t', SESSION]);
  }

  loadInput(text: string): Promise<string> {
    return this.command(['load-buffer', '-b', 'input', '-'], text);
  }

  pasteInput(): Promise<string> {
    // Bracket the buffer explicitly. tmux uses raw newlines only with -r.
    return this.command([
      'send-keys',
      '-t',
      SESSION,
      '-l',
      '--',
      '\x1b[200~',
      ';',
      'paste-buffer',
      '-t',
      SESSION,
      '-b',
      'input',
      '-r',
      '-d',
      ';',
      'send-keys',
      '-t',
      SESSION,
      '-l',
      '--',
      '\x1b[201~',
    ]);
  }

  enter(): Promise<string> {
    return this.command(['send-keys', '-t', SESSION, '-l', '--', '\r']);
  }

  interrupt(): Promise<string> {
    return this.command(['send-keys', '-t', SESSION, 'Escape']);
  }

  async stop(): Promise<void> {
    await this.launch?.catch(() => undefined);
    const socket = this.owned?.socket;
    if (!socket) return;
    try {
      await this.command(['kill-server']);
    } catch (error) {
      if (!serverGone(error)) throw error;
    }
    try {
      await this.command(['has-session', '-t', SESSION]);
      throw new Error('Antigravity tmux session survived kill-server');
    } catch (error) {
      if (!serverGone(error)) throw error;
    }
    await rm(socket, { force: true });
    await rmdir(dirname(socket));
    this.owned = undefined;
  }

  private command(
    args: readonly string[],
    input?: string,
    environment?: NodeJS.ProcessEnv,
  ): Promise<string> {
    const { bin, socket } = this.owned!;
    return new Promise((resolve, reject) => {
      const child = execFile(
        bin,
        ['-S', socket, '-f', '/dev/null', ...args],
        { timeout: 5000, env: { ...process.env, ...environment, TMUX: '' } },
        (error, stdout, stderr) => {
          if (!error) {
            resolve(stdout);
          } else {
            // execFile includes every launch argument in its original error.
            const reason =
              args[0] === 'new-session'
                ? (error.code ?? 'native launch failed')
                : stderr.trim() || error.code || 'tmux client failed';
            reject(new Error(`Antigravity tmux ${args[0]} failed (${reason})`));
          }
        },
      );
      child.stdin?.on('error', () => {
        // An exiting tmux client can close stdin before the callback reports
        // the command's failure.
      });
      child.stdin?.end(input);
    });
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function serverGone(error: unknown): boolean {
  return (
    error instanceof Error &&
    /no server running|error connecting to .+ \(No such file or directory\)/.test(
      error.message,
    )
  );
}
