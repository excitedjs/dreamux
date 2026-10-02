/**
 * The version every Dreamux-served MCP server reports as its own.
 *
 * An MCP `serverInfo.version` is a claim about the software answering the
 * connection, so the only honest value is this package's version. It was
 * previously a `'0.4.0'` literal copied into each delegate, which meant four
 * places had to be remembered on every release and none of them was; they went
 * on advertising a version Dreamux had long left behind.
 *
 * The version is taken from the package manifest itself, so it cannot drift:
 * `rush publish` bumps `package.json` and this follows. A static JSON import
 * keeps it a load-time constant — no filesystem read at all, so nothing here
 * can fail at runtime or trip the no-sync-IO rule. The relative path is the
 * same from `src/service/mcp/` and from the compiled `dist/service/mcp/`,
 * because both sit exactly two directories below the package root, and
 * `package.json` is always present in a published tarball.
 *
 * This module also owns the identity every delegate is published under —
 * `dreamux-<name>` at this version — since a version with no identity to
 * attach it to is half a fact.
 */
import manifest from '../../../package.json' with { type: 'json' };

/** This package's version, as reported to any MCP client that connects. */
export const MCP_IDENTITY_VERSION: string = manifest.version;

/**
 * The MCP server identity a delegate advertises for itself.
 *
 * Distinct from a delegate's `name`: this is what the server calls itself in
 * its own initialize response, while the name is the key the runtime
 * registers it under.
 */
export interface McpDelegateIdentity {
  readonly name: string;
  readonly version: string;
}

/**
 * A delegate's identity is a pure function of its own name: there is nothing
 * for a delegate to state here, so nothing to get wrong. Every identity so
 * far has been exactly `dreamux-<name>` at this package's own version — a
 * fact this function makes true by construction instead of by four separate
 * authors copying the same two-part literal.
 */
export function mcpDelegateIdentity(name: string): McpDelegateIdentity {
  return { name: `dreamux-${name}`, version: MCP_IDENTITY_VERSION };
}
