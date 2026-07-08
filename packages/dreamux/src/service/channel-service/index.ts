import type {
  AgentRuntimeMcpServer,
  ChannelSession,
  ChannelTarget,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import type { ChannelProviderCatalog } from '../../channel/catalog.js';
import type {
  DispatcherChannelConfig,
  DreamuxConfig,
} from '../../config/config.js';
import type { ChannelBinding } from '../channel-binding/store.js';
import { ChannelBindingStore } from '../channel-binding/store.js';
import type { ChannelMcpCallerScope } from './mcp-descriptors.js';
import { ChannelSessions } from './channel-sessions.js';
import { ChannelToolAuthorizationError } from './errors.js';

export interface ChannelRouteOwner {
  kind: 'team';
  teamName: string;
  leaderName: string;
}

export interface ChannelBindingSummary {
  channel_id: string;
  provider: string;
  target_type: string;
  target_key: string;
  display: string | null;
  canonical_url: string | null;
}

export interface ChannelServiceOptions {
  dispatcherId: string;
  config: DreamuxConfig;
  channelProviders: ChannelProviderCatalog;
  bindings?: ChannelBindingStore;
  channelLoggerFactory: (dispatcherId: string) => DreamuxLogger;
  adminSocketPath?: string;
}

export interface ChannelToolInvocation {
  providerRef?: string;
  channelId?: string;
  name: string;
  arguments: Record<string, unknown>;
}

export class ChannelService {
  private readonly dispatcherId: string;
  private readonly sessions: ChannelSessions;
  private readonly bindings: ChannelBindingStore;

  constructor(opts: ChannelServiceOptions) {
    this.dispatcherId = opts.dispatcherId;
    this.bindings = opts.bindings ?? new ChannelBindingStore();
    this.sessions = new ChannelSessions({
      dispatcherId: opts.dispatcherId,
      config: opts.config,
      channelProviders: opts.channelProviders,
      channelLoggerFactory: opts.channelLoggerFactory,
      ...(opts.adminSocketPath !== undefined
        ? { adminSocketPath: opts.adminSocketPath }
        : {}),
    });
  }

  live(): Map<string, ChannelSession> {
    return this.sessions.live();
  }

  build(): Promise<Map<string, ChannelSession>> {
    return this.sessions.build();
  }

  adopt(channels: Map<string, ChannelSession>): void {
    this.sessions.adopt(channels);
  }

  configuredChannels(): readonly DispatcherChannelConfig[] {
    return this.sessions.configuredChannels();
  }

  clear(): void {
    this.sessions.clear();
  }

  closeAll(log: DreamuxLogger): Promise<void> {
    return this.sessions.closeAll(log);
  }

  channelMcpServerDescriptorsForCaller(
    scope: ChannelMcpCallerScope,
  ): AgentRuntimeMcpServer[] {
    return this.sessions.channelMcpServerDescriptorsForCaller(scope);
  }

  async invokeTool(input: ChannelToolInvocation): Promise<unknown> {
    const channelId = this.resolveToolChannelId(
      input.channelId,
      input.providerRef,
    );
    return this.sessions.invokeTool({
      ...(input.providerRef !== undefined ? { providerRef: input.providerRef } : {}),
      name: input.name,
      arguments: input.arguments,
      channelId,
    });
  }

  async authorizeTeamLeaderEgress(input: {
    owner: ChannelRouteOwner;
    channelId?: string;
    providerRef?: string;
    arguments: Record<string, unknown>;
  }): Promise<{ channelId: string; target: ChannelTarget }> {
    const channelId = this.resolveToolChannelId(
      input.channelId,
      input.providerRef,
    );
    let target: ChannelTarget;
    try {
      target = await this.resolveTarget(input.arguments, channelId);
    } catch {
      throw new ChannelToolAuthorizationError(
        'BAD_REQUEST',
        'TeamLeader channel tools require a resolvable target',
      );
    }

    const messageId = input.arguments['message_id'];
    if (
      typeof messageId === 'string' &&
      !(await this.messageBelongsToTarget(target, messageId, channelId))
    ) {
      throw new ChannelToolAuthorizationError(
        'CHANNEL_SCOPE_DENIED',
        'TeamLeader may act only on messages observed in bound team channels',
      );
    }

    const allowedChannelId = await this.ownerCanUseTarget({
      owner: input.owner,
      targetKey: target.target_key,
    });
    if (allowedChannelId === null) {
      throw new ChannelToolAuthorizationError(
        'CHANNEL_SCOPE_DENIED',
        'TeamLeader may use channels only for bound team channels',
      );
    }
    if (allowedChannelId !== channelId) {
      throw new ChannelToolAuthorizationError(
        'CHANNEL_SCOPE_DENIED',
        'TeamLeader may use only the channel MCP server bound to the target',
      );
    }
    return { channelId, target };
  }

  async bindTarget(input: {
    owner: ChannelRouteOwner;
    channelId?: string;
    meta: Record<string, unknown>;
  }): Promise<ChannelBinding> {
    const channelId = this.resolveChannelId(input.channelId);
    const target = await this.resolveTarget(input.meta, channelId);
    return this.bindings.bind({
      dispatcherId: this.dispatcherId,
      channelId,
      provider: this.channelProviderRef(channelId),
      target,
      teamName: input.owner.teamName,
      leaderName: input.owner.leaderName,
    });
  }

  async transferBack(input: {
    expectedOwner?: ChannelRouteOwner;
    channelId?: string;
    meta: Record<string, unknown>;
  }): Promise<ChannelBinding | null> {
    const channelId = this.resolveChannelId(input.channelId);
    const target = await this.resolveTarget(input.meta, channelId);
    const binding = await this.bindings.resolve({
      dispatcherId: this.dispatcherId,
      channelId,
      targetKey: target.target_key,
    });
    if (binding === null) return null;
    if (
      input.expectedOwner !== undefined &&
      !ownerMatchesBinding(input.expectedOwner, binding)
    ) {
      throw new Error(
        `channel target '${target.target_key}' is bound to Team ` +
          `${JSON.stringify(binding.team_name)} leader ` +
          `${JSON.stringify(binding.leader_name)}, not Team ` +
          `${JSON.stringify(input.expectedOwner.teamName)} leader ` +
          `${JSON.stringify(input.expectedOwner.leaderName)}`,
      );
    }
    return this.bindings.transferBack({
      dispatcherId: this.dispatcherId,
      channelId,
      targetKey: target.target_key,
    });
  }

  async resolveInboundBinding(input: {
    channelId: string;
    target: ChannelTarget;
  }): Promise<{ binding: ChannelBinding; owner: ChannelRouteOwner } | null> {
    const binding = await this.bindings.resolve({
      dispatcherId: this.dispatcherId,
      channelId: input.channelId,
      targetKey: input.target.target_key,
    });
    if (binding === null) return null;
    return { binding, owner: ownerFromBinding(binding) };
  }

  async ownerCanUseTarget(input: {
    owner: ChannelRouteOwner;
    targetKey: string;
  }): Promise<string | null> {
    const bindings = await this.bindings.list(this.dispatcherId);
    const match = bindings.find(
      (binding) =>
        binding.active &&
        binding.target_key === input.targetKey &&
        ownerMatchesBinding(input.owner, binding),
    );
    return match?.channel_id ?? null;
  }

  async activeBindingSummaryForOwner(
    owner: ChannelRouteOwner,
  ): Promise<ChannelBindingSummary | null> {
    const bindings = await this.bindings.list(this.dispatcherId);
    const active = bindings.find(
      (binding) => binding.active && ownerMatchesBinding(owner, binding),
    );
    if (active === undefined) return null;
    return {
      channel_id: active.channel_id,
      provider: active.provider,
      target_type: active.target_type,
      target_key: active.target_key,
      display: active.display,
      canonical_url: active.canonical_url,
    };
  }

  async transferAllForOwner(owner: ChannelRouteOwner): Promise<ChannelBinding[]> {
    const transferred: ChannelBinding[] = [];
    for (const binding of await this.bindings.list(this.dispatcherId)) {
      if (!binding.active || !ownerMatchesBinding(owner, binding)) continue;
      const result = await this.bindings.transferBack({
        dispatcherId: this.dispatcherId,
        channelId: binding.channel_id,
        targetKey: binding.target_key,
      });
      if (result !== null) transferred.push(result);
    }
    return transferred;
  }

  resolveTarget(meta: unknown, channelId?: string): Promise<ChannelTarget> {
    return this.sessions.resolveTarget(meta, channelId);
  }

  messageBelongsToTarget(
    target: ChannelTarget,
    messageId: string,
    channelId?: string,
  ): Promise<boolean> {
    return this.sessions.messageBelongsToTarget(target, messageId, channelId);
  }

  resolveToolChannelId(requested?: string, providerRef?: string): string {
    if (providerRef === undefined) return this.resolveChannelId(requested);
    if (requested !== undefined) {
      const channelId = this.resolveChannelId(requested);
      const actualProvider = this.channelProviderRef(channelId);
      if (actualProvider !== providerRef) {
        throw new ChannelToolAuthorizationError(
          'BAD_REQUEST',
          `channel '${channelId}' for dispatcher '${this.dispatcherId}' uses provider '${actualProvider}', not '${providerRef}'`,
        );
      }
      return channelId;
    }
    const matches = this.dispatcherChannels().filter(
      (channel) => channel.provider === providerRef,
    );
    if (matches.length === 0) {
      throw new ChannelToolAuthorizationError(
        'BAD_REQUEST',
        `dispatcher '${this.dispatcherId}' has no configured channel for provider '${providerRef}'`,
      );
    }
    if (matches.length > 1) {
      throw new ChannelToolAuthorizationError(
        'BAD_REQUEST',
        `dispatcher '${this.dispatcherId}' has ${matches.length} channels for provider '${providerRef}'; channel_id is required`,
      );
    }
    return matches[0]!.id;
  }

  resolveChannelId(requested?: string): string {
    const ids = this.dispatcherChannels().map((channel) => channel.id);
    if (requested !== undefined) {
      if (!ids.includes(requested)) {
        throw new Error(
          `unknown channel_id '${requested}' for dispatcher '${this.dispatcherId}'; ` +
            `its configured channels are ${
              ids.length > 0 ? ids.map((id) => `'${id}'`).join(', ') : '(none)'
            }`,
        );
      }
      return requested;
    }
    if (ids.length === 0) {
      throw new Error(`dispatcher '${this.dispatcherId}' has no resolvable channel`);
    }
    if (ids.length > 1) {
      throw new Error(
        `dispatcher '${this.dispatcherId}' has ${ids.length} channels; ` +
          'channel_id is required to select one',
      );
    }
    return ids[0]!;
  }

  channelProviderRef(channelId: string): string {
    const channel = this.dispatcherChannels().find(
      (entry) => entry.id === channelId,
    );
    if (channel === undefined) {
      throw new Error(
        `unknown channel_id '${channelId}' for dispatcher '${this.dispatcherId}'`,
      );
    }
    return channel.provider;
  }

  private dispatcherChannels(): readonly DispatcherChannelConfig[] {
    return this.sessions.configuredChannels();
  }
}

function ownerFromBinding(binding: ChannelBinding): ChannelRouteOwner {
  return {
    kind: 'team',
    teamName: binding.team_name,
    leaderName: binding.leader_name,
  };
}

function ownerMatchesBinding(
  owner: ChannelRouteOwner,
  binding: ChannelBinding,
): boolean {
  return (
    owner.kind === 'team' &&
    binding.team_name === owner.teamName &&
    binding.leader_name === owner.leaderName
  );
}
