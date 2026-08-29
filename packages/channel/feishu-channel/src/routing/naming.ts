/**
 * Names Feishu chooses for the Teams it provisions.
 *
 * These used to live in Core's Collaboration Space service, which meant Core
 * held an opinion about what a Feishu topic should be called. They are moved
 * verbatim rather than redesigned: the external product effect — a Team named
 * after the space, with an intent naming the topic — is what operators already
 * see, and this refactor is not the place to change it.
 */
import { createHash } from 'node:crypto';

export function spaceId(input: {
  dispatcherId: string;
  channelId: string;
  containerChatId: string;
}): string {
  return createHash('sha256')
    .update(input.dispatcherId)
    .update('\0')
    .update(input.channelId)
    .update('\0')
    .update(input.containerChatId)
    .digest('hex')
    .slice(0, 12);
}

export function teamNamePrefix(display: string | null): string {
  return `space-${slugFor(nonBlank(display))}`;
}

export function targetIntent(input: {
  display: string | null;
  fallback: string;
}): string {
  const title = nonBlank(input.display);
  return title !== null
    ? `Collaboration target: ${title}`
    : `Collaboration target ${input.fallback.slice(-12)}`;
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
