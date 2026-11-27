import { execFile } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type {
  DreamuxLogger,
  TeamCreateCommand,
} from '@excitedjs/dreamux-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { teamCreatePayloadHash } from '../src/service/team/create-request.js';
import { WorktreeManager } from '../src/service/worktree/manager.js';
import {
  readWorktreeSetup,
  WORKTREE_CONFIG_FILENAME,
} from '../src/service/worktree/setup.js';
import { dispatcherFixture } from './helpers/real-dispatcher.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

async function initRepo(root: string, name = 'repo'): Promise<string> {
  const repo = join(root, name);
  await mkdir(repo, { recursive: true });
  await git(repo, ['init', '-q']);
  await git(repo, ['config', 'core.autocrlf', 'false']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'test']);
  await writeFile(join(repo, 'a.txt'), 'hello\n');
  await git(repo, ['add', 'a.txt']);
  await git(repo, ['commit', '-q', '-m', 'init']);
  return repo;
}

async function writeSetupConfig(repo: string, content: unknown): Promise<void> {
  const text =
    typeof content === 'string'
      ? content
      : `${JSON.stringify(content, null, 2)}\n`;
  await writeFile(join(repo, WORKTREE_CONFIG_FILENAME), text, 'utf8');
}

/**
 * Build a cross-platform shell command that runs `js` with the current Node
 * binary, avoiding POSIX vs cmd.exe quoting differences.
 */
function nodeScript(js: string): string {
  const encoded = Buffer.from(js, 'utf8').toString('base64');
  return `"${process.execPath}" -e "eval(Buffer.from('${encoded}','base64').toString())"`;
}

function gatedScript(input: {
  startedPath: string;
  gatePath: string;
  donePath: string;
  exitCode?: number;
  stderrText?: string;
}): string {
  const config = JSON.stringify(input);
  return nodeScript(`
    const fs = require('node:fs');
    const cfg = ${config};
    fs.writeFileSync(cfg.startedPath, process.cwd());
    const poll = setInterval(() => {
      if (!fs.existsSync(cfg.gatePath)) return;
      clearInterval(poll);
      if (cfg.stderrText) process.stderr.write(cfg.stderrText);
      fs.writeFileSync(cfg.donePath, JSON.stringify({
        cwd: process.cwd(),
        sourceRepo: process.env.DREAMUX_SOURCE_REPO,
        worktreePath: process.env.DREAMUX_WORKTREE_PATH,
      }));
      process.exit(cfg.exitCode ?? 0);
    }, 15);
  `);
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
  throw new Error(`timed out waiting for file: ${path}`);
}

async function waitForCondition(
  check: () => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`timed out waiting for condition: ${label}`);
}

async function pathIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

interface LogEntry {
  level: 'info' | 'warn' | 'error';
  fields: Record<string, unknown>;
  msg: string;
}

function spyLogger(): { log: DreamuxLogger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const push =
    (level: LogEntry['level']) =>
    (fields: Record<string, unknown>, msg?: string) => {
      entries.push({ level, fields, msg: msg ?? '' });
    };
  const log = {
    debug: vi.fn(),
    info: vi.fn(push('info')),
    warn: vi.fn(push('warn')),
    error: vi.fn(push('error')),
    child: () => log,
  } as unknown as DreamuxLogger;
  return { log, entries };
}

