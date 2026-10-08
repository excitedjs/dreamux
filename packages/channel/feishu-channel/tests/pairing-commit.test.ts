import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import { FeishuAccess } from '../src/access/index.js';
import {
  defaultDispatcherAccessState,
  PAIRING_TTL_MS,
} from '../src/access/state.js';
import type { GateInbound } from '../src/access/gate.js';
const log: DreamuxLogger = {
  error() {},
  warn() {},
  info() {},
  debug() {},
  trace() {},
  child() {
    return log;
  },
};
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
const inbound: GateInbound = {
  chat_type: 'p2p',
  sender_id: 'sender',
  chat_id: 'chat',
  is_bot_sender: false,
  trusted_bot: false,
  bot_mentioned: false,
};
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'pairing-commit-'));
  dirs.push(dir);
  const path = join(dir, 'access.json');
  return {
    path,
    access: new FeishuAccess({ stateDir: dir, dispatcherId: 'test', log }),
  };
}

describe('pairing commit after successful send', () => {
  it('replaces an expired same-sender entry and preserves another live sender', async () => {
    const f = await fixture();
    const now = 100_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    await writeFile(
      f.path,
      JSON.stringify({
        ...defaultDispatcherAccessState(),
        pending: {
          expired: {
            sender_id: 'sender',
            chat_id: 'chat',
            created_at: 1,
            expires_at: now,
          },
          other: {
            sender_id: 'other',
            chat_id: 'chat',
            created_at: 1,
            expires_at: now + 1000,
          },
        },
      }),
    );
    const action = await f.access.gate(inbound);
    if (action.action !== 'pair') throw new Error('pair expected');
    expect(
      JSON.parse(await readFile(f.path, 'utf8')).pending[action.token],
    ).toBeUndefined();
    await f.access.recordPairingPrompt(inbound, action, 'sent');
    const state = JSON.parse(await readFile(f.path, 'utf8'));
    expect(state.pending.expired).toBeUndefined();
    expect(state.pending.other).toBeDefined();
    expect(state.pending[action.token]).toMatchObject({
      prompt_message_id: 'sent',
      created_at: now,
      expires_at: now + PAIRING_TTL_MS,
    });
    expect((await f.access.approvePairingByToken(action.token)).status).toBe(
      'ok',
    );
  });

  it('does not persist a failed send and accepts its retry', async () => {
    const { path, access } = await fixture();
    const first = await access.gate(inbound);
    expect(first.action).toBe('pair');
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    const retry = await access.gate(inbound);
    if (retry.action !== 'pair') throw new Error('pair expected');
    await access.recordPairingPrompt(inbound, retry, 'retried');
    expect(
      JSON.parse(await readFile(path, 'utf8')).pending[retry.token]
        .prompt_message_id,
    ).toBe('retried');
  });

  it('concurrent approval wins over a late successful send', async () => {
    const { path, access } = await fixture();
    const first = await access.gate(inbound);
    if (first.action !== 'pair') throw new Error('pair expected');
    await access.recordPairingPrompt(inbound, first, 'first');
    const late = await access.gate(inbound);
    if (late.action !== 'pair') throw new Error('pair expected');
    await access.approvePairingByToken(first.token);
    await access.recordPairingPrompt(inbound, late, 'late');
    const state = JSON.parse(await readFile(path, 'utf8'));
    expect(state.allow_users).toContain('sender');
    expect(state.pending).toEqual({});
  });

  it('keeps a concurrent live winner, prunes expired strangers and supports both resend forms', async () => {
    const { path, access } = await fixture();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const other = await access.gate({ ...inbound, sender_id: 'other' });
    if (other.action !== 'pair') throw new Error('pair expected');
    await access.recordPairingPrompt(
      { ...inbound, sender_id: 'other' },
      other,
      'other',
    );
    clock.mockReturnValue(2000);
    const a = await access.gate(inbound);
    const b = await access.gate(inbound);
    if (a.action !== 'pair' || b.action !== 'pair')
      throw new Error('pair expected');
    await access.recordPairingPrompt(inbound, a, undefined);
    clock.mockReturnValue(1000 + PAIRING_TTL_MS);
    await access.recordPairingPrompt(inbound, b, 'loser');
    let state = JSON.parse(await readFile(path, 'utf8'));
    expect(Object.keys(state.pending)).toEqual([a.token]);
    const resend = await access.gate(inbound);
    if (resend.action !== 'pair') throw new Error('pair expected');
    await access.recordPairingPrompt(inbound, resend, 'winner');
    clock.mockReturnValue(2000 + PAIRING_TTL_MS);
    await access.refreshPairing({ ...resend, prompt_message_id: 'winner' });
    state = JSON.parse(await readFile(path, 'utf8'));
    expect(state.pending[a.token]).toMatchObject({
      prompt_message_id: 'winner',
      expires_at: 2000 + 2 * PAIRING_TTL_MS,
    });
  });
});
