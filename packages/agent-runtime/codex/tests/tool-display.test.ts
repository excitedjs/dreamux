/**
 * The display facts the runtime derives from a codex thread item.
 *
 * Items are hand-authored to the v2 app-server wire shapes (`ThreadItem` in
 * `codex-rs/app-server-protocol`); the wording under test is the codex TUI's
 * own. No codex binary is needed.
 */

import { describe, expect, it } from 'vitest';

import { toolDisplay } from '../src/tool-display.js';

describe('toolDisplay', () => {
  it('labels a plain command by its first line and keeps the whole command as the invocation', () => {
    expect(toolDisplay({
      type: 'commandExecution',
      id: 'item-1',
      command: 'npm test\necho done',
      commandActions: [{ type: 'unknown', command: 'npm test' }],
    })).toEqual({ action: 'run', summary: 'npm test', invocation: 'npm test\necho done', files: [] });
  });

  it('labels an all-read command by the files it read, deduplicated, the way the TUI groups an Explored cell, and lists their paths', () => {
    expect(toolDisplay({
      type: 'commandExecution',
      id: 'item-1',
      command: 'cat SKILL.md && sed -n 1,5p SKILL.md && cat README.md',
      commandActions: [
        { type: 'read', command: 'cat SKILL.md', name: 'SKILL.md', path: '/repo/SKILL.md' },
        { type: 'read', command: 'sed -n 1,5p SKILL.md', name: 'SKILL.md', path: '/repo/SKILL.md' },
        { type: 'read', command: 'cat README.md', name: 'README.md', path: '/repo/README.md' },
      ],
    })).toMatchObject({ action: 'read', summary: 'SKILL.md, README.md', files: ['/repo/SKILL.md', '/repo/README.md'] });
  });

  it('labels a search by its query and path', () => {
    expect(toolDisplay({
      type: 'commandExecution',
      id: 'item-1',
      command: 'rg TODO src',
      commandActions: [{ type: 'search', command: 'rg TODO src', query: 'TODO', path: 'src' }],
    })).toEqual({ action: 'search', summary: 'TODO in src', invocation: 'rg TODO src', files: [] });
  });

  it('falls back to the command line for a mixed pipeline', () => {
    expect(toolDisplay({
      type: 'commandExecution',
      id: 'item-1',
      command: 'cat a.rs | grep TODO',
      commandActions: [
        { type: 'read', command: 'cat a.rs', name: 'a.rs', path: '/repo/a.rs' },
        { type: 'search', command: 'grep TODO', query: 'TODO' },
      ],
    })).toEqual({ action: 'run', summary: 'cat a.rs | grep TODO', invocation: 'cat a.rs | grep TODO', files: [] });
  });

  it('labels a patch by the files it touches, lists them, and shows the diffs codex prepared', () => {
    expect(toolDisplay({
      type: 'fileChange',
      id: 'item-1',
      status: 'completed',
      changes: [
        { path: '/repo/a.rs', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-x\n+y' },
        { path: '/repo/b.rs', kind: { type: 'add' }, diff: 'fn main() {}' },
      ],
    })).toEqual({
      action: 'edit',
      summary: '/repo/a.rs, /repo/b.rs',
      invocation: '/repo/a.rs\n@@ -1 +1 @@\n-x\n+y\n\n/repo/b.rs\nfn main() {}',
      files: ['/repo/a.rs', '/repo/b.rs'],
    });
  });

  it('labels a web search by what was searched, per action kind', () => {
    expect(toolDisplay({ type: 'webSearch', id: 'item-1', query: 'rust async traits', action: null }))
      .toEqual({ action: 'search', summary: 'rust async traits', invocation: null, files: [] });
    expect(toolDisplay({
      type: 'webSearch',
      id: 'item-1',
      query: 'x',
      action: { type: 'findInPage', url: 'https://example.test', pattern: 'async' },
    })).toMatchObject({ summary: "'async' in https://example.test" });
    expect(toolDisplay({
      type: 'webSearch',
      id: 'item-1',
      query: 'x',
      action: { type: 'search', queries: ['first', 'second'] },
    })).toMatchObject({ summary: 'first …' });
  });

  it('labels nothing for an MCP tool call', () => {
    expect(toolDisplay({ type: 'mcpToolCall', id: 'item-1', server: 'feishu', tool: 'reply', arguments: {} }))
      .toEqual({ action: null, summary: null, invocation: null, files: [] });
  });
});
