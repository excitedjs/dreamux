import { createHash } from 'node:crypto';

import type {
  AgentRuntime,
  AgentRuntimeMcpServer,
  AgentRuntimeProvider,
  TurnSettledSignal,
} from '@excitedjs/dreamux-types';

import {
  bundledSkillSourcesForRole,
  HOST_INJECT_ENV,
  teammateHostPaths,
} from '../../agent-runtime/index.js';
import type { ResolvedAgentConfig } from '../../config/config.js';
import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import { validateDispatcherId } from '../../state/dispatcher-id.js';
import type { TeamMateIdentityStore } from './identity-store.js';
import { TeamMateRuntimeStateStore } from './runtime-state.js';
import type { TeamMateIdentity, TeamMateTurnOrigin } from './types.js';

export interface LiveTeamMate {
  runtime: AgentRuntime;
  state: TeamMateRuntimeStateStore;
  /**
   * Per-turn submission origin, keyed by runtime turn id. First-writer-wins:
   * a later input steered into an already-active turn never re-targets that
   * turn's completion. Bounded FIFO; entries are kept after settle so duplicate
   * settles of the same turn route consistently.
   */
  turnOrigins: Map<string, TeamMateTurnOrigin>;
}

export interface LiveTeamMateSettledInput {
  state: TeamMateRuntimeStateStore;
  runtime: AgentRuntime;
  settled: TurnSettledSignal;
  turnOrigins: ReadonlyMap<string, TeamMateTurnOrigin>;
}

export interface StartLiveTeamMateInput {
  identities: TeamMateIdentityStore;
  dispatcherId: string;
  identity: TeamMateIdentity;
  provider: AgentRuntimeProvider;
  agent: ResolvedAgentConfig;
  mcpServers: readonly AgentRuntimeMcpServer[];
  log: DreamuxLogger;
  onTurnSettled?: (input: LiveTeamMateSettledInput) => void;
}

const TURN_ORIGIN_CACHE_LIMIT = 256;

export interface LiveTeamMateRegistryOptions {
  identities: TeamMateIdentityStore;
  log: DreamuxLogger;
  mcpServersForTeamMate?: (input: {
    dispatcherId: string;
    name: string;
    identity: TeamMateIdentity;
  }) => readonly AgentRuntimeMcpServer[];
}

export class LiveTeamMateRegistry {
  private readonly live = new Map<string, LiveTeamMate>();

  constructor(private readonly opts: LiveTeamMateRegistryOptions) {}

  get(dispatcherId: string, name: string): LiveTeamMate | undefined {
    return this.live.get(liveKey(dispatcherId, name));
  }

  getRuntime(dispatcherId: string, name: string): AgentRuntime | null {
    return this.get(dispatcherId, name)?.runtime ?? null;
  }

  async start(input: {
    dispatcherId: string;
    identity: TeamMateIdentity;
    provider: AgentRuntimeProvider;
    agent: ResolvedAgentConfig;
    onTurnSettled?: (input: LiveTeamMateSettledInput) => void;
  }): Promise<LiveTeamMate> {
    const live = await startLiveTeamMate({
      identities: this.opts.identities,
      dispatcherId: input.dispatcherId,
      identity: input.identity,
      provider: input.provider,
      agent: input.agent,
      mcpServers:
        this.opts.mcpServersForTeamMate?.({
          dispatcherId: input.dispatcherId,
          name: input.identity.name,
          identity: input.identity,
        }) ?? [],
      log: this.opts.log,
      ...(input.onTurnSettled !== undefined
        ? { onTurnSettled: input.onTurnSettled }
        : {}),
    });
    this.live.set(liveKey(input.dispatcherId, input.identity.name), live);
    return live;
  }

  delete(dispatcherId: string, name: string): void {
    this.live.delete(liveKey(dispatcherId, name));
  }

  async stopAll(): Promise<void> {
    for (const [key, live] of this.live) {
      await live.runtime.stop();
      this.live.delete(key);
    }
  }
}

export async function startLiveTeamMate(
  input: StartLiveTeamMateInput,
): Promise<LiveTeamMate> {
  const resumeCapability = input.provider.getCapabilities().resume;
  const state = new TeamMateRuntimeStateStore(input.identities, input.identity);
  let liveRuntime: AgentRuntime | null = null;
  const turnOrigins = new Map<string, TeamMateTurnOrigin>();
  const runtimeName = runtimeIdentityName(input.identity);
  const runtime = input.provider.createRuntime({
    identity: {
      runtime_id: runtimeId(input.identity.dispatcher_id, runtimeName),
      checkpoint_id: input.identity.session_id,
    },
    role: input.identity.role,
    config: input.agent.config,
    cwd: input.identity.cwd,
    skillSources: bundledSkillSourcesForRole(input.identity.role),
    state,
    paths: teammateHostPaths(input.identity.dispatcher_id, runtimeName),
    injectEnv: HOST_INJECT_ENV,
    mcpServers: [...input.mcpServers],
    ...(input.onTurnSettled !== undefined
      ? {
          onTurnSettled: (settled: TurnSettledSignal): void => {
            const settledRuntime = liveRuntime;
            if (settledRuntime === null) return;
            input.onTurnSettled?.({
              state,
              runtime: settledRuntime,
              settled,
              turnOrigins,
            });
          },
        }
      : {}),
    logger:
      input.log.child?.({
        dispatcher_id: input.dispatcherId,
        teammate: input.identity.name,
      }) ?? input.log,
  });
  liveRuntime = runtime;
  if (input.identity.session_id !== null && resumeCapability.supported) {
    await runtime.resume({
      checkpoint: {
        kind: resumeCapability.checkpoint,
        id: input.identity.session_id,
      },
    });
  } else {
    await runtime.start();
  }
  return { runtime, state, turnOrigins };
}

export function liveKey(dispatcherId: string, name: string): string {
  return `${dispatcherId}\u0000${name}`;
}

export function recordTurnOrigin(
  live: LiveTeamMate,
  turnId: string,
  origin: TeamMateTurnOrigin,
): void {
  if (live.turnOrigins.has(turnId)) return;
  live.turnOrigins.set(turnId, origin);
  while (live.turnOrigins.size > TURN_ORIGIN_CACHE_LIMIT) {
    const oldest = live.turnOrigins.keys().next().value;
    if (oldest === undefined) break;
    live.turnOrigins.delete(oldest);
  }
}

function runtimeId(dispatcherId: string, name: string): string {
  const suffix = createHash('sha256')
    .update(`${dispatcherId}\u0000${name}`)
    .digest('hex')
    .slice(0, 12);
  const prefix = dispatcherId.slice(0, 40);
  return validateDispatcherId(`${prefix}.tm.${suffix}`, 'teammate runtime id');
}

function runtimeIdentityName(identity: TeamMateIdentity): string {
  return identity.team_id !== null
    ? `${identity.team_id}.${identity.name}`
    : identity.name;
}
