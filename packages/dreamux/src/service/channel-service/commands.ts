/** The Channel namespace's canonical Commands. */
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
import type { DispatcherService } from '../dispatcher-service/index.js';

interface ChannelListResult {
  channels: ReturnType<DispatcherService['listChannels']>;
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
