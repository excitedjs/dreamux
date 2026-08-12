import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';

import { AgentIdentityStore } from '../../src/service/agent-entity/identity-store.js';
import { AgentTurnsStore } from '../../src/service/agent-entity/turns-store.js';
import { CompletionRouter } from '../../src/service/completion-router/index.js';
import { TeamCollection } from '../../src/service/team-collection/index.js';
import { WorktreeManager } from '../../src/service/worktree/manager.js';
import { testDispatcherConfig, testDreamuxConfig } from './config.js';
import {
  FAKE_RUNTIME_REF,
  fakeRuntimeCatalog,
  noopLog,
  type FakeRuntime,
} from './fake-team-runtime.js';
import type { AgentRuntimeCreateContext } from '@excitedjs/dreamux-types';

interface MakeTeamsInput {
  runtimes: FakeRuntime[];
  worktrees: WorktreeManager;
  createRuntime?: (context: AgentRuntimeCreateContext) => FakeRuntime;
  isShuttingDown?: () => boolean;
  workflowStopGraceMs?: number;
}

export function createTeamDissolveFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dreamux-team-dissolve-lifecycle-'));
  const previousHome = process.env['HOME'];
  process.env['HOME'] = join(root, 'home');
  process.env['DREAMUX_ROOT'] = join(root, 'dreamux');
  const workspace = join(root, 'workspace');
  mkdirSync(process.env['HOME'], { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const config = testDreamuxConfig([
    testDispatcherConfig({
      id: 'dispatcher-a',
      cwd: workspace,
      agentRuntime: 'agent-a',
      runtimeProvider: FAKE_RUNTIME_REF,
    }),
  ]);
  const log = noopLog();

  return {
    makeTeams(input: MakeTeamsInput) {
      const suffixes = ['aaaa', 'bbbb', 'cccc', 'dddd'];
      return new TeamCollection({
        dispatcherId: 'dispatcher-a',
        config,
        agentRuntimeProviders: fakeRuntimeCatalog(input.runtimes, {
          ...(input.createRuntime === undefined
            ? {}
            : { createRuntime: input.createRuntime }),
        }),
        worktrees: input.worktrees,
        identities: new AgentIdentityStore(log),
        turnsStore: new AgentTurnsStore(log),
        router: new CompletionRouter({ dispatcherId: 'dispatcher-a', log }),
        initiatorFor: async () => null,
        isShuttingDown: input.isShuttingDown ?? (() => false),
        adminSocketPath: '/tmp/admin.sock',
        leaderChannelDescriptors: () => [],
        log,
        agentNameSuffixGenerator: () => suffixes.shift()!,
        ...(input.workflowStopGraceMs !== undefined
          ? { workflowStopGraceMs: input.workflowStopGraceMs }
          : {}),
      });
    },
    terminalAssessments(worktrees: WorktreeManager) {
      return vi.spyOn(worktrees, 'assessCleanup').mockImplementation(
        async (identity) => ({
          status: 'terminal' as const,
          worktree: identity.worktree,
        }),
      );
    },
    cleanup() {
      if (previousHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = previousHome;
      delete process.env['DREAMUX_ROOT'];
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
}
