/**
 * How codex's thread items present themselves on a display line.
 *
 * A tool row wants three neutral facts beside the tool's name: what kind of
 * thing the item does (`action`), the one line codex's own TUI leads with
 * (`summary`), and the member of the item that has a notation of its own
 * (`invocation`). The wording follows the TUI's exec, patch and web-search
 * cells (`codex-rs/tui/src/exec_cell`, `diff_render.rs`, `history_cell/search.rs`)
 * so that a card and a terminal describe one call the same way. An item this
 * module does not label — MCP and dynamic tool calls included — gets `null`
 * for summary and invocation and shows as its name.
 */

import type { RuntimeToolAction } from '@excitedjs/dreamux-types';

import type { ThreadItem } from './types.js';

export interface ToolDisplay {
  readonly action: RuntimeToolAction | null;
  readonly summary: string | null;
  readonly invocation: string | null;
}

const UNKNOWN: ToolDisplay = { action: null, summary: null, invocation: null };

export function toolDisplay(item: ThreadItem): ToolDisplay {
  switch (item.type) {
    case 'commandExecution': return commandDisplay(item);
    case 'fileChange': return fileChangeDisplay(item);
    case 'webSearch': return webSearchDisplay(item);
    default: return UNKNOWN;
  }
}

/**
 * One parsed member of a shell command, as codex's own best-effort parse
 * reports it (`commandActions[]`): what the TUI groups into an "Explored"
 * cell and labels `Read name` / `List path` / `Search query in path`.
 */
interface CommandAction {
  readonly action: RuntimeToolAction;
  readonly detail: string | null;
}

function commandDisplay(item: ThreadItem): ToolDisplay {
  const command = stringField(item, 'command');
  const actions = commandActions(item['commandActions']);
  const first = actions[0];
  const uniform = first !== undefined && actions.every((entry) => entry.action === first.action);
  if (!uniform || first.action === 'run') {
    return { action: 'run', summary: firstLine(command), invocation: command };
  }
  const details = [...new Set(actions.map((entry) => entry.detail).filter((d): d is string => d !== null))];
  return {
    action: first.action,
    summary: details.length === 0 ? firstLine(command) : details.join(', '),
    invocation: command,
  };
}

function commandActions(value: unknown): CommandAction[] {
  if (!Array.isArray(value)) return [];
  const actions: CommandAction[] = [];
  for (const entry of value) {
    const record = recordValue(entry);
    if (record === null) continue;
    switch (record['type']) {
      case 'read':
        actions.push({ action: 'read', detail: stringField(record, 'name') });
        break;
      case 'listFiles':
        actions.push({ action: 'list_files', detail: stringField(record, 'path') });
        break;
      case 'search': {
        const query = stringField(record, 'query');
        const path = stringField(record, 'path');
        actions.push({
          action: 'search',
          detail: query !== null && path !== null ? `${query} in ${path}` : query ?? path,
        });
        break;
      }
      default:
        actions.push({ action: 'run', detail: null });
    }
  }
  return actions;
}

/**
 * A patch, labelled by the files it touches and shown as the diff codex
 * prepared: a unified diff for an update, the whole content for an added or
 * deleted file — the shapes `item_builders.rs` puts on the wire.
 */
function fileChangeDisplay(item: ThreadItem): ToolDisplay {
  const changes = Array.isArray(item['changes'])
    ? item['changes'].map(recordValue).filter((c): c is Record<string, unknown> => c !== null)
    : [];
  const paths = [...new Set(changes.map((c) => stringField(c, 'path')).filter((p): p is string => p !== null))];
  const diffs = changes.flatMap((change) => {
    const path = stringField(change, 'path');
    const diff = stringField(change, 'diff');
    return diff === null ? [] : [path === null ? diff : `${path}\n${diff}`];
  });
  return {
    action: 'edit',
    summary: paths.length === 0 ? null : paths.join(', '),
    invocation: diffs.length === 0 ? null : diffs.join('\n\n'),
  };
}

/** "Searched the web for …", with the detail the TUI picks per action kind. */
function webSearchDisplay(item: ThreadItem): ToolDisplay {
  const query = stringField(item, 'query');
  const action = recordValue(item['action']);
  let detail: string | null = null;
  switch (action?.['type']) {
    case 'search': {
      const queries = Array.isArray(action['queries'])
        ? action['queries'].filter((q): q is string => typeof q === 'string' && q !== '')
        : [];
      detail = stringField(action, 'query') ??
        (queries.length === 0 ? null : queries.length === 1 ? queries[0]! : `${queries[0]!} …`);
      break;
    }
    case 'openPage':
      detail = stringField(action, 'url');
      break;
    case 'findInPage': {
      const pattern = stringField(action, 'pattern');
      const url = stringField(action, 'url');
      detail = pattern !== null && url !== null ? `'${pattern}' in ${url}` : pattern === null ? url : `'${pattern}'`;
      break;
    }
    default:
      break;
  }
  return { action: 'search', summary: detail ?? query, invocation: null };
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstLine(value: string | null): string | null {
  if (value === null) return null;
  const line = value.trimStart().split('\n', 1)[0]?.trimEnd() ?? '';
  return line === '' ? null : line;
}
