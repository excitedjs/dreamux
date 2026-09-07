/**
 * The Channel namespace's read-only inventory Commands.
 *
 * Hosts need to inspect configured Channels without starting sessions or
 * asking an agent to take a turn. The dispatcher supplies that public metadata
 * through its existing ChannelService; provider configuration stays private.
 * This inventory does not restore the retired Channel MCP proxy Commands
 * (`channel.invoke_tool` / `channel.mcp.*`): provider tools remain behind the
 * runtime-bound MCP delegates and the generic `mcp.*` transport Commands.
 */
import type { CoreCommandDefinition } from '@excitedjs/dreamux-types';

import { mustDispatcher, type CoreCommandHost } from '../../command/host.js';
import { commandPayload } from '../../command/payload.js';
import type { AnyCoreCommand } from '../../command/registry.js';
import {
  BOOLEAN,
  NO_INPUT,
  STRING,
  arrayOf,
  objectSchema,
} from '../../command/schema.js';
import type { ChannelMetadata } from './types.js';

interface ChannelListResult {
  channels: ChannelMetadata[];
}

export function channelCommands(host: CoreCommandHost): readonly AnyCoreCommand[] {
  const list: CoreCommandDefinition<'channel.list', void, ChannelListResult> = {
    name: 'channel.list',
    version: 1,
    input: NO_INPUT,
    output: objectSchema(
      {
        channels: arrayOf(objectSchema(
          { channel_id: STRING, provider: STRING, identity: STRING, live: BOOLEAN },
          ['channel_id', 'provider', 'identity', 'live'],
        )),
      },
      ['channels'],
    ),
    parse(payload) {
      commandPayload(payload);
    },
    async execute(context) {
      return { channels: mustDispatcher(host, context).listChannels() };
    },
  };

  return [list] as unknown as readonly AnyCoreCommand[];
}
