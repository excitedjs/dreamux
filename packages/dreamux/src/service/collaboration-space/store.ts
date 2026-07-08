import { readFile } from 'node:fs/promises';

import { writeFileAtomic } from '../../platform/atomic-write.js';
import { isNotFound } from '../../platform/fs-errors.js';
import { dispatcherCollaborationSpacesPath } from '../../platform/paths.js';
import type {
  CollaborationSpaceRecord,
  ProvisionedTargetRecord,
} from './types.js';

const STORE_VERSION = 1;

interface CollaborationSpaceStoreFile {
  version: typeof STORE_VERSION;
  spaces: CollaborationSpaceRecord[];
  targets: ProvisionedTargetRecord[];
}

export interface TargetKeyInput {
  channelId: string;
  containerKey: string;
  bindingGeneration: number;
  targetKey: string;
}

export class CollaborationSpaceStore {
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
    containerKey: string;
  }): Promise<CollaborationSpaceRecord | null> {
    return (
      (await this.read(input.dispatcherId)).spaces.find(
        (space) =>
          space.channel_id === input.channelId &&
          space.container_key === input.containerKey,
      ) ?? null
    );
  }

  async saveSpace(space: CollaborationSpaceRecord): Promise<CollaborationSpaceRecord> {
    const file = await this.read(space.dispatcher_id);
    const idx = file.spaces.findIndex(
      (entry) => entry.space_name === space.space_name,
    );
    if (idx === -1) file.spaces.push(space);
    else file.spaces[idx] = space;
    await this.write(space.dispatcher_id, file);
    return space;
  }

  async listTargets(
    dispatcherId: string,
    filter: {
      spaceName?: string;
      channelId?: string;
      containerKey?: string;
      bindingGeneration?: number;
    } = {},
  ): Promise<ProvisionedTargetRecord[]> {
    return (await this.read(dispatcherId)).targets.filter(
      (target) =>
        (filter.spaceName === undefined || target.space_name === filter.spaceName) &&
        (filter.channelId === undefined || target.channel_id === filter.channelId) &&
        (filter.containerKey === undefined || target.container_key === filter.containerKey) &&
        (filter.bindingGeneration === undefined ||
          target.binding_generation === filter.bindingGeneration),
    );
  }

  async getTarget(
    dispatcherId: string,
    key: TargetKeyInput,
  ): Promise<ProvisionedTargetRecord | null> {
    return (
      (await this.read(dispatcherId)).targets.find((target) =>
        target.channel_id === key.channelId &&
        target.container_key === key.containerKey &&
        target.binding_generation === key.bindingGeneration &&
        target.target_key === key.targetKey,
      ) ?? null
    );
  }

  async saveTarget(
    target: ProvisionedTargetRecord,
  ): Promise<ProvisionedTargetRecord> {
    const file = await this.read(target.dispatcher_id);
    const idx = file.targets.findIndex((entry) =>
      entry.channel_id === target.channel_id &&
      entry.container_key === target.container_key &&
      entry.binding_generation === target.binding_generation &&
      entry.target_key === target.target_key,
    );
    if (idx === -1) file.targets.push(target);
    else file.targets[idx] = target;
    await this.write(target.dispatcher_id, file);
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
      parsed['version'] !== STORE_VERSION ||
      !Array.isArray(parsed['spaces']) ||
      !Array.isArray(parsed['targets'])
    ) {
      throw new Error(`invalid collaboration-space store for dispatcher ${dispatcherId}`);
    }
    return parsed as unknown as CollaborationSpaceStoreFile;
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
}
