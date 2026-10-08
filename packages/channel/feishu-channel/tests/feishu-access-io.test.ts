/** Access IO through the held owner; fixtures only write initial on-disk state. */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import { FeishuAccess } from '../src/access/index.js';
import {
  defaultDispatcherAccessState,
  type DispatcherAccessStateV3,
} from '../src/access/state.js';
import type { GateInbound } from '../src/access/gate.js';

const log: DreamuxLogger = {
  error() {},
  warn() {},
  info() {},
  debug() {},
  trace() {},
  child: () => log,
};
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'feishu-access-io-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
function owner() {
  return new FeishuAccess({ stateDir: dir, dispatcherId: 'test', log });
}
const inbound: GateInbound = {
  chat_type: 'p2p',
  chat_id: 'chat',
  sender_id: 'sender',
  is_bot_sender: false,
  trusted_bot: false,
  bot_mentioned: false,
};
async function seed(value: unknown) {
  await writeFile(join(dir, 'access.json'), JSON.stringify(value));
}
async function disk(): Promise<DispatcherAccessStateV3> {
  return JSON.parse(
    await readFile(join(dir, 'access.json'), 'utf8'),
  ) as DispatcherAccessStateV3;
}

describe('FeishuAccess v3 loader and atomic writes', () => {
  it('logs fresh and resent pairing decisions without exposing the usable credential', async () => {
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      child: (): DreamuxLogger => logger,
    } satisfies DreamuxLogger;
    const access = new FeishuAccess({
      stateDir: dir,
      dispatcherId: 'test',
      log: logger,
    });
    const fresh = await access.gate(inbound);
    if (fresh.action !== 'pair') throw new Error('expected fresh pairing');
    await access.recordPairingPrompt(inbound, fresh, 'prompt');
    const resend = await access.gate(inbound);
    expect(resend).toMatchObject({
      action: 'pair',
      token: fresh.token,
      is_resend: true,
      prompt_message_id: 'prompt',
    });
    expect(logger.debug).toHaveBeenCalledWith(
      {
        pairing_token_len: fresh.token.length,
        sender_id: 'sender',
        chat_id: 'chat',
      },
      '[feishu-gate] dm pairing: new slot',
    );
    expect(logger.debug).toHaveBeenCalledWith(
      {
        pairing_token_len: fresh.token.length,
        sender_id: 'sender',
        chat_id: 'chat',
        prompt_message_id: 'prompt',
      },
      '[feishu-gate] dm pairing: existing prompt',
    );
    expect((await disk()).pending[fresh.token]).toMatchObject({
      sender_id: 'sender',
      chat_id: 'chat',
      prompt_message_id: 'prompt',
    });
    expect(await access.approvePairingByToken(fresh.token)).toMatchObject({
      status: 'ok',
    });
    expect(await access.decide(inbound)).toMatchObject({ action: 'deliver' });
    expect(
      JSON.stringify([
        ...logger.error.mock.calls,
        ...logger.warn.mock.calls,
        ...logger.info.mock.calls,
        ...logger.debug.mock.calls,
        ...logger.trace.mock.calls,
      ]),
    ).not.toContain(fresh.token);
  });

  it('missing access.json uses the secure default v3 policy', async () => {
    const access = owner();
    expect(await access.decide(inbound)).toMatchObject({
      action: 'pair',
      kind: 'dm',
    });
    expect(
      await access.inboundPolicy({
        chatType: 'group',
        chatId: 'group',
        senderId: 'sender',
      }),
    ).toMatchObject({ observeBots: false });
    expect(await access.isTrustedDispatcherUser('sender')).toBe(false);
    expect(
      await access.decide({ ...inbound, chat_type: 'group' }),
    ).toMatchObject({ action: 'drop', reason: 'group_bot_not_mentioned' });
    expect(
      await access.decide({
        ...inbound,
        chat_type: 'group',
        bot_mentioned: true,
      }),
    ).toMatchObject({ action: 'pair', kind: 'dm' });
    await expect(stat(join(dir, 'access.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('creates a missing state directory at 0700 and its first secure V3 file at 0600 on pairing commit', async () => {
    const stateDir = join(dir, 'new-state');
    const access = new FeishuAccess({ stateDir, dispatcherId: 'test', log });
    const action = await access.gate(inbound);
    if (action.action !== 'pair') throw new Error('expected pairing');
    await expect(stat(stateDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await access.recordPairingPrompt(inbound, action, 'prompt');
    expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
    const file = join(stateDir, 'access.json');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 3,
      dm_policy: 'pairing',
      group: {
        policy: 'follow-user',
        allow_chats: [],
        require_mention: true,
      },
      allow_users: [],
      pending: {
        [action.token]: {
          sender_id: 'sender',
          chat_id: 'chat',
          created_at: expect.any(Number),
          expires_at: expect.any(Number),
          prompt_message_id: 'prompt',
        },
      },
    });
  });

  it('v2 file throws error mentioning v3 and migration guidance', async () => {
    await seed({ ...defaultDispatcherAccessState(), version: 2 });
    await expect(owner().decide(inbound)).rejects.toThrow(/v3/);
    await expect(owner().decide(inbound)).rejects.toThrow(
      /CHANGELOG|access\.json/,
    );
  });
  it('v1 file throws error mentioning v3', async () => {
    await seed({ ...defaultDispatcherAccessState(), version: 1 });
    await expect(owner().decide(inbound)).rejects.toThrow(/v3/);
  });
  it('missing version field throws error mentioning v3 shape', async () => {
    const { version: _version, ...rest } = defaultDispatcherAccessState();
    await seed(rest);
    await expect(owner().decide(inbound)).rejects.toThrow(/v3/);
  });
  it('malformed JSON throws mentioning access.json', async () => {
    await writeFile(join(dir, 'access.json'), '{bad');
    await expect(owner().decide(inbound)).rejects.toThrow(/access\.json/);
  });
  it('shallow-loads a typo group policy but the gate fails closed before trusted delivery', async () => {
    const state = defaultDispatcherAccessState();
    await seed({
      ...state,
      allow_users: ['sender'],
      group: {
        ...state.group,
        policy: 'typo',
        allow_chats: ['chat'],
        require_mention: false,
      },
    });
    expect(
      await owner().decide({ ...inbound, chat_type: 'group' }),
    ).toMatchObject({ action: 'drop' });
  });
  it('committed pairing round-trips v3 state with 0600 file mode', async () => {
    const access = owner();
    const action = await access.gate(inbound);
    if (action.action !== 'pair') throw new Error('expected pairing');
    await access.recordPairingPrompt(inbound, action, 'prompt');
    const state = await disk();
    expect(state).toMatchObject({
      ...defaultDispatcherAccessState(),
      pending: {
        [action.token]: {
          sender_id: 'sender',
          chat_id: 'chat',
          prompt_message_id: 'prompt',
        },
      },
    });
    expect((await stat(join(dir, 'access.json'))).mode & 0o777).toBe(0o600);
    expect(await owner().decide(inbound)).toMatchObject({
      action: 'pair',
      token: action.token,
      is_resend: true,
      prompt_message_id: 'prompt',
    });
    expect(await owner().approvePairingByToken(action.token)).toMatchObject({
      status: 'ok',
    });
    expect(await owner().decide(inbound)).toMatchObject({ action: 'deliver' });
  });
  it('pairing approval preserves operator policy and existing trust while dropping retired diagnostic fields', async () => {
    const policy = {
      version: 3,
      dm_policy: 'pairing',
      group: {
        policy: 'follow-user',
        allow_chats: ['trusted-group'],
        require_mention: false,
      },
    };
    await seed({
      ...policy,
      allow_users: ['operator-user'],
      pending: {},
      observed_chats: { 'old-chat': {} },
      warnings: ['old diagnostic'],
      last_gate: { action: 'drop' },
    });
    const access = owner();
    const action = await access.gate(inbound);
    if (action.action !== 'pair') throw new Error('expected pairing');
    await access.recordPairingPrompt(inbound, action, 'prompt');
    expect(await access.approvePairingByToken(action.token)).toMatchObject({
      status: 'ok',
    });
    expect(await disk()).toEqual({
      ...policy,
      allow_users: ['operator-user', 'sender'],
      pending: {},
    });
    expect(await owner().decide(inbound)).toMatchObject({ action: 'deliver' });
    expect(await owner().isTrustedDispatcherUser('operator-user')).toBe(true);
  });
  it('concurrent pairing commits never tear the file or lose another sender', async () => {
    const access = owner();
    const entries = await Promise.all(
      Array.from({ length: 8 }, async (_, i) => {
        const input = {
          ...inbound,
          sender_id: `sender-${i}`,
          chat_id: `chat-${i}`,
        };
        const action = await access.decide(input);
        if (action.action !== 'pair') throw new Error('expected pairing');
        return { input, action };
      }),
    );
    await Promise.all(
      entries.map(async ({ input, action }, i) => {
        await access.recordPairingPrompt(input, action, `prompt-${i}`);
        expect((await disk()).version).toBe(3);
      }),
    );
    const state = await disk();
    expect(Object.keys(state.pending)).toHaveLength(entries.length);
    expect(
      Object.values(state.pending)
        .map((entry) => entry.sender_id)
        .sort(),
    ).toEqual(entries.map(({ input }) => input.sender_id).sort());
    expect((await stat(join(dir, 'access.json'))).mode & 0o777).toBe(0o600);
    const fresh = owner();
    for (const { input, action } of entries)
      expect(await fresh.decide(input)).toMatchObject({
        action: 'pair',
        token: action.token,
      });
  });
});
