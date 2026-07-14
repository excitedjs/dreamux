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

export function spaceKey(input: {
  channelId: string;
  container: { container_key: string };
}): string {
  return [input.channelId, input.container.container_key].join('\0');
}

export function targetRouteKey(target: ProvisionedTargetRecord): string {
  return routeKey({
    channelId: target.channel_id,
    targetKey: target.target_key,
  });
}

export function routeKey(input: {
  channelId: string;
  targetKey: string;
}): string {
  return [input.channelId, input.targetKey].join('\0');
}

export function parseMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
