import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import type {
  AgentRuntime,
  AgentRuntimeCapabilities,
  AgentRuntimeMcpServer,
  AgentRuntimePathContext,
  AgentRuntimeProvider,
  AgentRuntimeProviderCatalog,
  AgentRuntimeTurnResult,
  CompletionEnvelope,
} from '../../agent-runtime/index.js';
import type { TurnSettledSignal } from '../../agent-runtime/turn.js';
import {
  BUILTIN_CLAUDE_CODE_PROVIDER_REF,
  type DispatcherConfig,
  type DreamuxConfig,
  type ResolvedAgentConfig,
} from '../../config/config.js';
import type { DispatcherStore, DispatcherRow } from '../../state/dispatcher-store.js';
import type { DreamuxLogger } from '../../platform/logger.js';
import { teammateClaudeCodeStreamLogPath } from '../../agent-runtime/builtin/claude-code/paths.js';
import {
  teammateCodexAppServerErrorLogPath,
  teammateCodexAppServerLogPath,
} from '../../agent-runtime/builtin/codex/paths.js';
import {
  dispatcherCompletionSpillDir,
  dispatcherTeamMateRuntimeDir,
} from '../../platform/paths.js';
import { validateDispatcherId } from '../../state/dispatcher-id.js';
import { ensureDispatcherWorkspace } from '../dispatcher-workspace.js';
import { TeamMateIdentityStore } from './identity-store.js';
import { TeamMateRuntimeStateStore } from './runtime-state.js';
import { TeamMateTurnsStore } from './turns-store.js';
import { allocateConcreteName, type SuffixGenerator } from './name-allocator.js';
import { WorktreeManager, type PreparedTeamMateWorkspace } from './worktree-manager.js';
import {
  requireLifecycleText,
  validateTeamMateName,
  type CloseTeamMateInput,
  type SendTeamMateInput,
  type SpawnTeamMateInput,
  type TeamMateCapabilities,
  type TeamMateCallerPrincipal,
  type TeamMateCloseResult,
  type CreateTeamLeaderInput,
  type TeamMateHistoryQuery,
  type TeamMateHistoryResult,
  type TeamMateIdentity,
  type TeamMateRecordRow,
  type TeamMateLastResult,
  type TeamMateLastTurn,
  type TeamMateRole,
  type TeamMateAgentRuntimeCapability,
  type TeamMateRuntimeStatus,
  type TeamMateSendResult,
  type TeamMateSpawnResult,
  type TeamMateTurnOrigin,
  type TeamMateTurnResult,
  type TeamMateWorktreeIdentity,
  type TeamMateWorktreeRequest,
  dispatcherPrincipal,
  principalDispatcherId,
  teamServicePrincipal,
} from './types.js';

interface LiveTeamMate {
  runtime: AgentRuntime;
  state: TeamMateRuntimeStateStore;
  /**
   * Per-turn submission origin, keyed by runtime turn id. First-writer-wins:
   * a later input steered into an already-active turn never re-targets that
   * turn's completion. Bounded FIFO (see {@link TURN_ORIGIN_CACHE_LIMIT});
   * entries are kept after settle so duplicate settles of the same turn route
   * consistently.
   */
  turnOrigins: Map<string, TeamMateTurnOrigin>;
}

const TURN_ORIGIN_CACHE_LIMIT = 256;

export interface TeamMateAgentServiceOptions {
  config: DreamuxConfig;
  dispatchers: DispatcherStore;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  mcpServersForTeamMate?: (input: {
    dispatcherId: string;
    name: string;
    identity: TeamMateIdentity;
  }) => readonly AgentRuntimeMcpServer[];
  /**
   * Reverse-delivery sink: invoked when a teammate turn reaches a terminal state
   * (success, failure, or stop). The facade bridges it to the dispatcher
   * runtime's `completionInput`, turning a finished teammate into a fresh
   * dispatcher turn (issue #147). A teammate runtime is launched with
   * `onTurnSettled` only when this sink is present, so settlement never delivers
   * into a void.
   */
  onTeamMateCompletion?: (
    dispatcherId: string,
    identity: TeamMateIdentity,
    completion: CompletionEnvelope,
    /**
     * The settled turn's submission origin, or `null` when the turn id was
     * never recorded by this process (the sink picks the role's safe default).
     */
    origin: TeamMateTurnOrigin | null,
  ) => void | Promise<void>;
  /**
   * Test seam (issue #188): override the random suffix generator used by
   * concrete-name allocation so collisions and exhaustion are reproducible.
   * Production leaves this unset and uses the CSPRNG default.
   */
  suffixGenerator?: SuffixGenerator;
  log: DreamuxLogger;
}

export interface TeamMateSharedWorkspace {
  sourceCwd: string;
  sourceRepo: string | null;
  runtimeCwd: string;
  worktree: TeamMateWorktreeIdentity;
}

export interface ScopedSpawnTeamMateInput {
  principal: TeamMateCallerPrincipal;
  name: string;
  prompt: string;
  agentRuntime?: string;
  cwd?: string;
  worktree?: TeamMateWorktreeRequest;
  sharedWorkspace?: TeamMateSharedWorkspace;
  /** Required recovery subject (issue #182 PR-3). */
  intent: string;
}

export interface ScopedSendTeamMateInput {
  principal: TeamMateCallerPrincipal;
  name: string;
  prompt: string;
  /** Optional updated recovery subject, applied before the turn (issue #182 PR-3). */
  intent?: string;
}

export interface ScopedCloseTeamMateInput {
  principal: TeamMateCallerPrincipal;
  name: string;
  /** Required close reason (issue #182 PR-3). */
  note: string;
}

export class TeamMateAgentService {
  private readonly identities: TeamMateIdentityStore;
  private readonly turnsStore: TeamMateTurnsStore;
  private readonly worktrees = new WorktreeManager();
  private readonly live = new Map<string, LiveTeamMate>();
  private submissionSeq = 0;

  constructor(private readonly opts: TeamMateAgentServiceOptions) {
    this.identities = new TeamMateIdentityStore({
      warn: (message, fields) => opts.log.warn(fields ?? {}, message),
    });
    this.turnsStore = new TeamMateTurnsStore({
      warn: (message, fields) => opts.log.warn(fields ?? {}, message),
    });
  }

  /**
   * Read-only access to the per-name turns archive (issue #199 Slice 3),
   * exposed so tests and recovery tooling can stream a teammate's turn rows.
   */
  turns(): TeamMateTurnsStore {
    return this.turnsStore;
  }

  /**
   * Allocate a concrete, never-reused TeamLeader name for a team (issue #188).
   * The Team service calls this once at create time and persists the result as
   * the team's durable `leader_name`; routing reads that stored name rather
   * than reconstructing `${teamId}-leader`.
   */
  async allocateLeaderName(dispatcherId: string, teamId: string): Promise<string> {
    return this.allocateName(dispatcherId, 'team_leader', teamId, teamId);
  }

