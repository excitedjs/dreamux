/**
 * The body one inbound message flattens into.
 *
 * The text is written in Feishu's own vocabulary: a mention stands as the
 * placeholder the message's `mentions` records name, an image or file stands
 * as its resource key. The channel layer substitutes both when it renders, so
 * nothing here knows how a mention or an attachment is finally written.
 */

export type InboundResourceType = 'file' | 'image'

export interface InboundResource {
  type: InboundResourceType
  /** Feishu message resource key (`file_key` / `image_key`). */
  key: string
  /** Original user-facing filename. Treat as display text, never a path. */
  name?: string
}

export interface ParsedInbound {
  /** The message as text; placeholders and resource keys stand where they were. */
  text: string
  /** Every resource the text refers to, once each, in first-occurrence order. */
  resources: InboundResource[]
  /** True when the body omits visible content it could not read. */
  incomplete?: boolean
}

export interface BodyBuilder {
  /** Add one line; an empty string adds nothing. */
  line(text: string): void
  /** Register a resource once and return the key that stands for it. */
  attach(type: InboundResourceType, key: string, name?: string): string
  build(incomplete?: boolean): ParsedInbound
}

export function createBody(): BodyBuilder {
  let text = ''
  const resources: InboundResource[] = []
  const seen = new Set<string>()
  return {
    line(more) {
      if (more === '') return
      text += text === '' ? more : `\n${more}`
    },
    attach(type, key, name) {
      const identity = `${type}:${key}`
      if (!seen.has(identity)) {
        seen.add(identity)
        resources.push({ type, key, ...(name !== undefined ? { name } : {}) })
      }
      return key
    },
    build(incomplete) {
      return { text, resources, ...(incomplete === true ? { incomplete } : {}) }
    },
  }
}
