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
 * A flat channel-binding row (issue #209 binding store v3). The durable routing
 * key is `(channel_id, target_key)`; `target_key` is provider-owned and opaque
 * to core. Provider-defined target selectors live in `meta`, never as core
 * top-level columns, so the store routes by the opaque `target_key` and stays
 * channel-neutral. v3 also records explicit route provenance via `claim_id`.
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
  /**
   * Opaque ownership token for a managed route claim. Explicit Team binds set
   * this to null, so the owner tuple alone is never used to infer provenance.
   */
  claim_id: string | null;
  active: boolean;
  created_at: number;
  updated_at: number;
  deactivated_at: number | null;
}

const STORE_VERSION = 3;

interface ChannelBindingFile {
  version: typeof STORE_VERSION;
  bindings: ChannelBinding[];
}

interface DecodedChannelBindingFile extends ChannelBindingFile {
  sourceVersion: typeof STORE_VERSION | 2;
}

export interface V2ChannelBindingRouteKey {
  channelId: string;
  targetKey: string;
}

export interface BindChannelInput {
  dispatcherId: string;
  channelId: string;
  provider: ChannelProviderRef;
  target: ChannelTarget;
  teamName: string;
  leaderName: string;
}

export interface ChannelBindingOwnerInput {
  teamName: string;
  leaderName: string;
}

export interface ResolveChannelInput {
  dispatcherId: string;
  channelId: string;
  targetKey: string;
}

export type TransferChannelBackInput = ResolveChannelInput & {
  expectedOwner?: ChannelBindingOwnerInput;
};

export class ChannelBindingStore {
  private readonly writes = new KeyedAsyncQueue();

  async bind(input: BindChannelInput): Promise<ChannelBinding> {
    return this.bindInternal(input, 'replace');
  }

  /**
   * Create an explicit binding without taking over an active route. The exact
   * same explicit owner is idempotent; managed claims are never converted.
   */
  async bindIfAvailableToOwner(input: BindChannelInput): Promise<ChannelBinding> {
    return this.bindInternal(input, 'available');
  }

  async claim(input: BindChannelInput & { claimId: string }): Promise<ChannelBinding> {
    return this.bindInternal(input, 'claim');
  }

