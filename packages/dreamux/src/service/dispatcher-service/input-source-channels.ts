import type {
  ChannelSession,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type { ChannelProviderCatalog } from '../../channel/catalog.js';
import type { DreamuxConfig } from '../../config/config.js';
import type { DispatcherStore } from '../../state/dispatcher-store.js';
import type { AgentIdentityStore } from '../agent-entity/identity-store.js';
import type { AgentTurnsStore } from '../agent-entity/turns-store.js';
import type { ChannelService } from '../channel-service/index.js';
import type { CollaborationSpaceService } from '../collaboration-space/index.js';
import type { CompletionRouter } from '../completion-router/index.js';
import type { DispatcherCoreEventBus } from '../dispatcher-core-events/index.js';
import { ensureDispatcherWorkspace } from '../dispatcher-workspace.js';
import type { TeammateService } from '../teammate-service/index.js';
import { createDispatcherAgent } from './agent.js';
import { handleCollaborationTargetLifecycle } from './collaboration-routing.js';
import { ensureDispatcherRootIdentity } from './identity.js';
import { dispatcherMcpServerDescriptors } from './mcp-descriptors.js';
import { asInboundDeliveryResult } from './runtime-helpers.js';
import { assertRunnableChannelShape } from './runnable-channel.js';
import type { DispatcherScopedChannelRouting } from './scoped-channel-routing.js';

interface PrepareDispatcherChannelResourcesInput {
  dispatcherId: string;
  config: DreamuxConfig;
  dispatchers: DispatcherStore;
  channelProviders: ChannelProviderCatalog;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  identities: AgentIdentityStore;
  turnsStore: AgentTurnsStore;
  router: CompletionRouter;
  log: DreamuxLogger;
  channels: ChannelService;
  adminSocketPath: string;
}

export async function prepareDispatcherChannelResources(
  input: PrepareDispatcherChannelResourcesInput,
): Promise<{
  workspaceCwd: string;
  agent: TeammateService;
  sessions: Map<string, ChannelSession>;
}> {
  const row = input.dispatchers.get(input.dispatcherId);
  if (row === null) throw new Error(`no dispatcher '${input.dispatcherId}'`);
  const dispatcherConfig = input.config.dispatchers.find(
    (dispatcher) => dispatcher.id === input.dispatcherId,
  );
  if (dispatcherConfig === undefined) {
    throw new Error(`dispatcher '${input.dispatcherId}' has no config entry`);
  }
  assertRunnableChannelShape(dispatcherConfig, input.channelProviders);
  const workspaceCwd = await ensureDispatcherWorkspace(
    input.config,
    input.dispatcherId,
  );
  const identity = await ensureDispatcherRootIdentity({
    identities: input.identities,
    dispatcherId: input.dispatcherId,
    agentRuntime: dispatcherConfig.agentRuntime,
    cwd: workspaceCwd,
  });
  const agent = createDispatcherAgent({
    id: input.dispatcherId,
    config: input.config,
    agentRuntimeProviders: input.agentRuntimeProviders,
    identities: input.identities,
    turnsStore: input.turnsStore,
    router: input.router,
    log: input.log,
    mcpServers: dispatcherMcpServerDescriptors({
      dispatcherId: input.dispatcherId,
      channels: input.channels.configuredChannels(),
      channelProviders: input.channelProviders,
      adminSocketPath: input.adminSocketPath,
    }),
    identity,
  });
  return {
    workspaceCwd,
    agent,
    sessions: await input.channels.build(),
  };
}

interface StartPreparedDispatcherChannelsInput {
  dispatcherId: string;
  dispatcherAgentRuntime(): string;
  sessions: Map<string, ChannelSession>;
  channels: ChannelService;
  channelRoutes: DispatcherScopedChannelRouting;
  collaborationSpaces: CollaborationSpaceService;
  coreEvents: DispatcherCoreEventBus;
  log: DreamuxLogger;
  assertAvailable(): void;
}

export async function startPreparedDispatcherChannels(
  input: StartPreparedDispatcherChannelsInput,
): Promise<void> {
  const liveChannels = new Map<string, ChannelSession>();
  for (const [channelId, session] of input.sessions) {
    const coreEvents = input.coreEvents.createSource(channelId);
    const strictRoutes = input.channelRoutes.createSessionLease(channelId);
    await session.start({
      deliver: async (turn, envelope) =>
        asInboundDeliveryResult(
          await input.channelRoutes.route(channelId, turn, envelope),
        ),
      targetLifecycle: (event) =>
        handleCollaborationTargetLifecycle({
          dispatcherId: input.dispatcherId,
          dispatcherAgentRuntime: input.dispatcherAgentRuntime(),
          channelId,
          event,
          channels: input.channels,
          collaborationSpaces: input.collaborationSpaces,
          log: input.log,
        }),
      coreEvents: coreEvents.source,
      ensureCollaborationTarget: strictRoutes.ensure,
      deliverExact: strictRoutes.deliverExact,
    });
    input.assertAvailable();
    liveChannels.set(channelId, session);
    input.channels.adopt(liveChannels);
  }
  if (input.sessions.size === 0) input.channels.adopt(liveChannels);
}
