import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type {
  AgentRuntime,
  AgentRuntimeCreateContext,
  AgentRuntimeMcpServer,
  AgentRuntimeResumeCheckpoint,
  AgentRuntimeStateCallbacks,
  AgentRuntimeStatus,
  AgentRuntimeTurnResult,
  ChannelInboundEnvelope,
  ChannelSession,
  DreamuxLogger,
  InboundDeliveryHooks,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';

import {
  channelTargetHostPaths,
  DISABLE_FEATURE_CRON,
  DISABLE_FEATURE_USER_INTERRUPT,
  HOST_INJECT_ENV,
  type AgentRuntimeProviderCatalog,
} from '../../agent-runtime/index.js';
import type { DreamuxConfig } from '../../config/config.js';
import {
  bundledDispatcherSkillRoot,
  dispatcherChannelTargetRuntimeStatusPath,
} from '../../platform/paths.js';
import { validateDispatcherId } from '../../state/dispatcher-id.js';
import {
  DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS,
  DREAMUX_DISPATCHER_BASE_INSTRUCTIONS,
} from './base-prompt.js';
import { dispatcherMcpServerDescriptors } from './mcp-descriptors.js';

interface ChannelTargetRuntimePoolOptions {
  dispatcherId: string;
  config: DreamuxConfig;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  adminSocketPath: string;
  log: DreamuxLogger;
  resolveCwd: () => string;
  liveChannels: () => Map<string, ChannelSession>;
}

interface ChannelTargetRuntimeKey {
  channelId: string;
  targetKey: string;
  targetKeyHash: string;
}

interface ChannelTargetRuntimeSlot {
  readonly key: ChannelTargetRuntimeKey;
  runtime: AgentRuntime | null;
  starting: Promise<AgentRuntime> | null;
}

interface ChannelTargetRuntimeStatusFile {
  version: 1;
  dispatcher_id: string;
  channel_id: string;
  target_key: string;
  thread_id: string | null;
  status: AgentRuntimeStatus;
  updated_at: number;
  last_started_at: number | null;
  last_ready_at: number | null;
  last_error: string | null;
  last_lost_thread_id: string | null;
}

/**
 * Dispatcher-owned runtime pool for unbound bindable channel targets.
 *
 * Team bindings still take precedence. When no Team owns a bindable target,
 * core runs that target in a target-scoped dispatcher runtime/checkpoint rather
 * than falling back to the dispatcher's global runtime. This is what makes a
 * Feishu topic target (provider target_key includes the thread id) receive a
 * stable context distinct from sibling topics in the same group chat.
 */
export class ChannelTargetRuntimePool {
  private readonly slots = new Map<string, ChannelTargetRuntimeSlot>();
  private readonly store: ChannelTargetRuntimeStore;

  constructor(private readonly options: ChannelTargetRuntimePoolOptions) {
    this.store = new ChannelTargetRuntimeStore({
      dispatcherId: options.dispatcherId,
      warn: (message) => options.log.warn({ dispatcher_id: options.dispatcherId }, message),
    });
  }

  async channelInput(input: {
    channelId: string;
    turn: InboundTurnInput;
    envelope: ChannelInboundEnvelope;
    hooks?: InboundDeliveryHooks;
  }): Promise<AgentRuntimeTurnResult> {
    const runtime = await this.ensureRuntime({
      channelId: input.channelId,
      targetKey: input.envelope.target.target_key,
    });
    return runtime.channelInput(input.turn, input.hooks);
  }

  async stopAll(): Promise<void> {
    const slots = Array.from(this.slots.values());
    this.slots.clear();
    await Promise.allSettled(
      slots.map(async (slot) => {
        const starting = slot.starting ?? Promise.resolve(null);
        const startedRuntime = await starting.catch(() => null);
        const runtime = slot.runtime ?? startedRuntime;
        if (runtime === null) return;
        await runtime.stop();
      }),
    );
  }

  private async ensureRuntime(input: {
    channelId: string;
    targetKey: string;
  }): Promise<AgentRuntime> {
    const key = makeRuntimeKey(input.channelId, input.targetKey);
    const slotId = `${key.channelId}:${key.targetKeyHash}`;
    let slot = this.slots.get(slotId);
    if (slot === undefined) {
      slot = { key, runtime: null, starting: null };
      this.slots.set(slotId, slot);
    }
    if (slot.runtime !== null) return slot.runtime;
    if (slot.starting !== null) return slot.starting;
    slot.starting = this.createAndStart(slot)
      .then((runtime) => {
        slot.runtime = runtime;
        return runtime;
      })
      .finally(() => {
        slot.starting = null;
      });
    return slot.starting;
  }

  private async createAndStart(
    slot: ChannelTargetRuntimeSlot,
  ): Promise<AgentRuntime> {
    const dispatcherConfig = this.options.config.dispatchers.find(
      (entry) => entry.id === this.options.dispatcherId,
    );
    if (dispatcherConfig === undefined) {
      throw new Error(`dispatcher '${this.options.dispatcherId}' has no config entry`);
    }
    const provider = this.options.agentRuntimeProviders.resolve(
      dispatcherConfig.runtime.provider,
    );
    const status = await this.store.read(slot.key);
    const checkpointId = status?.thread_id ?? null;
    const runtime = provider.createRuntime(
      this.runtimeContext({
        slot,
        checkpointId,
        config: dispatcherConfig.runtime.config,
      }),
    );
    const resumeCapability = provider.getCapabilities().resume;
    if (checkpointId !== null && resumeCapability.supported) {
      await runtime.resume();
    } else {
      await runtime.start();
    }
    return runtime;
  }

  private runtimeContext(input: {
    slot: ChannelTargetRuntimeSlot;
    checkpointId: string | null;
    config: unknown;
  }): AgentRuntimeCreateContext {
    const mcpServers: AgentRuntimeMcpServer[] = dispatcherMcpServerDescriptors({
      dispatcherId: this.options.dispatcherId,
      channels: this.options.liveChannels(),
      adminSocketPath: this.options.adminSocketPath,
    });
    const { slot, checkpointId } = input;
    return {
      identity: {
        runtime_id: channelTargetRuntimeId(
          this.options.dispatcherId,
          slot.key.targetKeyHash,
        ),
        checkpoint_id: checkpointId,
      },
      config: input.config,
      cwd: this.options.resolveCwd(),
      systemPrompt: {
        replace: DREAMUX_DISPATCHER_BASE_INSTRUCTIONS,
        append: [DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS],
      },
      mcpServers,
      skillSources: [{
        name: 'dispatcher',
        path: bundledDispatcherSkillRoot(),
        source: 'dreamux-core',
      }],
      disableFeatures: [
        DISABLE_FEATURE_CRON,
        DISABLE_FEATURE_USER_INTERRUPT,
      ],
      injectEnv: HOST_INJECT_ENV,
      state: this.store.bindRuntime(slot.key),
      paths: channelTargetHostPaths(
        this.options.dispatcherId,
        slot.key.channelId,
        slot.key.targetKeyHash,
      ),
      logger:
        this.options.log.child?.({
          dispatcher_id: this.options.dispatcherId,
          channel_id: slot.key.channelId,
          channel_target: slot.key.targetKeyHash,
        }) ?? this.options.log,
    };
  }
}

class ChannelTargetRuntimeStore {
  constructor(
    private readonly options: {
      dispatcherId: string;
      warn: (message: string) => void;
    },
  ) {}

  bindRuntime(key: ChannelTargetRuntimeKey): AgentRuntimeStateCallbacks {
    return {
      setStatus: (status, extras) => this.setStatus(key, status, extras),
      setCheckpoint: (checkpoint) => this.setCheckpoint(key, checkpoint),
      recordLostCheckpoint: (lost, replacement, error) =>
        this.recordLostCheckpoint(key, lost, replacement, error),
    };
  }

  async read(
    key: ChannelTargetRuntimeKey,
  ): Promise<ChannelTargetRuntimeStatusFile | null> {
    const path = statusPath(this.options.dispatcherId, key);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      this.options.warn(
        `channel target runtime status ${path} could not be read ` +
          `(${errMessage(err)}); starting a fresh channel target runtime.`,
      );
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      this.options.warn(
        `channel target runtime status ${path} is not valid JSON ` +
          `(${errMessage(err)}); starting a fresh channel target runtime.`,
      );
      return null;
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.options.warn(
        `channel target runtime status ${path} ignored: top-level must be an object; ` +
          'starting a fresh channel target runtime.',
      );
      return null;
    }
    const raw = parsed as Partial<ChannelTargetRuntimeStatusFile>;
    if (
      raw.version !== 1 ||
      raw.dispatcher_id !== this.options.dispatcherId ||
      raw.channel_id !== key.channelId ||
      raw.target_key !== key.targetKey
    ) {
      this.options.warn(
        `channel target runtime status ${path} ignored: identity mismatch; ` +
          'starting a fresh channel target runtime.',
      );
      return null;
    }
    if (
      !isNullableString(raw.thread_id) ||
      !isRuntimeStatus(raw.status) ||
      !(typeof raw.updated_at === 'number' && Number.isFinite(raw.updated_at)) ||
      !isNullableNumber(raw.last_started_at) ||
      !isNullableNumber(raw.last_ready_at) ||
      !isNullableString(raw.last_error) ||
      !isNullableString(raw.last_lost_thread_id)
    ) {
      this.options.warn(
        `channel target runtime status ${path} ignored: malformed v1 fields; ` +
          'starting a fresh channel target runtime.',
      );
      return null;
    }
    return {
      version: 1,
      dispatcher_id: this.options.dispatcherId,
      channel_id: key.channelId,
      target_key: key.targetKey,
      thread_id: raw.thread_id ?? null,
      status: raw.status,
      updated_at: raw.updated_at,
      last_started_at: raw.last_started_at ?? null,
      last_ready_at: raw.last_ready_at ?? null,
      last_error: raw.last_error ?? null,
      last_lost_thread_id: raw.last_lost_thread_id ?? null,
    };
  }

  private async setStatus(
    key: ChannelTargetRuntimeKey,
    status: AgentRuntimeStatus,
    extras: {
      last_error?: string | null;
      last_started_at?: number;
      last_ready_at?: number;
    } = {},
  ): Promise<void> {
    const current = await this.read(key);
    await this.persist({
      ...recordDefaults(this.options.dispatcherId, key),
      ...current,
      status,
      updated_at: Date.now(),
      last_error: 'last_error' in extras
        ? extras.last_error ?? null
        : current?.last_error ?? null,
      last_started_at: extras.last_started_at ?? current?.last_started_at ?? null,
      last_ready_at: extras.last_ready_at ?? current?.last_ready_at ?? null,
    });
  }

  private async setCheckpoint(
    key: ChannelTargetRuntimeKey,
    checkpoint: AgentRuntimeResumeCheckpoint,
  ): Promise<void> {
    const current = await this.read(key);
    await this.persist({
      ...recordDefaults(this.options.dispatcherId, key),
      ...current,
      thread_id: checkpoint.id,
      updated_at: Date.now(),
    });
  }

  private async recordLostCheckpoint(
    key: ChannelTargetRuntimeKey,
    lost: AgentRuntimeResumeCheckpoint,
    replacement: AgentRuntimeResumeCheckpoint,
    error: string,
  ): Promise<void> {
    const current = await this.read(key);
    await this.persist({
      ...recordDefaults(this.options.dispatcherId, key),
      ...current,
      thread_id: replacement.id,
      last_lost_thread_id: lost.id,
      last_error: error,
      updated_at: Date.now(),
    });
  }

  private async persist(record: ChannelTargetRuntimeStatusFile): Promise<void> {
    const path = statusPath(this.options.dispatcherId, {
      channelId: record.channel_id,
      targetKey: record.target_key,
      targetKeyHash: targetKeyHash(record.target_key),
    });
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
    });
  }
}

