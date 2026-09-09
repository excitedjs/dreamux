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
    })).toEqual({ action: 'run', summary: 'npm test', invocation: 'npm test\necho done', items: [] });
  });

  it.each([
    ['/usr/bin/zsh', '-lc'],
    ['zsh', '-c'],
    ['/bin/bash', '-lc'],
    ['bash', '-c'],
    ['/bin/sh', '-c'],
    ['sh', '-lc'],
    ['bash.exe', '-lc'],
    ['/bin/zsh.backup.exe', '-c'],
  ])('unwraps %s %s without changing the inner script', (shell, flag) => {
    expect(toolDisplay({
      type: 'commandExecution',
      id: 'item-1',
      command: `${shell} ${flag} 'node --check script.mjs'`,
    })).toEqual({ action: 'run', summary: 'node --check script.mjs', invocation: 'node --check script.mjs', items: [] });
  });

  it.each([
    [String.raw`/bin/zsh -lc "python3 -c 'print(\"Hello, world!\")'"`, `python3 -c 'print("Hello, world!")'`],
    [String.raw`bash -c 'printf '\''%s'\'' "value"'`, `printf '%s' "value"`],
    [String.raw`bash -c 'printf '"'%s'"' value'`, `printf '%s' value`],
    ['bash -c "echo \\$HOME \\`date\\` \\\\path \\q"', 'echo $HOME `date` \\path \\q'],
    [String.raw`bash -c 'echo "$HOME" $(pwd) && printf "%s" "雪" | wc -c'`, 'echo "$HOME" $(pwd) && printf "%s" "雪" | wc -c'],
    ['bash -c "node --check script.mjs\necho done"', 'node --check script.mjs\necho done'],
    ['bash -c "echo one\\\ntwo"', 'echo onetwo'],
    ['bash -c echo\\\nhello', 'echohello'],
    ["bash -c 'echo one\\\ntwo'", 'echo one\\\ntwo'],
    ["bash -c 'bash -c echo'", 'bash -c echo'],
    ["bash -c ''", ''],
    ["bash -c '  echo hello'", '  echo hello'],
    ["bash -c 'echo one\r\necho two'", 'echo one\r\necho two'],
    ["# launcher\n bash\t-c 'echo hello' # trailing comment", 'echo hello'],
    ["bash -c echo#literal", 'echo#literal'],
  ])('decodes shell quoting in %s', (command, script) => {
    expect(toolDisplay({ type: 'commandExecution', id: 'item-1', command })).toEqual({
      action: 'run',
      summary: script.trimStart().split('\n', 1)[0]?.trimEnd() || null,
      invocation: script,
      items: [],
    });
  });

  it.each([
    'pwsh -Command',
    'powershell.exe -c',
    '/usr/local/bin/pwsh -NoLogo -NoProfile -Command',
    'pwsh -nOpRoFiLe -COMMAND',
  ])('unwraps %s using the upstream PowerShell flag rules', (prefix) => {
    expect(toolDisplay({
      type: 'commandExecution',
      id: 'item-1',
      command: `${prefix} 'Write-Host "$HOME"'`,
    })).toEqual({ action: 'run', summary: 'Write-Host "$HOME"', invocation: 'Write-Host "$HOME"', items: [] });
  });

  it('uses the argument following PowerShell -Command without interpreting its script or trailing arguments', () => {
    const script = 'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\nWrite-Host hi';
    expect(toolDisplay({
      type: 'commandExecution',
      id: 'item-1',
      command: `pwsh -Command '${script}' extra`,
    })).toMatchObject({ summary: script.split('\n')[0], invocation: script });
  });

  it.each([
    'npm test\necho done',
    '  node  --check "script.mjs"',
    '/usr/bin/fish -c "echo hi"',
    'BASH -c "echo hi"',
    'env bash -c "echo hi"',
    'bash --login -c "echo hi"',
    'bash -l -c "echo hi"',
    'bash -lc "echo hi" argument',
    'bash -lc',
    'bash -lc "echo hi',
    "bash -lc 'echo hi",
    'bash -c echo\\',
    'pwsh -File script.ps1',
    'pwsh -ExecutionPolicy Bypass -Command "Write-Host hi"',
    'pwsh -NoProfile -Command',
    String.raw`C:\Program Files\Git\bin\bash.exe -lc "echo hi"`,
    String.raw`bash -c 'echo C:\work'`,
  ])('preserves an ordinary or unrecognized command: %s', (command) => {
    expect(toolDisplay({ type: 'commandExecution', id: 'item-1', command })).toEqual({
      action: 'run',
      summary: command.trimStart().split('\n', 1)[0]?.trimEnd() || null,
      invocation: command,
      items: [],
    });
  });

  it.each([
    [String.raw`bash -c "echo C:\\work"`, String.raw`echo C:\work`],
    [String.raw`bash -c "echo C:\\work "'$HOME'`, String.raw`echo C:\work $HOME`],
    [String.raw`bash -c "echo C:\\work "'^caret'`, String.raw`echo C:\work ^caret`],
    [String.raw`bash -c "echo C:\\work '雪'"`, String.raw`echo C:\work '雪'`],
    [String.raw`bash -c "echo C:\\work "'!'`, String.raw`echo C:\work !`],
  ])('accepts canonical Windows drive-path quoting: %s', (command, script) => {
    expect(toolDisplay({ type: 'commandExecution', id: 'item-1', command }))
      .toEqual({ action: 'run', summary: script, invocation: script, items: [] });
  });

  it.each([
    { type: 'read', name: 'a.rs', path: '/repo/a.rs', action: 'read', summary: 'a.rs', items: ['/repo/a.rs'] },
    { type: 'listFiles', path: 'src', action: 'list_files', summary: 'src', items: [] },
    { type: 'search', query: 'TODO', path: 'src', action: 'search', summary: 'TODO in src', items: [] },
  ])('keeps the $type label and items while unwrapping its invocation', ({ action, summary, items, ...entry }) => {
    expect(toolDisplay({
      type: 'commandExecution',
      id: 'item-1',
      command: "zsh -lc 'cat a.rs | grep TODO'",
      commandActions: [entry],
    })).toEqual({ action, summary, invocation: 'cat a.rs | grep TODO', items });
  });

  it('uses the whole decoded script rather than lossy mixed action fragments', () => {
    expect(toolDisplay({
      type: 'commandExecution',
      id: 'item-1',
      command: "zsh -lc 'cat a.rs | grep TODO\necho done'",
      commandActions: [
        { type: 'read', name: 'a.rs', path: '/repo/a.rs', command: 'cat a.rs' },
        { type: 'search', query: 'TODO', command: 'grep TODO' },
      ],
    })).toEqual({ action: 'run', summary: 'cat a.rs | grep TODO', invocation: 'cat a.rs | grep TODO\necho done', items: [] });
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
    })).toMatchObject({ action: 'read', summary: 'SKILL.md, README.md', items: ['/repo/SKILL.md', '/repo/README.md'] });
  });

  it('labels a search by its query and path', () => {
    expect(toolDisplay({
      type: 'commandExecution',
      id: 'item-1',
      command: 'rg TODO src',
      commandActions: [{ type: 'search', command: 'rg TODO src', query: 'TODO', path: 'src' }],
    })).toEqual({ action: 'search', summary: 'TODO in src', invocation: 'rg TODO src', items: [] });
  });

  it('labels an all-listing command by the paths it listed', () => {
    expect(toolDisplay({
      type: 'commandExecution',
      id: 'item-1',
      command: 'ls src && ls tests',
      commandActions: [
        { type: 'listFiles', command: 'ls src', path: 'src' },
        { type: 'listFiles', command: 'ls tests', path: 'tests' },
      ],
    })).toEqual({ action: 'list_files', summary: 'src, tests', invocation: 'ls src && ls tests', items: [] });
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
    })).toEqual({ action: 'run', summary: 'cat a.rs | grep TODO', invocation: 'cat a.rs | grep TODO', items: [] });
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
      items: ['/repo/a.rs', '/repo/b.rs'],
    });
  });

  it('labels a web search by what was searched, per action kind', () => {
    expect(toolDisplay({ type: 'webSearch', id: 'item-1', query: 'rust async traits', action: null }))
      .toEqual({ action: 'search', summary: 'rust async traits', invocation: null, items: [] });
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
    expect(toolDisplay({
      type: 'webSearch',
      id: 'item-1',
      query: 'x',
      action: { type: 'openPage', url: 'https://example.test/page' },
    })).toMatchObject({ action: 'search', summary: 'https://example.test/page' });
  });

  it('labels nothing for an MCP tool call', () => {
    expect(toolDisplay({ type: 'mcpToolCall', id: 'item-1', server: 'feishu', tool: 'reply', arguments: {} }))
      .toEqual({ action: null, summary: null, invocation: null, items: [] });
  });
});
