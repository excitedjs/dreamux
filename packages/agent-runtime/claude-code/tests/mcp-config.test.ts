/**
 * Claude Code MCP config document translation (`src/mcp-config.ts`).
 *
 * Core hands the provider a fully-resolved `AgentRuntimeMcpServer[]`: the
 * provider must launch EXACTLY that list, unchanged and unaugmented, translated
 * into Claude Code's own native `--mcp-config` JSON document shape. These are
 * pure, no-IO translation tests — no live `claude` binary needed.
 */
import { describe, expect, it } from 'vitest';

import {
  claudeCodeMcpConfig,
  stringifyClaudeCodeMcpConfig,
} from '../src/mcp-config.js';
import type { AgentRuntimeMcpServer } from '@excitedjs/dreamux-types';

describe('claudeCodeMcpConfig', () => {
  it('translates each Core-supplied server into the native mcpServers map, keyed by its unchanged logical name', () => {
    const servers: AgentRuntimeMcpServer[] = [
      { name: 'dreamux-core', command: '/usr/bin/node', args: ['server.js'] },
      { name: 'search', command: 'search-mcp', args: ['--flag', 'value'] },
    ];
    expect(claudeCodeMcpConfig(servers)).toEqual({
      mcpServers: {
        'dreamux-core': { command: '/usr/bin/node', args: ['server.js'] },
        search: { command: 'search-mcp', args: ['--flag', 'value'] },
      },
    });
  });

  it('produces no servers at all for an empty Core-supplied list (never invents or discovers one)', () => {
    expect(claudeCodeMcpConfig([])).toEqual({ mcpServers: {} });
  });

  it('carries a descriptor env through unchanged, and omits the key entirely when a descriptor has none', () => {
    const servers: AgentRuntimeMcpServer[] = [
      { name: 'with-env', command: 'bin', args: [], env: { TOKEN: 'secret-value' } },
      { name: 'without-env', command: 'bin', args: [] },
    ];
    const config = claudeCodeMcpConfig(servers);
    expect(config.mcpServers['with-env']).toEqual({
      command: 'bin',
      args: [],
      env: { TOKEN: 'secret-value' },
    });
    expect('env' in config.mcpServers['without-env']!).toBe(false);
  });

  it('copies args and env rather than aliasing the input descriptor (Core cannot be mutated through the translated config)', () => {
    const args = ['--one'];
    const env = { KEY: 'value' };
    const servers: AgentRuntimeMcpServer[] = [
      { name: 'server', command: 'bin', args, env },
    ];
    const config = claudeCodeMcpConfig(servers);
    config.mcpServers['server']!.args.push('--mutated');
    (config.mcpServers['server']!.env as Record<string, string>)['KEY'] = 'mutated';
    expect(args).toEqual(['--one']);
    expect(env).toEqual({ KEY: 'value' });
  });

  it('never renames a logical server name (the key IS the Core-supplied name, verbatim)', () => {
    const servers: AgentRuntimeMcpServer[] = [
      { name: 'Some-Mixed_Case.name', command: 'bin', args: [] },
    ];
    const config = claudeCodeMcpConfig(servers);
    expect(Object.keys(config.mcpServers)).toEqual(['Some-Mixed_Case.name']);
  });
});

describe('stringifyClaudeCodeMcpConfig', () => {
  it('serializes to the exact JSON document handed to --mcp-config', () => {
    const servers: AgentRuntimeMcpServer[] = [
      { name: 'a', command: 'bin-a', args: ['x'] },
    ];
    expect(stringifyClaudeCodeMcpConfig(servers)).toBe(
      JSON.stringify({ mcpServers: { a: { command: 'bin-a', args: ['x'] } } }),
    );
  });

  it('round-trips to a document with no servers beyond the Core-supplied set', () => {
    const servers: AgentRuntimeMcpServer[] = [
      { name: 'one', command: 'bin', args: [] },
      { name: 'two', command: 'bin', args: [] },
    ];
    const parsed = JSON.parse(stringifyClaudeCodeMcpConfig(servers)) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(parsed.mcpServers).sort()).toEqual(['one', 'two']);
  });
});
