/**
 * How Antigravity ACP tool calls and outputs present themselves on a display
 * line.
 *
 * Mirrors `claude-code/src/tool-display.ts` and `codex/src/tool-display.ts`:
 * this module is the one place in the ACP adapter that knows Antigravity's
 * native tool names, argument keys, and result wrappers. Removing generic
 * `kind`-based classification avoids both double-prefixed relative file titles
 * (`Read File ../../../...`) and MCP tools being labelled as shell commands.
 */

import { win32 } from 'node:path';

import type { ToolCall, ToolCallUpdate } from '@agentclientprotocol/sdk';
import type { JsonValue, RuntimeToolAction } from '@excitedjs/dreamux-types';
import { isPlainObject } from '@excitedjs/dreamux-utils';

export type NativeTool = ToolCall | ToolCallUpdate;

export interface ToolDisplay {
  readonly action: RuntimeToolAction | null;
  readonly summary: string | null;
  readonly invocation: string | null;
  readonly items: readonly string[];
}

export function toolDisplay(tool: NativeTool): ToolDisplay {
  const name = tool.name ?? '';
  const input = isPlainObject(tool.rawInput) ? tool.rawInput : null;
  switch (name) {
    case 'read_file':
      return fileTool('read', filePath(input, tool.locations));
    case 'write_file':
    case 'edit_file':
      return fileTool('edit', filePath(input, tool.locations));
    case 'run_command': {
      const command = rawNonEmptyString(input?.['CommandLine']);
      return {
        action: 'run',
        summary:
          trimmedString(input?.['toolSummary']) ??
          firstLine(command) ??
          trimmedString(tool.title),
        invocation: command,
        items: [],
      };
    }
    case 'search_web':
      return {
        action: 'search',
        summary: trimmedString(input?.['query']),
        invocation: null,
        items: [],
      };
    case 'invoke_subagent':
      return {
        action: null,
        summary: trimmedString(input?.['Role']),
        invocation: rawNonEmptyString(input?.['Prompt']),
        items: [],
      };
    case 'run_workflow':
      return {
        action: null,
        summary: trimmedString(input?.['Description']),
        invocation: rawNonEmptyString(input?.['Script']),
        items: [],
      };
    default: {
      const summary = trimmedString(input?.['toolSummary']);
      return {
        action: null,
        summary: summary === null ? null : `${name} · ${summary}`,
        invocation: null,
        items: [],
      };
    }
  }
}

/**
 * Extract human-readable tool output from an ACP tool update.
 *
 * ACP carries both structured `rawOutput` (which for `run_command` is
 * `{ output, exit_code }`) and display `content` blocks. Prefer joined text
 * blocks when every `content` entry is a text block, then `rawOutput.output`
 * for `run_command`, then `rawOutput` as-is.
 */
export function toolResult(tool: NativeTool): JsonValue | null {
  const contentText = extractContentText(tool.content);
  if (contentText !== null) return contentText;
  if (tool.name === 'run_command' && isPlainObject(tool.rawOutput)) {
    const output = tool.rawOutput['output'];
    if (typeof output === 'string') return output;
  }
  return (tool.rawOutput ?? null) as JsonValue | null;
}

/**
 * Antigravity reports non-zero shell exit codes on `run_command` with native
 * ACP `status: "completed"` and `rawOutput.exit_code !== 0`.
 */
export function isCommandExitFailure(tool: NativeTool): boolean {
  if (tool.name !== 'run_command' || !isPlainObject(tool.rawOutput))
    return false;
  const code = tool.rawOutput['exit_code'];
  return typeof code === 'number' && code !== 0;
}

function fileTool(action: 'read' | 'edit', path: string | null): ToolDisplay {
  return {
    action,
    summary: path === null ? null : fileBasename(path),
    invocation: null,
    items: path === null ? [] : [path],
  };
}

function filePath(
  input: Record<string, unknown> | null,
  locations: NativeTool['locations'],
): string | null {
  const fromInput = rawNonEmptyString(input?.['Path']);
  if (fromInput !== null) return fromInput;
  return rawNonEmptyString(locations?.[0]?.path);
}

function fileBasename(path: string): string | null {
  return win32.basename(path) || null;
}

function extractContentText(content: NativeTool['content']): string | null {
  if (!Array.isArray(content) || content.length === 0) return null;
  const texts: string[] = [];
  for (const entry of content) {
    if (!isPlainObject(entry) || entry['type'] !== 'content') return null;
    const inner = entry['content'];
    if (
      !isPlainObject(inner) ||
      inner['type'] !== 'text' ||
      typeof inner['text'] !== 'string'
    )
      return null;
    texts.push(inner['text']);
  }
  return texts.join('\n');
}

function rawNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function trimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function firstLine(value: string | null): string | null {
  if (value === null) return null;
  const line = value.trimStart().split('\n', 1)[0]?.trimEnd() ?? '';
  return line === '' ? null : line;
}
