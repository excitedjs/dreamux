import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Server } from '../src/server.js';
import { DispatcherService } from '../src/service/dispatcher-service/index.js';
import { feishuChannelCatalog } from './helpers/fake-channel.js';
import { createFakeFeishuBot } from './helpers/fake-feishu-bot.js';
import {
  FAKE_RUNTIME_REF,
  fakeRuntimeCatalog,
} from './helpers/fake-team-runtime.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dreamux-server-shutdown-'));
  previousHome = process.env['HOME'];
  process.env['HOME'] = join(home, 'home');
  process.env['DREAMUX_ROOT'] = join(home, 'dreamux');
  mkdirSync(process.env['HOME'], { recursive: true });
});

afterEach(() => {
  if (previousHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = previousHome;
  delete process.env['DREAMUX_ROOT'];
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('server shutdown broadcast', () => {
  it('broadcasts workflow signals and dissolve interrupts before draining accepted admin requests', async () => {
    const workspace = join(home, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const server = new Server({
      config: testDreamuxConfig([
        testDispatcherConfig({
          id: 'dispatcher-a',
          cwd: workspace,
          agentRuntime: 'agent-a',
          runtimeProvider: FAKE_RUNTIME_REF,
        }),
      ]),
      agentRuntimeProviderCatalog: fakeRuntimeCatalog([]),
      channelProviderCatalog: feishuChannelCatalog(() => createFakeFeishuBot()),
      adminSocketPath: join(home, 'admin.sock'),
    });
    // Materialize the dispatcher so the broadcast has a live target.
    const dispatcher = server.dispatchers.get('dispatcher-a');
    const broadcast = vi.spyOn(
      DispatcherService.prototype,
      'signalShutdownBroadcast',
    );

    let releaseRequest!: () => void;
    const requestBlock = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    const admitted = server.admitAdminRequest(async () => {
      await requestBlock;
      // The narrow pre-drain broadcast must not flip dispatcher availability:
      // this accepted handler's inner admission still completes normally.
      return dispatcher.admitOperation(async () => 'inner-work');
    });
    let shutdownSettled = false;
    const shutdown = server.shutdown().then(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    // The broadcast ran before the accepted admin requests drained.
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(shutdownSettled).toBe(false);

    releaseRequest();
    await expect(admitted).resolves.toBe('inner-work');
    await expect(shutdown).resolves.toBeUndefined();
  });

  it('leaves non-admin availability unchanged by the pre-drain broadcast', async () => {
    const workspace = join(home, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const server = new Server({
      config: testDreamuxConfig([
        testDispatcherConfig({
          id: 'dispatcher-a',
          cwd: workspace,
          agentRuntime: 'agent-a',
          runtimeProvider: FAKE_RUNTIME_REF,
        }),
      ]),
      agentRuntimeProviderCatalog: fakeRuntimeCatalog([]),
      channelProviderCatalog: feishuChannelCatalog(() => createFakeFeishuBot()),
      adminSocketPath: join(home, 'admin.sock'),
    });
    const dispatcher = server.dispatchers.get('dispatcher-a');
    await dispatcher.start();
    const broadcast = vi.spyOn(
      DispatcherService.prototype,
      'signalShutdownBroadcast',
    );

    let releaseRequest!: () => void;
    const requestBlock = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    const admitted = server.admitAdminRequest(async () => {
      await requestBlock;
      // The isShuttingDown-gated spawn path must still accept work after the
      // broadcast; full availability flips only in shutdown() after the drain.
      return dispatcher.teammates.spawn({
        name: 'post-broadcast',
        prompt: 'still available',
        intent: 'availability check',
      });
    });
    const shutdown = server.shutdown();
    await Promise.resolve();
    await Promise.resolve();
    expect(broadcast).toHaveBeenCalledTimes(1);

    releaseRequest();
    const spawned = await admitted;
    expect(spawned.teammate.name).toContain('post-broadcast');
    await expect(shutdown).resolves.toBeUndefined();
  });
});
