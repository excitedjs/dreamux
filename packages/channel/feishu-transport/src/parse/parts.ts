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

/** Canonical parser result before compatibility projections are added. */
export interface ParsedContent {
  parts: InboundContentPart[]
  incomplete?: boolean
  /** Exact legacy text retained only when it cannot be inferred from `parts`. */
  compatibilityText?: string
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

export function projectLegacyText(content: ParsedContent): string {
  if (content.compatibilityText !== undefined) {
    return content.compatibilityText
  }
  return content.parts.map(projectLegacyPart).join('')
}

export function projectUniqueResources(
  parts: InboundContentPart[],
): InboundResource[] {
  const resources: InboundResource[] = []
  const seen = new Set<string>()
  for (const part of parts) {
    if (part.kind !== 'resource') continue
    const identity = resourceIdentity(part.resource)
    if (identity !== undefined && seen.has(identity)) continue
    if (identity !== undefined) seen.add(identity)
    resources.push(part.resource)
  }
  return resources
}

export function resourceIdentity(
  resource: InboundResource,
): string | undefined {
  return resource.key === undefined
    ? undefined
    : `${resource.type}:${resource.key}`
}

function projectLegacyPart(part: InboundContentPart): string {
  if (part.kind === 'text') return part.text
  if (part.kind === 'code') return renderLegacyCode(part)
  return resourceMarker(part.resource)
}

function renderLegacyCode(
  part: Extract<InboundContentPart, { kind: 'code' }>,
): string {
  const longestRun = Math.max(
    0,
    ...Array.from(part.code.matchAll(/`+/g), (match) => match[0].length),
  )
  const fence = '`'.repeat(Math.max(3, longestRun + 1))
  return `${fence}${part.language ?? ''}\n${part.code}\n${fence}`
}

function resourceMarker(resource: InboundResource): string {
  const detail = resource.type === 'image'
    ? resource.key
    : resource.name ?? resource.key
  return detail === undefined
    ? `[${resource.type} attachment without a resource key]`
    : `[${resource.type} attachment: ${detail}]`
}
