import { Buffer } from 'node:buffer';

import type {
  AgentRuntimeMcpServer,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type { DreamuxConfig } from '../../config/config.js';
import type { WorktreeManager } from '../worktree/manager.js';
import { dispatcherWorkspace } from '../worktree/workspaces.js';
import { TeammateCollection } from '../teammate-collection/index.js';
import type { TeamMateIdentityStore } from '../teammate-collection/identity-store.js';
import type { TeamMateTurnsStore } from '../teammate-collection/turns-store.js';
import type {
  CompletionInitiator,
  CompletionRouter,
} from '../completion-router/index.js';
import type { TeammateService } from '../teammate-service/index.js';
import { requireLifecycleText } from '../teammate-collection/types.js';
import type { TeamMateIdentity } from '../teammate-collection/types.js';
import type { ChannelBindingStore } from '../channel-binding/store.js';
import type { ChannelBinding } from '../channel-binding/store.js';
import { SchedulerService } from '../scheduler/service.js';
import { CronJobStore } from '../scheduler/store.js';
import { dispatcherTeamCronJobsPath } from '../../platform/paths.js';
import { TeamStore } from './store.js';
import type {
  TeamChannelBindingSummary,
  TeamCreateInput,
  TeamCreateResult,
  TeamHistoryQuery,
  TeamHistoryResult,
  TeamHistoryRow,
  TeamListRow,
  TeamRecord,
  TeamTransferChannelBackInput,
} from './types.js';
import { validateTeamId } from './types.js';
import type { TeamMateIdentityStatus } from '../teammate-collection/types.js';
import {
  activeGroupBindingFor,
  teamView,
  TeamService,
  type TeamServiceOptions,
} from '../team-service/index.js';

export interface TeamCollectionOptions {
  /** The dispatcher this collection belongs to (issue #233 ownership sinking). */
  dispatcherId: string;
  config: DreamuxConfig;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  worktrees: WorktreeManager;
  bindings: ChannelBindingStore;
  /**
   * The dispatcher's identity + turns store pair (issue #233 R4). Supplied by
   * `DispatcherService` (the same pair the dispatcher agent + dispatcher-scope
   * collection share) and forwarded into every per-team collection so no team
   * news its own. Read-path probes (`leaderState` / `memberCount`) read the
   * identity store directly, never a throwaway collection. The stores are
   * stateless (paths by role + team_id), so one pair safely serves all scopes.
   */
  identities: TeamMateIdentityStore;
  turnsStore: TeamMateTurnsStore;
  // Shared per-dispatcher deps `DispatcherService` always supplies; forwarded
  // unchanged into each team's own collection so it stays topology-free (#233).
  router: CompletionRouter;
  initiatorFor: (
    producer: TeamMateIdentity,
  ) => Promise<CompletionInitiator | null>;
  isShuttingDown: () => boolean;
  mcpServersForTeamMate: (input: {
    dispatcherId: string;
    name: string;
    identity: TeamMateIdentity;
  }) => readonly AgentRuntimeMcpServer[];
  log: DreamuxLogger;
}

/**
 * The dispatcher's team collection (issue #233): one per dispatcher, owned by
 * `DispatcherService`. Owns the team store + the per-dispatcher binding store /
 * worktree manager; exposes `create` / `list` / `history` + pre-team channel
 * resolution. `get(teamId)` is a get-or-rebuild factory (like `Dispatchers.get`
 * / `TeammateCollection.entityFor`): cached live {@link TeamService} if any, else
 * rebuilt from the persisted {@link TeamRecord} and cached. Each `TeamService`
 * OWNS its per-team {@link TeammateCollection} (`teamScope: team_id`) built from
 * the shared deps forwarded here; live cache ≡ process lifetime, `dissolve`
 * evicts so a later `get` reads `status: closed`.
 */
export class TeamCollection {
  private readonly dispatcherId: string;
  private readonly store = new TeamStore();
  private readonly worktrees: WorktreeManager;
  private readonly bindings: ChannelBindingStore;
  /** Live {@link TeamService} cache keyed by team id (issue #233 factory). */
  private readonly cache = new Map<string, TeamService>();
  /** In-flight `create` per team id (concurrent same-id creates share one). */
  private readonly creating = new Map<string, Promise<TeamCreateResult>>();
  /** In-flight cache-miss `get`, so a cold-cache race rebuilds one TeamService
   * (one leader runtime), not two (issue #233 concurrency guard). */
  private readonly rebuilding = new Map<string, Promise<TeamService>>();
  /** Live TeamLeader schedulers keyed by team id; schedulers are resident at boot. */
  private readonly schedulers = new Map<string, SchedulerService>();

  constructor(private readonly opts: TeamCollectionOptions) {
    this.dispatcherId = opts.dispatcherId;
    this.worktrees = opts.worktrees;
    this.bindings = opts.bindings;
  }

  async create(input: TeamCreateInput): Promise<TeamCreateResult> {
    return dedupe(this.creating, validateTeamId(input.name), () =>
      this.doCreate(input),
    );
  }

  private async doCreate(input: TeamCreateInput): Promise<TeamCreateResult> {
    requireLifecycleText(input.intent, 'Team create intent');
    const teamId = validateTeamId(input.name);
    const existing = await this.store.get(this.dispatcherId, teamId);
    if (existing !== null && existing.status !== 'closed') {
      throw new Error(`Team ${JSON.stringify(teamId)} already exists`);
    }
    const workspaceRoot = await dispatcherWorkspace(this.opts.config, this.dispatcherId);
    const workspace =
      input.worktree === undefined && input.repoCwd === undefined
        ? await this.worktrees.prepareDefaultWorkspace({
            dispatcherWorkspace: workspaceRoot,
            slug: teamId,
          })
        : await this.worktrees.prepare({
            dispatcherId: this.dispatcherId,
            teammateName: `team-${teamId}`,
            cwd: input.repoCwd ?? workspaceRoot,
            dispatcherWorkspace: workspaceRoot,
            request: input.worktree ?? {
              mode: 'managed',
              slug: `team-${teamId}`,
              cleanup: 'keep',
            },
          });
    // The team's own collection allocates the (dispatcher-global) leader name
    // and creates the leader (issue #233).
    const teammates = this.buildTeammates(teamId);
    const leaderName = await teammates.allocateLeaderName();
    let team =
      existing ??
      (await this.store.create({
        dispatcher_id: this.dispatcherId,
        team_id: teamId,
        name: input.name,
        repo_cwd: workspace.sourceCwd,
        source_repo: workspace.sourceRepo,
        leader_name: leaderName,
        leader_agent_runtime: input.leaderAgentRuntime,
        runtime_cwd: workspace.runtimeCwd,
        worktree: workspace.worktree,
        status: 'starting',
        intent: input.intent,
        closed_at: null,
        close_note: null,
      }));
    team = await this.store.update(team, {
      status: 'starting',
      closedAt: null,
      closeNote: null,
      worktree: workspace.worktree,
      intent: input.intent,
      leaderName,
    });
    const { leader, result } = await teammates.createTeamLeader({
      name: leaderName,
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      agentRuntime: input.leaderAgentRuntime,
      sourceCwd: workspace.sourceCwd,
      sourceRepo: workspace.sourceRepo,
      runtimeCwd: workspace.runtimeCwd,
      worktree: workspace.worktree,
      intent: input.intent,
    });
    team = await this.store.update(team, { status: 'running' });
    // Cache the live service so later `get`s reuse this leader + collection and
    // record mutations route through it (issue #233).
    const service = new TeamService(
      await this.teamServiceOptions(team, teammates, leader),
    );
    this.cache.set(teamId, service);
    return {
      team: teamView(team),
      leader: result.teammate,
      member_count: await service.memberCount(),
      binding: null,
      turn: result.turn,
    };
  }

  async list(): Promise<TeamListRow[]> {
    const teams = await this.store.list(this.dispatcherId);
    const out: TeamListRow[] = [];
    for (const team of teams) out.push(await this.listRow(team));
    return out;
  }

  async history(input: TeamHistoryQuery): Promise<TeamHistoryResult> {
    const teams = await this.store.list(this.dispatcherId);
    const rows: TeamHistoryRow[] = [];
    for (const team of teams) {
      const row = await this.historyRow(team);
      if (matchesTeamHistoryQuery(row, input)) rows.push(row);
    }
    rows.sort(
      (a, b) =>
        b.updated_at - a.updated_at ||
        b.created_at - a.created_at ||
        a.team_name.localeCompare(b.team_name),
    );
    const start = input.cursor !== undefined ? decodeTeamCursor(input.cursor) : 0;
    const limit = clampTeamHistoryLimit(input.limit);
    const items = rows.slice(start, start + limit);
    const next = start + items.length;
    return {
      items,
      next_cursor: next < rows.length ? encodeTeamCursor(next) : null,
    };
  }

  /** Get-or-rebuild the team's service; a cold-cache miss is deduped (#233). */
  async get(teamId: string): Promise<TeamService> {
    const id = validateTeamId(teamId);
    const cached = this.cache.get(id);
    if (cached !== undefined) return cached;
    return dedupe(this.rebuilding, id, async () =>
      this.serviceFor(await this.mustTeam(id)),
    );
  }

  async resolveChannel(input: {
    channelId: string;
    targetKey: string;
  }): Promise<ChannelBinding | null> {
    const binding = await this.bindings.resolve({
      dispatcherId: this.dispatcherId,
      channelId: input.channelId,
      targetKey: input.targetKey,
    });
    if (binding === null) return null;
    const team = await this.store.get(this.dispatcherId, binding.team_name);
    if (team === null || team.status === 'closed') return null;
    return binding;
  }

  async transferChannelBack(
    input: TeamTransferChannelBackInput,
  ): Promise<ChannelBinding | null> {
    return this.bindings.transferBack({
      dispatcherId: this.dispatcherId,
      channelId: input.channelId,
      targetKey: input.targetKey,
    });
  }

  /** Rebuild a team's live service from its record and cache it (issue #233). */
  private async serviceFor(record: TeamRecord): Promise<TeamService> {
    const teammates = this.buildTeammates(record.team_id);
    const leader = await teammates.leader(record.leader_name);
    const service = new TeamService(
      await this.teamServiceOptions(record, teammates, leader),
    );
    this.cache.set(record.team_id, service);
    return service;
  }

  /** Build the team-scoped {@link TeammateCollection} the team OWNS (issue #233).
   * Shares the dispatcher's identity + turns store pair (R4) — the stores are
   * stateless path-derivers, so no team news its own. */
  private buildTeammates(teamId: string): TeammateCollection {
    return new TeammateCollection({
      dispatcherId: this.dispatcherId,
      teamScope: teamId,
      config: this.opts.config,
      agentRuntimeProviders: this.opts.agentRuntimeProviders,
      worktrees: this.worktrees,
      identities: this.opts.identities,
      turnsStore: this.opts.turnsStore,
      router: this.opts.router,
      initiatorFor: this.opts.initiatorFor,
      isShuttingDown: this.opts.isShuttingDown,
      mcpServersForTeamMate: this.opts.mcpServersForTeamMate,
      log: this.opts.log,
    });
  }

  private async teamServiceOptions(
    record: TeamRecord,
    teammates: TeammateCollection,
    leader: TeammateService,
  ): Promise<TeamServiceOptions> {
    const scheduler =
      record.status === 'closed'
        ? this.buildScheduler(record.team_id)
        : this.schedulerFor(record.team_id);
    if (record.status !== 'closed') await scheduler.start();
    return {
      record,
      leader,
      scheduler,
      store: this.store,
      bindings: this.bindings,
      worktrees: this.worktrees,
      teammates,
      evict: () => {
        this.schedulers.get(record.team_id)?.stop();
        this.cache.delete(record.team_id);
        this.schedulers.delete(record.team_id);
      },
    };
  }

  private schedulerFor(teamId: string): SchedulerService {
    const existing = this.schedulers.get(teamId);
    if (existing !== undefined) return existing;
    const scheduler = this.buildScheduler(teamId);
    this.schedulers.set(teamId, scheduler);
    return scheduler;
  }

  private buildScheduler(teamId: string): SchedulerService {
    const scheduler = new SchedulerService({
      ownerId: `${this.dispatcherId}/team/${teamId}`,
      store: new CronJobStore({
        cronJobsPath: dispatcherTeamCronJobsPath(this.dispatcherId, teamId),
        dispatcherId: this.dispatcherId,
      }),
      absentRuntimeStrategy: 'submit',
      getRuntime: () => this.cache.get(teamId)?.leader.getRuntime() ?? null,
      submitScheduled: (input) => this.leaderFor(teamId).scheduledInput(input),
      log: this.opts.log,
    });
    return scheduler;
  }

  private leaderFor(teamId: string): TeammateService {
    const team = this.cache.get(teamId);
    if (team === undefined) {
      throw new Error(`Team ${JSON.stringify(teamId)} is not materialized`);
    }
    return team.leader;
  }

  private async listRow(team: TeamRecord): Promise<TeamListRow> {
    return {
      team_name: team.team_id,
      status: team.status,
      intent: team.intent,
      source_repo: team.source_repo,
      leader_name: team.leader_name,
      leader_state: await this.leaderState(team),
      member_count: await this.memberCount(team),
      bound_group: await this.activeGroupBinding(team),
      created_at: team.created_at,
      updated_at: team.updated_at,
      closed_at: team.closed_at,
    };
  }

  private async historyRow(team: TeamRecord): Promise<TeamHistoryRow> {
    return {
      team_name: team.team_id,
      status: team.status,
      intent: team.intent,
      source_repo: team.source_repo,
      leader_name: team.leader_name,
      leader_agent_runtime: team.leader_agent_runtime,
      leader_state: await this.leaderState(team),
      member_count: await this.memberCount(team),
      bound_group: await this.activeGroupBinding(team),
      created_at: team.created_at,
      updated_at: team.updated_at,
      closed_at: team.closed_at,
      close_note: team.close_note,
      close_note_preview:
        team.close_note !== null ? previewTeamText(team.close_note) : null,
    };
  }

  private async leaderState(
    team: TeamRecord,
  ): Promise<TeamMateIdentityStatus | null> {
    // Read-only probe straight from the shared identity store (issue #233 R4):
    // the leader lives at the team root, so the get is team-scoped. Equivalent to
    // the old throwaway-collection `status(name)` — that probe held no entities,
    // so its projection was already just `identity.status` with no live runtime.
    // The `.catch(() => null)` matches the old `status(...).catch(() => null)`:
    // this is a scan probe, so one unreadable team record (malformed leader_name,
    // legacy state, IO error) must degrade to a null leader_state for that row,
    // not throw and poison the whole list/history scan.
    const leader = await this.opts.identities
      .get(this.dispatcherId, team.leader_name, team.team_id)
      .catch(() => null);
    return leader?.status ?? null;
  }

  private async activeGroupBinding(
    team: TeamRecord,
  ): Promise<TeamChannelBindingSummary | null> {
    return activeGroupBindingFor(
      await this.bindings.list(this.dispatcherId),
      team.team_id,
    );
  }

  private async memberCount(team: TeamRecord): Promise<number> {
    // Members-only roster, read straight from the shared identity store (issue
    // #233 R4): a team-scope list returns only that team's members. Equivalent to
    // the old throwaway-collection `list().length` — same store call, no entities.
    return (await this.opts.identities.list(this.dispatcherId, team.team_id))
      .length;
  }

  private async mustTeam(teamId: string): Promise<TeamRecord> {
    const team = await this.store.get(this.dispatcherId, validateTeamId(teamId));
    if (team === null) {
      throw new TeamUnavailableError(`Team ${JSON.stringify(teamId)} does not exist`);
    }
    return team;
  }

  private async mustOpenTeam(teamId: string): Promise<TeamRecord> {
    const team = await this.mustTeam(teamId);
    if (team.status === 'closed') {
      throw new TeamUnavailableError(`Team ${JSON.stringify(teamId)} is closed`);
    }
    return team;
  }

  async scheduler(teamId: string): Promise<SchedulerService> {
    await this.mustOpenTeam(teamId);
    return (await this.get(teamId)).scheduler;
  }

  async startSchedulers(): Promise<void> {
    const teams = await this.store.list(this.dispatcherId);
    for (const team of teams) {
      if (team.status === 'closed') continue;
      try {
        await this.serviceFor(team);
      } catch (err) {
        this.opts.log.error(
          { dispatcher_id: this.dispatcherId, team_id: team.team_id, err: errInfo(err) },
          'TeamLeader scheduler start failed',
        );
      }
    }
  }

  stopSchedulers(): void {
    for (const scheduler of this.schedulers.values()) scheduler.stop();
  }

  /**
   * Stop every live team's runtimes on server shutdown (issue #233). Only the
   * currently materialized {@link TeamService}s are swept (live cache ≡ process
   * lifetime), so this never reads the durable store or lazily starts a runtime.
   */
  async stopAll(): Promise<void> {
    for (const service of this.cache.values()) {
      await service.stopAll();
    }
  }
}

export class TeamUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamUnavailableError';
  }
}

