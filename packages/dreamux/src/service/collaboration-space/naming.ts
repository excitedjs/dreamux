import { createHash } from 'node:crypto';

import type { ChannelTarget } from '@excitedjs/dreamux-types';

import type { ProvisionedTargetRecord } from './types.js';

export function targetIntent(
  target: ChannelTarget,
  record: ProvisionedTargetRecord,
): string {
  const title = nonBlank(record.target_display) ?? nonBlank(target.display);
  return title !== null
    ? `Collaboration target: ${title}`
    : `Collaboration target ${record.team_name.slice(-12)}`;
}

export function hashTarget(input: {
  dispatcherId: string;
  channelId: string;
  containerKey: string;
  bindingGeneration: number;
  targetKey: string;
}): string {
  return createHash('sha256')
    .update(input.dispatcherId)
    .update('\0')
    .update(input.channelId)
    .update('\0')
    .update(input.containerKey)
    .update('\0')
    .update(String(input.bindingGeneration))
    .update('\0')
    .update(input.targetKey)
    .digest('hex')
    .slice(0, 12);
}

export function slugFor(value: string | null): string {
  if (value === null) return 'target';
  const slug = value
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[^A-Za-z0-9]+$/, '')
    .slice(0, 32);
  return slug === '' ? 'target' : slug;
}

export function nonBlank(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
