import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { dispatcherChannelBindingsPath } from '../../platform/paths.js';

export type ChannelProvider = 'builtin:feishu';
export type ChannelChatType = 'group' | 'p2p';

export interface ChannelBinding {
  provider: ChannelProvider;
  chat_id: string;
  chat_type: 'group';
  team_id: string;
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
  teamId: string;
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
      team_id: input.teamId,
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
    return value as unknown as ChannelBindingFile;
  }

  private async write(
    dispatcherId: string,
    file: ChannelBindingFile,
  ): Promise<void> {
    const path = dispatcherChannelBindingsPath(dispatcherId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  }
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}
