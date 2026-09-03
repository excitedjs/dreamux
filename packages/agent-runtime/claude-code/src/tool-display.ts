/**
 * How claude's built-in tools present themselves on a display line.
 *
 * A tool row wants three neutral facts beside the tool's name: what kind of
 * thing the call does (`action`), the one line claude's own UI leads with
 * (`summary`), and the member of the input that has a notation of its own
 * (`invocation`). All three come from the tool's declared input schema
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
}

const UNKNOWN: ToolDisplay = { action: null, summary: null, invocation: null };

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
      };
    }
    case 'Read':
      return { action: 'read', summary: field('file_path'), invocation: null };
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return { action: 'edit', summary: field('file_path'), invocation: null };
    case 'NotebookEdit':
      return { action: 'edit', summary: field('notebook_path'), invocation: null };
    case 'Grep':
    case 'Glob':
      return { action: 'search', summary: field('pattern'), invocation: null };
    case 'WebSearch':
      return { action: 'search', summary: field('query'), invocation: null };
    case 'ToolSearch':
      return { action: null, summary: field('query'), invocation: null };
    case 'WebFetch':
      return { action: null, summary: field('url'), invocation: null };
    case 'Agent':
      return { action: null, summary: field('description'), invocation: field('prompt') };
    case 'Skill':
      return { action: null, summary: field('skill'), invocation: null };
    case 'TaskCreate':
      return { action: null, summary: field('subject'), invocation: null };
    case 'REPL':
      return { action: 'run', summary: field('description'), invocation: field('code') };
    case 'Workflow':
      return { action: null, summary: field('name'), invocation: field('script') };
    default:
      return UNKNOWN;
  }
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
