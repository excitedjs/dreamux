/**
 * The display facts the runtime derives from a built-in tool's input.
 *
 * Inputs follow the declared schemas in `sdk-tools.d.ts`; `Skill` follows
 * the shape observed on the wire. No `claude` binary is needed.
 */

import { describe, expect, it } from 'vitest';

import { toolDisplay } from '../src/tool-display.js';

describe('toolDisplay', () => {
  it('leads a Bash call with its stated description and keeps the command line as the invocation', () => {
    expect(toolDisplay('Bash', { command: 'git status --short', description: 'Show working tree status' }))
      .toEqual({ action: 'run', summary: 'Show working tree status', invocation: 'git status --short', items: [] });
  });

  it('falls back to the first line of an undescribed command', () => {
    expect(toolDisplay('Bash', { command: '\ncd repo && npm test\necho done\n' }))
      .toEqual({ action: 'run', summary: 'cd repo && npm test', invocation: '\ncd repo && npm test\necho done\n', items: [] });
  });

  it('labels file tools by the path they touch, which is also their one item, with nothing to invoke', () => {
    expect(toolDisplay('Read', { file_path: '/repo/src/a.ts', offset: 10 }))
      .toEqual({ action: 'read', summary: '/repo/src/a.ts', invocation: null, items: ['/repo/src/a.ts'] });
    expect(toolDisplay('Edit', { file_path: '/repo/src/a.ts', old_string: 'x', new_string: 'y' }))
      .toEqual({ action: 'edit', summary: '/repo/src/a.ts', invocation: null, items: ['/repo/src/a.ts'] });
    expect(toolDisplay('NotebookEdit', { notebook_path: '/repo/n.ipynb', new_source: '' }))
      .toEqual({ action: 'edit', summary: '/repo/n.ipynb', invocation: null, items: ['/repo/n.ipynb'] });
  });

  it('labels searches by their pattern or query', () => {
    expect(toolDisplay('Grep', { pattern: 'TODO', path: 'src' }))
      .toEqual({ action: 'search', summary: 'TODO', invocation: null, items: [] });
    expect(toolDisplay('Glob', { pattern: '**/*.ts' }))
      .toEqual({ action: 'search', summary: '**/*.ts', invocation: null, items: [] });
    expect(toolDisplay('WebSearch', { query: 'vitest mock timers' }))
      .toEqual({ action: 'search', summary: 'vitest mock timers', invocation: null, items: [] });
  });

  it('labels a sub-agent by its short description and hands the task text over as the invocation', () => {
    expect(toolDisplay('Agent', { description: 'Audit the docs', prompt: 'Read every page and list gaps.' }))
      .toEqual({ action: null, summary: 'Audit the docs', invocation: 'Read every page and list gaps.', items: [] });
  });

  it('labels a skill load by the skill name', () => {
    expect(toolDisplay('Skill', { skill: 'team-workflow' }))
      .toEqual({ action: null, summary: 'team-workflow', invocation: null, items: [] });
  });

  it('knows nothing about a tool outside the built-in table', () => {
    expect(toolDisplay('mcp__dreamux__spawn', { name: 'scout', prompt: 'go' }))
      .toEqual({ action: null, summary: null, invocation: null, items: [] });
    expect(toolDisplay(undefined, null))
      .toEqual({ action: null, summary: null, invocation: null, items: [] });
  });

  it('keeps the action when a known tool arrives with an input it cannot label', () => {
    expect(toolDisplay('Bash', null)).toEqual({ action: 'run', summary: null, invocation: null, items: [] });
    expect(toolDisplay('Read', { file_path: '' })).toEqual({ action: 'read', summary: null, invocation: null, items: [] });
  });
});
