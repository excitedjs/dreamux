/**
 * Neutral JSON contracts shared by every Dreamux seam.
 *
 * Both the Agent Runtime and Channel boundaries carry JSON-compatible payloads
 * (Command input/output, provider-owned session identity, structured-output
 * schemas). They live in one domain-neutral module so no seam has to borrow the
 * other's module to name a JSON value.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * A JSON Schema document, expressed as a plain JSON object. Dreamux never
 * constrains the schema dialect a Command or a Provider uses beyond "it is a
 * JSON object", so this stays deliberately structural.
 */
export type JsonSchema = { readonly [key: string]: JsonValue };