/** Share one in-flight promise per key; a concurrent same-key call joins it. */
function dedupe<T>(
  inFlight: Map<string, Promise<T>>,
  key: string,
  start: () => Promise<T>,
): Promise<T> {
  const existing = inFlight.get(key);
  if (existing !== undefined) return existing;
  const promise = start().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

function matchesTeamHistoryQuery(
  row: TeamHistoryRow,
  input: Omit<TeamHistoryQuery, 'dispatcherId'>,
): boolean {
  if (input.name !== undefined && row.team_name !== validateTeamId(input.name)) {
    return false;
  }
  if (input.status !== undefined && row.status !== input.status) return false;
  if (input.repo !== undefined) {
    const needle = input.repo.toLowerCase();
    const hit = row.source_repo !== null && row.source_repo.toLowerCase().includes(needle);
    if (!hit) return false;
  }
  if (input.grep !== undefined && !teamRowMatchesText(row, input.grep)) {
    return false;
  }
  if (input.since !== undefined && row.updated_at < input.since) return false;
  if (input.until !== undefined && row.updated_at > input.until) return false;
  return true;
}

function teamRowMatchesText(row: TeamHistoryRow, grep: string): boolean {
  const needle = grep.toLowerCase();
  if (needle === '') return true;
  return [
    row.team_name,
    row.intent,
    row.source_repo,
    row.leader_name,
    row.close_note,
  ].some((value) => value !== null && value.toLowerCase().includes(needle));
}

function clampTeamHistoryLimit(input: number | undefined): number {
  if (input === undefined) return 20;
  if (!Number.isInteger(input) || input < 1) {
    throw new Error('history limit must be a positive integer');
  }
  return Math.min(input, 100);
}

function encodeTeamCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

function decodeTeamCursor(cursor: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      offset?: unknown;
    };
    if (typeof parsed.offset === 'number' && Number.isInteger(parsed.offset) && parsed.offset >= 0) {
      return parsed.offset;
    }
  } catch {
  }
  throw new Error('invalid history cursor');
}

function previewTeamText(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= 500 ? collapsed : `${collapsed.slice(0, 497)}...`;
}

function errInfo(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { type: err.name, message: err.message, stack: err.stack };
  }
  return { value: String(err) };
}
