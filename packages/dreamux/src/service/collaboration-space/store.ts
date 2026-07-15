import { readFile } from 'node:fs/promises';

import { writeFileAtomic } from '../../platform/atomic-write.js';
import { isNotFound } from '../../platform/fs-errors.js';
import { dispatcherCollaborationSpacesPath } from '../../platform/paths.js';
import { KeyedAsyncQueue } from '../serial-queue.js';
import type {
  CollaborationSpaceBindingRecord,
  CollaborationSpaceRecord,
  ProvisionedTargetRecord,
} from './types.js';
import { COLLABORATION_SPACE_RECORD_VERSION } from './types.js';

const STORE_VERSION = 2;
// One dispatcher has one process-level writer authority. Keep the fence at
// module scope so test/preflight store instances cannot bypass that authority.
const STORE_WRITES = new KeyedAsyncQueue();

interface CollaborationSpaceStoreFile {
  version: typeof STORE_VERSION;
  spaces: CollaborationSpaceRecord[];
  targets: ProvisionedTargetRecord[];
}

export interface TargetKeyInput {
  channelId: string;
  containerType: string;
  containerKey: string;
  bindingGeneration: number;
  targetKey: string;
}

export interface BindSpaceInput {
  dispatcherId: string;
  spaceName: string;
  channelId: string;
  provider: string;
  container?: {
    container_type: string;
    container_key: string;
    display?: string;
    canonical_url?: string;
  };
  display?: string;
  binding: Omit<CollaborationSpaceBindingRecord, 'generation' | 'bound_at'>;
}

export class CollaborationSpaceStore {
  /**
   * Commit one collaboration-space bind transition. The bound-state check,
   * container uniqueness check, generation allocation, and policy write share
   * one store critical section so a generation always identifies one immutable
   * binding policy.
  */
  async bindSpace(input: BindSpaceInput): Promise<CollaborationSpaceRecord> {
    return STORE_WRITES.run(input.dispatcherId, async () => {
      const file = await this.read(input.dispatcherId);
      const existing = file.spaces.find(
        (space) => space.space_name === input.spaceName,
      ) ?? null;
      if (existing === null && input.container === undefined) {
        throw new Error('container is required when binding a new collaboration space');
      }
      const container = input.container ?? {
        container_type: existing!.container_type,
        container_key: existing!.container_key,
        ...(existing!.display !== null ? { display: existing!.display } : {}),
        ...(existing!.canonical_url !== null
          ? { canonical_url: existing!.canonical_url }
          : {}),
      };
      if (
        existing !== null &&
        (existing.channel_id !== input.channelId ||
          existing.container_type !== container.container_type ||
          existing.container_key !== container.container_key)
      ) {
        throw new Error(
          `collaboration space ${JSON.stringify(input.spaceName)} is already ` +
            'registered for a different channel container',
        );
      }
      if (existing?.status === 'bound') {
        throw new Error(
          `collaboration space ${JSON.stringify(input.spaceName)} is already bound; ` +
            'dissolve it before binding it again',
        );
      }
      const existingByContainer = file.spaces.find(
        (space) =>
          space.space_name !== input.spaceName &&
          space.channel_id === input.channelId &&
          space.container_type === container.container_type &&
          space.container_key === container.container_key,
      );
      if (existingByContainer !== undefined) {
        throw new Error(
          `channel container ${JSON.stringify(container.container_key)} is already ` +
            `registered as collaboration space ` +
            `${JSON.stringify(existingByContainer.space_name)}`,
        );
      }

      const now = Date.now();
      const generation = (existing?.last_binding_generation ?? 0) + 1;
      const saved: CollaborationSpaceRecord = {
        version: COLLABORATION_SPACE_RECORD_VERSION,
        dispatcher_id: input.dispatcherId,
        space_name: input.spaceName,
        channel_id: input.channelId,
        provider: input.provider,
        container_type: container.container_type,
        container_key: container.container_key,
        display: input.display ?? container.display ?? existing?.display ?? null,
        canonical_url: container.canonical_url ?? existing?.canonical_url ?? null,
        current_binding: {
          ...input.binding,
          generation,
          bound_at: now,
        },
        last_binding_generation: generation,
        status: 'bound',
        created_at: existing?.created_at ?? now,
        updated_at: now,
        unbound_at: null,
        unbound_note: null,
      };
      this.upsertSpace(file, saved);
      await this.write(input.dispatcherId, file);
      return saved;
    });
  }

  async listSpaces(dispatcherId: string): Promise<CollaborationSpaceRecord[]> {
    return (await this.read(dispatcherId)).spaces;
  }

  async getSpace(
    dispatcherId: string,
    spaceName: string,
  ): Promise<CollaborationSpaceRecord | null> {
    return (
      (await this.read(dispatcherId)).spaces.find(
        (space) => space.space_name === spaceName,
      ) ?? null
    );
  }

