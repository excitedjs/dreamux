export type InboundResourceType = 'file' | 'image'

export interface InboundResource {
  type: InboundResourceType
  /** Feishu message resource key (`file_key` / `image_key`) when present. */
  key?: string
  /** Original user-facing filename. Treat as display text, never a path. */
  name?: string
}

export type InboundContentPart =
  | { kind: 'text'; text: string }
  | { kind: 'code'; code: string; language?: string }
  | { kind: 'resource'; resource: InboundResource }
  /**
   * One mention occurrence, at the position it was written. `id` is always a
   * user identity the reply syntax accepts; a record the platform gave no such
   * identity for (an application, for one) stays ordinary `@name` text.
   */
  | { kind: 'mention'; id: string; name: string }

/** One inbound message's visible content, in Feishu source order. */
export interface ParsedInbound {
  parts: InboundContentPart[]
  /** True when the projection is an honest fallback or omitted visible data. */
  incomplete?: boolean
}

export function appendTextPart(
  parts: InboundContentPart[],
  text: string,
): void {
  if (text === '') return
  const previous = parts.at(-1)
  if (previous?.kind === 'text') previous.text += text
  else parts.push({ kind: 'text', text })
}

export function resourcePart(
  type: InboundResourceType,
  key?: string,
  name?: string,
): Extract<InboundContentPart, { kind: 'resource' }> {
  return {
    kind: 'resource',
    resource: {
      type,
      ...(key !== undefined ? { key } : {}),
      ...(name !== undefined ? { name } : {}),
    },
  }
}

export function resourceIdentity(
  resource: InboundResource,
): string | undefined {
  return resource.key === undefined
    ? undefined
    : `${resource.type}:${resource.key}`
}