  /**
   * Allocate a concrete name from an agent-supplied base slug (issue #188).
   * Uniqueness is checked against ALL persisted identities (closed included),
   * so a concrete name is never reused; the suffix is regenerated on collision
   * and the allocation fails loudly if the attempt budget is exhausted.
   */
  private async allocateName(
    dispatcherId: string,
    role: TeamMateRole,
    base: string,
    teamSlug?: string,
  ): Promise<string> {
    const identities = await this.identities.list(dispatcherId);
    const taken = new Set(identities.map((identity) => identity.name));
    return allocateConcreteName({
      role,
      base,
      ...(teamSlug !== undefined ? { teamSlug } : {}),
      exists: (candidate) => taken.has(candidate),
      ...(this.opts.suffixGenerator !== undefined
        ? { generateSuffix: this.opts.suffixGenerator }
        : {}),
    });
  }

  async spawn(input: SpawnTeamMateInput): Promise<TeamMateSpawnResult> {
    return this.spawnScoped({
      principal: dispatcherPrincipal(input.dispatcherId),
      name: input.name,
      prompt: input.prompt,
      intent: input.intent,
      ...(input.agentRuntime !== undefined ? { agentRuntime: input.agentRuntime } : {}),
      cwd: input.cwd,
      ...(input.worktree !== undefined ? { worktree: input.worktree } : {}),
    });
  }

  async spawnScoped(input: ScopedSpawnTeamMateInput): Promise<TeamMateSpawnResult> {
    const dispatcherId = principalDispatcherId(input.principal);
    if (input.principal.kind === 'teammate') {
      throw new Error('ordinary TeamMates cannot spawn TeamMates');
    }
    // The agent-supplied `name` is a base slug / display hint, not the final
    // address (issue #188): require it non-empty, then allocate a concrete,
    // never-reused name below and return it in the spawn result.
    const requestedName = requireLifecycleText(input.name, 'TeamMate spawn name');
    // Required recovery subject — enforced here too for in-process callers that
    // bypass the MCP shim / admin layer (issue #182 PR-3).
    requireLifecycleText(input.intent, 'TeamMate spawn intent');
    if (input.principal.kind === 'team_leader' && input.sharedWorkspace === undefined) {
      throw new Error('TeamLeader member spawn requires a shared team workspace');
    }
    const owner = ownerForPrincipal(input.principal);
    const role: TeamMateRole =
      input.principal.kind === 'team_leader' ? 'team_member' : 'teammate';
    // Allocate the concrete address from the requested slug (Team members get
    // the `tm-` rule). Checked against all persisted identities, never reused.
    const name = await this.allocateName(dispatcherId, role, requestedName);
    const agentRuntimeId =
      input.agentRuntime ?? this.defaultAgentRuntime(dispatcherId);
    const agent = this.resolveAgent(dispatcherId, agentRuntimeId);
    const provider = this.opts.agentRuntimeProviders.resolve(agent.provider);
    const workspace = await this.resolveSpawnWorkspace(dispatcherId, name, input);
    if (input.sharedWorkspace === undefined) {
      await this.assertManagedWorktreeAvailable(dispatcherId, name, workspace.worktree);
    }
    // #199 Slice 3: no Dreamux-minted session id — session_id is the
    // runtime-native thread id, set when the runtime reports one. The concrete
    // name is fresh, so this is always a create (issue #188).
    let identity = await this.identities.create({
      dispatcherId,
      name,
      owner,
      role,
      teamId: owner.kind === 'team' ? owner.team_id : null,
      agentRuntime: agentRuntimeId,
      sourceCwd: workspace.sourceCwd,
      sourceRepo: workspace.sourceRepo,
      cwd: workspace.runtimeCwd,
      runtimeCwd: workspace.runtimeCwd,
      worktree: workspace.worktree,
      intent: input.intent,
      status: 'starting',
    });
    this.assertPrincipalCanAccess(input.principal, identity);
    const live = await this.startRuntime(dispatcherId, identity, provider, agent);
    identity = live.state.current();
    const turn = await this.submitPrompt(dispatcherId, name, input.prompt, {
      principal: input.principal,
    });
    await this.recordSubmittedTurn(dispatcherId, live, {
      turnId: turn.turn_id ?? null,
      turnOrigin: principalTurnOrigin(input.principal),
      prompt: input.prompt,
    });
    return { teammate: this.toStatus(live.state.current(), live.runtime), turn };
  }

  /**
   * Resolve a spawn's workspace (issue #199). Three cases, in order:
   *   - a Team member inherits the Team's shared workspace verbatim;
   *   - no `repo` and no explicit cwd → a plain per-name work directory under
   *     the dispatcher workspace (`.workspace/work/<name>/`), NOT a git worktree,
   *     so the dispatcher cwd need not be a git repo;
   *   - an explicit cwd and/or `repo` mode → reuse-cwd runs in the given cwd;
   *     managed creates a git worktree under the dispatcher workspace (only
   *     managed forces the dispatcher cwd contract — issue #182 PR-4).
   */
  private async resolveSpawnWorkspace(
    dispatcherId: string,
    name: string,
    input: ScopedSpawnTeamMateInput,
  ): Promise<PreparedTeamMateWorkspace | TeamMateSharedWorkspace> {
    if (input.sharedWorkspace !== undefined) return input.sharedWorkspace;
    if (
      input.worktree === undefined &&
      (input.cwd === undefined || input.cwd.trim() === '')
    ) {
      return this.worktrees.prepareDefaultWorkspace({
        dispatcherWorkspace: await this.dispatcherWorkspace(dispatcherId),
        slug: name,
      });
    }
    const cwd = input.cwd;
    if (typeof cwd !== 'string' || cwd.trim() === '') {
      throw new Error('TeamMate spawn requires cwd');
    }
    const managedMode = (input.worktree?.mode ?? 'reuse-cwd') === 'managed';
    return this.worktrees.prepare({
      dispatcherId,
      teammateName: name,
      cwd,
      ...(managedMode
        ? { dispatcherWorkspace: await this.dispatcherWorkspace(dispatcherId) }
        : {}),
      request: input.worktree,
    });
  }

  async send(input: SendTeamMateInput): Promise<TeamMateSendResult> {
    return this.sendScoped({
      principal: dispatcherPrincipal(input.dispatcherId),
      name: input.name,
      prompt: input.prompt,
      ...(input.intent !== undefined ? { intent: input.intent } : {}),
    });
  }

  async sendScoped(input: ScopedSendTeamMateInput): Promise<TeamMateSendResult> {
    // send subsumes the former `resume` verb (issue #155): a teammate that is
    // not live — including one previously `close`d — is reopened from its
    // persisted checkpoint and the turn is submitted, so send always works as
    // long as the identity exists. reopenClosed scopes this revival to send;
    // read-only verbs (last/status) never silently reopen a closed teammate.
    const dispatcherId = principalDispatcherId(input.principal);
    const live = await this.ensureRuntime(dispatcherId, input.name, {
      principal: input.principal,
      reopenClosed: true,
    });
    // Optional intent update is applied BEFORE the turn so the recorded recovery
    // subject reflects the work this turn is about (issue #182 PR-3). An empty
    // string is ignored so a stray send never wipes a meaningful subject.
    if (input.intent !== undefined && input.intent !== '') {
      await live.state.updateIntent(input.intent);
    }
    const turn = await this.submitPrompt(dispatcherId, input.name, input.prompt, {
      principal: input.principal,
    });
    await this.recordSubmittedTurn(dispatcherId, live, {
      turnId: turn.turn_id ?? null,
      turnOrigin: principalTurnOrigin(input.principal),
      prompt: input.prompt,
    });
    return { teammate: this.toStatus(live.state.current(), live.runtime), turn };
  }

