import type { DreamuxConfig } from '../../config/config.js';
import { resolveAgent } from '../teammate-collection/agent-config.js';
import { validateTeamId } from '../team-collection/types.js';
import type { CollaborationSpaceStore } from './store.js';
import type {
  CollaborationSpaceDefaultBindingInput,
  CollaborationSpaceRecord,
} from './types.js';
import type { ChannelContainer } from '@excitedjs/dreamux-types';
import { COLLABORATION_SPACE_RECORD_VERSION } from './types.js';
import { defaultSpaceName } from './naming.js';

export async function createDefaultBoundSpace(input: {
  dispatcherId: string;
  config: DreamuxConfig;
  store: CollaborationSpaceStore;
  channelId: string;
  provider: string;
  container: ChannelContainer;
  binding: CollaborationSpaceDefaultBindingInput;
}): Promise<CollaborationSpaceRecord> {
  const { dispatcherId, config, store, channelId, provider, container, binding } = input;
  resolveAgent(config, dispatcherId, binding.leaderAgentRuntime);
  const spaceName = validateTeamId(
    defaultSpaceName({
      dispatcherId,
      channelId,
      containerType: container.container_type,
      containerKey: container.container_key,
    }),
  );
  const now = Date.now();
  return store.saveDefaultBoundSpace({
    version: COLLABORATION_SPACE_RECORD_VERSION,
    dispatcher_id: dispatcherId,
    space_name: spaceName,
    channel_id: channelId,
    provider,
    container_type: container.container_type,
    container_key: container.container_key,
    display: container.display ?? null,
    canonical_url: container.canonical_url ?? null,
    current_binding: {
      generation: 1,
      repo_cwd: binding.repo?.cwd ?? null,
      worktree: binding.repo === undefined
        ? { mode: 'default' }
        : {
            mode: 'managed',
            base_ref: binding.repo.baseRef ?? null,
            cleanup: 'delete-on-close',
          },
      leader_agent_runtime: binding.leaderAgentRuntime,
      identity: binding.identity ?? null,
      ...(binding.repositoryPolicy !== undefined
        ? { repository_policy: binding.repositoryPolicy }
        : {}),
      bound_at: now,
    },
    last_binding_generation: 1,
    status: 'bound',
    created_at: now,
    updated_at: now,
    unbound_at: null,
    unbound_note: null,
  });
}
