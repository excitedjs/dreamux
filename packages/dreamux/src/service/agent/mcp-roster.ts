/** The compact roster row shared by owner and member MCP list tools. */
import { NULLABLE_STRING, STRING, objectSchema } from '../../command/schema.js';
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
