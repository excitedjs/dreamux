import { createHash } from 'node:crypto';

import type {
  AgentRuntime,
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
  BUILTIN_CODEX_PROVIDER_REF,
  type DispatcherConfig,
  type DreamuxConfig,
} from '../../config/config.js';
import type { DispatcherStore, DispatcherRow } from '../../state/dispatcher-store.js';
import type { DreamuxLogger } from '../../platform/logger.js';
import { teammateClaudeCodeStreamLogPath } from '../../agent-runtime/builtin/claude-code/paths.js';
import {
  teammateCodexAppServerErrorLogPath,
  teammateCodexAppServerLogPath,
} from '../../agent-runtime/builtin/codex/paths.js';
import { dispatcherTeamMateRuntimeDir } from '../../platform/paths.js';
import { validateDispatcherId } from '../../state/dispatcher-id.js';
import { TeamMateIdentityStore } from './identity-store.js';
import { TeamMateRuntimeStateStore } from './runtime-state.js';
import {
  validateTeamMateName,
  type CloseTeamMateInput,
  type ResumeTeamMateInput,
  type SendTeamMateInput,
  type SpawnTeamMateInput,
  type TeamMateCapabilities,
  type TeamMateCloseResult,
  type TeamMateContextResult,
  type TeamMateHistoryResult,
  type TeamMateIdentity,
  type TeamMateLastResult,
  type TeamMateProviderCapability,
  type TeamMateResumeResult,
  type TeamMateRuntimeStatus,
  type TeamMateSendResult,
  type TeamMateSpawnResult,
  type TeamMateTurnResult,
} from './types.js';

interface LiveTeamMate {
  runtime: AgentRuntime;
  state: TeamMateRuntimeStateStore;
}

export interface TeamMateAgentServiceOptions {
  config: DreamuxConfig;
  dispatchers: DispatcherStore;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  mcpServersForTeamMate?: (input: {
    dispatcherId: string;
    name: string;
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
    completion: CompletionEnvelope,
  ) => void | Promise<void>;
  log: DreamuxLogger;
}

export class TeamMateAgentService {
  private readonly identities: TeamMateIdentityStore;
  private readonly live = new Map<string, LiveTeamMate>();

  constructor(private readonly opts: TeamMateAgentServiceOptions) {
    this.identities = new TeamMateIdentityStore({
      warn: (message, fields) => opts.log.warn(fields ?? {}, message),
    });
  }

  async spawn(input: SpawnTeamMateInput): Promise<TeamMateSpawnResult> {
    const name = validateTeamMateName(input.name);
    const existing = await this.identities.get(input.dispatcherId, name);
    if (existing !== null && existing.status !== 'closed') {
      throw new Error(`TeamMate ${JSON.stringify(name)} already exists; use send or resume`);
    }
    const providerRef = input.providerRef ?? this.defaultProviderRef(input.dispatcherId);
    const provider = this.opts.agentRuntimeProviders.resolve(providerRef);
    const cwd = this.resolveCwd(input.dispatcherId, input.cwd);
    let identity =
      existing ??
      (await this.identities.create({
        dispatcherId: input.dispatcherId,
        name,
        providerRef: provider.ref,
        cwd,
      }));
    identity = await this.identities.update(identity, {
      providerRef: provider.ref,
      cwd,
      status: 'starting',
      closedAt: null,
      closeNote: null,
      lastError: null,
      checkpoint: null,
    });
    const live = await this.startRuntime(input.dispatcherId, identity, provider);
    identity = live.state.current();
    const turn = await this.submitPrompt(input.dispatcherId, name, input.prompt);
    await this.identities.appendHistory(live.state.current(), {
      type: 'spawn',
      prompt: input.prompt,
      turnId: turn.turn_id ?? null,
    });
    return { teammate: this.toStatus(live.state.current(), live.runtime), turn };
  }