describe('readWorktreeSetup(): config resolution and validation', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-worktree-config-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns null when .dreamux-worktree.json is absent, omits setup, or resolves to an empty script', async () => {
    expect(await readWorktreeSetup(root)).toBeNull();

    await writeSetupConfig(root, {});
    expect(await readWorktreeSetup(root)).toBeNull();

    await writeSetupConfig(root, { setup: {} });
    expect(await readWorktreeSetup(root)).toBeNull();

    await writeSetupConfig(root, { setup: { script: '   \n\t  ' } });
    expect(await readWorktreeSetup(root)).toBeNull();
  });

  it('defaults background to false and applies OS-specific overrides cleanly', async () => {
    await writeSetupConfig(root, {
      setup: {
        script: 'pnpm install',
        darwin: { script: 'brew bundle && pnpm install', background: true },
        linux: { background: true },
        win32: { script: '' },
      },
    });

    expect(await readWorktreeSetup(root, 'darwin')).toEqual({
      script: 'brew bundle && pnpm install',
      background: true,
    });
    expect(await readWorktreeSetup(root, 'linux')).toEqual({
      script: 'pnpm install',
      background: true,
    });
    expect(await readWorktreeSetup(root, 'win32')).toBeNull();
    expect(await readWorktreeSetup(root, 'freebsd')).toEqual({
      script: 'pnpm install',
      background: false,
    });
  });

  it.each([
    { label: 'malformed JSON', body: '{ invalid json' },
    { label: 'non-object root', body: ['not-an-object'] },
    {
      label: 'unknown root key (top-level script typo)',
      body: { script: 'echo hi' },
    },
    { label: 'non-object setup', body: { setup: 'echo hi' } },
    {
      label: 'unknown setup key (macos typo)',
      body: { setup: { macos: { script: 'echo hi' } } },
    },
    { label: 'non-string setup.script', body: { setup: { script: 42 } } },
    {
      label: 'non-boolean setup.background',
      body: { setup: { script: 'echo hi', background: 'true' } },
    },
    {
      label: 'non-object platform override',
      body: { setup: { win32: 'echo hi' } },
    },
    {
      label: 'unknown platform key (command typo)',
      body: { setup: { win32: { command: 'echo hi' } } },
    },
    {
      label: 'wrong type inside non-host platform override',
      body: { setup: { darwin: { script: 123 }, win32: { background: 'no' } } },
    },
  ])('fails loud on $label', async ({ body }) => {
    await writeSetupConfig(root, body);
    await expect(readWorktreeSetup(root, 'linux')).rejects.toThrow(
      WORKTREE_CONFIG_FILENAME,
    );
  });
});

