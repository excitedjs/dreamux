/**
 * A real, file-backed `TeamCollection` for team-lifecycle tests.
 *
 * Why real and not a mock stack: the contracts this node owns (idempotency,
 * record validity, single-flight construction, closed-team record-only reads)
 * are properties of how `TeamCollection` / `TeamStore` / `TeamService` actually
 * cooperate through the filesystem. Faking that cooperation would only prove
 * the fakes agree with each other, not that production does.
 *
 * The one seam this harness fakes is the Agent Runtime itself: starting a real
 * Codex/Claude process is out of scope for a unit suite and would violate the
 * "no network, no real login" test-style rule. A TeamLeader's runtime starts
 * inside its own first `submitInput()` call, not inside a separate `activate()`
 * step: a Team creation WITH a prompt calls `leader.submitInput()` once the
 * leader's identity is durable, and that call is what starts the runtime; a
 * creation WITHOUT a prompt calls nothing on the runtime at all.
 * `TeammateService.submitInput` is therefore the sole boundary between "Team
 * lifecycle" and "runtime process", so this mocks exactly that method (via
 * `mockLeaderSubmission`) and lets everything above it — record publication,
 * name allocation, identity alignment, roster projection, workflow/scheduler
 * bootstrap — run for real against a temp `DREAMUX_ROOT` and a temp dispatcher
 * workspace outside it.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { vi } from 'vitest';

import type { DreamuxConfig } from '../../src/config/config.js';
import { AgentNameRegistry } from '../../src/service/agent-entity/identity-store.js';
import { AdmissionLedger } from '../../src/service/teammate-service/admission-ledger.js';
import { CompletionDeliveryPolicy } from '../../src/service/completion-router/index.js';
import { TeamCollection } from '../../src/service/team-collection/index.js';
import type { TeamCollectionOptions } from '../../src/service/team-collection/types.js';
import { TeamStore } from '../../src/service/team-collection/store.js';
import type { TeamRecord } from '../../src/service/team-collection/types.js';
import { TeammateService } from '../../src/service/teammate-service/index.js';
import type { TeammateAgentMcp } from '../../src/service/teammate-service/types.js';
import type { Turn } from '../../src/service/teammate-service/turn-recording.js';
import { reuseCwdWorktree, WorktreeManager } from '../../src/service/worktree/manager.js';
import {
  dispatcherDir,
  dispatcherTeamDir,
  dispatcherTeamMateDir,
} from '../../src/platform/paths.js';

const silentLog = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  child() {
    return silentLog;
  },
} as unknown as TeamCollectionOptions['log'];

/** A `DreamuxLogger`-shaped no-op, for pieces that want their own instance. */
export function harnessLog(): TeamCollectionOptions['log'] {
  return silentLog;
}

export interface TeamCollectionHarness {
  readonly collection: TeamCollection;
  readonly dispatcherId: string;
  /** The real `team/` collection root this harness's `TeamCollection` reads. */
  readonly teamCollectionRoot: string;
  /**
   * A second, independent `TeamStore` bound to the same `team/` root.
   *
   * Used to seed or inspect `record.json` files directly — bypassing Team
   * creation entirely — for tests that plant a record (a replay target, a
   * malformed record, a closed record) rather than create one through the
   * ordinary path.
   */
  readonly seedStore: TeamStore;
  /** Remove every temp directory this harness created. */
  cleanup(): Promise<void>;
}

/**
 * Build one isolated `TeamCollection`, wired the same way
 * `DispatcherService` wires its own (same path builders, same collaborator
 * shapes) but pointed at a temp `DREAMUX_ROOT`.
 *
 * Callers MUST restore `process.env.DREAMUX_ROOT` themselves (or use
 * {@link withIsolatedDreamuxRoot}) — this only sets it, since a test file may
 * want several harnesses to share one root.
 */
export async function buildTeamCollectionHarness(input?: {
  dispatcherId?: string;
  /**
   * A deterministic name-suffix sequence, for tests that need to force a
   * specific candidate name or a specific candidate-collision sequence
   * (idempotency's "the first candidate is taken, so allocation moves on to
   * the next one" case) rather than a real random suffix.
   */
  nameSuffixGenerator?: () => string;
}): Promise<TeamCollectionHarness> {
  const dispatcherId = input?.dispatcherId ?? 'harness-dispatcher';
  const dreamuxRoot = await mkdtemp(join(tmpdir(), 'dreamux-root-'));
  // The dispatcher workspace is an operator project directory, never inside
  // Dreamux's own home — `WorktreeManager.prepareDefaultWorkspace` enforces
  // exactly this and would otherwise refuse a workspace nested under it.
  const workspaceCwd = await mkdtemp(join(tmpdir(), 'dreamux-workspace-'));
  process.env['DREAMUX_ROOT'] = dreamuxRoot;

  const config: DreamuxConfig = {
    agents: {},
    dispatchers: [{
      id: dispatcherId,
      cwd: workspaceCwd,
      enabled: true,
      workspace: { enabled: false },
      channels: [],
      agentRuntime: 'unused-default',
      runtime: { provider: 'unused', config: {} },
    }],
  };

  const teamCollectionRoot = dispatcherTeamDir(dispatcherId);
  const names = new AgentNameRegistry({
    teamMateRoot: dispatcherTeamMateDir(dispatcherId),
    teamRoot: teamCollectionRoot,
    dispatcherId,
    log: silentLog,
  });
  const admissions = new AdmissionLedger();
  const completionDelivery = new CompletionDeliveryPolicy({
    dispatcherId,
    log: silentLog,
  });
  const worktrees = new WorktreeManager();

  const collection = new TeamCollection({
    dispatcherId,
    config,
    // Never resolved in these tests: every leader submission is mocked via
    // `mockLeaderSubmission`, so nothing here ever asks the catalog for a real
    // provider implementation.
    agentRuntimeProviders: {} as unknown as TeamCollectionOptions['agentRuntimeProviders'],
    worktrees,
    root: teamCollectionRoot,
    names,
    admissions,
    completionDelivery,
    dispatcherCompletionInitiator: async () => null,
    leaderMcp: (): TeammateAgentMcp => ({
      leases: {} as unknown as TeammateAgentMcp['leases'],
      delegates: [],
      adminSocketPath: join(dreamuxRoot, 'admin.sock'),
    }),
    log: silentLog,
    workflowLog: silentLog,
    ...(input?.nameSuffixGenerator !== undefined
      ? { nameSuffixGenerator: input.nameSuffixGenerator }
      : {}),
  });

  const seedStore = new TeamStore({ root: teamCollectionRoot, dispatcherId });

  return {
    collection,
    dispatcherId,
    teamCollectionRoot,
    seedStore,
    async cleanup() {
      delete process.env['DREAMUX_ROOT'];
      await Promise.all([
        rm(dreamuxRoot, { recursive: true, force: true }),
        rm(workspaceCwd, { recursive: true, force: true }),
      ]);
    },
  };
}

