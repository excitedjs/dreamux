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
 */
import manifest from '../../../package.json' with { type: 'json' };

/** This package's version, as reported to any MCP client that connects. */
export const MCP_IDENTITY_VERSION: string = manifest.version;
