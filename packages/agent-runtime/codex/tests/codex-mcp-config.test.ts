/**
 * Unit coverage for `codexMcpServerArgs` (mcp-config.ts): rendering the
 * Core-supplied `AgentRuntimeMcpServer[]` list into Codex's `-c
 * mcp_servers=...` override.
 *
 * Per the Stage 8 audit decision an MCP server name is a provider-neutral
 * logical identity Core owns: this adapter's job is making the UNCHANGED name
 * expressible in Codex's native TOML, never constraining or transforming it.
 * These tests assert round-trip fidelity for the characters that would break a
 * naive (non-quoted) rendering — dots, quotes, whitespace, and non-ASCII —
 * by parsing the rendered TOML value back out with a real TOML parser and
 * checking the key it landed under.
 */
import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';

import { codexMcpServerArgs } from '../src/mcp-config.js';
import type { AgentRuntimeMcpServer } from '@excitedjs/dreamux-types';

/** Extract the `mcp_servers={...}` value out of the `-c key=value` CLI pair. */
function mcpServersTomlValue(args: string[]): string {
  const flagIndex = args.indexOf('-c');
  expect(flagIndex).toBeGreaterThanOrEqual(0);
  const pair = args[flagIndex + 1]!;
  const eq = pair.indexOf('=');
  expect(pair.slice(0, eq)).toBe('mcp_servers');
  return pair.slice(eq + 1);
}

/** Parse the rendered override the same way Codex's own TOML parser would. */
function parsedMcpServers(args: string[]): Record<string, unknown> {
  const value = mcpServersTomlValue(args);
  // The override is a bare TOML inline table; wrap it under a key so a
  // standalone TOML document parser accepts it.
  const doc = `mcp_servers = ${value}\n`;
  return (parseToml(doc) as { mcp_servers: Record<string, unknown> }).mcp_servers;
}

describe('codexMcpServerArgs', () => {
  it('returns no args at all for an empty server list', () => {
    expect(codexMcpServerArgs([])).toEqual([]);
  });

  it('renders a plain server name, command, and args', () => {
    const servers: AgentRuntimeMcpServer[] = [
      { name: 'feishu', command: 'node', args: ['server.js', '--port', '0'] },
    ];
    const args = codexMcpServerArgs(servers);
    expect(args[0]).toBe('-c');
    const parsed = parsedMcpServers(args);
    expect(parsed).toEqual({
      feishu: { command: 'node', args: ['server.js', '--port', '0'] },
    });
  });

  it('carries env when present and omits the field entirely when absent', () => {
    const servers: AgentRuntimeMcpServer[] = [
      { name: 'with-env', command: 'node', args: [], env: { TOKEN: 'abc' } },
      { name: 'without-env', command: 'node', args: [] },
    ];
    const parsed = parsedMcpServers(codexMcpServerArgs(servers));
    expect(parsed['with-env']).toEqual({
      command: 'node',
      args: [],
      env: { TOKEN: 'abc' },
    });
    expect(parsed['without-env']).toEqual({ command: 'node', args: [] });
  });

  it.each([
    'name.with.dots',
    'name "with" quotes',
    'name with spaces',
    'name#with#hash',
    'name=with=equals',
    '中文名字',
    'emoji-🚀-name',
    'tab\tnewline\nname',
  ])('round-trips the UNCHANGED logical name %j through TOML quoting', (name) => {
    const servers: AgentRuntimeMcpServer[] = [
      { name, command: 'node', args: [] },
    ];
    const parsed = parsedMcpServers(codexMcpServerArgs(servers));
    // A dotted/quoted/spaced name must land under EXACTLY that key — never
    // split across nested tables (the failure mode a bare, unquoted `.` in a
    // `-c key=value` key would cause) and never sanitized.
    expect(Object.keys(parsed)).toEqual([name]);
    expect(parsed[name]).toMatchObject({ command: 'node' });
  });

  it('merges into the operator config rather than replacing it: only Core-named servers appear', () => {
    // codexMcpServerArgs itself only ever emits ONE `-c mcp_servers=...`
    // override covering exactly the servers Core supplied; this asserts that
    // shape directly rather than the runtime merge behavior, which is Codex's
    // own `-c` semantics (documented in mcp-config.ts, not reimplemented here).
    const servers: AgentRuntimeMcpServer[] = [
      { name: 'only-this-one', command: 'node', args: [] },
    ];
    const args = codexMcpServerArgs(servers);
    expect(args).toHaveLength(2);
    const parsed = parsedMcpServers(args);
    expect(Object.keys(parsed)).toEqual(['only-this-one']);
  });

  it('renders multiple servers as sibling entries in call order', () => {
    const servers: AgentRuntimeMcpServer[] = [
      { name: 'first', command: 'node', args: [] },
      { name: 'second', command: 'python3', args: ['-m', 'server'] },
    ];
    const parsed = parsedMcpServers(codexMcpServerArgs(servers));
    expect(Object.keys(parsed)).toEqual(['first', 'second']);
    expect(parsed['second']).toEqual({ command: 'python3', args: ['-m', 'server'] });
  });
});
