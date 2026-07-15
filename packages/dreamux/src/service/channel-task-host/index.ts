import type {
  ChannelTaskHost,
  ChannelTaskHostEventSink,
  ChannelTaskReceipt,
  ChannelTaskTerminalResult,
  DreamuxLogger,
} from '@excitedjs/dreamux-types';

import type { AgentRuntimeProviderCatalog } from '../../agent-runtime/index.js';
import type { DreamuxConfig } from '../../config/config.js';
import type { ChannelService } from '../channel-service/index.js';
import type { CollaborationSpaceService } from '../collaboration-space/index.js';
import type { CollaborationSpaceRecord } from '../collaboration-space/types.js';
import type { TeamCollection } from '../team-collection/index.js';
import type { TaskTeamSubmissionBridge } from '../task-runtime-submission.js';
import { discoverTaskHostManifests } from './manifest.js';
import { TaskChannelHostService } from './service.js';
import { TaskHostStore } from './store.js';

export interface TaskChannelHostCollectionOptions {
  dispatcherId: string;
  config: DreamuxConfig;
  channels: ChannelService;
  collaborationSpaces: CollaborationSpaceService;
  teams: TeamCollection;
  agentRuntimeProviders: AgentRuntimeProviderCatalog;
  log: DreamuxLogger;
  isShuttingDown: () => boolean;
  taskHostParentDir?: string;
}

export class TaskChannelHostCollection {
  private readonly hosts = new Map<string, TaskChannelHostService>();
  private readonly sessionChannels = new Set<string>();

  private constructor() {}

  static async open(opts: TaskChannelHostCollectionOptions) {
    const collection = new TaskChannelHostCollection();
    const discovered = await discoverTaskHostManifests(
      opts.dispatcherId,
      opts.taskHostParentDir,
    );
    const manifests = new Map(
      discovered.map((entry) => [entry.manifest.channel_id, entry]),
    );
    if (manifests.size !== discovered.length) {
      throw new Error('multiple durable task hosts claim the same channel');
    }
    const configured = new Map(
      opts.channels.configuredChannels().map((channel) => [channel.id, channel]),
    );
    for (const entry of discovered) {
      const channel = configured.get(entry.manifest.channel_id);
      if (
        channel !== undefined &&
        channel.provider !== entry.manifest.provider_ref
      ) {
        throw new Error(
          `durable task host provider does not match channel ${JSON.stringify(channel.id)}`,
        );
      }
    }
    for (const channel of opts.channels.configuredChannels()) {
      if (!opts.channels.supportsTaskHost(channel.id)) continue;
      collection.sessionChannels.add(channel.id);
      const manifest = manifests.get(channel.id);
      collection.hosts.set(channel.id, await TaskChannelHostService.open({
        dispatcherId: opts.dispatcherId,
        channelId: channel.id,
        provider: channel.provider,
        config: opts.config,
        channels: opts.channels,
        collaborationSpaces: opts.collaborationSpaces,
        teams: opts.teams,
        agentRuntimeProviders: opts.agentRuntimeProviders,
        log: opts.log,
        isShuttingDown: opts.isShuttingDown,
        ...(manifest !== undefined ? { storeRoot: manifest.rootDir } : {}),
      }));
    }
    for (const entry of discovered) {
      const channelId = entry.manifest.channel_id;
      if (collection.hosts.has(channelId)) continue;
      const store = await TaskHostStore.open({
        dispatcherId: opts.dispatcherId,
        channelId,
        providerRef: entry.manifest.provider_ref,
        rootDir: entry.rootDir,
      });
      const unfinished = store.list().filter((target) => target.phase !== 'finalized');
      if (unfinished.some((target) => target.terminal === null)) {
        throw new Error(
          `durable task host ${JSON.stringify(channelId)} has active targets but ` +
            'its configured channel does not expose the required task capability',
        );
      }
      if (unfinished.length === 0) continue;
      // A provider session is not needed to converge already-terminal Core
      // state. Keep the durable host alive only for runtime settlement and
      // Team/worktree finalization; no channel transport is opened here.
      collection.hosts.set(channelId, await TaskChannelHostService.open({
        dispatcherId: opts.dispatcherId,
        channelId,
        provider: entry.manifest.provider_ref,
        config: opts.config,
        channels: opts.channels,
        collaborationSpaces: opts.collaborationSpaces,
        teams: opts.teams,
        agentRuntimeProviders: opts.agentRuntimeProviders,
        log: opts.log,
        isShuttingDown: opts.isShuttingDown,
        store,
      }));
    }
    return collection;
  }

  async recover(): Promise<void> {
    for (const host of this.hosts.values()) await host.recover();
  }

  beginSession(channelId: string): ChannelTaskHost | undefined {
    if (!this.sessionChannels.has(channelId)) return undefined;
    return this.hosts.get(channelId)?.beginSession();
  }

  attachEventSink(
    channelId: string,
    sessionFence: string,
    sink: ChannelTaskHostEventSink | undefined,
  ): void {
    this.hosts.get(channelId)?.attachEventSink(sessionFence, sink);
  }

  detachEventSinks(): void {
    for (const host of this.hosts.values()) host.detachEventSink();
  }

  async notifySettlement(input: {
    teamId: string;
    runtimeId: string;
    durabilityNamespace: string;
    turnId: string;
  }): Promise<void> {
    const host = this.hostForTeam(input.teamId);
    if (host !== null) await host.notifySettlement(input);
  }

  submissionBridgeForTeam(teamId: string): TaskTeamSubmissionBridge | null {
    return this.hostForTeam(teamId)?.submissionBridgeForTeam(teamId) ?? null;
  }

  async finishForTeam(input: {
    teamId: string;
    leaderName: string;
    result: ChannelTaskTerminalResult;
  }): Promise<ChannelTaskReceipt> {
    const host = this.hostForTeam(input.teamId);
    if (host === null) throw new Error('TeamLeader has no active task attempt');
    return host.finishForTeam(input);
  }

  hasTeam(teamId: string): boolean {
    return this.hostForTeam(teamId) !== null;
  }

  assertSpaceCanDissolve(space: CollaborationSpaceRecord): void {
    for (const host of this.hosts.values()) {
      if (host.hasActiveContainer(space)) {
        throw new Error(
          `collaboration space ${JSON.stringify(space.space_name)} is owned by ` +
            'an active task attempt; finish or cancel the task attempt instead',
        );
      }
    }
  }

  async prepareStop(): Promise<void> {
    await Promise.all([...this.hosts.values()].map((host) => host.prepareStop()));
  }

  async finishStop(): Promise<void> {
    await Promise.all([...this.hosts.values()].map((host) => host.finishStop()));
  }

  async drain(): Promise<void> {
    await Promise.all([...this.hosts.values()].map((host) => host.drain()));
  }

  close(): void {
    for (const host of this.hosts.values()) host.close();
    this.hosts.clear();
    this.sessionChannels.clear();
  }

  private hostForTeam(teamId: string): TaskChannelHostService | null {
    for (const host of this.hosts.values()) {
      if (host.hasTeam(teamId)) return host;
    }
    return null;
  }

}
