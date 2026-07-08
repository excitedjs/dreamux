import { readFile } from 'node:fs/promises';

import type { ChannelTarget } from '@excitedjs/dreamux-types';

import { writeFileAtomic } from '../../platform/atomic-write.js';
import { isNotFound } from '../../platform/fs-errors.js';
import { dispatcherChannelBindingsPath } from '../../platform/paths.js';
import { LegacyStateError } from '../legacy-state.js';
import { KeyedAsyncQueue } from '../serial-queue.js';

/** A channel provider ref (e.g. `builtin:feishu`); core never narrows to one. */
export type ChannelProviderRef = string;

/**
 * A flat channel-binding row (issue #209 binding store v2). The durable routing
 * key is `(channel_id, target_key)`; `target_key` is provider-owned and opaque
 * to core. Provider-defined target selectors live in `meta`, never as core
 * top-level columns, so the store routes by the opaque `target_key` and stays
 * channel-neutral.
 */
export interface ChannelBinding {
  /** Dispatcher-local channel id (`dispatchers[].channels[].id`). */
  channel_id: string;
  provider: ChannelProviderRef;
  /** Provider target type (e.g. a chat channel's `group`). */
  target_type: string;
  /** Provider-owned stable routing key (e.g. a chat channel's chat id). */
  target_key: string;
  display: string | null;
  canonical_url: string | null;
  /** The channel provider's target selector(s). */
  meta: Record<string, unknown>;
  /** The concrete Team key the target is bound to (issue #199 Slice 4). */
  team_name: string;
  leader_name: string;
  active: boolean;
  created_at: number;
  updated_at: number;
  deactivated_at: number | null;
}

const STORE_VERSION = 2;

interface ChannelBindingFile {
  version: typeof STORE_VERSION;
  bindings: ChannelBinding[];
}

export interface BindChannelInput {
  dispatcherId: string;
  channelId: string;
  provider: ChannelProviderRef;
  target: ChannelTarget;
  teamName: string;
  leaderName: string;
}

export interface ResolveChannelInput {
  dispatcherId: string;
  channelId: string;
  targetKey: string;
}

export type TransferChannelBackInput = ResolveChannelInput;

export class ChannelBindingStore {
  private readonly writes = new KeyedAsyncQueue();

  async bind(input: BindChannelInput): Promise<ChannelBinding> {
    if (!input.target.bindable) {
      throw new Error(
        `channel target ${JSON.stringify(input.target.target_key)} (type ` +
          `${input.target.target_type}) is not bindable; only bindable targets ` +
          'can be handed to a Team (P2P always routes to the dispatcher)',
      );
    }
    return this.writes.run(input.dispatcherId, async () => {
      const file = await this.read(input.dispatcherId);
      const now = Date.now();
      const next: ChannelBinding = {
        channel_id: input.channelId,
        provider: input.provider,
        target_type: input.target.target_type,
        target_key: input.target.target_key,
        display: input.target.display ?? null,
        canonical_url: input.target.canonical_url ?? null,
        meta: input.target.meta ?? {},
        team_name: input.teamName,
        leader_name: input.leaderName,
        active: true,
        created_at: now,
        updated_at: now,
        deactivated_at: null,
      };
      // Active uniqueness is `(channel_id, target_key)`: a channel target is
      // active for at most one Team. Re-binding the same target reassigns it
      // (last-bind-wins, preserving created_at), so there is always exactly one
      // row per key.
      const idx = file.bindings.findIndex(
        (binding) =>
          binding.channel_id === input.channelId &&
          binding.target_key === input.target.target_key,
      );
      if (idx === -1) {
        file.bindings.push(next);
        await this.write(input.dispatcherId, file);
        return next;
      }
      const merged: ChannelBinding = {
        ...next,
        created_at: file.bindings[idx]!.created_at,
      };
      file.bindings[idx] = merged;
      await this.write(input.dispatcherId, file);
      return merged;
    });
  }

