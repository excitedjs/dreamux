import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  DREAMUX_UNIX_SOCKET_PATH_MAX_BYTES,
  unixSocketPathFitsBudget,
} from '@excitedjs/dreamux-utils';
import { hostRuntimePaths } from '../src/agent-runtime/host-paths.js';
import {
  adminSocketPath,
  cacheRoot,
  dispatcherChannelBindingsPath,
  dispatcherCompletionSpillDir,
  dispatcherDir,
  dispatcherAgentIdentityPath,
  dispatcherAgentTurnsPath,
  dispatcherTeamDir,
  dispatcherTeamMateDir,
  dispatcherTeamNameClaimPath,
  dispatcherTeamRecordPath,
  dispatcherTeamScopeDir,
  dispatcherTeamTeamMateDir,
  channelLogDir,
  channelLogPath,
  channelMcpLogDir,
  channelMcpLogPath,
  teammateMcpLogDir,
  teammateMcpLogPath,
  validateWorkflowRunId,
  workflowLogDir,
  workflowLogPath,
  workflowRunDir,
  workflowRunJournalPath,
  workflowRunRecordPath,
  dreamuxRoot,
  logsRoot,
  resetRuntimeConfig,
  restartIntentPath,
  runRoot,
  serverLogPath,
  stateRoot,
} from '../src/platform/paths.js';
describe('runtime paths', () => {
  let root: string;
  let previousHome: string | undefined;
  let previousXdgRuntimeDir: string | undefined;
  let previousTmpdir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join('/tmp', 'dreamux-paths-'));
    previousHome = process.env['HOME'];
    previousXdgRuntimeDir = process.env['XDG_RUNTIME_DIR'];
    previousTmpdir = process.env['TMPDIR'];
    process.env['HOME'] = join(root, 'home');
    delete process.env['CODEX_HOST_RUNTIME_DIR'];
    delete process.env['CODEX_HOST_ADMIN_SOCKET'];
    resetRuntimeConfig();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    if (previousXdgRuntimeDir === undefined) delete process.env['XDG_RUNTIME_DIR'];
    else process.env['XDG_RUNTIME_DIR'] = previousXdgRuntimeDir;
    if (previousTmpdir === undefined) delete process.env['TMPDIR'];
    else process.env['TMPDIR'] = previousTmpdir;
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it('uses ~/.dreamux/{run,state,logs} as the effective layout', () => {
    expect(dreamuxRoot()).toBe(join(homedir(), '.dreamux'));
    expect(stateRoot()).toBe(join(dreamuxRoot(), 'state'));
    expect(runRoot()).toBe(join(dreamuxRoot(), 'run'));
    expect(logsRoot()).toBe(join(dreamuxRoot(), 'logs'));
    // Volatile run files live under run/, not the durable state tree
    // (issue #182): the admin IPC endpoint and the one-shot restart marker.
    expect(adminSocketPath()).toBe(join(runRoot(), 'admin.sock'));
    expect(restartIntentPath()).toBe(join(runRoot(), 'restart-intent.json'));

    expect(dispatcherDir('dispatcher-a')).toBe(
      join(stateRoot(), 'dispatcher-a'),
    );
    // Cache, not durable state (issue #182 PR-2). The per-channel attachment
    // cache subdir is the channel package's concern now (issue #209 de-leak);
    // core only exposes the neutral dispatcher cache root.
    expect(dispatcherCompletionSpillDir('dispatcher-a')).toBe(
      join(cacheRoot(), 'dispatcher-a', 'spill'),
    );
    // #233 symmetric layout: each agent is a directory holding
    // {identity.json, turn.jsonl}. The dispatcher `teammate/` and `team/` dirs
    // hold ONLY entity dirs; channel bindings live at the dispatcher root.
    expect(dispatcherTeamMateDir('dispatcher-a')).toBe(
      join(stateRoot(), 'dispatcher-a', 'teammate'),
    );
    expect(dispatcherTeamDir('dispatcher-a')).toBe(
      join(stateRoot(), 'dispatcher-a', 'team'),
    );
    expect(dispatcherChannelBindingsPath('dispatcher-a')).toBe(
      join(stateRoot(), 'dispatcher-a', 'channel-bindings.json'),
    );
    // A dispatcher-owned teammate: teammate/<name>/{identity.json, turn.jsonl}.
    const reviewer = {
      dispatcherId: 'dispatcher-a',
      name: 'reviewer-1',
      teamId: null,
      role: 'teammate' as const,
    };
    expect(dispatcherAgentIdentityPath(reviewer)).toBe(
      join(stateRoot(), 'dispatcher-a', 'teammate', 'reviewer-1', 'identity.json'),
    );
    expect(dispatcherAgentTurnsPath(reviewer)).toBe(
      join(stateRoot(), 'dispatcher-a', 'teammate', 'reviewer-1', 'turn.jsonl'),
    );
    // A team scope: leader pair + record.json at the team root, members under
    // team/<team>/teammate/<name>/.
    expect(dispatcherTeamScopeDir('dispatcher-a', 'alpha')).toBe(
      join(stateRoot(), 'dispatcher-a', 'team', 'alpha'),
    );
    expect(dispatcherTeamRecordPath('dispatcher-a', 'alpha')).toBe(
      join(stateRoot(), 'dispatcher-a', 'team', 'alpha', 'record.json'),
    );
    expect(dispatcherTeamNameClaimPath('dispatcher-a', 'alpha')).toBe(
      join(stateRoot(), 'dispatcher-a', 'team', 'alpha', 'name-claim.json'),
    );
    expect(
      dispatcherAgentIdentityPath({
        dispatcherId: 'dispatcher-a',
        name: 'alpha.leader',
        teamId: 'alpha',
        role: 'team_leader',
      }),
    ).toBe(join(stateRoot(), 'dispatcher-a', 'team', 'alpha', 'identity.json'));
    expect(dispatcherTeamTeamMateDir('dispatcher-a', 'alpha')).toBe(
      join(stateRoot(), 'dispatcher-a', 'team', 'alpha', 'teammate'),
    );
    expect(
      dispatcherAgentTurnsPath({
        dispatcherId: 'dispatcher-a',
        name: 'member-1',
        teamId: 'alpha',
        role: 'team_member',
      }),
    ).toBe(
      join(stateRoot(), 'dispatcher-a', 'team', 'alpha', 'teammate', 'member-1', 'turn.jsonl'),
    );
    // Per-runtime app-server log paths are no longer core path builders: each
    // runtime package composes a flat `<logsDir>/<engine>/<runtime_id>.log`
    // keyed by its own runtime_id (issue #209). Core owns only logsRoot().
  });

  it('keeps cache artifacts under cache/, never under durable state (issue #182 PR-2)', () => {
    expect(cacheRoot()).toBe(join(dreamuxRoot(), 'cache'));
    expect(hostRuntimePaths.cacheDir()).toBe(cacheRoot());
    expect(hostRuntimePaths.cacheDir()).not.toBe(dispatcherDir('dispatcher-a'));
    for (const cachePath of [
      dispatcherCompletionSpillDir('dispatcher-a'),
    ]) {
      expect(cachePath.startsWith(cacheRoot())).toBe(true);
      expect(cachePath.startsWith(stateRoot())).toBe(false);
    }
    const retiredStateRuntimeDir = join(
      dispatcherDir('dispatcher-a'),
      'runtime',
      'dispatcher',
    );
    expect(hostRuntimePaths.cacheDir()).not.toBe(retiredStateRuntimeDir);
  });

  it('places logs under component log directories', () => {
    expect(serverLogPath()).toBe(join(logsRoot(), 'dreamux-server.log'));
    expect(channelLogDir()).toBe(join(logsRoot(), 'channel'));
    expect(channelLogPath('dispatcher-a')).toBe(
      join(logsRoot(), 'channel', 'dispatcher-a.log'),
    );
    expect(channelMcpLogDir()).toBe(join(logsRoot(), 'channel-mcp'));
    expect(channelMcpLogPath('dispatcher-a')).toBe(
      join(logsRoot(), 'channel-mcp', 'dispatcher-a.log'),
    );
    expect(teammateMcpLogDir()).toBe(join(logsRoot(), 'teammate-mcp'));
    expect(teammateMcpLogPath('dispatcher-a')).toBe(
      join(logsRoot(), 'teammate-mcp', 'dispatcher-a.log'),
    );
    expect(workflowLogDir()).toBe(join(logsRoot(), 'workflow'));
    expect(workflowLogPath('dispatcher-a')).toBe(
      join(logsRoot(), 'workflow', 'dispatcher-a.log'),
    );
  });

  it('builds validated dispatcher and Team workflow run paths', () => {
    const dispatcherRun = {
      dispatcherId: 'dispatcher-a',
      teamId: null,
      runId: 'run-123',
    };
    expect(workflowRunDir(dispatcherRun)).toBe(
      join(stateRoot(), 'dispatcher-a', 'workflow', 'run-123'),
    );
    expect(workflowRunRecordPath(dispatcherRun)).toBe(
      join(workflowRunDir(dispatcherRun), 'record.json'),
    );
    expect(workflowRunJournalPath(dispatcherRun)).toBe(
      join(workflowRunDir(dispatcherRun), 'journal.jsonl'),
    );
    expect(
      workflowRunDir({ ...dispatcherRun, teamId: 'team-a' }),
    ).toBe(
      join(stateRoot(), 'dispatcher-a', 'team', 'team-a', 'workflow', 'run-123'),
    );
    expect(validateWorkflowRunId('abc-123')).toBe('abc-123');
    for (const invalid of ['', '../run', 'Run', 'run_1']) {
      expect(() => validateWorkflowRunId(invalid)).toThrow(/invalid workflow run id/);
    }
  });

  it('rejects dispatcher ids that are not valid path segments', () => {
    expect(dispatcherDir('dispatcher-a')).toBe(
      join(stateRoot(), 'dispatcher-a'),
    );
    expect(() => dispatcherDir('team/alpha beta')).toThrow(/dispatcher id/);
    expect(() => dispatcherDir('team_alpha_beta')).not.toThrow();
  });

  it('rejects Unix socket paths that exceed the safe sun_path budget', () => {
    expect(unixSocketPathFitsBudget('x'.repeat(DREAMUX_UNIX_SOCKET_PATH_MAX_BYTES)))
      .toBe(true);
    expect(
      unixSocketPathFitsBudget('x'.repeat(DREAMUX_UNIX_SOCKET_PATH_MAX_BYTES + 1)),
    ).toBe(false);

    process.env['DREAMUX_ROOT'] = join(root, 'h'.repeat(90));
    expect(() => adminSocketPath()).toThrow(/too long for Unix sockets/);
  });

});
