/**
 * Shared fixtures for the Core-event catalog / COT-projection test suite
 * (Stage 9 coverage cell C, node "core-events").
 *
 * These helpers build REAL production objects (AgentIdentityStore, TeamStore,
 * AgentRuntimeStateStore, ...) against throwaway temp directories rather than
 * re-implementing their contracts, so the tests exercise the actual owning
 * boundary instead of a parallel model of it.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ChannelCoreEvent, DreamuxLogger } from '@excitedjs/dreamux-types';

import type { DispatcherCoreEventPublisher } from '../../src/service/dispatcher-core-events/index.js';
import type {
  AgentEntityIdentity,
  AgentEntityWorktreeIdentity,
} from '../../src/service/agent/identity.js';
import { AgentIdentityStore } from '../../src/service/agent/store.js';
import type { AgentIdentityCreateInput } from '../../src/service/agent/store.js';
import { capturingLogger } from './command-harness.js';

/**
 * A `DispatcherCoreEventPublisher` fake that only records what was published,
 * with no bus/seal machinery of its own. Used where a test wants to observe
 * exactly what a Service-layer publisher call site emits, independent of the
 * live-delivery bus that `DispatcherCoreEventBus` owns (that bus is tested
 * directly, against the real class, elsewhere).
 */
export interface CapturingPublisher extends DispatcherCoreEventPublisher {
  readonly published: Array<{ event: ChannelCoreEvent }>;
  sourcesPresent: boolean;
}

export function createCapturingPublisher(
  sourcesPresent = true,
): CapturingPublisher {
  const published: CapturingPublisher['published'] = [];
  return {
    published,
    sourcesPresent,
    publish(event: ChannelCoreEvent): void {
      published.push({ event });
    },
    hasSources(): boolean {
      return this.sourcesPresent;
    },
  };
}

/** A fresh temp directory this test owns; caller removes it in `afterEach`. */
export async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${prefix}-`));
}

export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export function makeWorktreeIdentity(
  path: string,
): AgentEntityWorktreeIdentity {
  return {
    mode: 'reuse-cwd',
    slug: null,
    path,
    branch: null,
    base_ref: null,
    cleanup: 'keep',
    cleanup_state: 'not-managed',
    cleanup_error: null,
  };
}

/** Minimal valid `AgentIdentityStore.create()` input for one fixture agent. */
export function makeIdentityCreateInput(
  overrides: Partial<AgentIdentityCreateInput> = {},
): AgentIdentityCreateInput {
  return {
    name: 'fixture-agent',
    teamId: null,
    agentRuntime: 'fixture-runtime',
    sourceCwd: '/workspace/repo',
    sourceRepo: null,
    cwd: '/workspace/repo',
    runtimeCwd: '/workspace/repo',
    worktree: makeWorktreeIdentity('/workspace/repo'),
    ...overrides,
  };
}

/** A directory-bound `AgentIdentityStore` under a fresh temp entity dir. */
export function makeIdentityStore(input: {
  dir: string;
  dispatcherId?: string;
  expectedName?: string | null;
  log?: DreamuxLogger;
}): AgentIdentityStore {
  return new AgentIdentityStore({
    dir: input.dir,
    dispatcherId: input.dispatcherId ?? 'dispatcher-fixture',
    expectedName: input.expectedName ?? null,
    log: input.log ?? capturingLogger([]),
  });
}

/** A full in-memory `AgentEntityIdentity`, for tests that never touch disk. */
export function makeIdentity(
  overrides: Partial<AgentEntityIdentity> = {},
): AgentEntityIdentity {
  const now = Date.now();
  return {
    version: 1,
    dispatcher_id: 'dispatcher-fixture',
    name: 'fixture-agent',
    team_id: null,
    agent_runtime: 'fixture-runtime',
    session_id: null,
    source_cwd: '/workspace/repo',
    source_repo: null,
    cwd: '/workspace/repo',
    runtime_cwd: '/workspace/repo',
    worktree: makeWorktreeIdentity('/workspace/repo'),
    intent: null,
    identity_prompt: null,
    skill_sources: [],
    created_at: now,
    updated_at: now,
    status: 'starting',
    last_error: null,
    closed_at: null,
    close_note: null,
    ...overrides,
  };
}