  async close(input: CloseTeamMateInput): Promise<TeamMateCloseResult> {
    return this.closeScoped({
      principal: dispatcherPrincipal(input.dispatcherId),
      name: input.name,
      note: input.note,
    });
  }

  async closeScoped(input: ScopedCloseTeamMateInput): Promise<TeamMateCloseResult> {
    const dispatcherId = principalDispatcherId(input.principal);
    const name = validateTeamMateName(input.name);
    const identity = await this.mustIdentity(dispatcherId, name, input.principal);
    // Required close reason — enforced for in-process callers too (issue #182
    // PR-3); the Team dissolve path supplies an explicit note. Checked after the
    // existence/access lookup so an inaccessible teammate reports that first.
    requireLifecycleText(input.note, 'TeamMate close note');
    const key = liveKey(dispatcherId, name);
    const live = this.live.get(key);
    if (live !== undefined) {
      await live.runtime.stop();
      this.live.delete(key);
    }
    // #199 Slice 3: the close note and updated_at land on the record; history
    // reads the record directly (no separate close event), and the record stays
    // searchable/recoverable after close. No turns row is written for a close.
    const closed = await this.identities.update(identity, {
      status: 'closed',
      closedAt: Date.now(),
      closeNote: input.note,
      lastSeenAt: Date.now(),
      worktree: await this.worktrees.cleanup(identity),
    });
    return { teammate: this.toStatus(closed, null) };
  }

  /**
   * Capture a submitted turn (issue #199 Slice 3): append a compact `submit`
   * row to the per-name turns archive and bump the record's rolling summary
   * (turn_count / last_seen / last_prompt_preview). The summary update is routed
   * through the live state so its `current()` snapshot stays canonical.
   */
  private async recordSubmittedTurn(
    dispatcherId: string,
    live: LiveTeamMate,
    input: { turnId: string | null; turnOrigin: TeamMateTurnOrigin | null; prompt: string },
  ): Promise<void> {
    const current = live.state.current();
    await this.turnsStore.appendSubmit(dispatcherId, current.name, {
      turnId: input.turnId,
      turnOrigin: input.turnOrigin,
      prompt: input.prompt,
      intent: current.intent,
    });
    await live.state.recordSubmittedTurn(input.prompt);
  }

  /**
   * Capture a settled turn: append a `settled` row (final assistant output up to
   * the durable hard cap) and record the latest assistant preview on the record.
   */
  private async recordSettledTurn(
    dispatcherId: string,
    name: string,
    state: TeamMateRuntimeStateStore,
    input: {
      turnId: string | null;
      assistant: string | null;
      settleStatus: 'completed' | 'failed' | 'stopped' | null;
    },
  ): Promise<void> {
    await this.turnsStore.appendSettled(dispatcherId, name, {
      turnId: input.turnId,
      assistant: input.assistant,
      settleStatus: input.settleStatus,
    });
    await state.recordSettledTurn(input.assistant);
  }

  async list(dispatcherId: string): Promise<TeamMateRuntimeStatus[]> {
    return this.listScoped(dispatcherPrincipal(dispatcherId));
  }

  async listScoped(principal: TeamMateCallerPrincipal): Promise<TeamMateRuntimeStatus[]> {
    const dispatcherId = principalDispatcherId(principal);
    return (await this.scopedList(principal)).map((identity) =>
      this.toStatus(identity, this.live.get(liveKey(dispatcherId, identity.name))?.runtime ?? null),
    );
  }

  /**
   * The scoped LIST chokepoint (issue #199 Slice 4): the only place a list of
   * records is read for the `teammate.*` surface. Reads every record for the
   * principal's dispatcher and keeps just the ones {@link principalCanAccess}
   * admits, so list/history can never widen visibility independently.
   */
  private async scopedList(
    principal: TeamMateCallerPrincipal,
  ): Promise<TeamMateIdentity[]> {
    const identities = await this.identities.list(principalDispatcherId(principal));
    return identities.filter((identity) => principalCanAccess(principal, identity));
  }

  async status(
    dispatcherId: string,
    name: string,
  ): Promise<TeamMateRuntimeStatus> {
    return this.statusScoped(dispatcherPrincipal(dispatcherId), name);
  }

  async statusScoped(
    principal: TeamMateCallerPrincipal,
    name: string,
  ): Promise<TeamMateRuntimeStatus> {
    const dispatcherId = principalDispatcherId(principal);
    const identity = await this.mustIdentity(
      dispatcherId,
      validateTeamMateName(name),
      principal,
    );
    return this.toStatus(
      identity,
      this.live.get(liveKey(dispatcherId, identity.name))?.runtime ?? null,
    );
  }

  async history(input: TeamMateHistoryQuery): Promise<TeamMateHistoryResult> {
    return this.historyScoped({
      ...input,
      principal: input.principal ?? dispatcherPrincipal(input.dispatcherId),
    });
  }

  async historyScoped(
    input: Omit<TeamMateHistoryQuery, 'dispatcherId' | 'principal'> & {
      principal: TeamMateCallerPrincipal;
    },
  ): Promise<TeamMateHistoryResult> {
    // #199 Slice 3: `history` reads the per-name RECORDS only — each record
    // carries the rolling recovery summary (turn count, last-seen, previews), so
    // there is no turn/event fold here. Closed teammates keep their record and
    // stay searchable; live-only facts (runtime status) come from the live map.
    // #199 Slice 4: visibility is enforced by the same scoped-list chokepoint as
    // `list`, so `history` can never surface a record `list` would hide.
    const rows: TeamMateRecordRow[] = [];
    for (const identity of await this.scopedList(input.principal)) {
      const row = this.toRecordRow(identity);
      if (this.matchesRecordQuery(row, input)) {
        rows.push(row);
      }
    }
    rows.sort((a, b) =>
      b.last_seen_at - a.last_seen_at ||
      b.updated_at - a.updated_at ||
      a.name.localeCompare(b.name),
    );
    const start = input.cursor !== undefined ? decodeCursor(input.cursor) : 0;
    const limit = clampHistoryLimit(input.limit);
    const items = rows.slice(start, start + limit);
    const next = start + items.length;
    return {
      items,
      next_cursor: next < rows.length ? encodeCursor(next) : null,
    };
  }

  async last(
    dispatcherId: string,
    name: string,
    turns?: number,
  ): Promise<TeamMateLastResult> {
    return this.lastScoped(dispatcherPrincipal(dispatcherId), name, turns);
  }