  async send(input: SendTeamMateInput): Promise<TeamMateSendResult> {
    const live = await this.ensureRuntime(input.dispatcherId, input.name);
    const turn = await this.submitPrompt(input.dispatcherId, input.name, input.prompt);
    await this.identities.appendHistory(live.state.current(), {
      type: 'send',
      prompt: input.prompt,
      turnId: turn.turn_id ?? null,
    });
    return { teammate: this.toStatus(live.state.current(), live.runtime), turn };
  }

  async resume(input: ResumeTeamMateInput): Promise<TeamMateResumeResult> {
    const live = await this.ensureRuntime(input.dispatcherId, input.name);
    await this.identities.appendHistory(live.state.current(), {
      type: 'resume',
      prompt: input.prompt ?? null,
    });
    let turn: TeamMateTurnResult | undefined;
    if (input.prompt !== undefined && input.prompt !== '') {
      turn = await this.submitPrompt(input.dispatcherId, input.name, input.prompt);
      await this.identities.appendHistory(live.state.current(), {
        type: 'send',
        prompt: input.prompt,
        turnId: turn.turn_id ?? null,
      });
    }
    return {
      teammate: this.toStatus(live.state.current(), live.runtime),
      ...(turn !== undefined ? { turn } : {}),
    };
  }

  async close(input: CloseTeamMateInput): Promise<TeamMateCloseResult> {
    const name = validateTeamMateName(input.name);
    const identity = await this.mustIdentity(input.dispatcherId, name);
    const key = liveKey(input.dispatcherId, name);
    const live = this.live.get(key);
    if (live !== undefined) {
      await live.runtime.stop();
      this.live.delete(key);
    }
    const closed = await this.identities.update(identity, {
      status: 'closed',
      closedAt: Date.now(),
      closeNote: input.note ?? null,
    });
    await this.identities.appendHistory(closed, {
      type: 'close',
      note: input.note ?? null,
    });
    return { teammate: this.toStatus(closed, null) };
  }

  async list(dispatcherId: string): Promise<TeamMateRuntimeStatus[]> {
    const identities = await this.identities.list(dispatcherId);
    return identities.map((identity) =>
      this.toStatus(identity, this.live.get(liveKey(dispatcherId, identity.name))?.runtime ?? null),
    );
  }

  async status(
    dispatcherId: string,
    name: string,
  ): Promise<TeamMateRuntimeStatus> {
    const identity = await this.mustIdentity(dispatcherId, validateTeamMateName(name));
    return this.toStatus(
      identity,
      this.live.get(liveKey(dispatcherId, identity.name))?.runtime ?? null,
    );
  }

  async history(
    dispatcherId: string,
    name: string,
  ): Promise<TeamMateHistoryResult> {
    const teammateName = validateTeamMateName(name);
    const identity = await this.identities.get(dispatcherId, teammateName);
    return {
      teammate:
        identity === null
          ? null
          : this.toStatus(
              identity,
              this.live.get(liveKey(dispatcherId, teammateName))?.runtime ?? null,
            ),
      events: await this.identities.history(dispatcherId, teammateName),
    };
  }

  async last(dispatcherId: string, name: string): Promise<TeamMateLastResult> {
    const live = await this.ensureRuntime(dispatcherId, name);
    return {
      teammate: this.toStatus(live.state.current(), live.runtime),
      last: await live.runtime.getLast(),
    };
  }

  async context(
    dispatcherId: string,
    name: string,
  ): Promise<TeamMateContextResult> {
    const live = await this.ensureRuntime(dispatcherId, name);
    return {
      teammate: this.toStatus(live.state.current(), live.runtime),
      context: await live.runtime.getContext(),
    };
  }

  getCapabilities(): TeamMateCapabilities {
    return {
      verbs: [
        'spawn',
        'send',
        'resume',
        'close',
        'history',
        'list',
        'status',
        'last',
        'ctx',
        'get_capabilities',
      ],
      providers: this.opts.agentRuntimeProviders
        .list()
        .map((provider) => this.providerCapability(provider)),
    };
  }

