/**
 * What an Agent of a TeammateCollection is launched with, and in what order.
 *
 * The join itself is one small function (`teammate-collection/system-prompt.ts`),
 * but calling it directly would say nothing about which identity the collection
 * hands it, or on which paths. So the prompt is read the way a provider reads
 * it: drive a real `TeammateCollection` through its own construction paths
 * against a minimal fake Agent Runtime provider, and inspect the launch context
 * that provider is handed.
 *
 * Three orders exist and all three are covered (final.md §3.6 and ruling R9 of
 * the refine-model-facing-surfaces task record): a
 * Team-scoped TeamMate, a dispatcher-scoped TeamMate — which is told none of
 * it, because it has no TeamLeader — and a Team-scoped workflow agent, whose
 * operation contributes an append of its own between the two.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  AgentRuntimeCreateContext,
  AgentRuntimeProvider,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../src/agent-runtime/index.js';
import type { DreamuxConfig, ResolvedAgentConfig } from '../src/config/config.js';
import {
  AgentEntityCollectionStore,
  AgentNameRegistry,
} from '../src/service/agent-entity/identity-store.js';
import { AGENT_TASK_SOURCE } from '../src/service/submission-sources.js';
import { TeammateCollection } from '../src/service/teammate-collection/index.js';
import { AdmissionLedger } from '../src/service/teammate-service/admission-ledger.js';
import { WORKFLOW_AGENT_SYSTEM_PROMPT } from '../src/service/workflow-service/agent-policy.js';
import {
  reuseCwdWorktree,
  type WorktreeManager,
} from '../src/service/worktree/manager.js';
import { controllableRuntimeSubmission } from './helpers/runtime-submission.js';

const DISPATCHER = 'flow';
const TEAM = 'alpha';
const RUNTIME_ID = 'fake-runtime';
/** Fixed so an allocated name is exact rather than approximately asserted. */
const SUFFIX = 'test';
const IDENTITY = 'You review with a bias for deletion.';

const silentLog = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  child: () => silentLog,
} as unknown as DreamuxLogger;

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

interface Harness {
  readonly root: string;
  readonly store: AgentEntityCollectionStore;
  readonly collection: TeammateCollection;
  /** Every context the provider was asked to build a runtime from. */
  readonly launches: AgentRuntimeCreateContext<unknown>[];
}

/** A real collection over a temp-dir store, bound to the given scope. */
async function harness(teamScope: string | null): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dreamux-teammate-system-prompt-'));
  roots.push(root);

  // The minimal provider: it records the context Core launches it with and
  // accepts one submission, because the launch only happens on the way to a
  // submission. Anything Core calls that is not here fails loudly.
  const launches: AgentRuntimeCreateContext<unknown>[] = [];
  const provider = {
    getCapabilities: () => ({ tags: [], publicConfig: null }),
    readRecentActivity: async () => ({ records: [], truncated: false }),
    async createRuntime(context: AgentRuntimeCreateContext<unknown>) {
      launches.push(context);
      return {
        async start() {
          return { continuity: 'fresh' as const };
        },
        async submit() {
          const pending = controllableRuntimeSubmission();
          pending.complete(null);
          return { status: 'submitted' as const, submission: pending.submission };
        },
        async stop() {},
      };
    },
  } as unknown as AgentRuntimeProvider<unknown>;

  const config: DreamuxConfig = {
    agents: {
      [RUNTIME_ID]: { provider: 'fake', config: {} } as unknown as ResolvedAgentConfig,
    },
    dispatchers: [],
  };

  const teamMateRoot = join(root, 'teammate');
  const store = new AgentEntityCollectionStore({
    root: teamMateRoot,
    dispatcherId: DISPATCHER,
    log: silentLog,
  });
  const collection = new TeammateCollection({
    dispatcherId: DISPATCHER,
    teamScope,
    config,
    agentRuntimeProviders: {
      resolve: () => ({ implementation: provider }),
    } as unknown as AgentRuntimeProviderCatalog,
    // No path below reaches the worktree manager: a record that already holds a
    // reuse-cwd workspace never re-prepares one, and a Team's workflow agent is
    // handed its Team's directory as a loan. An empty object makes a reach a
    // loud failure rather than a silent pass.
    worktrees: {} as unknown as WorktreeManager,
    store,
    names: new AgentNameRegistry({
      teamMateRoot,
      teamRoot: join(root, 'team'),
      dispatcherId: DISPATCHER,
      log: silentLog,
    }),
    admissions: new AdmissionLedger(),
    suffixGenerator: () => SUFFIX,
    log: silentLog,
  });
  return { root, store, collection, launches };
}

