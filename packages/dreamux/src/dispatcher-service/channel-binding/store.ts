import { readFile } from 'node:fs/promises';

import { writeFileAtomic } from '../../platform/atomic-write.js';
import { isNotFound } from '../../platform/fs-errors.js';
import { dispatcherChannelBindingsPath } from '../../platform/paths.js';
import { LegacyStateError } from '../legacy-state.js';

export type ChannelProvider = 'builtin:feishu';
export type ChannelChatType = 'group' | 'p2p';

export interface ChannelBinding {
  provider: ChannelProvider;
  chat_id: string;
  chat_type: 'group';
  /** The concrete Team key the chat is bound to (issue #199 Slice 4). */
  team_name: string;
  leader_name: string;
  active: boolean;
  created_at: number;
  updated_at: number;
  deactivated_at: number | null;
}

interface ChannelBindingFile {
  version: 1;
  bindings: ChannelBinding[];
}

export interface BindChannelInput {
  dispatcherId: string;
  provider: ChannelProvider;
  chatId: string;
  chatType: ChannelChatType;
  teamName: string;
  leaderName: string;
}

export interface TransferChannelBackInput {
  dispatcherId: string;
  provider: ChannelProvider;
  chatId: string;
  chatType: ChannelChatType;
}

export class ChannelBindingStore {
  async bind(input: BindChannelInput): Promise<ChannelBinding> {
    if (input.chatType !== 'group') {
      throw new Error('Team channel binding supports group chats only');
    }
    const file = await this.read(input.dispatcherId);
    const now = Date.now();
    const next: ChannelBinding = {
      provider: input.provider,
      chat_id: input.chatId,
      chat_type: input.chatType,
      team_name: input.teamName,
      leader_name: input.leaderName,
      active: true,
      created_at: now,
      updated_at: now,
      deactivated_at: null,
    };
    const idx = file.bindings.findIndex((binding) =>
      binding.provider === input.provider && binding.chat_id === input.chatId,
    );
    if (idx === -1) file.bindings.push(next);
    else file.bindings[idx] = { ...next, created_at: file.bindings[idx]!.created_at };
    await this.write(input.dispatcherId, file);
    return idx === -1 ? next : file.bindings[idx]!;
  }

  async transferBack(input: TransferChannelBackInput): Promise<ChannelBinding | null> {
    if (input.chatType !== 'group') {
      throw new Error('Team channel transfer supports group chats only');
    }
    const file = await this.read(input.dispatcherId);
    const binding = file.bindings.find((entry) =>
      entry.provider === input.provider &&
      entry.chat_id === input.chatId &&
      entry.active,
    );
    if (binding === undefined) return null;
    binding.active = false;
    binding.updated_at = Date.now();
    binding.deactivated_at = binding.updated_at;
    await this.write(input.dispatcherId, file);
    return binding;
  }

  async resolve(input: {
    dispatcherId: string;
    provider: ChannelProvider;
    chatId: string;
    chatType: ChannelChatType;
  }): Promise<ChannelBinding | null> {
    if (input.chatType !== 'group') return null;
    const file = await this.read(input.dispatcherId);
    return file.bindings.find((binding) =>
      binding.provider === input.provider &&
      binding.chat_id === input.chatId &&
      binding.active,
    ) ?? null;
  }

  async list(dispatcherId: string): Promise<ChannelBinding[]> {
    return (await this.read(dispatcherId)).bindings;
  }

  private async read(dispatcherId: string): Promise<ChannelBindingFile> {
    let raw: string;
    try {
      raw = await readFile(dispatcherChannelBindingsPath(dispatcherId), 'utf8');
    } catch (err) {
      if (isNotFound(err)) return { version: 1, bindings: [] };
      throw err;
    }
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value['version'] !== 1 || !Array.isArray(value['bindings'])) {
      throw new Error(`invalid channel binding store for dispatcher ${dispatcherId}`);
    }
    // #199 Slice 5 fail-loud: a pre-Slice-4 binding keyed the chat on the old
    // `team_id` instead of the concrete `team_name`. Dreamux 0.x does not
    // migrate it — reject with rebuild guidance rather than reading a row that
    // can no longer resolve a Team.
    const legacy = (value['bindings'] as Record<string, unknown>[]).some((row) =>
      typeof row === 'object' &&
      row !== null &&
      !Object.prototype.hasOwnProperty.call(row, 'team_name') &&
      Object.prototype.hasOwnProperty.call(row, 'team_id'),
    );
    if (legacy) {
      throw new LegacyStateError(
        `channel binding store for dispatcher ${dispatcherId} has pre-#199 rows keyed by ` +
          'team_id instead of team_name. Dreamux 0.x does not migrate old state — delete ' +
          `${dispatcherChannelBindingsPath(dispatcherId)} and re-bind the channel(s) to rebuild it.`,
      );
    }
    return value as unknown as ChannelBindingFile;
  }

  private async write(
    dispatcherId: string,
    file: ChannelBindingFile,
  ): Promise<void> {
    const path = dispatcherChannelBindingsPath(dispatcherId);
    await writeFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`);
  }
}