  async findSpaceByContainer(input: {
    dispatcherId: string;
    channelId: string;
    containerType: string;
    containerKey: string;
  }): Promise<CollaborationSpaceRecord | null> {
    return (
      (await this.read(input.dispatcherId)).spaces.find(
        (space) =>
          space.channel_id === input.channelId &&
          space.container_type === input.containerType &&
          space.container_key === input.containerKey,
      ) ?? null
    );
  }

  async saveSpace(space: CollaborationSpaceRecord): Promise<CollaborationSpaceRecord> {
    await STORE_WRITES.run(space.dispatcher_id, async () => {
      const file = await this.read(space.dispatcher_id);
      this.upsertSpace(file, space);
      await this.write(space.dispatcher_id, file);
    });
    return space;
  }

  async saveDefaultBoundSpace(
    space: CollaborationSpaceRecord,
  ): Promise<CollaborationSpaceRecord> {
    let saved = space;
    await STORE_WRITES.run(space.dispatcher_id, async () => {
      const file = await this.read(space.dispatcher_id);
      const byContainer = file.spaces.find((entry) =>
        sameContainer(entry, space),
      );
      if (byContainer !== undefined) {
        if (
          byContainer.current_binding !== null &&
          byContainer.status === 'bound'
        ) {
          saved = byContainer;
          return;
        }
        throw new Error(
          `collaboration space ${JSON.stringify(byContainer.space_name)} is ` +
            'unbound and will not be auto-bound again',
        );
      }
      this.upsertSpace(file, space);
      await this.write(space.dispatcher_id, file);
    });
    return saved;
  }

  /**
   * Backfill immutable task repository policy onto an existing binding
   * generation only when its already-persisted concrete repository facts match.
   */
  async pinRepositoryPolicy(input: {
    dispatcherId: string;
    channelId: string;
    containerType: string;
    containerKey: string;
    repoCwd: string;
    baseRef: string | null;
    policy: NonNullable<CollaborationSpaceBindingRecord['repository_policy']>;
  }): Promise<CollaborationSpaceRecord> {
    return STORE_WRITES.run(input.dispatcherId, async () => {
      const file = await this.read(input.dispatcherId);
      const space = file.spaces.find(
        (entry) =>
          entry.channel_id === input.channelId &&
          entry.container_type === input.containerType &&
          entry.container_key === input.containerKey,
      );
      const binding = space?.current_binding;
      if (
        space === undefined ||
        space.status !== 'bound' ||
        binding === null ||
        binding === undefined ||
        binding.repo_cwd !== input.repoCwd ||
        binding.worktree.mode !== 'managed' ||
        binding.worktree.base_ref !== input.baseRef
      ) {
        throw new Error('collaboration space repository binding does not match');
      }
      if (binding.repository_policy !== undefined) {
        if (JSON.stringify(binding.repository_policy) !== JSON.stringify(input.policy)) {
          throw new Error('collaboration space repository policy is already pinned');
        }
        return space;
      }
      binding.repository_policy = structuredClone(input.policy);
      space.updated_at = Date.now();
      this.upsertSpace(file, space);
      await this.write(input.dispatcherId, file);
      return space;
    });
  }

  async listTargets(
    dispatcherId: string,
    filter: {
      spaceName?: string;
      channelId?: string;
      containerType?: string;
      containerKey?: string;
      bindingGeneration?: number;
      targetKey?: string;
    } = {},
  ): Promise<ProvisionedTargetRecord[]> {
    return (await this.read(dispatcherId)).targets.filter(
      (target) =>
        (filter.spaceName === undefined || target.space_name === filter.spaceName) &&
        (filter.channelId === undefined || target.channel_id === filter.channelId) &&
        (filter.containerType === undefined ||
          target.container_type === filter.containerType) &&
        (filter.containerKey === undefined || target.container_key === filter.containerKey) &&
        (filter.bindingGeneration === undefined ||
          target.binding_generation === filter.bindingGeneration) &&
        (filter.targetKey === undefined || target.target_key === filter.targetKey),
    );
  }

  async findOpenTargetByChannelTarget(
    dispatcherId: string,
    input: {
      channelId: string;
      targetKey: string;
    },
  ): Promise<ProvisionedTargetRecord | null> {
    const targets = (await this.read(dispatcherId)).targets
      .filter(
        (target) =>
          target.channel_id === input.channelId &&
          target.target_key === input.targetKey &&
          target.lifecycle_status !== 'closed' &&
          target.lifecycle_status !== 'detached',
      )
      .sort((left, right) =>
        right.binding_generation - left.binding_generation ||
        right.updated_at - left.updated_at,
      );
    return targets[0] ?? null;
  }

