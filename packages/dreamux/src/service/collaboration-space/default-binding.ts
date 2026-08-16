import type { DreamuxConfig } from '../../config/config.js';
import { resolveAgent } from '../agent-entity/agent-config.js';
import { validateTeamId } from '../team-collection/types.js';
import type {
  CollaborationSpaceBindTransition,
  CollaborationSpaceStore,
} from './store.js';
import type {
  CollaborationSpaceDefaultBindingInput,
  CollaborationSpaceProvisionInput,
} from './types.js';
import { COLLABORATION_SPACE_RECORD_VERSION } from './types.js';
import { hashContainer } from './naming.js';

export async function createDefaultBoundSpace(input: {
  dispatcherId: string;
  config: DreamuxConfig;
  store: CollaborationSpaceStore;
  provision: CollaborationSpaceProvisionInput;
  binding: CollaborationSpaceDefaultBindingInput;
}): Promise<CollaborationSpaceBindTransition> {
  const { dispatcherId, config, store, provision, binding } = input;
  resolveAgent(config, dispatcherId, binding.leaderAgentRuntime);
  const spaceName = validateTeamId(
    `space-${hashContainer({
      dispatcherId,
      channelId: provision.channelId,
      containerKey: provision.container.container_key,
    })}`,
  );
  const now = Date.now();
  return store.saveDefaultBoundSpace({
    version: COLLABORATION_SPACE_RECORD_VERSION,
    dispatcher_id: dispatcherId,
    space_name: spaceName,
    channel_id: provision.channelId,
    provider: provision.provider,
    container_type: provision.container.container_type,
    container_key: provision.container.container_key,
    display: provision.container.display ?? null,
    canonical_url: provision.container.canonical_url ?? null,
    meta: provision.container.meta ?? {},
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
