import type { AgentRuntimeMcpServer } from '@excitedjs/dreamux-types';

/**
 * Render neutral MCP server descriptors into a Codex `-c mcp_servers=...`
 * config-override CLI arg.
 *
 * Provider-neutral about *what* it renders: it knows nothing about which
 * channel or shim produced a descriptor — the Dreamux host decides which MCP
 * servers a runtime gets and passes them through the create context. What it
 * does own is *how* a descriptor becomes Codex configuration, including the
 * server name. A name is a logical identity chosen by the host; making it
 * expressible in TOML is this adapter's job, not a constraint the host has to
 * honor when it picks one.
 *
 * That is why the whole table is rendered as one override value rather than as
 * one `mcp_servers.<name>.<field>=` override per field. Codex parses the value
 * of `-c key=value` as TOML but not the key: it splits the key on `.` and takes
 * each segment literally, so a quoted segment arrives with its quotes attached
 * and a name containing `.` is silently split across two config levels. Inside
 * the value a real TOML parser is reading, so a quoted key carries any string —
 * dots, spaces, quotes, `=`, `#`, newlines, non-ASCII — back out under exactly
 * the name it went in under.
 *
 * The override still merges into the operator's own `config.toml` rather than
 * replacing it, at every level: servers Dreamux does not name are untouched,
 * and for a name it does, fields it does not set keep their configured values.
 *
 * Values that cannot survive the TOML/argv boundary at all — a lone surrogate,
 * an unescaped control character — fail loud when Codex loads the override.
 * That envelope already applies to `command`, `args`, and `env`; a name is not
 * given a private encoding to escape it.
 */
export function codexMcpServerArgs(
  servers: readonly AgentRuntimeMcpServer[],
): string[] {
  if (servers.length === 0) return [];
  const entries = servers.map(
    (server) => `${tomlString(server.name)} = ${tomlServerTable(server)}`,
  );
  return ['-c', `mcp_servers={${entries.join(', ')}}`];
}

function tomlServerTable(server: AgentRuntimeMcpServer): string {
  const fields = [
    `command = ${tomlString(server.command)}`,
    `args = ${tomlStringArray(server.args)}`,
    // Carried, never dropped: a descriptor's `env` holds what its server needs
    // to start, so losing it breaks the server it was minted for. Note that
    // this rendering puts those values into Codex's own command line, so `env`
    // is not a secrecy boundary here — the host is told as much and does not
    // rely on one.
    ...(server.env !== undefined ? [`env = ${tomlTable(server.env)}`] : []),
  ];
  return `{${fields.join(', ')}}`;
}

function tomlTable(entries: Readonly<Record<string, string>>): string {
  const pairs = Object.entries(entries).map(
    ([key, value]) => `${tomlString(key)} = ${tomlString(value)}`,
  );
  return `{${pairs.join(', ')}}`;
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

/**
 * One TOML basic string, used for both keys and values.
 *
 * `JSON.stringify` is the whole implementation because TOML's basic-string
 * escapes are a superset of JSON's: the same double quotes, the same `\"`,
 * `\\`, `\b`, `\f`, `\n`, `\r`, `\t`, and the same `\uXXXX`.
 */
function tomlString(value: string): string {
  return JSON.stringify(value);
}