describe('WorktreeManager.prepare(): post-worktree setup script execution', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-worktree-setup-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads uncommitted .dreamux-worktree.json from sourceRepo, sets cwd and env, and awaits foreground completion', async () => {
    const repo = await initRepo(root);
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    // Local untracked secret file in sourceRepo that the setup script copies.
    await writeFile(join(repo, '.env.local'), 'SECRET_TOKEN=local-only\n');

    const startedPath = join(root, 'fg-started');
    const gatePath = join(root, 'fg-gate');
    const donePath = join(root, 'fg-done.json');

    // Keep .dreamux-worktree.json uncommitted in sourceRepo.
    await writeSetupConfig(repo, {
      setup: {
        script: nodeScript(`
          const fs = require('node:fs');
          const path = require('node:path');
          fs.copyFileSync(
            path.join(process.env.DREAMUX_SOURCE_REPO, '.env.local'),
            path.join(process.cwd(), '.env.local'),
          );
          fs.writeFileSync(${JSON.stringify(startedPath)}, 'started');
          const poll = setInterval(() => {
            if (!fs.existsSync(${JSON.stringify(gatePath)})) return;
            clearInterval(poll);
            fs.writeFileSync(${JSON.stringify(donePath)}, JSON.stringify({
              cwd: process.cwd(),
              sourceRepo: process.env.DREAMUX_SOURCE_REPO,
              worktreePath: process.env.DREAMUX_WORKTREE_PATH,
            }));
            process.exit(0);
          }, 15);
        `),
      },
    });

    const { log, entries } = spyLogger();
    const manager = new WorktreeManager({ log });

    let resolved = false;
    const preparing = manager
      .prepare({
        dispatcherId: 'flow',
        teammateName: 'fg-worker',
        cwd: repo,
        dispatcherWorkspace: workspace,
        request: { mode: 'managed' },
      })
      .then((res) => {
        resolved = true;
        return res;
      });

    // Wait until the setup script is actively running, then confirm prepare() is still blocked.
    await waitForFile(startedPath);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(resolved).toBe(false);

    // Release the foreground setup script.
    await writeFile(gatePath, 'go');
    const result = await preparing;
    expect(resolved).toBe(true);
    expect(result.createdCheckout).toBe(true);

    const observed = JSON.parse(await readFile(donePath, 'utf8')) as {
      cwd: string;
      sourceRepo: string;
      worktreePath: string;
    };
    expect(await realpath(observed.cwd)).toBe(
      await realpath(result.runtimeCwd),
    );
    expect(await realpath(observed.sourceRepo)).toBe(await realpath(repo));
    expect(await realpath(observed.worktreePath)).toBe(
      await realpath(result.runtimeCwd),
    );
    expect(await readFile(join(result.runtimeCwd, '.env.local'), 'utf8')).toBe(
      'SECRET_TOKEN=local-only\n',
    );
    expect(
      entries.some((e) => e.msg === 'worktree setup script completed'),
    ).toBe(true);
  });

  it('rejects invalid config before git worktree add so no directory or branch is created', async () => {
    const repo = await initRepo(root);
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    await writeSetupConfig(repo, '{ bad json');

    const manager = new WorktreeManager();
    await expect(
      manager.prepare({
        dispatcherId: 'flow',
        teammateName: 'invalid-cfg',
        cwd: repo,
        dispatcherWorkspace: workspace,
        request: { mode: 'managed' },
      }),
    ).rejects.toThrow(WORKTREE_CONFIG_FILENAME);

    expect(await git(repo, ['worktree', 'list', '--porcelain'])).not.toMatch(
      /invalid-cfg/,
    );
    expect(await git(repo, ['branch', '--list'])).not.toMatch(/invalid-cfg/);
    expect(await pathIsDirectory(join(workspace, '.workspace'))).toBe(false);
  });

  it('fails loud, preserves multi-byte UTF-8 stderr and branch, and rolls back even when cleanup is keep', async () => {
    const repo = await initRepo(root);
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });

    await writeSetupConfig(repo, {
      setup: {
        background: false,
        script: nodeScript(`
          const fs = require('node:fs');
          fs.writeFileSync('partial-artifact.txt', 'untracked');
          const bytes = Buffer.from('依赖安装失败 exploded\\n', 'utf8');
          // Split a 3-byte UTF-8 character across two writes to verify utf8 decoding.
          process.stderr.write(bytes.subarray(0, 2));
          setTimeout(() => {
            process.stderr.write(bytes.subarray(2));
            process.exit(7);
          }, 15);
        `),
      },
    });

    const { log, entries } = spyLogger();
    const manager = new WorktreeManager({ log });

    await expect(
      manager.prepare({
        dispatcherId: 'flow',
        teammateName: 'failing-fg',
        cwd: repo,
        dispatcherWorkspace: workspace,
        request: { mode: 'managed', cleanup: 'keep' },
      }),
    ).rejects.toThrow(/exit code 7.*依赖安装失败 exploded/);

    // Newly created checkout was rolled back even with untracked files and cleanup: 'keep'.
    expect(await git(repo, ['worktree', 'list', '--porcelain'])).not.toMatch(
      /failing-fg/,
    );
    // Automatic rollback never deletes the Git branch.
    expect(
      (await git(repo, ['branch', '--list', 'dreamux/failing-fg'])).trim(),
    ).toBe('dreamux/failing-fg');
    // Source repository remains intact.
    expect(await pathIsDirectory(repo)).toBe(true);
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('hello\n');
    expect(
      entries.some(
        (e) => e.level === 'warn' && e.msg === 'worktree setup script failed',
      ),
    ).toBe(true);
  });

  it('foreground setup settles on direct child exit even when a descendant keeps stdio pipes open', async () => {
    const repo = await initRepo(root);
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const childPidPath = join(root, 'descendant.pid');

    const descendantCode = `
      const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));
      setTimeout(() => {}, 15000);
    `;
    const descendantEncoded = Buffer.from(descendantCode, 'utf8').toString(
      'base64',
    );

    await writeSetupConfig(repo, {
      setup: {
        background: false,
        script: nodeScript(`
          const fs = require('node:fs');
          const os = require('node:os');
          const { spawn } = require('node:child_process');
          const descendant = spawn(
            process.execPath,
            ['-e', "eval(Buffer.from('${descendantEncoded}','base64').toString())"],
            {
              cwd: os.tmpdir(),
              detached: true,
              stdio: ['ignore', 'inherit', 'inherit'],
              windowsHide: true,
            },
          );
          descendant.unref();
          const poll = setInterval(() => {
            if (!fs.existsSync(${JSON.stringify(childPidPath)})) return;
            clearInterval(poll);
            process.exit(0);
          }, 15);
        `),
      },
    });

    const manager = new WorktreeManager();
    const startedAt = Date.now();
    let descendantPid: number | null = null;
    try {
      const result = await manager.prepare({
        dispatcherId: 'flow',
        teammateName: 'exit-with-descendant',
        cwd: repo,
        dispatcherWorkspace: workspace,
        request: { mode: 'managed' },
      });
      const elapsedMs = Date.now() - startedAt;
      expect(result.createdCheckout).toBe(true);
      // Direct shell exited immediately; prepare() must not wait 15s for the descendant's pipes.
      expect(elapsedMs).toBeLessThan(5_000);
      descendantPid = Number((await readFile(childPidPath, 'utf8')).trim());
      // Descendant is still alive when prepare() resolved.
      expect(() => process.kill(descendantPid!, 0)).not.toThrow();
    } finally {
      if (descendantPid !== null && Number.isInteger(descendantPid)) {
        try {
          process.kill(descendantPid, 'SIGKILL');
        } catch {
          /* already exited */
        }
      }
    }
  });

  it('returns immediately for background: true and logs completion asynchronously', async () => {
    const repo = await initRepo(root);
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });

    const startedPath = join(root, 'bg-started');
    const gatePath = join(root, 'bg-gate');
    const donePath = join(root, 'bg-done.json');

    await writeSetupConfig(repo, {
      setup: {
        background: true,
        script: gatedScript({ startedPath, gatePath, donePath }),
      },
    });

    const { log, entries } = spyLogger();
    const manager = new WorktreeManager({ log });

    const result = await manager.prepare({
      dispatcherId: 'flow',
      teammateName: 'bg-worker',
      cwd: repo,
      dispatcherWorkspace: workspace,
      request: { mode: 'managed' },
    });

    // prepare() returned BEFORE the gated script was released.
    await waitForFile(startedPath);
    await expect(access(donePath)).rejects.toThrow();

    // Release and verify async completion + logging.
    await writeFile(gatePath, 'go');
    await waitForFile(donePath);
    await waitForCondition(
      () =>
        entries.some(
          (e) =>
            e.level === 'info' &&
            e.msg === 'background worktree setup script completed',
        ),
      'background completion log',
    );
    expect(await pathIsDirectory(result.runtimeCwd)).toBe(true);
  });

  it('logs background script failure without failing prepare()', async () => {
    const repo = await initRepo(root);
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });

    const startedPath = join(root, 'bg-fail-started');
    const gatePath = join(root, 'bg-fail-gate');
    const donePath = join(root, 'bg-fail-done');

    await writeSetupConfig(repo, {
      setup: {
        background: true,
        script: gatedScript({
          startedPath,
          gatePath,
          donePath,
          exitCode: 3,
          stderrText: 'bg boom\n',
        }),
      },
    });

    const { log, entries } = spyLogger();
    const manager = new WorktreeManager({ log });

    const result = await manager.prepare({
      dispatcherId: 'flow',
      teammateName: 'bg-fail',
      cwd: repo,
      dispatcherWorkspace: workspace,
      request: { mode: 'managed' },
    });
    expect(result.createdCheckout).toBe(true);

    await waitForFile(startedPath);
    await writeFile(gatePath, 'go');
    await waitForCondition(
      () =>
        entries.some(
          (e) =>
            e.level === 'warn' &&
            e.msg === 'background worktree setup script failed' &&
            e.fields['exit_code'] === 3 &&
            String(e.fields['output_tail'] ?? '').includes('bg boom'),
        ),
      'background failure log',
    );
  });

  it('does not run setup on existing worktree reuse, reuse-cwd, or default workspaces', async () => {
    const repo = await initRepo(root);
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });

    const countPath = join(root, 'run-count.txt');
    await writeSetupConfig(repo, {
      setup: {
        script: nodeScript(`
          const fs = require('node:fs');
          fs.appendFileSync(${JSON.stringify(countPath)}, '1\\n');
        `),
      },
    });

    const manager = new WorktreeManager();

    // 1. reuse-cwd must not run setup.
    await manager.prepare({
      dispatcherId: 'flow',
      teammateName: 'reuser',
      cwd: repo,
      request: { mode: 'reuse-cwd' },
    });
    await expect(access(countPath)).rejects.toThrow();

    // 2. prepareDefaultWorkspace must not run setup.
    await manager.prepareDefaultWorkspace({
      dispatcherWorkspace: workspace,
      slug: 'plain',
      workspaceEnabled: true,
    });
    await expect(access(countPath)).rejects.toThrow();

    // 3. First managed prepare runs setup once.
    const first = await manager.prepare({
      dispatcherId: 'flow',
      teammateName: 'once',
      cwd: repo,
      dispatcherWorkspace: workspace,
      request: { mode: 'managed' },
    });
    expect(first.createdCheckout).toBe(true);
    expect((await readFile(countPath, 'utf8')).trim().split('\n')).toHaveLength(
      1,
    );

    // 4. Second managed prepare on the same already-existing worktree does NOT re-run setup.
    const second = await manager.prepare({
      dispatcherId: 'flow',
      teammateName: 'once',
      cwd: repo,
      dispatcherWorkspace: workspace,
      request: { mode: 'managed' },
    });
    expect(second.createdCheckout).toBe(false);
    expect((await readFile(countPath, 'utf8')).trim().split('\n')).toHaveLength(
      1,
    );
  });
});

