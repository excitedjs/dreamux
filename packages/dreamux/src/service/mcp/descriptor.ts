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
 * placement should not be read as secrecy. Both providers serialize this whole
 * descriptor — `env` included — into their own native command line (Codex as
 * `-c mcp_servers.<name>.env=...`, Claude Code as inline `--mcp-config` JSON),
 * so the token is visible in the runtime process's cmdline to anything that can
 * read it. `env` still keeps it out of the *shim's* argv, which is worth having,
 * and it is where a provider that ever stops inlining its config would put it.
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
 * The alphabet an MCP server name must stay inside to be composable into every
 * provider's native configuration.
 *
 * A descriptor's other fields are quoted or escaped by each provider before they
 * reach a native config — the name is not. Codex interpolates it bare into a
 * TOML key path (`-c mcp_servers.<name>.command=...`), so it must be a bare TOML
 * key: a `.` silently moves the server to a different config path, an `=`
 * truncates the override, and a space or quote produces an invalid one. Claude
 * Code uses it as a JSON object key, where every string parses. So the binding
 * rule is exactly TOML's bare-key set, which is also a safe object key and a
 * safe prefix for the tool names a client shows the model.
 *
 * That is the whole rule. There is no length ceiling, because neither native
 * format defines one, and no rule about the first character, because a bare TOML
 * key has none — an invented limit here would push an arbitrary Core constraint
 * back onto the operator data a name may be derived from.
 */
const NATIVE_SAFE_SERVER_NAME = /^[A-Za-z0-9_-]+$/;

/** Characters {@link nativeSafeMcpNameSegment} passes through unchanged. */
const NAME_SEGMENT_UNRESERVED = /^[A-Za-z0-9-]$/;

/**
 * The width of one escape's hex payload.
 *
 * Four, because a UTF-16 code unit is exactly 16 bits, so every escape has the
 * same length no matter what it encodes. That is what a decoder needs: it never
 * has to look past a fixed window to know where an escape ends.
 */
const ESCAPE_HEX_DIGITS = 4;

/**
 * Encode arbitrary text as a native-safe name segment, without losing any of it.
 *
 * A delegate whose name is derived from operator data — a configured channel id,
 * which config constrains only to a non-empty string unique in its dispatcher —
 * cannot use that data as a native key directly. The answer is to encode it, not
 * to constrain it: every id an operator may legally configure has to stay
 * expressible, so this never sanitizes, truncates, or hashes.
 *
 * The unit is one UTF-16 code unit, which is what a JavaScript string is
 * actually made of. Encoding bytes instead would be lossy: a lone surrogate is
 * a legal `string` — JSON can write one as `"\ud800"`, and config asks a channel
 * id for nothing beyond being a non-empty string — and any UTF-8 encoder
 * replaces every one of them with the same U+FFFD, which would map two
 * different ids onto one native key.
 *
 * `[A-Za-z0-9-]` pass through; every other code unit becomes `_` followed by its
 * {@link ESCAPE_HEX_DIGITS} uppercase hex digits, and `_` is not in the
 * pass-through set, so a literal one is itself escaped (`_005F`). Three facts
 * therefore hold together: `_` appears in the output only as an escape lead,
 * every escape is the same length, and a pass-through character always stands
 * for itself. Reading left to right — take five characters at a `_`, one
 * otherwise — recovers the input exactly, so the map is injective and two
 * different ids can never produce the same key. A non-empty input yields a
 * non-empty output, and every output character is a bare TOML key character, so
 * an encoded segment always satisfies {@link assertComposableMcpServerNames}.
 */
export function nativeSafeMcpNameSegment(value: string): string {
  let encoded = '';
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    const char = String.fromCharCode(unit);
    if (NAME_SEGMENT_UNRESERVED.test(char)) {
      encoded += char;
      continue;
    }
    const hex = unit.toString(16).toUpperCase();
    encoded += `_${hex.padStart(ESCAPE_HEX_DIGITS, '0')}`;
  }
  return encoded;
}

/**
 * Prove one runtime's whole server set before the runtime is constructed.
 *
 * Both rules are properties of the set, not of a single descriptor, and neither
 * can be delegated to a provider: a provider map discovers a collision only by
 * losing an entry, and a config renderer discovers a bad name only by emitting
 * a broken document. Failing here instead means the launch stops in the process
 * that can name the offending server, before any native runtime exists.
 *
 * Generic on purpose. It knows no Dreamux server name and reserves no word —
 * uniqueness is what keeps a Channel from colliding with an internal delegate,
 * so a new delegate never has to be added to a list here. An injective encoder
 * keeps one domain's own names distinct; only this proof can see two domains at
 * once.
 */
export function assertComposableMcpServerNames(
  servers: readonly AgentRuntimeMcpServer[],
): void {
  const seen = new Set<string>();
  for (const server of servers) {
    if (!NATIVE_SAFE_SERVER_NAME.test(server.name)) {
      throw new Error(
        `MCP server name ${JSON.stringify(server.name)} cannot be configured ` +
          "on an agent runtime: a name must be letters, digits, '-', or '_'",
      );
    }
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