  /**
   * Read a closed-or-live teammate's most recent settled turn(s) from the
   * per-name turns archive (issue #199 Slice 3). This is a pure read: it reads
   * the RECORD first (existence / scope / common fields), then folds
   * `turns/<name>.jsonl` — it NEVER starts, resumes, or requires a live runtime,
   * so it works after a teammate is closed or stopped. `turns` defaults to 1 and
   * is clamped-by-rejection to 1..5; the newest turn is `turns.at(-1)`. This is
   * the failed-completion-delivery fallback, so it returns the assistant output
   * as completely as it was durably captured (truncation is flagged).
   */
  async lastScoped(
    principal: TeamMateCallerPrincipal,
    name: string,
    turns?: number,
  ): Promise<TeamMateLastResult> {
    const requestedTurns = validateLastTurns(turns);
    const dispatcherId = principalDispatcherId(principal);
    const identity = await this.mustIdentity(
      dispatcherId,
      validateTeamMateName(name),
      principal,
    );
    const teammate = this.toStatus(
      identity,
      this.live.get(liveKey(dispatcherId, identity.name))?.runtime ?? null,
    );
    // Fold the turns archive in file APPEND ORDER — the only correct turn
    // ordering, since `timestamp` is `Date.now()` (a wall clock that can collide
    // within a millisecond or move backwards on an NTP step) and must NOT be used
    // to order or pick the latest turn. The fold is
    // BOUNDED: only the most recent `requestedTurns` settled turns retain their
    // (possibly 160k-char) assistant text, so memory does not grow with session
    // length. `firstSeq` records each turn's first-seen (submit) order so a turn
    // is ranked by when it STARTED, not by when a (possibly duplicate) settle was
    // written; it holds only short turn ids, never assistant text.
    let nextSeq = 0;
    const firstSeq = new Map<string, number>();
    const seqOf = (turnId: string): number => {
      const existing = firstSeq.get(turnId);
      if (existing !== undefined) return existing;
      const seq = nextSeq;
      nextSeq += 1;
      firstSeq.set(turnId, seq);
      return seq;
    };
    // Submit metadata (prompt/intent/origin) for turns not yet paired with a
    // settle; dropped once paired, so it stays small.
    const submitMeta = new Map<
      string,
      Pick<TeamMateLastTurn, 'turn_origin' | 'prompt_preview' | 'intent' | 'submitted_at'>
    >();
    // The bounded window of settled turns, keyed by turn id; size <= requestedTurns.
    const recent = new Map<string, TeamMateLastTurn>();
    for await (const event of this.turnsStore.stream(dispatcherId, identity.name)) {
      const turnId = event.turn_id;
      if (turnId === null) continue;
      seqOf(turnId);
      if (event.type === 'submit') {
        submitMeta.set(turnId, {
          turn_origin: event.turn_origin,
          prompt_preview: event.prompt_preview,
          intent: event.intent,
          submitted_at: event.timestamp,
        });
        continue;
      }
      if (event.type !== 'settled') continue;
      const present = recent.get(turnId);
      if (present !== undefined) {
        // Duplicate/re-settle of a turn still in the window: override the settle
        // fields in append order, keeping its already-paired submit fields.
        present.settle_status = event.settle_status;
        present.assistant = event.assistant;
        present.assistant_preview = event.assistant_preview;
        present.assistant_truncated = event.assistant_truncated;
        present.settled_at = event.timestamp;
        continue;
      }
      const submit = submitMeta.get(turnId);
      submitMeta.delete(turnId);
      recent.set(turnId, {
        turn_id: turnId,
        turn_origin: submit?.turn_origin ?? null,
        prompt_preview: submit?.prompt_preview ?? null,
        intent: submit?.intent ?? null,
        submitted_at: submit?.submitted_at ?? null,
        settled_at: event.timestamp,
        settle_status: event.settle_status,
        assistant: event.assistant,
        assistant_preview: event.assistant_preview,
        assistant_truncated: event.assistant_truncated,
      });
      if (recent.size > requestedTurns) {
        // Evict the oldest-by-first-seen turn so the window holds the most recent
        // `requestedTurns` turns by START order (a late re-settle of an already
        // evicted, older turn is evicted again here rather than resurfacing).
        let evictId: string | undefined;
        let evictSeq = Infinity;
        for (const id of recent.keys()) {
          const seq = firstSeq.get(id) ?? Infinity;
          if (seq < evictSeq) {
            evictSeq = seq;
            evictId = id;
          }
        }
        if (evictId !== undefined) recent.delete(evictId);
      }
    }
    // `last` is the completion fallback, so it returns SETTLED turns (those with
    // a durable assistant output), ordered oldest-first by start order.
    const lastTurns = [...recent.values()].sort(
      (a, b) => (firstSeq.get(a.turn_id) ?? 0) - (firstSeq.get(b.turn_id) ?? 0),
    );
    return {
      teammate,
      requested_turns: requestedTurns,
      returned_turns: lastTurns.length,
      turns: lastTurns,
    };
  }

  async channelInputScoped(
    principal: TeamMateCallerPrincipal,
    name: string,
    input: import('../../agent-runtime/turn.js').InboundTurnInput,
  ): Promise<AgentRuntimeTurnResult> {
    const dispatcherId = principalDispatcherId(principal);
    const live = await this.ensureRuntime(dispatcherId, name, {
      principal,
      reopenClosed: true,
    });
    const result = await live.runtime.channelInput(input);
    if (result.status === 'submitted') {
      recordTurnOrigin(live, result.turnId, 'channel');
      // Capture the channel-origin turn (issue #182 PR-5, PR #187 review P1): a
      // TeamLeader's normal user turns arrive through a bound Team channel here,
      // not via send, and would otherwise be missing from the turns archive.
      await this.recordSubmittedTurn(dispatcherId, live, {
        turnId: result.turnId,
        turnOrigin: 'channel',
        prompt: input.text,
      });
    }
    return result;
  }

  async createTeamLeader(input: CreateTeamLeaderInput): Promise<TeamMateSpawnResult> {
    const name = validateTeamMateName(input.name);
    // #188: a concrete name is never reused — the duplicate check includes closed
    // identities. The caller (TeamService) always passes a freshly allocated `tl-`
    // name, so a pre-existing identity under this name (closed OR live) means a
    // collision or a misuse of this seam; fail loud rather than rebinding the
    // name to a new session (which would map one concrete name to >1 session).
    const existing = await this.identities.get(input.dispatcherId, name);
    if (existing !== null) {
      throw new Error(`TeamLeader ${JSON.stringify(name)} already exists`);
    }
    const agent = this.resolveAgent(input.dispatcherId, input.agentRuntime);
    const provider = this.opts.agentRuntimeProviders.resolve(agent.provider);
    const owner: TeamMateIdentity['owner'] = {
      kind: 'dispatcher',
      dispatcher_id: input.dispatcherId,
    };
    // #199 Slice 3: session_id is the runtime-native thread id, set when the
    // runtime reports one. The name is freshly allocated — always a create.
    let identity = await this.identities.create({
      dispatcherId: input.dispatcherId,
      name,
      owner,
      role: 'team_leader',
      teamId: input.teamId,
      agentRuntime: input.agentRuntime,
      sourceCwd: input.sourceCwd,
      sourceRepo: input.sourceRepo,
      cwd: input.runtimeCwd,
      runtimeCwd: input.runtimeCwd,
      worktree: input.worktree,
      intent: input.intent ?? null,
      status: 'starting',
    });
    const live = await this.startRuntime(input.dispatcherId, identity, provider, agent);
    identity = live.state.current();
    // The TeamLeader is not reachable through the public dispatcher principal
    // (issue #199 Slice 4); the bootstrap turn submits under the internal
    // Team-service authority over this leader.
    const turn = await this.submitPrompt(input.dispatcherId, name, input.prompt, {
      principal: teamServicePrincipal({
        dispatcherId: input.dispatcherId,
        teamId: input.teamId,
        leaderName: name,
      }),
    });
    await this.recordSubmittedTurn(input.dispatcherId, live, {
      turnId: turn.turn_id ?? null,
      turnOrigin: 'dispatcher',
      prompt: input.prompt,
    });
    return { teammate: this.toStatus(live.state.current(), live.runtime), turn };
  }