  async stopAll(): Promise<void> {
    for (const [key, live] of this.live) {
      await live.runtime.stop();
      this.live.delete(key);
    }
  }

  private async ensureRuntime(
    dispatcherId: string,
    name: string,
  ): Promise<LiveTeamMate> {
    const teammateName = validateTeamMateName(name);
    const key = liveKey(dispatcherId, teammateName);
    const existing = this.live.get(key);
    if (existing !== undefined) return existing;
    const identity = await this.mustIdentity(dispatcherId, teammateName);
    if (identity.status === 'closed') {
      throw new Error(`TeamMate ${JSON.stringify(teammateName)} is closed`);
    }
    const provider = this.opts.agentRuntimeProviders.resolve(identity.provider_ref);
    return this.startRuntime(dispatcherId, identity, provider);
  }

  private async startRuntime(
    dispatcherId: string,
    identity: TeamMateIdentity,
    provider: AgentRuntimeProvider,
  ): Promise<LiveTeamMate> {
    const resumeCapability = provider.getCapabilities().resume;
    const state = new TeamMateRuntimeStateStore(
      this.identities,
      identity,
      resumeCapability.supported ? resumeCapability.checkpoint : null,
    );
    const row = this.runtimeRow(identity);
    const onTeamMateCompletion = this.opts.onTeamMateCompletion;
    // Bound late so the settle handler closes over the runtime instance directly
    // rather than re-reading the live map: close() deletes the live entry right
    // after stop() fires its terminal `stopped` settles, which would otherwise
    // race the lookup.
    let liveRuntime: AgentRuntime | null = null;
    // Only inherit the dispatcher's runtime config when the teammate runs the
    // SAME provider. A teammate on a different provider (e.g. a claude-code
    // teammate under a codex dispatcher) must fall back to its provider's
    // defaults: the dispatcher's config block is the wrong shape, and the
    // provider's createRuntime would reject it ("... is not wired to ...").
    const dispatcherCfg = this.dispatcherConfig(dispatcherId);
    const inheritedConfig =
      dispatcherCfg !== null && dispatcherCfg.runtime.provider === provider.ref
        ? dispatcherCfg
        : null;
    const runtime = provider.createRuntime({
      row,
      dispatcher: inheritedConfig,
      dispatchers: this.opts.dispatchers,
      cwd: identity.cwd,
      state,
      paths: this.runtimePaths(identity, provider.ref),
      mcpServers: [
        ...(this.opts.mcpServersForTeamMate?.({
          dispatcherId,
          name: identity.name,
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
                settledRuntime,
                settled,
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
    if (identity.checkpoint !== null) {
      await runtime.resume({ checkpoint: identity.checkpoint });
    } else {
      await runtime.start();
    }
    const live = { runtime, state };
    this.live.set(liveKey(dispatcherId, identity.name), live);
    return live;
  }

  private async submitPrompt(
    dispatcherId: string,
    name: string,
    prompt: string,
  ): Promise<TeamMateTurnResult> {
    const live = await this.ensureRuntime(dispatcherId, name);
    const result = await live.runtime.channelInput({
      sourceId: `teammate:${name}:${Date.now()}`,
      text: prompt,
    });
    return toTurnResult(result);
  }

  /**
   * Seam ② of the reverse-delivery path (issue #147): turn a settled teammate
   * turn into a {@link CompletionEnvelope} and hand it to the sink. Reads the
   * teammate's final assistant-visible result via `getLast`. A `stopped` turn
   * maps to envelope status `failed` (the envelope carries only completed/failed)
   * so a torn-down teammate still surfaces, never silently vanishing. Every step
   * is error-isolated: this runs `void`-ed off the synchronous settle callback,
   * so any escape would become an unhandled rejection.
   */
  private async deliverTurnSettled(
    dispatcherId: string,
    name: string,
    runtime: AgentRuntime,
    settled: TurnSettledSignal,
    sink: NonNullable<TeamMateAgentServiceOptions['onTeamMateCompletion']>,
  ): Promise<void> {
    try {
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
        id: settled.turnId !== null ? `${name}:${settled.turnId}` : name,
        status: settled.status === 'completed' ? 'completed' : 'failed',
        result,
      };
      await sink(dispatcherId, envelope);
    } catch (err) {
      this.opts.log.warn(
        { dispatcher_id: dispatcherId, teammate: name, err: errInfo(err) },
        'teammate completion delivery failed',
      );
    }
  }

  private async mustIdentity(
    dispatcherId: string,
    name: string,
  ): Promise<TeamMateIdentity> {
    const identity = await this.identities.get(dispatcherId, name);
    if (identity === null) {
      throw new Error(`TeamMate ${JSON.stringify(name)} does not exist`);
    }
    return identity;
  }

  private runtimeRow(identity: TeamMateIdentity): DispatcherRow {
    return {
      dispatcher_id: runtimeId(identity.dispatcher_id, identity.name),
      bot_app_id: `teammate-${identity.name}`,
      bot_secret_ref: '',
      thread_id: identity.checkpoint?.id ?? null,
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
   * Per-teammate path context. The teammate runtime dir is the neutral root both
   * built-in runtimes derive their state files from (Codex `codex.sock`, Claude
   * Code `mcp.json`); only the central-tree log files vary by runtime, so the
   * launcher selects them from the resolved provider ref.
   */
  private runtimePaths(
    identity: TeamMateIdentity,
    providerRef: string,
  ): AgentRuntimePathContext {
    const dispatcherDir = (): string =>
      dispatcherTeamMateRuntimeDir(identity.dispatcher_id, identity.name);
    if (providerRef === BUILTIN_CLAUDE_CODE_PROVIDER_REF) {
      const streamLog = (): string =>
        teammateClaudeCodeStreamLogPath(
          identity.dispatcher_id,
          identity.name,
        );
      return {
        dispatcherDir,
        stdoutLogPath: streamLog,
        stderrLogPath: streamLog,
      };
    }
    return {
      dispatcherDir,
      stdoutLogPath: () =>
        teammateCodexAppServerLogPath(
          identity.dispatcher_id,
          identity.name,
        ),
      stderrLogPath: () =>
        teammateCodexAppServerErrorLogPath(
          identity.dispatcher_id,
          identity.name,
        ),
    };
  }

  private defaultProviderRef(dispatcherId: string): string {
    return (
      this.dispatcherConfig(dispatcherId)?.runtime.provider ??
      BUILTIN_CODEX_PROVIDER_REF
    );
  }

  private dispatcherConfig(dispatcherId: string): DispatcherConfig | null {
    return (
      this.opts.config.dispatchers.find((entry) => entry.id === dispatcherId) ??
      null
    );
  }

  private resolveCwd(dispatcherId: string, input: string | undefined): string {
    if (input !== undefined && input !== '') return input;
    return (
      this.dispatcherConfig(dispatcherId)?.cwd ??
      dispatcherTeamMateRuntimeDir(dispatcherId, 'default')
    );
  }

  private toStatus(
    identity: TeamMateIdentity,
    runtime: AgentRuntime | null,
  ): TeamMateRuntimeStatus {
    return {
      name: identity.name,
      provider_ref: identity.provider_ref,
      cwd: identity.cwd,
      status: identity.status,
      runtime_status: runtime?.getStatus() ?? null,
      checkpoint: identity.checkpoint,
      last_error: identity.last_error,
      closed_at: identity.closed_at,
      close_note: identity.close_note,
    };
  }

  private providerCapability(
    provider: AgentRuntimeProvider,
  ): TeamMateProviderCapability {
    const capabilities = provider.getCapabilities();
    return {
      provider_ref: provider.ref,
      runtime_available: true,
      resume: capabilities.resume,
      steer: capabilities.steer,
      events: capabilities.events,
      last: capabilities.last,
      context: capabilities.context,
      unsupported_reason: null,
    };
  }
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

function errInfo(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { type: err.name, message: err.message, stack: err.stack };
  }
  return { value: String(err) };
}
