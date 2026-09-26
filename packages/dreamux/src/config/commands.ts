/**
 * The Config namespace's canonical Commands.
 *
 * Neither is dispatcher-scoped: `agents[]` is a process-wide fact, addressed
 * the same way `server.status` is, so both definitions read the injected
 * `ConfigService` directly rather than resolving a dispatcher through
 * `mustDispatcher`. There is no `config.dispatchers.*` pair — `dispatchers[]`
 * has no Command and stays a hand-edited, daemon-stopped-only file
 * (`config/service.ts`).
 *
 * `parse` on `config.agents.replace` narrows only as far as matching needs: an
 * array of plain objects, each with a non-empty string `id`. Everything else
 * about an entry — `provider`, `config`, and any key this Command does not
 * know about — passes through untouched. `ConfigService.replaceAgents` merges
 * by `id` and `resolveConfig` (`./load.js`) is the one validator for
 * `provider`/`config` shape and for a duplicate `id`; narrowing either one a
 * second time here would just be a second, out-of-sync copy of that check.
 */
import type { CoreCommandDefinition } from '@excitedjs/dreamux-types';

import type { AnyCoreCommand } from '../command/registry.js';
import { ValidationError } from '../command/errors.js';
import { commandPayload } from '../command/payload.js';
import { NO_INPUT, OBJECT, arrayOf, objectSchema } from '../command/schema.js';
import type { AgentFileEntry, ConfigService } from './service.js';

const AGENTS_SHAPE = objectSchema({ agents: arrayOf(OBJECT) }, ['agents']);

interface ConfigAgentsGetResult {
  agents: AgentFileEntry[];
}

interface ConfigAgentsReplaceInput {
  agents: AgentFileEntry[];
}

interface ConfigAgentsReplaceResult {
  agents: AgentFileEntry[];
}

export function configCommands(
  config: ConfigService,
): readonly AnyCoreCommand[] {
  const get: CoreCommandDefinition<
    'config.agents.get',
    void,
    ConfigAgentsGetResult
  > = {
    name: 'config.agents.get',
    version: 1,
    input: NO_INPUT,
    output: AGENTS_SHAPE,
    parse(payload) {
      commandPayload(payload);
    },
    async execute() {
      return { agents: config.readAgents() };
    },
  };

  const replace: CoreCommandDefinition<
    'config.agents.replace',
    ConfigAgentsReplaceInput,
    ConfigAgentsReplaceResult
  > = {
    name: 'config.agents.replace',
    version: 1,
    input: AGENTS_SHAPE,
    output: AGENTS_SHAPE,
    parse(payload) {
      const params = commandPayload(payload);
      // The declared input schema already proved `agents` is an array of
      // JSON objects; this narrows only the one field replaceAgents matches
      // entries by.
      const rawAgents = params['agents'] as readonly Record<string, unknown>[];
      return {
        agents: rawAgents.map((entry, index) => requireAgentId(entry, index)),
      };
    },
    async execute(_context, input) {
      return { agents: await config.replaceAgents(input.agents) };
    },
  };

  return [get as AnyCoreCommand, replace as AnyCoreCommand];
}

function requireAgentId(
  entry: Record<string, unknown>,
  index: number,
): AgentFileEntry {
  const id = entry['id'];
  if (typeof id !== 'string' || id === '') {
    throw new ValidationError(`agents[${index}].id must be a non-empty string`);
  }
  return entry;
}