  getCapabilities(): TeamMateCapabilities {
    return {
      verbs: [
        'spawn',
        'send',
        'close',
        'history',
        'list',
        'status',
        'last',
        'get_capabilities',
      ],
      agent_runtimes: Object.entries(this.opts.config.agents).map(
        ([agentRuntimeId, agent]) =>
          this.agentRuntimeCapability(agentRuntimeId, agent),
      ),
    };
  }

  async stopAll(): Promise<void> {
    for (const [key, live] of this.live) {
      await live.runtime.stop();
      this.live.delete(key);
    }
  }

  getLiveRuntime(dispatcherId: string, name: string): AgentRuntime | null {
    return this.live.get(liveKey(dispatcherId, validateTeamMateName(name)))?.runtime ?? null;
  }

  private async ensureRuntime(
    dispatcherId: string,
    name: string,
    opts: { principal?: TeamMateCallerPrincipal; reopenClosed?: boolean } = {},
  ): Promise<LiveTeamMate> {
    const teammateName = validateTeamMateName(name);
    const key = liveKey(dispatcherId, teammateName);
    const existing = this.live.get(key);
    if (existing !== undefined) {
      this.assertPrincipalCanAccess(
        opts.principal ?? dispatcherPrincipal(dispatcherId),
        existing.state.current(),
      );
      return existing;
    }
    let identity = await this.mustIdentity(
      dispatcherId,
      teammateName,
      opts.principal ?? dispatcherPrincipal(dispatcherId),
    );
    if (identity.status === 'closed') {
      // Only send reopens a closed teammate (issue #155): clear the closed
      // markers and revive from the persisted checkpoint. `checkpoint` is left
      // intact — it is what distinguishes a reopen (resumes prior context) from
      // a fresh spawn (which nulls it). Read-only verbs pass no flag and still
      // fail-loud on a closed teammate.
      if (opts.reopenClosed !== true) {
        throw new Error(`TeamMate ${JSON.stringify(teammateName)} is closed`);
      }
      identity = await this.reprepareDeletedManagedWorktree(identity);
      identity = await this.identities.update(identity, {
        status: 'starting',
        closedAt: null,
        closeNote: null,
        lastError: null,
      });
    }
    // Re-resolve the persisted agent id against the live agents map: an agent
    // removed from config since spawn fails loud here rather than silently
    // defaulting to some other runtime.
    const agent = this.resolveAgent(dispatcherId, identity.agent_runtime);
    const provider = this.opts.agentRuntimeProviders.resolve(agent.provider);
    return this.startRuntime(dispatcherId, identity, provider, agent);
  }

  private async reprepareDeletedManagedWorktree(
    identity: TeamMateIdentity,
  ): Promise<TeamMateIdentity> {
    if (
      identity.worktree.mode !== 'managed' ||
      identity.worktree.cleanup_state !== 'deleted'
    ) {
      return identity;
    }
    const workspace = await this.worktrees.prepare({
      dispatcherId: identity.dispatcher_id,
      teammateName: identity.name,
      cwd: identity.source_cwd,
      dispatcherWorkspace: await this.dispatcherWorkspace(identity.dispatcher_id),
      request: {
        mode: 'managed',
        ...(identity.worktree.slug !== null ? { slug: identity.worktree.slug } : {}),
        ...(identity.worktree.base_ref !== null
          ? { base_ref: identity.worktree.base_ref }
          : {}),
        ...(identity.worktree.branch !== null ? { branch: identity.worktree.branch } : {}),
        cleanup: identity.worktree.cleanup,
      },
    });
    await this.assertManagedWorktreeAvailable(
      identity.dispatcher_id,
      identity.name,
      workspace.worktree,
    );
    return this.identities.update(identity, {
      sourceCwd: workspace.sourceCwd,
      sourceRepo: workspace.sourceRepo,
      cwd: workspace.runtimeCwd,
      runtimeCwd: workspace.runtimeCwd,
      worktree: workspace.worktree,
    });
  }

  private async startRuntime(
    dispatcherId: string,
    identity: TeamMateIdentity,
    provider: AgentRuntimeProvider,
    agent: ResolvedAgentConfig,
  ): Promise<LiveTeamMate> {
    const resumeCapability = provider.getCapabilities().resume;
    const state = new TeamMateRuntimeStateStore(this.identities, identity);
    const row = this.runtimeRow(identity);
    const onTeamMateCompletion = this.opts.onTeamMateCompletion;
    // Bound late so the settle handler closes over the runtime instance directly
    // rather than re-reading the live map: close() deletes the live entry right
    // after stop() fires its terminal `stopped` settles, which would otherwise
    // race the lookup. The origin map is closed over for the same reason.
    let liveRuntime: AgentRuntime | null = null;
    const turnOrigins = new Map<string, TeamMateTurnOrigin>();
    // The teammate's runtime config comes from its own resolved agent (the
    // agents[].id it was spawned with), never inherited from the dispatcher.
    // Hand the provider a create-context dispatcher whose `runtime` is the
    // resolved agent's { provider, config }: a teammate on a different provider
    // than its dispatcher (e.g. a claude teammate under a codex dispatcher) gets
    // its OWN typed config, which structurally removes the cross-provider
    // "is not wired to ..." mismatch. Other dispatcher fields (id, cwd, channels)
    // come from the real dispatcher config when present.
    const dispatcherCfg = this.dispatcherConfig(dispatcherId);
    const createContextDispatcher: DispatcherConfig = {
      ...(dispatcherCfg ?? syntheticDispatcherConfig(dispatcherId)),
      agentRuntime: identity.agent_runtime,
      runtime: { provider: agent.provider, config: agent.config },
    };
    const runtime = provider.createRuntime({
      row,
      dispatcher: createContextDispatcher,
      dispatchers: this.opts.dispatchers,
      cwd: identity.cwd,
      state,
      paths: this.runtimePaths(identity, provider.ref),
      mcpServers: [
        ...(this.opts.mcpServersForTeamMate?.({
          dispatcherId,
          name: identity.name,
          identity,
        }) ?? []),
      ],
      // Attach the settle hook only when a sink is wired (the dispatcher's own
      // runtime never gets one, so it cannot self-deliver). The handler runs off
      // the synchronous callback and isolates every error so a delivery failure
      // can never crash the teammate runtime or the settle path.
      ...(onTeamMateCompletion !== undefined
        ? {
            onTurnSettled: (settled: TurnSettledSignal): void => {
              const settledRuntime = liveRuntime;
              if (settledRuntime === null) return;
              void this.deliverTurnSettled(
                dispatcherId,
                identity.name,
                identity,
                state,
                settledRuntime,
                settled,
                turnOrigins,
                onTeamMateCompletion,
              );
            },
          }
        : {}),
      log: (level, message, err) =>
        this.opts.log[level](
          {
            dispatcher_id: dispatcherId,
            teammate: identity.name,
            ...(err !== undefined ? { err: errInfo(err) } : {}),
          },
          message,
        ),
    });
    liveRuntime = runtime;
    // #199 Slice 3: rebuild the resume checkpoint from the persisted
    // runtime-native session_id (thread id) plus the runtime's OWN declared
    // checkpoint kind — the kind is never persisted as a durable concept.
    if (identity.session_id !== null && resumeCapability.supported) {
      await runtime.resume({
        checkpoint: { kind: resumeCapability.checkpoint, id: identity.session_id },
      });
    } else {
      await runtime.start();
    }
    const live = { runtime, state, turnOrigins };
    this.live.set(liveKey(dispatcherId, identity.name), live);
    return live;
  }