function makeRuntimeKey(
  channelId: string,
  targetKey: string,
): ChannelTargetRuntimeKey {
  return {
    channelId,
    targetKey,
    targetKeyHash: targetKeyHash(targetKey),
  };
}

function targetKeyHash(targetKey: string): string {
  return createHash('sha256').update(targetKey).digest('hex').slice(0, 16);
}

function channelTargetRuntimeId(dispatcherId: string, hash: string): string {
  const maxDispatcherPrefix = 64 - '.ch.'.length - hash.length;
  return validateDispatcherId(
    `${dispatcherId.slice(0, maxDispatcherPrefix)}.ch.${hash}`,
    'channel target runtime id',
  );
}

function statusPath(
  dispatcherId: string,
  key: ChannelTargetRuntimeKey,
): string {
  return dispatcherChannelTargetRuntimeStatusPath({
    dispatcherId,
    channelId: key.channelId,
    targetKeyHash: key.targetKeyHash,
  });
}

function recordDefaults(
  dispatcherId: string,
  key: ChannelTargetRuntimeKey,
): ChannelTargetRuntimeStatusFile {
  return {
    version: 1,
    dispatcher_id: dispatcherId,
    channel_id: key.channelId,
    target_key: key.targetKey,
    thread_id: null,
    status: 'declared',
    updated_at: Date.now(),
    last_started_at: null,
    last_ready_at: null,
    last_error: null,
    last_lost_thread_id: null,
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isNullableString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

function isNullableNumber(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function isRuntimeStatus(value: unknown): value is AgentRuntimeStatus {
  return value === 'declared' ||
    value === 'starting' ||
    value === 'ready' ||
    value === 'degraded' ||
    value === 'stopping' ||
    value === 'stopped';
}