/**
 * Launch one ordinary TeamMate: the record exists, and a send starts it. This
 * is the path every TeamMate an Agent spawned takes on its next turn.
 */
async function launchedTeamMate(input: {
  teamScope: string | null;
  name: string;
  identityPrompt: string | null;
}): Promise<AgentRuntimeCreateContext<unknown>> {
  const built = await harness(input.teamScope);
  await built.store.entity(input.name).create({
    name: input.name,
    teamId: input.teamScope,
    agentRuntime: RUNTIME_ID,
    sourceCwd: built.root,
    sourceRepo: null,
    cwd: built.root,
    runtimeCwd: built.root,
    worktree: reuseCwdWorktree(built.root),
    intent: 'review the change',
    identityPrompt: input.identityPrompt,
    status: 'stopped',
  });

  await built.collection.send({ name: input.name, prompt: 'go' });

  expect(built.launches).toHaveLength(1);
  return built.launches[0]!;
}

/**
 * Launch one Team-scoped workflow agent, the way a Team's Workflow does:
 * `createLocked` with the operation's own append and the Team's workspace
 * loan, then one submission through the handle it holds.
 */
async function launchedWorkflowAgent(): Promise<{
  readonly name: string;
  readonly launch: AgentRuntimeCreateContext<unknown>;
}> {
  const built = await harness(TEAM);
  const handle = await built.collection.createLocked(
    {
      name: 'agent',
      prompt: 'go',
      intent: 'Workflow run-a agent 1',
      agentRuntime: RUNTIME_ID,
      identity: IDENTITY,
      sharedWorkspace: {
        sourceCwd: built.root,
        sourceRepo: null,
        runtimeCwd: built.root,
      },
    },
    { systemPromptAppend: [WORKFLOW_AGENT_SYSTEM_PROMPT] },
  );
  await handle.submit({ prompt: 'go', source: AGENT_TASK_SOURCE });

  expect(built.launches).toHaveLength(1);
  return { name: handle.name, launch: built.launches[0]! };
}

describe('the system prompt an Agent of a TeammateCollection is launched with', () => {
  it('leads a Team-scoped TeamMate with who it is and where its output goes, then the operator identity', async () => {
    const launch = await launchedTeamMate({
      teamScope: TEAM,
      name: 'tm-mate-test',
      identityPrompt: IDENTITY,
    });

    expect(launch.systemPrompt?.append).toEqual([
      'You are TeamMate "tm-mate-test" of Dreamux Team "alpha". Your TeamLeader ' +
        'receives what you output when your turn ends.',
      IDENTITY,
    ]);
  });

  it('tells a dispatcher-scoped TeamMate nothing but the operator identity', async () => {
    const launch = await launchedTeamMate({
      teamScope: null,
      name: 'mate-test',
      identityPrompt: IDENTITY,
    });

    // It reports to the Dispatcher that spawned it, not to a TeamLeader, so
    // there is no Team-membership fact to state.
    expect(launch.systemPrompt?.append).toEqual([IDENTITY]);
  });

  it('gives a dispatcher-scoped TeamMate without an identity no system prompt at all', async () => {
    const launch = await launchedTeamMate({
      teamScope: null,
      name: 'plain-test',
      identityPrompt: null,
    });

    expect(launch.systemPrompt).toBeUndefined();
  });

  it('tells a Team-scoped workflow agent who it is, then the workflow contract, then the identity — and nothing about its TeamLeader receiving its output', async () => {
    const { name, launch } = await launchedWorkflowAgent();

    expect(name).toBe('tm-agent-test');
    expect(launch.systemPrompt?.append).toEqual([
      'You are TeamMate "tm-agent-test" of Dreamux Team "alpha".',
      WORKFLOW_AGENT_SYSTEM_PROMPT,
      IDENTITY,
    ]);
  });
});
