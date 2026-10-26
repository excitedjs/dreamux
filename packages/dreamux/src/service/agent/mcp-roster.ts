/** The compact roster row shared by owner and member MCP list tools. */
import type { CommandPayload } from '../../command/payload.js';
import { NULLABLE_STRING, STRING, objectSchema } from '../../command/schema.js';
import { listPage } from '../mcp/list-page.js';
import type { AgentEntityRuntimeStatus } from './identity.js';

export const TEAMMATE_LIST_STATUSES = [
  'starting',
  'running',
  'degraded',
  'closed',
  'stopped',
] as const;

export const TEAMMATE_ROSTER_ROW_SCHEMA = objectSchema(
  {
    name: STRING,
    status: STRING,
    agent_runtime: STRING,
    intent: NULLABLE_STRING,
  },
  ['name', 'status', 'agent_runtime', 'intent'],
);

export function teammateRosterRow({
  name,
  status,
  agent_runtime,
  intent,
}: AgentEntityRuntimeStatus) {
  return { name, status, agent_runtime, intent };
}

/**
 * One page of roster rows. An owner lists every TeamMate it holds; a member
 * lists the same collection minus itself, and the exclusion is applied before
 * `total` is counted.
 */
export function teammateRosterPage(
  rows: readonly AgentEntityRuntimeStatus[],
  args: CommandPayload,
  exclude?: (row: AgentEntityRuntimeStatus) => boolean,
) {
  const page = listPage(rows, args, TEAMMATE_LIST_STATUSES, exclude);
  return {
    teammates: page.items.map(teammateRosterRow),
    total: page.total,
    next_cursor: page.next_cursor,
  };
}