  private async submitPrompt(
    dispatcherId: string,
    name: string,
    prompt: string,
    opts: { principal?: TeamMateCallerPrincipal } = {},
  ): Promise<TeamMateTurnResult> {
    const live = await this.ensureRuntime(dispatcherId, name, opts);
    const submissionSeq = ++this.submissionSeq;
    const result = await live.runtime.channelInput({
      sourceId: `teammate:${name}:${submissionSeq}`,
      text: prompt,
    });
    if (result.status === 'submitted') {
      recordTurnOrigin(live, result.turnId, principalTurnOrigin(opts.principal));
    }
    return toTurnResult(result);
  }

  /**
   * Seam ② of the reverse-delivery path (issue #147): turn a settled teammate
   * turn into a {@link CompletionEnvelope} and hand it to the sink. Reads the
   * teammate's final assistant-visible result via `getLast`. The settle status
   * (completed/failed/stopped) passes through to the envelope verbatim, so a
   * torn-down teammate surfaces with its real status, never silently vanishing
   * and never mislabeled. Reverse
   * delivery requires a stable non-null turn id because the completion id is the
   * idempotency key; builtin runtimes only settle accepted turns after they have
   * a turn id. The settled turn's recorded submission origin rides along so the
   * sink can route per turn (channel-origin TeamLeader turns stay pull-only).
   * Every step is error-isolated: this runs `void`-ed off the
   * synchronous settle callback, so any escape would become an unhandled
   * rejection.
   */
  private async deliverTurnSettled(
    dispatcherId: string,
    name: string,
    identity: TeamMateIdentity,
    state: TeamMateRuntimeStateStore,
    runtime: AgentRuntime,
    settled: TurnSettledSignal,
    turnOrigins: ReadonlyMap<string, TeamMateTurnOrigin>,
    sink: NonNullable<TeamMateAgentServiceOptions['onTeamMateCompletion']>,
  ): Promise<void> {
    try {
      if (settled.turnId === null) {
        this.opts.log.warn(
          {
            dispatcher_id: dispatcherId,
            teammate: name,
            status: settled.status,
          },
          'dropping teammate completion: settled turn has no turn id',
        );
        return;
      }
      let result = '';
      try {
        const last = await runtime.getLast();
        result = last?.text ?? '';
      } catch (err) {
        this.opts.log.warn(
          { dispatcher_id: dispatcherId, teammate: name, err: errInfo(err) },
          'teammate completion getLast failed',
        );
      }
      const envelope: CompletionEnvelope = {
        source: name,
        id: `${name}:${settled.turnId}`,
        // Pass the settle status through verbatim — completed/failed/stopped are
        // the CompletionEnvelope statuses too. (Previously stopped was folded
        // into failed; the runtimes now render a distinct "was stopped" line.)
        status: settled.status,
        result,
      };
      // Attempt reverse delivery first (unchanged timing), but isolate its
      // failure so it never skips the durable settled-turn capture below — a
      // failed delivery is exactly when the recovery metadata matters most
      // (issue #182 PR-5, PR #187 review P2).
      try {
        await sink(
          dispatcherId,
          identity,
          envelope,
          turnOrigins.get(settled.turnId) ?? null,
        );
      } catch (err) {
        this.opts.log.warn(
          { dispatcher_id: dispatcherId, teammate: name, err: errInfo(err) },
          'teammate completion delivery failed',
        );
      }
      // Capture the settled turn in the per-name turns archive AFTER the
      // delivery attempt — regardless of its outcome — so capture never perturbs
      // reverse-delivery timing. The record's rolling summary is bumped through
      // the live state so its snapshot stays canonical (issue #199 Slice 3).
      await this.recordSettledTurn(dispatcherId, name, state, {
        turnId: settled.turnId,
        assistant: result,
        settleStatus: settled.status,
      });
    } catch (err) {
      this.opts.log.warn(
        { dispatcher_id: dispatcherId, teammate: name, err: errInfo(err) },
        'teammate settled-turn capture failed',
      );
    }
  }

  /**
   * The scoped single-read chokepoint (issue #199 Slice 4): the only place a
   * record is read by name for the `teammate.*` surface (status / last / send /
   * close all resolve their target here). An out-of-scope record reports the
   * same "does not exist" as a missing one, so visibility never leaks through an
   * existence oracle.
   */
  private async mustIdentity(
    dispatcherId: string,
    name: string,
    principal: TeamMateCallerPrincipal = dispatcherPrincipal(dispatcherId),
  ): Promise<TeamMateIdentity> {
    const identity = await this.identities.get(dispatcherId, name);
    if (identity === null) {
      throw new Error(`TeamMate ${JSON.stringify(name)} does not exist`);
    }
    this.assertPrincipalCanAccess(principal, identity);
    return identity;
  }

  private assertPrincipalCanAccess(
    principal: TeamMateCallerPrincipal,
    identity: TeamMateIdentity,
  ): void {
    if (principalCanAccess(principal, identity)) return;
    throw new Error(`TeamMate ${JSON.stringify(identity.name)} does not exist`);
  }

  private runtimeRow(identity: TeamMateIdentity): DispatcherRow {
    const runtimeIdentity = runtimeIdentityName(identity);
    return {
      dispatcher_id: runtimeId(identity.dispatcher_id, runtimeIdentity),
      bot_app_id: `teammate-${runtimeIdentity}`,
      bot_secret_ref: '',
      thread_id: identity.session_id,
      status: 'declared',
      enabled: 1,
      created_at: identity.created_at,
      updated_at: identity.updated_at,
      last_started_at: null,
      last_ready_at: null,
      last_error: identity.last_error,
      last_lost_thread_id: null,
    };
  }

  /**
   * Per-teammate path context. The teammate runtime dir is the neutral root a
   * runtime derives its state files from (Claude Code `mcp.json`; Codex keeps
   * no per-teammate state files — its rendezvous socket is allocated per start
   * under the private runtime-socket root, issue #182); only the central-tree
   * log files vary by runtime, so the launcher selects them from the resolved
   * provider ref.
   */
  private runtimePaths(
    identity: TeamMateIdentity,
    providerRef: string,
  ): AgentRuntimePathContext {
    const runtimeIdentity = runtimeIdentityName(identity);
    const dispatcherDir = (): string =>
      dispatcherTeamMateRuntimeDir(identity.dispatcher_id, runtimeIdentity);
    // Completion spill belongs to the OPERATOR dispatcher's cache, not the
    // teammate's composite runtime id, so it groups with the rest of that
    // dispatcher's ephemera (issue #182 PR-2).
    const completionSpillDir = (): string =>
      dispatcherCompletionSpillDir(identity.dispatcher_id);
    if (providerRef === BUILTIN_CLAUDE_CODE_PROVIDER_REF) {
      const streamLog = (): string =>
        teammateClaudeCodeStreamLogPath(
          identity.dispatcher_id,
          runtimeIdentity,
        );
      return {
        dispatcherDir,
        stdoutLogPath: streamLog,
        stderrLogPath: streamLog,
        completionSpillDir,
      };
    }
    return {
      dispatcherDir,
      stdoutLogPath: () =>
        teammateCodexAppServerLogPath(
          identity.dispatcher_id,
          runtimeIdentity,
        ),
      stderrLogPath: () =>
        teammateCodexAppServerErrorLogPath(
          identity.dispatcher_id,
          runtimeIdentity,
        ),
      completionSpillDir,
    };
  }