export interface LeaderSubmissionGate {
  /** Resolve every `submitInput()` call currently waiting, and every future one. */
  release(): void;
  /** How many times `submitInput()` has been invoked so far. */
  callCount(): number;
  restore(): void;
}

/**
 * Hold every `TeammateService.submitInput()` call open until released.
 *
 * This is the harness's one seam into the runtime boundary: a Team creation
 * WITH a prompt calls `leader.submitInput()` once the leader's identity is
 * durable, and that call is what starts the runtime — holding it open is what
 * lets a test observe "under construction" as a real, inspectable state — e.g.
 * proving a concurrent `open()`/`admit()` joins the same construction instead
 * of reading a half-built Team. A creation WITHOUT a prompt reaches no runtime
 * at all, so those tests need no mock here.
 */
export function mockLeaderSubmission(): LeaderSubmissionGate {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const spy = vi
    .spyOn(TeammateService.prototype, 'submitInput')
    .mockImplementation(async () => {
      calls += 1;
      await gate;
      // Neither `createNew` nor `toSubmissionResult` reads the turn itself —
      // only the admission's `status` — so a minimal stub is enough here.
      return { status: 'submitted' as const, turn: {} as unknown as Turn };
    });
  return {
    release: () => release?.(),
    callCount: () => calls,
    restore: () => spy.mockRestore(),
  };
}

/**
 * Fail every `submitInput()` call with `error`.
 *
 * Used to force a Team creation to fail AFTER its record is already published
 * (creation publishes the `starting` record, then writes the leader identity,
 * then submits the prompt to the leader) — the "failure after the acceptance
 * point" case idempotency has to answer for, as opposed to a failure that
 * never reaches publication at all.
 */
export function mockLeaderSubmissionRejected(error: Error): LeaderSubmissionGate {
  let calls = 0;
  const spy = vi
    .spyOn(TeammateService.prototype, 'submitInput')
    .mockImplementation(async () => {
      calls += 1;
      throw error;
    });
  return {
    release: () => {},
    callCount: () => calls,
    restore: () => spy.mockRestore(),
  };
}

/**
 * A minimal, valid {@link TeamStore.create} input for a team a test plants
 * directly (bypassing `TeamService` entirely) — for tests that need a Team
 * record to already exist (a replay target, a closed record, a corrupt
 * neighbor) without paying for a full leader materialization.
 *
 * Every field this exercises is exactly the record-validity boundary
 * `TeamStore`'s reader checks (directory-bound identity, leader name,
 * lifecycle status, leader runtime, repo/runtime directories, worktree
 * identity, identity prompt, normalized skill sources) plus the two
 * idempotency fields — nothing speculative.
 */
export function minimalTeamRecordInput(input: {
  dispatcherId: string;
  teamId: string;
  leaderName?: string;
  status?: TeamRecord['status'];
  createRequestId?: string | null;
  createPayloadHash?: string | null;
  runtimeCwd?: string;
}): Omit<TeamRecord, 'version' | 'created_at' | 'updated_at' | 'worktree_cleanup_force'> {
  const runtimeCwd = input.runtimeCwd ?? '/tmp/dreamux-harness-unused-cwd';
  return {
    dispatcher_id: input.dispatcherId,
    team_id: input.teamId,
    name: input.teamId,
    repo_cwd: runtimeCwd,
    source_repo: null,
    leader_name: input.leaderName ?? `tl-${input.teamId}-seed`,
    leader_agent_runtime: 'fake',
    leader_identity_prompt: null,
    leader_skill_sources: [],
    runtime_cwd: runtimeCwd,
    worktree: reuseCwdWorktree(runtimeCwd),
    status: input.status ?? 'running',
    intent: 'seeded directly, not through TeamService',
    closed_at: null,
    close_note: null,
    create_request_id: input.createRequestId ?? null,
    create_payload_hash: input.createPayloadHash ?? null,
  };
}

/** Remove the given dispatcher root under the real state tree, defensively. */
export async function rmDispatcherState(dispatcherId: string): Promise<void> {
  await rm(dispatcherDir(dispatcherId), { recursive: true, force: true });
}