  private async bindInternal(
    input: BindChannelInput & { claimId?: string },
    mode: 'replace' | 'available' | 'claim',
  ): Promise<ChannelBinding> {
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
        claim_id: mode === 'claim' ? input.claimId! : null,
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
      const previous = file.bindings[idx]!;
      if (mode === 'available' && previous.active) {
        if (previous.claim_id !== null) {
          throw new Error(
            `channel target ${JSON.stringify(input.target.target_key)} is managed ` +
              'by an active collaboration route',
          );
        }
        if (
          previous.team_name !== input.teamName ||
          previous.leader_name !== input.leaderName
        ) {
          throw new Error(
            `channel target ${JSON.stringify(input.target.target_key)} is already ` +
              'bound to another owner',
          );
        }
        return previous;
      }
      if (
        mode === 'claim' &&
        previous.active &&
        (previous.team_name !== input.teamName ||
          previous.leader_name !== input.leaderName)
      ) {
        throw new Error(
          `channel target ${JSON.stringify(input.target.target_key)} is already ` +
          `bound to Team ${JSON.stringify(previous.team_name)}`,
        );
      }
      if (
        mode === 'claim' &&
        previous.active &&
        previous.claim_id !== input.claimId
      ) {
        throw new Error(
          `channel target ${JSON.stringify(input.target.target_key)} already has ` +
            'a different active route claim',
        );
      }
      const merged: ChannelBinding = {
        ...next,
        created_at: previous.created_at,
      };
      file.bindings[idx] = merged;
      await this.write(input.dispatcherId, file);
      return merged;
    });
  }

  async transferBack(
    input: TransferChannelBackInput,
  ): Promise<ChannelBinding | null> {
    return this.transferBackInternal(input, 'throw-on-mismatch');
  }

  async transferBackIfOwned(
    input: ResolveChannelInput & {
      owner: ChannelBindingOwnerInput;
    },
  ): Promise<ChannelBinding | null> {
    return this.transferBackInternal(
      {
        dispatcherId: input.dispatcherId,
        channelId: input.channelId,
        targetKey: input.targetKey,
        expectedOwner: input.owner,
      },
      'ignore-mismatch',
    );
  }

  async transferBackIfClaimed(
    input: ResolveChannelInput & { claimId: string },
  ): Promise<ChannelBinding | null> {
    return this.transferBackInternal(
      {
        dispatcherId: input.dispatcherId,
        channelId: input.channelId,
        targetKey: input.targetKey,
        expectedClaimId: input.claimId,
      },
      'ignore-mismatch',
    );
  }

  private async transferBackInternal(
    input: TransferChannelBackInput & { expectedClaimId?: string },
    mode: 'throw-on-mismatch' | 'ignore-mismatch',
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
      if (
        input.expectedOwner !== undefined &&
        (binding.team_name !== input.expectedOwner.teamName ||
          binding.leader_name !== input.expectedOwner.leaderName)
      ) {
        if (mode === 'ignore-mismatch') return null;
        throw new Error(
          `channel target '${input.targetKey}' is bound to Team ` +
            `${JSON.stringify(binding.team_name)} leader ` +
            `${JSON.stringify(binding.leader_name)}, not Team ` +
            `${JSON.stringify(input.expectedOwner.teamName)} leader ` +
          `${JSON.stringify(input.expectedOwner.leaderName)}`,
        );
      }
      if (
        input.expectedClaimId !== undefined &&
        binding.claim_id !== input.expectedClaimId
      ) {
        return null;
      }
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
   * Fail loud if the on-disk store cannot be decoded into the current row
   * shape. The serve/doctor startup probe separately checks v2 collaboration
   * overlap so ambiguous provenance is rejected at boot, not lazily on first
   * inbound.
   */
  async assertCurrent(dispatcherId: string): Promise<void> {
    await this.read(dispatcherId);
  }

  private async read(dispatcherId: string): Promise<ChannelBindingFile> {
    const file = await readChannelBindingFile(dispatcherId);
    return {
      version: file.version,
      bindings: file.bindings,
    };
  }

  private async write(
    dispatcherId: string,
    file: ChannelBindingFile,
  ): Promise<void> {
    const path = dispatcherChannelBindingsPath(dispatcherId);
    await writeFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`);
  }
}

async function readChannelBindingFile(
  dispatcherId: string,
): Promise<DecodedChannelBindingFile> {
  let raw: string;
  const path = dispatcherChannelBindingsPath(dispatcherId);
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (isNotFound(err)) {
      return { sourceVersion: STORE_VERSION, version: STORE_VERSION, bindings: [] };
    }
    throw err;
  }
  const value = JSON.parse(raw) as Record<string, unknown>;
  const sourceVersion = value['version'];
  if (
    (sourceVersion !== STORE_VERSION && sourceVersion !== 2) ||
    !Array.isArray(value['bindings'])
  ) {
    throw new LegacyStateError(
      `channel binding store for dispatcher ${dispatcherId} is not a compatible ` +
        `version (issue #209 binding store v3 with route provenance). Dreamux ` +
        `0.x can reuse version 2 routing-key rows, but older binding state must ` +
        `be rebuilt — delete ${path} and re-bind the channel(s).`,
    );
  }
  const bindings: ChannelBinding[] = [];
  for (const row of value['bindings'] as Record<string, unknown>[]) {
    if (typeof row !== 'object' || row === null) {
      throw new LegacyStateError(
        `channel binding store for dispatcher ${dispatcherId} has a non-object ` +
          `binding row (issue #209 binding store v3). Dreamux 0.x can reuse ` +
          `version 2 routing-key rows, but this row must be rebuilt — delete ` +
          `${path} and re-bind the channel(s).`,
      );
    }
    const hasV3Keys =
      typeof row['channel_id'] === 'string' &&
      row['channel_id'] !== '' &&
      typeof row['target_key'] === 'string' &&
      row['target_key'] !== '';
    if (!hasV3Keys) {
      throw new LegacyStateError(
        `channel binding store for dispatcher ${dispatcherId} has a pre-v3 row ` +
          'missing channel_id / target_key (issue #209 binding store v3). Dreamux ' +
          `0.x can reuse version 2 routing-key rows, but this row must be ` +
          `rebuilt — delete ${path} and re-bind the channel(s).`,
      );
    }
    if (!Object.prototype.hasOwnProperty.call(row, 'claim_id')) {
      if (sourceVersion === 2) {
        bindings.push({ ...row, claim_id: null } as unknown as ChannelBinding);
        continue;
      }
      throw new LegacyStateError(
        `channel binding store for dispatcher ${dispatcherId} has a version 3 row ` +
          'missing claim_id route provenance. Delete the malformed row or rebuild ' +
          'the binding state.',
      );
    }
    if (row['claim_id'] !== null && typeof row['claim_id'] !== 'string') {
      throw new LegacyStateError(
        `channel binding store for dispatcher ${dispatcherId} has an invalid ` +
          'claim_id route provenance field. Delete the malformed row or rebuild ' +
          'the binding state.',
      );
    }
    bindings.push(row as unknown as ChannelBinding);
  }
  return {
    sourceVersion,
    version: STORE_VERSION,
    bindings,
  };
}

export async function readActiveV2ChannelBindingRouteKeys(
  dispatcherId: string,
): Promise<V2ChannelBindingRouteKey[]> {
  const file = await readChannelBindingFile(dispatcherId);
  if (file.sourceVersion !== 2) return [];
  return file.bindings
    .filter((binding) => binding.active)
    .map((binding) => ({
      channelId: binding.channel_id,
      targetKey: binding.target_key,
    }));
}

/**
 * Startup/doctor probe (issue #209 binding store v3): return the rebuild message
 * if a dispatcher's on-disk channel-binding store is not compatible, or `null`
 * when it is current, absent, or row-compatible v2 state. This surfaces the same
 * fail-loud as a lazy `read()` at `dreamux serve` / `dreamux doctor`, so
 * incompatible state is caught at boot rather than on first inbound traffic.
 * V2 overlap with collaboration target state is checked by
 * `detectAmbiguousV2ChannelBindingRoutes` at the startup/doctor layer.
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
