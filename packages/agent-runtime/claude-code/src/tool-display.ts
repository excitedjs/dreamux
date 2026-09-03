/**
 * How claude's built-in tools present themselves on a display line.
 *
 * A tool row wants four neutral facts beside the tool's name: what kind of
 * thing the call does (`action`), the one line claude's own UI leads with
 * (`summary`), the member of the input that has a notation of its own
 * (`invocation`), and the files a file tool touches (`files`). All four come
 * from the tool's declared input schema
 * (`sdk-tools.d.ts` of `@anthropic-ai/claude-agent-sdk`; `Skill` from the
 * CLI's observed wire), so this module is the only place in the runtime that
 * knows a built-in tool's field names. A tool this table does not know —
 * every MCP tool included — gets `null` for all three and shows as its name.
 */

import type { JsonValue, RuntimeToolAction } from '@excitedjs/dreamux-types';

export interface ToolDisplay {
  readonly action: RuntimeToolAction | null;
  readonly summary: string | null;
  readonly invocation: string | null;
  readonly files: readonly string[];
}

const UNKNOWN: ToolDisplay = { action: null, summary: null, invocation: null, files: [] };

export function toolDisplay(name: string | null | undefined, args: JsonValue | null): ToolDisplay {
  const input = inputRecord(args);
  const field = (key: string): string | null => {
    const value = input[key];
    return typeof value === 'string' && value !== '' ? value : null;
  };
  switch (name) {
    case 'Bash':
    case 'PowerShell': {
      const command = field('command');
      return {
        action: 'run',
        summary: field('description') ?? firstLine(command),
        invocation: command,
        files: [],
      };
    }
    case 'Read':
      return fileTool('read', field('file_path'));
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return fileTool('edit', field('file_path'));
    case 'NotebookEdit':
      return fileTool('edit', field('notebook_path'));
    case 'Grep':
    case 'Glob':
      return { action: 'search', summary: field('pattern'), invocation: null, files: [] };
    case 'WebSearch':
      return { action: 'search', summary: field('query'), invocation: null, files: [] };
    case 'ToolSearch':
      return { action: null, summary: field('query'), invocation: null, files: [] };
    case 'WebFetch':
      return { action: null, summary: field('url'), invocation: null, files: [] };
    case 'Agent':
      return { action: null, summary: field('description'), invocation: field('prompt'), files: [] };
    case 'Skill':
      return { action: null, summary: field('skill'), invocation: null, files: [] };
    case 'TaskCreate':
      return { action: null, summary: field('subject'), invocation: null, files: [] };
    case 'REPL':
      return { action: 'run', summary: field('description'), invocation: field('code'), files: [] };
    case 'Workflow':
      return { action: null, summary: field('name'), invocation: field('script'), files: [] };
    default:
      return UNKNOWN;
  }
}

/** A file tool is labelled by the one path it touches, which is also its file list. */
function fileTool(action: 'read' | 'edit', path: string | null): ToolDisplay {
  return { action, summary: path, invocation: null, files: path === null ? [] : [path] };
}

function inputRecord(args: JsonValue | null): Readonly<Record<string, JsonValue>> {
  return args !== null && typeof args === 'object' && !Array.isArray(args)
    ? (args as Readonly<Record<string, JsonValue>>)
    : {};
}

function firstLine(value: string | null): string | null {
  if (value === null) return null;
  const line = value.trimStart().split('\n', 1)[0]?.trimEnd() ?? '';
  return line === '' ? null : line;
}