  /**
   * The agents[].id a teammate inherits when `spawn` names none: the
   * dispatcher's own `agentRuntime`. There is no provider-ref fallback — a
   * teammate always resolves to a named agent, never a bare provider.
   */
  private defaultAgentRuntime(dispatcherId: string): string {
    const dispatcherCfg = this.dispatcherConfig(dispatcherId);
    if (dispatcherCfg === null) {
      throw new Error(
        `cannot spawn a teammate for unknown dispatcher '${dispatcherId}': ` +
          'no dispatcher config to resolve a default agentRuntime from. Pass an ' +
          'explicit agentRuntime (an agents[].id).',
      );
    }
    return dispatcherCfg.agentRuntime;
  }

  /**
   * Resolve an agents[].id against the live agents map into its
   * { provider, config }. #98 fail-loud: an id with no matching agents[] entry
   * (e.g. removed from config since the teammate was spawned) throws with
   * rebuild guidance rather than silently defaulting a runtime.
   */
  private resolveAgent(
    dispatcherId: string,
    agentRuntimeId: string,
  ): ResolvedAgentConfig {
    const agent = this.opts.config.agents[agentRuntimeId];
    if (agent === undefined) {
      const known = Object.keys(this.opts.config.agents);
      const knownHint =
        known.length > 0
          ? `Known agents: ${known.map((id) => `'${id}'`).join(', ')}.`
          : 'No agents are declared.';
      throw new Error(
        `teammate for dispatcher '${dispatcherId}' references agentRuntime ` +
          `'${agentRuntimeId}', which matches no agents[].id. ${knownHint} ` +
          'Add the agent to config and rebuild, or respawn the teammate with a ' +
          'known agent id.',
      );
    }
    return agent;
  }

  private dispatcherConfig(dispatcherId: string): DispatcherConfig | null {
    return (
      this.opts.config.dispatchers.find((entry) => entry.id === dispatcherId) ??
      null
    );
  }

  /**
   * Resolve and validate the dispatcher workspace cwd (issue #182 PR-4): the
   * root under which managed worktrees are placed. Fails loud when the
   * dispatcher declares no explicit `cwd` — there is no state-dir fallback.
   * Exposed so the Team service (which owns its own WorktreeManager) resolves
   * the same workspace.
   */
  async dispatcherWorkspace(dispatcherId: string): Promise<string> {
    return ensureDispatcherWorkspace(this.opts.config, dispatcherId);
  }

  private toStatus(
    identity: TeamMateIdentity,
    runtime: AgentRuntime | null,
  ): TeamMateRuntimeStatus {
    return {
      name: identity.name,
      // #199 Slice 3: session_id is the runtime-native thread id, persisted
      // directly. Null until the runtime reports one.
      session_id: identity.session_id,
      owner: identity.owner,
      agent_runtime: identity.agent_runtime,
      repo: {
        mode: identity.worktree.mode,
        path: identity.runtime_cwd,
        source_repo: identity.source_repo,
        branch: identity.worktree.branch,
        base_ref: identity.worktree.base_ref,
        cleanup: identity.worktree.cleanup,
        cleanup_state: identity.worktree.cleanup_state,
      },
      intent: identity.intent,
      status: identity.status,
      runtime_status: runtime?.getStatus() ?? null,
      last_error: identity.last_error,
      closed_at: identity.closed_at,
      close_note: identity.close_note,
    };
  }

  /**
   * Build one recovery row for a teammate (issue #199 Slice 3). All recovery
   * facts — turn count, last-seen, prompt/assistant previews — are read from the
   * per-name RECORD's rolling summary; `history` no longer folds the turns
   * archive. Live-only facts (runtime status) come from the live map.
   */
  private toRecordRow(identity: TeamMateIdentity): TeamMateRecordRow {
    const runtime = this.live.get(liveKey(identity.dispatcher_id, identity.name))?.runtime ?? null;
    return {
      name: identity.name,
      turn_count: identity.turn_count,
      owner: identity.owner,
      agent_runtime: identity.agent_runtime,
      source_repo: identity.source_repo,
      created_at: identity.created_at,
      updated_at: identity.updated_at,
      last_seen_at: identity.last_seen_at,
      status: identity.status,
      runtime_status: runtime?.getStatus() ?? null,
      intent: identity.intent,
      closed_at: identity.closed_at,
      close_note: identity.close_note,
      close_note_preview:
        identity.close_note !== null ? previewText(identity.close_note) : null,
      last_prompt_preview: identity.last_prompt_preview,
      last_assistant_preview: identity.last_assistant_preview,
      cleanup_state: identity.worktree.cleanup_state,
      // A teammate is reopenable while open, or once it has a runtime-native
      // session id to resume from after close.
      resume:
        identity.closed_at === null || identity.session_id !== null
          ? { tool: 'send', name: identity.name }
          : null,
    };
  }

  private matchesRecordQuery(
    row: TeamMateRecordRow,
    input: Omit<TeamMateHistoryQuery, 'dispatcherId' | 'principal'>,
  ): boolean {
    if (input.name !== undefined && row.name !== validateTeamMateName(input.name)) {
      return false;
    }
    if (input.status !== undefined && row.status !== input.status) return false;
    if (
      input.agentRuntime !== undefined &&
      row.agent_runtime !== input.agentRuntime
    ) {
      return false;
    }
    if (input.repo !== undefined) {
      const needle = input.repo.toLowerCase();
      const hit =
        row.source_repo !== null && row.source_repo.toLowerCase().includes(needle);
      if (!hit) return false;
    }
    if (input.grep !== undefined && !recordRowMatchesText(row, input.grep)) {
      return false;
    }
    if (input.since !== undefined && row.last_seen_at < input.since) return false;
    if (input.until !== undefined && row.last_seen_at > input.until) return false;
    return true;
  }

  private async assertManagedWorktreeAvailable(
    dispatcherId: string,
    name: string,
    worktree: TeamMateIdentity['worktree'],
  ): Promise<void> {
    if (worktree.mode !== 'managed') return;
    const identities = await this.identities.list(dispatcherId);
    const collision = identities.find(
      (identity) =>
        identity.name !== name &&
        identity.worktree.mode === 'managed' &&
        identity.worktree.path === worktree.path,
    );
    if (collision !== undefined) {
      throw new Error(
        `managed worktree path ${JSON.stringify(worktree.path)} is already ` +
          `owned by TeamMate ${JSON.stringify(collision.name)}`,
      );
    }
  }