  async transferBack(
    input: TransferChannelBackInput,
  ): Promise<ChannelBinding | null> {
    return this.writes.run(input.dispatcherId, async () => {
      const file = await this.read(input.dispatcherId);
      const binding = file.bindings.find(
        (entry) =>
          entry.channel_id === input.channelId &&
          entry.target_key === input.targetKey &&
          entry.active,
      );
      if (binding === undefined) return null;
      binding.active = false;
      binding.updated_at = Date.now();
      binding.deactivated_at = binding.updated_at;
      await this.write(input.dispatcherId, file);
      return binding;
    });
  }

  async resolve(input: ResolveChannelInput): Promise<ChannelBinding | null> {
    const file = await this.read(input.dispatcherId);
    return (
      file.bindings.find(
        (binding) =>
          binding.channel_id === input.channelId &&
          binding.target_key === input.targetKey &&
          binding.active,
      ) ?? null
    );
  }

  async list(dispatcherId: string): Promise<ChannelBinding[]> {
    return (await this.read(dispatcherId)).bindings;
  }

  /**
   * Fail loud if the on-disk store is a pre-v2 shape. Called by the serve/doctor
   * startup probe so a v1 store is rejected at boot, not lazily on first inbound.
   */
  async assertCurrent(dispatcherId: string): Promise<void> {
    await this.read(dispatcherId);
  }

  private async read(dispatcherId: string): Promise<ChannelBindingFile> {
    let raw: string;
    const path = dispatcherChannelBindingsPath(dispatcherId);
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      if (isNotFound(err)) return { version: STORE_VERSION, bindings: [] };
      throw err;
    }
    const value = JSON.parse(raw) as Record<string, unknown>;
    // Pre-v2 fail-loud (issue #209 binding store v2): the old store was
    // `version: 1`, keyed by `(provider, chat_id)`, with no `channel_id` /
    // `target_key`. Dreamux 0.x does not migrate it — reject with rebuild
    // guidance naming the file rather than read a row that cannot route by key.
    if (value['version'] !== STORE_VERSION || !Array.isArray(value['bindings'])) {
      throw new LegacyStateError(
        `channel binding store for dispatcher ${dispatcherId} is not version ` +
          `${STORE_VERSION} (issue #209 binding store v2). Dreamux 0.x does not ` +
          `migrate old binding state — delete ${path} and re-bind the channel(s) ` +
          'to rebuild it.',
      );
    }
    for (const row of value['bindings'] as Record<string, unknown>[]) {
      if (typeof row !== 'object' || row === null) {
        throw new LegacyStateError(
          `channel binding store for dispatcher ${dispatcherId} has a non-object ` +
            'binding row (issue #209 binding store v2). Dreamux 0.x does not ' +
            `migrate old binding state — delete ${path} and re-bind the ` +
            'channel(s) to rebuild it.',
        );
      }
      const hasV2Keys =
        typeof row['channel_id'] === 'string' &&
        row['channel_id'] !== '' &&
        typeof row['target_key'] === 'string' &&
        row['target_key'] !== '';
      if (!hasV2Keys) {
        throw new LegacyStateError(
          `channel binding store for dispatcher ${dispatcherId} has a pre-v2 row ` +
            'missing channel_id / target_key (issue #209 binding store v2). Dreamux ' +
            `0.x does not migrate old binding state — delete ${path} and re-bind ` +
            'the channel(s) to rebuild it.',
        );
      }
    }
    return value as unknown as ChannelBindingFile;
  }

  private async write(
    dispatcherId: string,
    file: ChannelBindingFile,
  ): Promise<void> {
    const path = dispatcherChannelBindingsPath(dispatcherId);
    await writeFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`);
  }
}

/**
 * Startup/doctor probe (issue #209 binding store v2): return the rebuild message
 * if a dispatcher's on-disk channel-binding store is a pre-v2 shape, or `null`
 * when it is current/absent. This surfaces the same fail-loud as a lazy `read()`
 * at `dreamux serve` / `dreamux doctor`, so a v1 store is caught at boot rather
 * than on first inbound traffic.
 */
export async function detectLegacyChannelBindingStore(
  dispatcherId: string,
): Promise<string | null> {
  try {
    await new ChannelBindingStore().assertCurrent(dispatcherId);
    return null;
  } catch (err) {
    if (err instanceof LegacyStateError) return err.message;
    throw err;
  }
}
