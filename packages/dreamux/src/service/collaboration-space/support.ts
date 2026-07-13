import type { ChannelContainer } from '@excitedjs/dreamux-types';

import type {
  CollaborationSpaceRecord,
  ProvisionedTargetRecord,
} from './types.js';

export function requiredSpace(
  space: CollaborationSpaceRecord | null,
): CollaborationSpaceRecord {
  if (space === null) {
    throw new Error('collaboration space record is required');
  }
  return space;
}

export function requiredBinding(
  space: CollaborationSpaceRecord,
): NonNullable<CollaborationSpaceRecord['current_binding']> {
  if (space.current_binding === null) {
    throw new Error(
      `collaboration space ${JSON.stringify(space.space_name)} is not bound`,
    );
  }
  return space.current_binding;
}

export function containerFromSpace(space: CollaborationSpaceRecord): ChannelContainer {
  return {
    container_type: space.container_type,
    container_key: space.container_key,
    ...(space.display !== null ? { display: space.display } : {}),
    ...(space.canonical_url !== null ? { canonical_url: space.canonical_url } : {}),
  };
}

export function assertSameContainer(
  space: CollaborationSpaceRecord,
  channelId: string,
  container: ChannelContainer,
): void {
  if (
    space.channel_id !== channelId ||
    space.container_type !== container.container_type ||
    space.container_key !== container.container_key
  ) {
    throw new Error(
      `collaboration space ${JSON.stringify(space.space_name)} is already ` +
        'registered for a different channel container',
    );
  }
}

export function lockKey(input: {
  channelId: string;
  containerKey: string;
  bindingGeneration: number;
  targetKey: string;
}): string {
  return [
    input.channelId,
    input.containerKey,
    String(input.bindingGeneration),
    input.targetKey,
  ].join('\0');
}

export function targetKey(target: ProvisionedTargetRecord): string {
  return lockKey({
    channelId: target.channel_id,
    containerKey: target.container_key,
    bindingGeneration: target.binding_generation,
    targetKey: target.target_key,
  });
}

export function parseMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