describe('Team and TeamMate creation ordering with worktree setup scripts', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-team-setup-order-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function managedTeamRequest(input: {
    id: string;
    repo: string;
    prompt: string;
  }) {
    const command: TeamCreateCommand = {
      request_id: input.id,
      name_prefix: 'setup-order',
      intent: 'Verify setup ordering',
      repo: { mode: 'managed', path: input.repo },
      leader: {
        agent_runtime: 'controlled',
        prompt: input.prompt,
      },
    };
    return {
      requestId: input.id,
      payloadHash: teamCreatePayloadHash(command),
      command,
      deliverCompletionToDispatcher: false,
    };
  }

  it('foreground setup (background: false) completes before TeamLeader launches or receives its first prompt', async () => {
    const f = await dispatcherFixture();
    const repo = await initRepo(root);
    const startedPath = join(root, 'team-fg-started');
    const gatePath = join(root, 'team-fg-gate');
    const donePath = join(root, 'team-fg-done.json');

    await writeSetupConfig(repo, {
      setup: {
        background: false,
        script: gatedScript({ startedPath, gatePath, donePath }),
      },
    });

    const creating = f.teams.createFromRequest(
      managedTeamRequest({
        id: 'fg-team',
        repo,
        prompt: 'Start work after setup',
      }),
    );

    // While foreground setup is blocked, no TeamLeader runtime exists and no prompt was sent.
    await waitForFile(startedPath);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(f.provider.runtimes).toHaveLength(0);

    // Release setup script; TeamLeader now launches and receives the first prompt.
    await writeFile(gatePath, 'go');
    const created = await creating;
    await waitForFile(donePath);
    expect(created.status).toBe('running');
    expect(f.provider.runtimes).toHaveLength(1);
    expect(f.provider.runtimes[0]!.inputs).toHaveLength(1);
    expect(f.provider.runtimes[0]!.inputs[0]).toContain(
      'Start work after setup',
    );
  });

  it('background setup (background: true) launches TeamLeader and submits its first prompt before setup finishes', async () => {
    const f = await dispatcherFixture();
    const repo = await initRepo(root);
    const startedPath = join(root, 'team-bg-started');
    const gatePath = join(root, 'team-bg-gate');
    const donePath = join(root, 'team-bg-done.json');

    await writeSetupConfig(repo, {
      setup: {
        background: true,
        script: gatedScript({ startedPath, gatePath, donePath }),
      },
    });

    const created = await f.teams.createFromRequest(
      managedTeamRequest({
        id: 'bg-team',
        repo,
        prompt: 'Start immediately',
      }),
    );

    // TeamLeader is already running with its first prompt while the background script is still gated.
    expect(created.status).toBe('running');
    expect(f.provider.runtimes).toHaveLength(1);
    expect(f.provider.runtimes[0]!.inputs[0]).toContain('Start immediately');
    await waitForFile(startedPath);
    await expect(access(donePath)).rejects.toThrow();

    // Release so the background process exits cleanly before teardown.
    await writeFile(gatePath, 'go');
    await waitForFile(donePath);
  });

  it('foreground setup failure aborts team.create without launching TeamLeader or leaving a worktree', async () => {
    const f = await dispatcherFixture();
    const repo = await initRepo(root);
    await writeSetupConfig(repo, {
      setup: {
        background: false,
        script: nodeScript(
          `process.stderr.write('setup broken\\n'); process.exit(2);`,
        ),
      },
    });

    await expect(
      f.teams.createFromRequest(
        managedTeamRequest({
          id: 'fg-fail-team',
          repo,
          prompt: 'Never sent',
        }),
      ),
    ).rejects.toThrow(/exit code 2.*setup broken/);

    expect(f.provider.runtimes).toHaveLength(0);
    const listed = (await git(repo, ['worktree', 'list', '--porcelain']))
      .split('\n')
      .filter((line) => line.startsWith('worktree '));
    expect(listed).toHaveLength(1);
    expect(await f.teams.list()).toEqual([]);
  });

  it('runs setup on Dispatcher-root managed teammate.spawn and gates runtime launch on reopen after deleted worktree', async () => {
    const f = await dispatcherFixture();
    await f.host.start();
    const repo = await initRepo(root);
    const countPath = join(root, 'teammate-runs.txt');

    await writeSetupConfig(repo, {
      setup: {
        background: false,
        script: nodeScript(`
          const fs = require('node:fs');
          fs.appendFileSync(${JSON.stringify(countPath)}, process.cwd() + '\\n');
        `),
      },
    });

    const spawned = await f.host.teammates.spawn({
      name: 'builder',
      intent: 'Build in managed worktree',
      prompt: 'Run build',
      cwd: repo,
      worktree: { mode: 'managed', cleanup: 'delete-on-close' },
    });
    expect(spawned.status).toBe('submitted');
    expect((await readFile(countPath, 'utf8')).trim().split('\n')).toHaveLength(
      1,
    );

    // Close the teammate so its managed delete-on-close worktree is deleted.
    const closed = await f.host.teammates.close({
      name: spawned.teammate.name,
      note: 'done for now',
    });
    expect(closed.teammate.repo.cleanup_state).toBe('deleted');
    const runtimesBeforeReopen = f.provider.runtimes.length;

    // Gate reopen setup so we prove no new runtime starts until setup completes.
    const reopenStarted = join(root, 'reopen-started');
    const reopenGate = join(root, 'reopen-gate');
    const reopenDone = join(root, 'reopen-done');
    await writeSetupConfig(repo, {
      setup: {
        background: false,
        script: gatedScript({
          startedPath: reopenStarted,
          gatePath: reopenGate,
          donePath: reopenDone,
        }),
      },
    });

    const reopening = f.host.teammates.send({
      name: spawned.teammate.name,
      prompt: 'Resume build',
    });
    await waitForFile(reopenStarted);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(f.provider.runtimes).toHaveLength(runtimesBeforeReopen);

    await writeFile(reopenGate, 'go');
    const reopened = await reopening;
    await waitForFile(reopenDone);
    expect(reopened.status).toBe('submitted');
    expect(f.provider.runtimes).toHaveLength(runtimesBeforeReopen + 1);
    expect(f.provider.runtimes.at(-1)!.inputs[0]).toContain('Resume build');
  });
});
