/**
 * The one MCP server descriptor builder.
 *
 * There used to be five of these, each spelling out its own subcommand and its
 * own caller-scope flags, and each one was a place where a caller fact could be
 * written into a command line the model's runtime could read. There is now one
 * shape for every Agent-facing MCP server: the same binary, the same
 * subcommand, the admin socket to reach, and an opaque lease token.
 *
 * The token travels in the descriptor's `env` rather than its `args`, but that
 * placement should not be read as secrecy. Every provider serializes this whole
 * descriptor — `env` included — into its own native runtime configuration and
 * passes that configuration inline on the runtime's command line, so the token
 * is visible in the runtime process's cmdline to anything that can read it.
 * `env` still keeps it out of the *shim's* argv, which is worth having, and it
 * is where a provider that ever stops inlining its config would put it.
 *
 * What actually bounds this capability is elsewhere, and does not depend on the
 * token staying unseen. Redeeming one requires reaching `admin.sock`, whose file
 * permissions are the real access boundary: a reader who cannot open the socket
 * cannot use the token, and one who can open it already holds full admin
 * authority without any token at all. The token's own contributions are that it
 * is opaque — it names no dispatcher, Team, or caller, so it discloses nothing —
 * and that it is generation-scoped, so it stops working the moment its owner
 * releases it or its runtime generation is replaced.
 */
import type { AgentRuntimeMcpServer } from '@excitedjs/dreamux-types';

import { dreamuxBinPath } from '../../platform/package-bin.js';

/** The environment variable the generic shim reads its lease token from. */
export const DREAMUX_MCP_LEASE_ENV = 'DREAMUX_MCP_LEASE';

/** The `dreamux` subcommand that runs the generic Agent-facing MCP shim. */
export const DREAMUX_MCP_SUBCOMMAND = 'mcp';

/**
 * Prove one runtime's whole server set before the runtime is constructed.
 *
 * Uniqueness is a property of the set, not of a single descriptor, and it
 * cannot be delegated to a provider: a provider's own server map discovers a
 * collision only by losing an entry, and by then the runtime is already
 * starting with one fewer server than the host composed. Failing here instead
 * means the launch stops in the process that can name the offending server.
 *
 * Uniqueness is also the *whole* rule. A server name is a logical identity: the
 * host chooses it, the model sees it, and it reaches every runtime unchanged.
 * What a name has to look like to be written into some runtime's own
 * configuration format is that runtime adapter's problem, and each one quotes
 * or escapes the name it is given. Deriving a Core-wide alphabet from one
 * adapter's format would push that adapter's limits onto operator data — and
 * onto every other adapter, including ones that accept any string at all.
 *
 * Generic on purpose. It knows no Dreamux server name and reserves no word —
 * uniqueness is what keeps a Channel from colliding with an internal delegate,
 * so a new delegate never has to be added to a list here. A domain that derives
 * names from operator data keeps its own names distinct by namespacing them;
 * only this proof can see two domains at once.
 */
export function assertUniqueMcpServerNames(
  servers: readonly AgentRuntimeMcpServer[],
): void {
  const seen = new Set<string>();
  for (const server of servers) {
    if (seen.has(server.name)) {
      throw new Error(
        `MCP server name ${JSON.stringify(server.name)} is composed twice ` +
          'for one agent runtime; server names must be unique',
      );
    }
    seen.add(server.name);
  }
}

export function mcpServerDescriptor(input: {
  /** The MCP server name the delegate owns. */
  name: string;
  /** The opaque token minted for this runtime generation. */
  token: string;
  adminSocketPath: string;
  command?: string;
  env?: NodeJS.ProcessEnv;
}): AgentRuntimeMcpServer {
  return {
    name: input.name,
    command: input.command ?? dreamuxBinPath(input.env),
    args: [
      DREAMUX_MCP_SUBCOMMAND,
      '--admin-socket',
      input.adminSocketPath,
    ],
    env: { [DREAMUX_MCP_LEASE_ENV]: input.token },
  };
}
