/** Actual session owners with narrowly recorded tool boundaries. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, vi } from 'vitest';
import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import { createFeishuBot } from '../../src/bot.js';
import { FeishuChannelSession } from '../../src/session/session.js';
import type { FeishuToolSession } from '../../src/tools/types.js';
import { createFakeFeishuBot } from './fake-feishu-bot.js';
vi.mock('../../src/bot.js', () => ({ createFeishuBot: vi.fn() }));
const held: Array<{ dir: string; session: FeishuChannelSession }> = [];
const log: DreamuxLogger = {
  error() {},
  warn() {},
  info() {},
  debug() {},
  trace() {},
  child: () => log,
};
afterEach(async () => {
  for (const { dir, session } of held.splice(0)) {
    await session.close();
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});
export interface ToolOverrides {
  bindChannel: FeishuToolSession['bindings']['bindChannel'];
  unbindChannel: FeishuToolSession['bindings']['unbindChannel'];
  bindSpace: FeishuToolSession['bindings']['bindSpace'];
  unbindSpace: FeishuToolSession['bindings']['unbindSpace'];
  getSpace: FeishuToolSession['routing']['spaceByName'];
  listSpaces: FeishuToolSession['routing']['listSpaces'];
  listBindings: FeishuToolSession['routing']['listBindings'];
  listSubscriptions: FeishuToolSession['routing']['listSubscriptions'];
  subscribeDocument: FeishuToolSession['docComments']['subscribe'];
  unsubscribeDocument: FeishuToolSession['docComments']['unsubscribe'];
}
export function makeToolSession(
  overrides: Partial<ToolOverrides> = {},
): FeishuToolSession {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-tool-session-'));
  vi.mocked(createFeishuBot).mockReturnValueOnce(createFakeFeishuBot());
  const owner = new FeishuChannelSession({
    dispatcherId: 'fixture',
    channelId: 'chan-1',
    appId: 'app',
    appSecret: '',
    stateDir: dir,
    attachmentCacheDir: dir,
    log,
  });
  held.push({ dir, session: owner });
  const tools = owner.tools;
  const unused = async (): Promise<never> => {
    throw new Error('unused tool boundary');
  };
  vi.spyOn(tools.bindings, 'bindChannel').mockImplementation(
    overrides.bindChannel ?? unused,
  );
  vi.spyOn(tools.bindings, 'unbindChannel').mockImplementation(
    overrides.unbindChannel ?? unused,
  );
  vi.spyOn(tools.bindings, 'bindSpace').mockImplementation(
    overrides.bindSpace ?? unused,
  );
  vi.spyOn(tools.bindings, 'unbindSpace').mockImplementation(
    overrides.unbindSpace ?? (async () => null),
  );
  vi.spyOn(tools.routing, 'spaceByName').mockImplementation(
    overrides.getSpace ?? (() => undefined),
  );
  vi.spyOn(tools.routing, 'listSpaces').mockImplementation(
    overrides.listSpaces ?? (() => []),
  );
  vi.spyOn(tools.routing, 'listBindings').mockImplementation(
    overrides.listBindings ?? (() => []),
  );
  vi.spyOn(tools.routing, 'listSubscriptions').mockImplementation(
    overrides.listSubscriptions ?? (() => []),
  );
  vi.spyOn(tools.docComments, 'subscribe').mockImplementation(
    overrides.subscribeDocument ?? unused,
  );
  vi.spyOn(tools.docComments, 'unsubscribe').mockImplementation(
    overrides.unsubscribeDocument ?? unused,
  );
  vi.spyOn(tools.cardActions, 'askUserQuestion').mockResolvedValue({
    request_id: 'ask-1',
  });
  return tools;
}