  private agentRuntimeCapability(
    agentRuntimeId: string,
    agent: ResolvedAgentConfig,
  ): TeamMateAgentRuntimeCapability {
    let capabilities: AgentRuntimeCapabilities | null = null;
    let unsupportedReason: string | null = null;
    try {
      capabilities = this.opts.agentRuntimeProviders
        .resolve(agent.provider)
        .getCapabilities();
    } catch (err) {
      unsupportedReason = err instanceof Error ? err.message : String(err);
    }
    return {
      id: agentRuntimeId,
      spawn: { agent_runtime: agentRuntimeId },
      runtime_available: capabilities !== null,
      resume: capabilities?.resume ?? { supported: false },
      steer: capabilities?.steer ?? { supported: false },
      events: capabilities?.events ?? { kind: 'synthesized' },
      last: capabilities?.last ?? { supported: false },
      context: capabilities?.context ?? { supported: false },
      unsupported_reason: unsupportedReason,
    };
  }
}

/**
 * A minimal {@link DispatcherConfig} skeleton for the create-context when no
 * matching dispatcher config exists (the teammate was spawned for an id with no
 * declared dispatcher). The runtime block is overwritten by the caller with the
 * teammate's resolved agent; only the neutral fields matter here.
 */
function syntheticDispatcherConfig(dispatcherId: string): DispatcherConfig {
  return {
    id: dispatcherId,
    cwd: null,
    enabled: true,
    channels: [],
    agentRuntime: '',
    runtime: { provider: '', config: {} },
  };
}

function toTurnResult(result: AgentRuntimeTurnResult): TeamMateTurnResult {
  switch (result.status) {
    case 'submitted':
      return { status: 'submitted', turn_id: result.turnId };
    case 'duplicate':
    case 'stopped':
      return { status: result.status };
    case 'failed':
      return { status: 'failed', error: result.error.message };
    case 'skipped':
      return { status: 'stopped', error: 'turn skipped' };
  }
}

/**
 * The completion origin a submitting principal implies: a TeamLeader-submitted
 * turn (member spawn/send) answers to that leader; everything else — including
 * the principal-less `createTeamLeader` bootstrap prompt — answers to the
 * dispatcher. Channel-delivered turns never come through here; they are
 * recorded as `channel` at the `channelInputScoped` seam.
 */
function principalTurnOrigin(
  principal: TeamMateCallerPrincipal | undefined,
): TeamMateTurnOrigin {
  return principal?.kind === 'team_leader' ? 'team_leader' : 'dispatcher';
}

function recordTurnOrigin(
  live: LiveTeamMate,
  turnId: string,
  origin: TeamMateTurnOrigin,
): void {
  // First-writer-wins: a send steered into an already-active turn must not
  // re-target the completion of the turn that absorbed it.
  if (live.turnOrigins.has(turnId)) return;
  live.turnOrigins.set(turnId, origin);
  while (live.turnOrigins.size > TURN_ORIGIN_CACHE_LIMIT) {
    const oldest = live.turnOrigins.keys().next().value;
    if (oldest === undefined) break;
    live.turnOrigins.delete(oldest);
  }
}

function ownerForPrincipal(principal: TeamMateCallerPrincipal): TeamMateIdentity['owner'] {
  if (principal.kind === 'team_leader') {
    return {
      kind: 'team',
      dispatcher_id: principal.dispatcherId,
      team_id: principal.teamId,
      leader_name: principal.leaderName,
    };
  }
  return { kind: 'dispatcher', dispatcher_id: principal.dispatcherId };
}

/**
 * The single visibility predicate for the `teammate.*` surface (issue #199
 * Slice 4). Every scoped read enforces it through exactly one of two
 * chokepoints — {@link TeamMateAgentService.scopedList} for list reads and
 * {@link TeamMateAgentService.mustIdentity} for single reads — so the rules
 * below are applied consistently and cannot be bypassed by a new read site.
 *
 * - A dispatcher sees only the ordinary TeamMates it directly spawned: a
 *   dispatcher-owned record with `role === 'teammate'`. A TeamLeader is also
 *   dispatcher-owned (its `owner.kind` is `dispatcher`), so `role` is what
 *   keeps a leader — and every Team member — out of the dispatcher's view; the
 *   dispatcher inspects Teams through the `team.*` surface instead.
 * - A TeamLeader sees only the members of its own Team.
 * - An ordinary TeamMate sees nothing (it cannot read peers).
 */
function principalCanAccess(
  principal: TeamMateCallerPrincipal,
  identity: TeamMateIdentity,
): boolean {
  if (principal.kind === 'dispatcher') {
    return (
      identity.dispatcher_id === principal.dispatcherId &&
      identity.owner.kind === 'dispatcher' &&
      identity.role === 'teammate'
    );
  }
  if (principal.kind === 'team_leader') {
    return (
      identity.dispatcher_id === principal.dispatcherId &&
      identity.owner.kind === 'team' &&
      identity.owner.team_id === principal.teamId &&
      identity.role === 'team_member'
    );
  }
  if (principal.kind === 'team_service') {
    // Internal Team-service authority: its own TeamLeader (by concrete name) plus
    // the members of its Team. Never derived from a public caller.
    if (identity.dispatcher_id !== principal.dispatcherId) return false;
    if (identity.role === 'team_leader') return identity.name === principal.leaderName;
    return (
      identity.owner.kind === 'team' &&
      identity.owner.team_id === principal.teamId &&
      identity.role === 'team_member'
    );
  }
  return false;
}

function clampHistoryLimit(input: number | undefined): number {
  if (input === undefined) return 20;
  if (!Number.isInteger(input) || input < 1) {
    throw new Error('history limit must be a positive integer');
  }
  return Math.min(input, 100);
}

const LAST_TURNS_DEFAULT = 1;
const LAST_TURNS_MAX = 5;

/**
 * Validate the `last` turn count (issue #188): default 1, integer in 1..5.
 * Out-of-range is rejected (fail loud) rather than silently clamped, so a
 * caller asking for 10 turns learns its request was invalid.
 */
function validateLastTurns(input: number | undefined): number {
  if (input === undefined) return LAST_TURNS_DEFAULT;
  if (!Number.isInteger(input) || input < 1 || input > LAST_TURNS_MAX) {
    throw new Error(`last turns must be an integer in 1..${LAST_TURNS_MAX}`);
  }
  return input;
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    if (
      typeof parsed['offset'] === 'number' &&
      Number.isInteger(parsed['offset']) &&
      parsed['offset'] >= 0
    ) {
      return parsed['offset'];
    }
  } catch {
    // fall through
  }
  throw new Error('invalid history cursor');
}

function recordRowMatchesText(row: TeamMateRecordRow, grep: string): boolean {
  const needle = grep.trim().toLowerCase();
  if (needle === '') return true;
  return [
    row.name,
    row.agent_runtime,
    row.source_repo,
    row.intent,
    row.close_note,
    row.last_prompt_preview,
    row.last_assistant_preview,
  ].some((value) => value !== null && value.toLowerCase().includes(needle));
}

function previewText(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= 500 ? collapsed : `${collapsed.slice(0, 497)}...`;
}

function liveKey(dispatcherId: string, name: string): string {
  return `${dispatcherId}\u0000${name}`;
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
  return identity.owner.kind === 'team'
    ? `${identity.owner.team_id}.${identity.name}`
    : identity.name;
}

function errInfo(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { type: err.name, message: err.message, stack: err.stack };
  }
  return { value: String(err) };
}