  async findLatestTargetByChannelTarget(
    dispatcherId: string,
    input: {
      channelId: string;
      targetKey: string;
    },
  ): Promise<ProvisionedTargetRecord | null> {
    const targets = (await this.read(dispatcherId)).targets
      .filter(
        (target) =>
          target.channel_id === input.channelId &&
          target.target_key === input.targetKey,
      )
      .sort((left, right) =>
        right.binding_generation - left.binding_generation ||
        right.updated_at - left.updated_at,
      );
    return targets[0] ?? null;
  }

  async getTarget(
    dispatcherId: string,
    key: TargetKeyInput,
  ): Promise<ProvisionedTargetRecord | null> {
    return (
      (await this.read(dispatcherId)).targets.find((target) =>
        target.channel_id === key.channelId &&
        target.container_type === key.containerType &&
        target.container_key === key.containerKey &&
        target.binding_generation === key.bindingGeneration &&
        target.target_key === key.targetKey,
      ) ?? null
    );
  }

  async saveTarget(
    target: ProvisionedTargetRecord,
  ): Promise<ProvisionedTargetRecord> {
    await STORE_WRITES.run(target.dispatcher_id, async () => {
      const file = await this.read(target.dispatcher_id);
      const idx = file.targets.findIndex((entry) =>
        entry.channel_id === target.channel_id &&
        entry.container_type === target.container_type &&
        entry.container_key === target.container_key &&
        entry.binding_generation === target.binding_generation &&
        entry.target_key === target.target_key,
      );
      if (idx === -1) file.targets.push(target);
      else file.targets[idx] = target;
      await this.write(target.dispatcher_id, file);
    });
    return target;
  }

  private async read(dispatcherId: string): Promise<CollaborationSpaceStoreFile> {
    let raw: string;
    try {
      raw = await readFile(dispatcherCollaborationSpacesPath(dispatcherId), 'utf8');
    } catch (err) {
      if (isNotFound(err)) {
        return { version: STORE_VERSION, spaces: [], targets: [] };
      }
      throw err;
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      ![1, STORE_VERSION].includes(parsed['version'] as number) ||
      !Array.isArray(parsed['spaces']) ||
      !Array.isArray(parsed['targets'])
    ) {
      throw new Error(`invalid collaboration-space store for dispatcher ${dispatcherId}`);
    }
    const spaces = parsed['spaces'] as CollaborationSpaceRecord[];
    const targets = (parsed['targets'] as Array<
      ProvisionedTargetRecord & {
        container_type?: string;
        route_claim_id?: string;
      }
    >).map((target) => {
      const space = spaces.find((candidate) =>
        candidate.space_name === target.space_name &&
        candidate.channel_id === target.channel_id &&
        candidate.container_key === target.container_key,
      );
      const containerType = target.container_type ?? space?.container_type ??
        (parsed['version'] === 1 ? 'legacy_unknown' : undefined);
      if (containerType === undefined) {
        throw new Error(
          `cannot migrate collaboration target without its container: ${target.target_key}`,
        );
      }
      return {
        ...target,
        container_type: containerType,
        route_claim_id: target.route_claim_id ?? JSON.stringify([
          target.dispatcher_id,
          target.channel_id,
          target.container_key,
          target.binding_generation,
          target.target_key,
        ]),
      };
    });
    return { version: STORE_VERSION, spaces, targets };
  }

  private async write(
    dispatcherId: string,
    file: CollaborationSpaceStoreFile,
  ): Promise<void> {
    await writeFileAtomic(
      dispatcherCollaborationSpacesPath(dispatcherId),
      `${JSON.stringify(file, null, 2)}\n`,
    );
  }

  private upsertSpace(
    file: CollaborationSpaceStoreFile,
    space: CollaborationSpaceRecord,
  ): void {
    const idx = file.spaces.findIndex(
      (entry) => entry.space_name === space.space_name,
    );
    const existingByName = idx === -1 ? null : file.spaces[idx]!;
    if (existingByName !== null && !sameContainer(existingByName, space)) {
      throw new Error(
        `collaboration space ${JSON.stringify(space.space_name)} is already ` +
          'registered for a different channel container',
      );
    }
    const existingByContainer = file.spaces.find((entry) =>
      entry.space_name !== space.space_name && sameContainer(entry, space),
    );
    if (existingByContainer !== undefined) {
      throw new Error(
        `channel container ${JSON.stringify(space.container_key)} is already ` +
          `registered as collaboration space ` +
          `${JSON.stringify(existingByContainer.space_name)}`,
      );
    }
    if (idx === -1) file.spaces.push(space);
    else file.spaces[idx] = space;
  }
}

function sameContainer(
  left: CollaborationSpaceRecord,
  right: CollaborationSpaceRecord,
): boolean {
  return left.channel_id === right.channel_id &&
    left.container_type === right.container_type &&
    left.container_key === right.container_key;
}
